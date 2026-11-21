#!/usr/bin/env bash
# Tests for the Boss tab in `space.json` — its **name** and the **argv** it was opened with.
#
# Why these exist: `bin/space new` used to write the Boss tab's herdr **id** into `uberboss_tab`
# and nothing into a name field, so the guard read that id as the tab's name and opened tabs
# called `tbe0cd445bff056584e86051e0c782ea74` and `2`. The record is what a reboot replays, so the
# fix is checked in the record itself and in the argv a stub `herdr-app` saw: `space new` writes
# `boss` + `boss_argv` and opens the tab with that argv, the guard names the Boss tab from `boss`,
# a Boss tab that is already there is recorded and never opened twice, and a space with no record
# is not touched at all. No network, no desktop app, nothing written outside $WORK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
GUARD="$ROOT/bin/guard"
for prog in "$SPACE" "$GUARD"; do
	[ -x "$prog" ] || {
		printf 'FATAL: %s is not executable\n' "$prog" >&2
		exit 1
	}
done
for prog in node bash; do
	command -v "$prog" >/dev/null 2>&1 || {
		printf 'FATAL: %s is not on PATH\n' "$prog" >&2
		exit 1
	}
done

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub" "$WORK/resume"
export HERDR_LOG="$WORK/herdr.log"
# `ls` is a question, not an action: it goes to its own file so a pass that opened nothing is a
# fact about both files.
export HERDR_LS_LOG="$WORK/herdr-ls.log"
export HERDR_SPACES="$WORK/spaces.json"
export PI_HERDR_RESUME_DIR="$WORK/resume"
trap 'rm -rf -- "$WORK"' EXIT
PATH="$WORK/stub:$PATH"
export PATH

# The resume sweep is not what this file checks: a stub that says nothing keeps it from running the
# real script against this machine's sessions.
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/stub/herdr-resume.mjs"
export PI_GUARD_RESUME_SCRIPT="$WORK/stub/herdr-resume.mjs"

# herdr-app: `space.new` answers with a **tab id** (the shape the live app gives, and the shape
# that used to end up as a tab name), `tab.new` hands out a fresh tab, `ls` answers whatever the
# case put in $HERDR_SPACES, and every argv is written down so the assertions can read it back.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"ls "*) printf '%s\n' "$*" >>"$HERDR_LS_LOG" ;;
*) printf '%s\n' "$*" >>"$HERDR_LOG" ;;
esac
case "$1 $2" in
"do space.new") printf '{"space":"sp1","tab":"tbe0cd445bff056584e86051e0c782ea74","pane":"p1","terminal":"tbe0cd445bff056584e86051e0c782ea74"}\n' ;;
"do tab.new") printf '{"space":"sp1","tab":"tb9","pane":"p9","terminal":"t9"}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
chmod +x "$WORK/stub/herdr-app"

PASS_N=0
FAIL_N=0
CASE=""
new_case() {
	CASE="$1"
	printf '\n== %s\n' "$CASE"
}
pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	[ "$#" -eq 0 ] || printf '%s\n' "$@" | sed 's/^/     /'
}
run() { OUT=$(timeout 60 "$@" 2>&1); RC=$?; }
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }
sd() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1"; }
herdr() { cat "$HERDR_LOG" 2>/dev/null || true; }
clear_log() { : >"$HERDR_LOG"; : >"$HERDR_LS_LOG"; }
spaces() { printf '%s\n' "$1" >"$HERDR_SPACES"; }
# A record the way an older `bin/space` wrote it, plus whatever the case adds.
make_record() { # <slug> <name> <project> [extra-json]
	local extra=${4:-}
	[ -n "$extra" ] || extra='{}'
	node -e '
		const fs = require("fs"), [dir, name, project, extra] = process.argv.slice(1);
		fs.mkdirSync(dir + "/reports", { recursive: true });
		const rec = Object.assign({
			name, id: "sp-" + name, project, git: false, remote: "",
			created: "2026-01-01T00:00:00.000Z",
			uberboss_tab: "tbe0cd445bff056584e86051e0c782ea74",
			terminals: ["t-" + name],
		}, JSON.parse(extra));
		fs.writeFileSync(dir + "/space.json", JSON.stringify(rec, null, 2) + "\n");
	' "$(sd "$1")" "$2" "$3" "$extra"
}
argv_of() { # <record> <field>
	node -e '
		const fs = require("fs"), [file, field] = process.argv.slice(1);
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		const v = j[field];
		process.stdout.write(Array.isArray(v) ? JSON.stringify(v) : String(v ?? ""));
	' "$1" "$2"
}
tabs_name() { # <record> — every recorded tab name, one per line
	node -e '
		const fs = require("fs");
		const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		for (const t of Array.isArray(j.tabs) ? j.tabs : []) process.stdout.write(String(t && t.name) + "\n");
	' "$1"
}

ID="tbe0cd445bff056584e86051e0c782ea74"
PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"

# ----------------------------------------- space new writes the name and the argv --
new_case 'space new records the Boss tab name and the argv it opened it with'
clear_log
run "$SPACE" new --name demo --project "$PROJ" --kind harness
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'space new failed' "$OUT"; fi
if grep -q '"boss": "Boss"' "$(record demo)"; then pass 'the record names the Boss tab'; else fail 'the record has no boss name' "$(cat "$(record demo)")"; fi
if [ "$(argv_of "$(record demo)" boss_argv)" = '["pi"]' ]; then pass 'the argv it was opened with is recorded'; else fail 'boss_argv is missing or wrong' "$(cat "$(record demo)")"; fi
if [ "$(argv_of "$(record demo)" uberboss_tab)" = "$ID" ]; then pass 'uberboss_tab is still the tab id'; else fail 'uberboss_tab is no longer the id' "$(cat "$(record demo)")"; fi
case $(herdr) in
*"do space.new --name demo --folder $PROJ --tab Boss --argv [\"pi\"]"*)
	pass 'space.new is asked to open the Boss tab with that argv'
	;;
*) fail 'space.new was not given --argv' "$(herdr)" ;;
esac
if node -e '
	const j = require(process.argv[1]);
	const want = ["pi"], got = j.boss_argv || [];
	process.exit(JSON.stringify(want) === JSON.stringify(got) ? 0 : 1);
' "$(record demo)"; then
	pass 'the file holds the argv as an array, not as text'
else
	fail 'boss_argv is not a JSON array' "$(cat "$(record demo)")"
fi

new_case '--tab-name and --argv are both kept'
clear_log
run "$SPACE" new --name captain --project "$PROJ" --tab-name Captain --argv '["sh","-lc","pi"]'
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'space new failed' "$OUT"; fi
if grep -q '"boss": "Captain"' "$(record captain)"; then pass 'the record names the tab what --tab-name said'; else fail 'the tab name was not recorded' "$(cat "$(record captain)")"; fi
if [ "$(argv_of "$(record captain)" boss_argv)" = '["sh","-lc","pi"]' ]; then pass 'the given argv is recorded, not the default'; else fail 'the given argv was not recorded' "$(cat "$(record captain)")"; fi
case $(herdr) in
*"do space.new --name captain --folder $PROJ --tab Captain --argv [\"sh\",\"-lc\",\"pi\"]"*)
	pass 'space.new gets the name and the argv'
	;;
*) fail 'space.new was not given the name and argv' "$(herdr)" ;;
esac

new_case 'an --argv that is not a JSON array of strings is refused'
clear_log
run "$SPACE" new --name broken --project "$PROJ" --argv 'pi'
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a bare string was accepted as argv'; fi
case $OUT in
*--argv*) pass 'the refusal names --argv' ;;
*) fail 'the refusal does not name --argv' "$OUT" ;;
esac
if [ -e "$(record broken)" ]; then fail 'a record was written anyway'; else pass 'no record was written'; fi
if [ -s "$HERDR_LOG" ]; then fail 'the app was asked to open a space anyway' "$(herdr)"; else pass 'nothing was opened'; fi

# ----------------------------------- the guard names the Boss tab from `boss` --
new_case 'a record whose uberboss_tab is an id still opens a tab named Boss'
make_record olddemo olddemo "$PROJ" '{"boss":"Boss","tabs":[{"name":"Boss","folder":"'"$PROJ"'","argv":[]}]}'
spaces '{"spaces":[{"id":"sp-olddemo","name":"olddemo","tabs":[{"id":"tb-other","name":"other"}]}]}'
clear_log
run "$GUARD" --once --space olddemo
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
case $(herdr) in
*"do tab.new --name Boss --space sp-olddemo --folder $PROJ"*) pass 'the tab is opened by its name' ;;
*) fail 'no tab named Boss was opened' "$(herdr)" ;;
esac
if printf '%s\n' "$(herdr)" | grep -qF -- "$ID"; then
	fail 'a tab was named after the id'
else
	pass 'no tab is named after the id'
fi
if [ "$(tabs_name "$(record olddemo)" | head -n 1)" = "Boss" ]; then pass 'the record lists the tab by name'; else fail 'the record lists something else' "$(cat "$(record olddemo)")"; fi

new_case 'a record with no boss field at all falls back to Boss, never to the id'
make_record noname noname "$PROJ" '{"tabs":[{"name":"Boss","folder":"'"$PROJ"'","argv":[]}]}'
spaces '{"spaces":[{"id":"sp-noname","name":"noname","tabs":[{"id":"tb-other","name":"other"}]}]}'
clear_log
run "$GUARD" --once --space noname
case $(herdr) in
*"do tab.new --name Boss --space sp-noname"*) pass 'the tab is opened as Boss' ;;
*) fail 'the fallback name is not Boss' "$(herdr)" ;;
esac
if printf '%s\n' "$(herdr)" | grep -qF -- "$ID"; then fail 'the id was used as a name'; else pass 'the id never becomes a name'; fi

new_case 'a Boss tab that is already there is recorded, never opened again'
make_record live live "$PROJ" '{"boss":"Boss","tabs":[{"name":"Boss","folder":"'"$PROJ"'","argv":["pi"]}]}'
spaces '{"spaces":[{"id":"sp-live","name":"live","tabs":[{"id":"tb-boss","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once --space live
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail 'the guard opened something it did not need to' "$(herdr)"; else pass 'no tab.new and no space.new'; fi
if [ "$(argv_of "$(record live)" boss_argv)" = '' ]; then
	pass 'an empty argv on the command line does not erase one'
else
	fail 'the recorded argv was rewritten' "$(cat "$(record live)")"
fi
if node -e '
	const j = require(process.argv[1]);
	const t = (j.tabs || []).find((x) => x && x.name === "Boss");
	process.exit(t && JSON.stringify(t.argv) === JSON.stringify(["pi"]) ? 0 : 1);
' "$(record live)"; then
	pass 'the recorded Boss tab keeps its argv'
else
	fail 'the recorded Boss tab lost its argv' "$(cat "$(record live)")"
fi

new_case 'a space the guard has no record for gets no tab at all'
spaces '{"spaces":[{"id":"sp2","name":"2","tabs":[]}]}'
clear_log
OUT=$(PI_SPACE_ROOT="$WORK/nothing" PI_BOSS_ROOT="$WORK/nothing" timeout 60 "$GUARD" --once 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail 'the guard opened a tab in a space it does not own' "$(herdr)"; else pass 'no tab.new and no space.new'; fi
OUT=$(timeout 60 "$GUARD" --once --space 2 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass '--space on an unrecorded space exits 0'; else fail '--space 2 failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail '--space 2 still opened a tab' "$(herdr)"; else pass '--space 2 opens nothing'; fi
case $OUT in
*"no record, left alone"*) pass 'it says why the space is left alone' ;;
*) fail 'the refusal does not say the record is missing' "$OUT" ;;
esac

new_case 'a gone space is rebuilt with the recorded name and argv'
make_record rebuild rebuild "$PROJ" '{"boss":"Rebuild Boss","boss_argv":["sh","-lc","pi"],"tabs":[{"name":"Rebuild Boss","folder":"'"$PROJ"'","argv":["sh","-lc","pi"]}]}'
spaces '{"spaces":[]}'
clear_log
run "$GUARD" --once --space rebuild
case $(herdr) in
*"do space.new --name rebuild --folder $PROJ --tab Rebuild Boss --argv [\"sh\",\"-lc\",\"pi\"]"*)
	pass 'space.new is given the name and the argv the record kept'
	;;
*) fail 'the rebuild did not use the recorded name and argv' "$(herdr)" ;;
esac
if grep -qF 'do tab.new --name Rebuild Boss' "$HERDR_LOG"; then
	fail 'the Boss tab was opened twice'
else
	pass 'space.new makes it, so it is not opened a second time'
fi

new_case '--dry-run names the Boss tab, and calls no app'
make_record dry dry "$PROJ" '{"boss":"Captain","tabs":[{"name":"Captain","folder":"'"$PROJ"'","argv":[]}]}'
clear_log
run "$GUARD" --once --dry-run
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the dry run failed' "$OUT"; fi
case $OUT in
*"dry-run"*"Boss tab 'Captain'"*) pass 'the line names the Boss tab by its name' ;;
*) fail 'the dry-run line does not name the Boss tab' "$OUT" ;;
esac
# `ls` is a question and a dry run may ask it; an action would be a line in the action log.
if [ -s "$HERDR_LOG" ]; then fail 'the dry run opened something' "$(herdr)"; else pass 'no space.new and no tab.new'; fi

printf '\n%s: %d passed, %d failed\n' "${0##*/}" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
