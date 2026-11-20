#!/usr/bin/env bash
# Tests for bin/guard — the supervisor that puts a recorded space back.
#
# Why these exist: a space outlives the terminals in it (`state/spaces/<slug>/space.json`), so the
# record is only worth having if something makes it true again after a space, a tab or a reboot
# takes the terminals away. That something is bin/guard, and every promise it makes is visible in
# the argv a stub herdr-app saw and in the one log line per action — so that is what is checked
# here: the space is rebuilt from the record (never from a new name or folder), a missing Boss tab
# comes back from its resume entry, a Boss tab that is there is left alone, a worker's tab is never
# rebuilt, a space whose folder is gone is refused with the command that fixes it, a forgotten space
# is not recreated, --dry-run calls no app at all, --once exits, and nothing is ever closed or
# renamed. No network, no desktop app, nothing written outside $WORK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$ROOT/bin/guard"
[ -x "$GUARD" ] || {
	printf 'FATAL: %s is not executable\n' "$GUARD" >&2
	exit 1
}
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
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub" "$WORK/resume"
PATH="$WORK/stub:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
# `ls` is a question, not an action: it goes to its own file so "herdr-app was not called at all"
# is a fact about both files rather than a grep that has to exclude the question.
export HERDR_LS_LOG="$WORK/herdr-ls.log"
export HC_LOG="$WORK/hc.log"
export HERDR_SPACES="$WORK/spaces.json"
export PI_HERDR_RESUME_DIR="$WORK/resume"
# One resume script for the whole run: a stub that answers the one line the guard looks for, so the
# test proves the tool is called and never runs the real one against this machine's sessions.
cat >"$WORK/stub/herdr-resume.mjs" <<'STUB'
#!/usr/bin/env node
console.log("restored terminal t9 (from a stub): exec sh --session /tmp/x.jsonl");
STUB
export PI_GUARD_RESUME_SCRIPT="$WORK/stub/herdr-resume.mjs"

# herdr-app: the two calls that make a space or a tab answer with ids, `ls` answers whatever the
# case put in $HERDR_SPACES, and every argv is written down so the assertions can read it back.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"ls "*) printf '%s\n' "$*" >>"$HERDR_LS_LOG" ;;
*) printf '%s\n' "$*" >>"$HERDR_LOG" ;;
esac
case "$1 $2" in
"do space.new") printf '{"space":"s1","tab":"tb-boss","pane":"p1","terminal":"t-boss"}\n' ;;
"do tab.new")
	printf '{"space":"s1","tab":"tb9","pane":"p9","terminal":"t9"}\n'
	;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
# hc: never expected to be asked anything by the guard itself. A line here is a fail below.
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HC_LOG"
printf '{}\n'
STUB
chmod +x "$WORK/stub/"*

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
sd() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1"; }
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }
herdr() { cat "$HERDR_LOG" 2>/dev/null || true; }
asked_nothing() { [ -s "$HERDR_LOG" ] || [ -s "$HERDR_LS_LOG" ]; }
clear_log() { : >"$HERDR_LOG"; : >"$HERDR_LS_LOG"; : >"$HC_LOG"; }

PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"
export PROJ

# A record the way `bin/space new` writes it, plus the `tabs` list the supervisor maintains.
make_record() { # <slug> <name> <project> <id>
	node -e '
		const fs = require("fs"), [dir, name, project, id] = process.argv.slice(1);
		fs.mkdirSync(dir + "/reports", { recursive: true });
		const rec = {
			name, id, project, git: false, remote: "", created: "2026-01-01T00:00:00.000Z",
			uberboss_tab: "Boss", terminals: [id ? "t-" + name : ""].filter(Boolean),
			tabs: [{ name: "Boss", folder: project, argv: [] }],
		};
		fs.writeFileSync(dir + "/space.json", JSON.stringify(rec, null, 2) + "\n");
	' "$(sd "$1")" "$2" "$3" "$4"
}
set_tabs() { # <slug> <tabs-json>
	TABS="$2" node -e '
		const fs = require("fs");
		const file = process.argv[1];
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		j.tabs = JSON.parse(process.env.TABS);
		fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
	' "$(record "$1")"
}
worker() { # <slug> <worker> <report?>
	node -e '
		const fs = require("fs"), [dir, slug, hasReport] = process.argv.slice(1);
		const rec = { slug, kind: "tab", space: "s1", spaceName: slug, tab: "tb2", pane: "p2", terminal: "t2" };
		fs.writeFileSync(dir + "/delegations.json", JSON.stringify({ [slug]: rec }, null, 2) + "\n");
		if (hasReport === "report") fs.writeFileSync(dir + "/reports/" + slug + ".md", "Mission: a fixture\n");
	' "$(sd "$1")" "$2" "${3:-}"
}
spaces() { printf '%s\n' "$1" >"$HERDR_SPACES"; }
resume_entry() { # <terminal> <session>
	node -e '
		const fs = require("fs"), [dir, terminal, session] = process.argv.slice(1);
		fs.writeFileSync(dir + "/" + terminal + ".json", JSON.stringify({
			version: 1, terminal, session_path: session, cwd: process.env.PROJ,
			argv: ["/bin/sh", "-lc", "pi"], updated_at: "2026-01-02T00:00:00.000Z",
		}, null, 2) + "\n");
	' "$PI_HERDR_RESUME_DIR" "$1" "$2"
}

# ------------------------------------------------- the space is gone: rebuild it --
new_case 'a space herdr no longer lists is rebuilt from its record'
make_record demo demo "$PROJ" s-boss
worker demo w1 report
set_tabs demo "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]},{\"name\":\"logs\",\"folder\":\"$PROJ\",\"argv\":[\"sh\",\"-lc\",\"date\"]}]"
spaces '{"spaces":[{"id":"s-x","name":"other","tabs":[]}]}'
clear_log
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
case $(herdr) in
*"do space.new --name demo --folder $PROJ --tab Boss"*) pass 'space.new is called with the recorded name, folder and Boss tab name' ;;
*) fail 'the space was not rebuilt from the record' "$(herdr)" ;;
esac
case $(herdr) in
*"do tab.new --name logs --space s1 --folder $PROJ --argv [\"sh\",\"-lc\",\"date\"]"*)
	pass 'the extra recorded tab is opened with its own folder and argv'
	;;
*) fail 'the recorded extra tab was not opened' "$(herdr)" ;;
esac
if printf '%s\n' "$OUT" | grep -qF 'guard: harness: space gone, recreating with 2 tabs'; then
	pass 'one line says how many tabs it rebuilt'
else
	fail 'the rebuild line is missing or miscounts' "$OUT"
fi
if grep -qF 'do tab.new --name Boss' "$HERDR_LOG"; then
	fail 'the Boss tab was opened twice: space.new already made it' "$(herdr)"
else
	pass 'the Boss tab is made by space.new, not a second time'
fi
if grep -qE 'do tab\.new --name (w1) ' "$HERDR_LOG"; then
	fail "a worker's tab was recreated" "$(herdr)"
else
	pass "a worker's tab is never recreated"
fi
if node -e 'const j=require(process.argv[1]);process.exit(Array.isArray(j.tabs)&&j.tabs.length?0:1)' "$(record demo)"; then
	pass 'the record still lists its tabs'
else
	fail 'the record lost its tabs list' "$(cat "$(record demo)")"
fi

# ------------------------------------------ the space is there, the Boss tab is not --
new_case 'a missing Boss tab is respawned with the session its terminal recorded'
SESSION="$WORK/session.jsonl"
printf '{}\n' >"$SESSION"
PROJ="$PROJ" resume_entry t-demo "$SESSION"
spaces '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-other","name":"other"}]}]}'
clear_log
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
case $(herdr) in
*"do tab.new --name Boss --space s-boss --folder $PROJ --argv [\"/bin/sh\",\"-lc\",\"pi\",\"--session\",\"$SESSION\"]"*)
	pass 'the tab is started from the entry argv plus --session, in the recorded space id'
	;;
*) fail 'the Boss tab was not respawned from its resume entry' "$(herdr)" ;;
esac
if printf '%s\n' "$OUT" | grep -qF "guard: harness: Boss tab resumed from session $SESSION"; then
	pass 'the log names the session it resumed'
else
	fail 'the resume line is missing' "$OUT"
fi
if grep -qF 'do space.new' "$HERDR_LOG"; then
	fail 'the space was rebuilt although it exists' "$(herdr)"
else
	pass 'a space that is there is never rebuilt'
fi

# --------------------------------------------------------- a live Boss tab is left alone --
new_case 'a Boss tab that is there is left alone, entry or no entry'
spaces '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-boss","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail 'herdr-app was asked to do something to a live space' "$(herdr)"; else pass 'nothing was opened'; fi
if [ -s "$HC_LOG" ]; then fail 'a terminal was typed into' "$(cat "$HC_LOG")"; else pass 'nothing was typed into any tab'; fi

# -------------------------------------------------- a space renamed in the app is the same space --
new_case 'a space renamed in herdr is found by its id instead of being built again'
spaces '{"spaces":[{"id":"s-boss","name":"Renamed by hand","tabs":[{"id":"tb-boss","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once
if [ -s "$HERDR_LOG" ]; then
	fail 'the renamed space was rebuilt: two spaces for one project' "$(herdr)"
else
	pass 'the id in the record found the space its name no longer does'
fi

# --------------------------------------------------------- a worker's tab stays closed --
new_case 'a worker tab that is gone is not recreated, even when the record names it'
set_tabs demo "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]},{\"name\":\"w1\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-boss","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once
if [ -s "$HERDR_LOG" ]; then fail 'a finished worker tab came back' "$(herdr)"; else pass 'no tab was opened for the worker'; fi
if [ -f "$(sd demo)/reports/w1.md" ]; then pass 'the worker had already reported, which is why its tab stays closed'; else fail 'the fixture has no report'; fi

# ------------------------------------------------------------ the project folder is gone --
new_case 'a space whose project folder is gone is skipped with the command that fixes it'
make_record vanished vanished "$WORK/vamoosed" s-vanished
clear_log
run "$GUARD" --once --space vanished
if [ -s "$HERDR_LOG" ]; then fail 'herdr-app was asked to build a space on a folder that is gone' "$(herdr)"; else pass 'no space was created'; fi
if printf '%s\n' "$OUT" | grep -qF 'guard: vanished: project folder is gone, skipped'; then
	pass 'the refusal names the space'
else
	fail 'the refusal does not name the space' "$OUT"
fi
if printf '%s\n' "$OUT" | grep -qF 'bin/space forget vanished'; then
	pass 'the refusal carries the command that forgets it'
else
	fail 'the refusal names no way out' "$OUT"
fi

# ------------------------------------------------------------- a forgotten space stays gone --
new_case 'a space with no record is never recreated'
spaces '{"spaces":[{"id":"s-scratch","name":"scratch","tabs":[]}]}'
clear_log
run "$GUARD" --once --space ghost
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail 'a space nobody recorded was created' "$(herdr)"; else pass 'nothing was created from a missing record'; fi
if printf '%s\n' "$OUT" | grep -qF 'ghost: no record'; then pass 'the screen says why it was left alone'; else fail 'no line about the forgotten space' "$OUT"; fi
run "$GUARD" --once
if grep -qF '"scratch"' "$HERDR_LOG"; then fail "herdr's own scratch space was touched" "$(herdr)"; else pass 'a space in herdr with no record is not supervised'; fi

# ------------------------------------------------------------------------- --dry-run --
new_case '--dry-run calls no herdr-app at all'
clear_log
run "$GUARD" --once --dry-run
if [ "$RC" -eq 0 ]; then pass 'the dry pass exits 0'; else fail 'the dry pass failed' "$OUT"; fi
if asked_nothing; then pass 'herdr-app was never called'; else fail 'herdr-app was called in a dry run' "$(herdr)" "$(cat "$HERDR_LS_LOG")"; fi
if printf '%s\n' "$OUT" | grep -qF 'dry-run'; then pass 'the plan is printed'; else fail 'a dry run says nothing' "$OUT"; fi

# ----------------------------------------------------------------- env -i, with only PATH and HOME --
new_case 'it runs under env -i with only PATH and HOME'
mkdir -p "$WORK/min"
for tool in node bash cat date dirname readlink sleep grep sed printf mkdir; do
	real=$(command -v "$tool" 2>/dev/null) || continue
	ln -sf "$real" "$WORK/min/$tool" 2>/dev/null || true
done
ln -sf "$WORK/stub/herdr-app" "$WORK/min/herdr-app"
make_record plain plain "$PROJ" s-plain
spaces '{"spaces":[]}'
: >"$HERDR_LOG"
OUT=$(timeout 60 env -i PATH="$WORK/min:$WORK/stub:/usr/bin:/bin" HOME="$HOME" PI_SPACE_ROOT="$PI_SPACE_ROOT" \
	HERDR_LOG="$HERDR_LOG" HERDR_LS_LOG="$HERDR_LS_LOG" HERDR_SPACES="$HERDR_SPACES" PI_HERDR_RESUME_DIR="$PI_HERDR_RESUME_DIR" \
	PI_GUARD_RESUME_SCRIPT="$PI_GUARD_RESUME_SCRIPT" "$GUARD" --once 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'a pass with no inherited environment exits 0'; else fail 'the pass needs more than PATH and HOME' "$OUT"; fi
if printf '%s\n' "$OUT" | grep -qF 'space gone, recreating'; then pass 'it rebuilt the space with nothing but PATH and HOME'; else fail 'nothing was rebuilt' "$OUT"; fi
if printf '%s\n' "$OUT" | grep -qF 'herdr-resume restored 1 session(s)'; then
	pass 'the resume script is called after a rebuild, and its restore is reported'
else
	fail 'the resume script was not called after a rebuild' "$OUT"
fi

# ------------------------------------------------------------------------- --once exits --
new_case '--once runs one pass and exits'
START=$SECONDS
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'it exits 0'; else fail 'it did not exit clean' "$OUT"; fi
[ $((SECONDS - START)) -le 20 ] && pass 'it did not start looping' || fail 'the pass took over 20 seconds'

# ------------------------------------------------------------------ never closes or renames --
new_case 'nothing is ever closed, renamed or moved'
if grep -qE 'space\.close|tab\.close|space\.move|\.rename|--rename' "$HERDR_LOG"; then
	fail 'the guard asked herdr to remove or rename something' "$(grep -E 'close|rename|move' "$HERDR_LOG")"
else
	pass 'no close, no rename, no move in any argv herdr-app saw'
fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
