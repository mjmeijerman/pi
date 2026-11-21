#!/usr/bin/env bash
# Tests for one question: is this live space the one this record means?
#
# Why these exist: a record and the app disagreed about a space's identity, so the guard recreated a
# space that was already there (three log lines a day), and a Boss came back as an empty `pi`
# because the resume entry carried a dead terminal's id. So the rules are checked where they are
# visible — in the record, in the argv a stub `herdr-app` saw, and in the one line per action:
#
#   1. a record whose id disagrees with the live space is adopted, not recreated;
#   2. two records on one folder are told apart by name, and neither is cloned;
#   3. a resume with a terminal the record never had opens the newest session for the folder;
#   4. `space new` writes `bin/pi-bare` and refuses a sandboxed `--argv`;
#   5. a record pointing into the retired `~/big-boss-pi` is rewritten to this tree's `bin/pi-bare`,
#      and nothing is opened twice.
#
# `--dry-run` is checked last: it names what it would do and calls no `space.new`.
#
# No network, no desktop app, nothing written outside $WORK. Set PI_IDENTITY_BIN to another `bin/`
# (trunk's `guard`, `space` and `space-lib.sh`) to run the same cases against older code, which is
# how the report shows a case failing before the fix.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BINDIR=${PI_IDENTITY_BIN:-$ROOT/bin}
GUARD="$BINDIR/guard"
SPACE="$BINDIR/space"
for prog in "$GUARD" "$SPACE"; do
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
# The tree the tools live in: that is where a bare Boss is, and the guard reads its own `..`.
PI_HOME=$(cd -- "$BINDIR/.." && pwd)
BARE="$PI_HOME/bin/pi-bare"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
# The retired checkout is a fixture path, not this machine's: the guard rewrites it, never reads it.
export PI_LEGACY_BOSS_ROOT="$WORK/big-boss-pi"
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub" "$WORK/resume" "$WORK/sessions" "$PI_LEGACY_BOSS_ROOT"
PATH="$WORK/stub:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export HERDR_LS_LOG="$WORK/herdr-ls.log"
export HERDR_SPACES="$WORK/spaces.json"
export PI_HERDR_RESUME_DIR="$WORK/resume"
export PI_SESSIONS_DIR="$WORK/sessions"

# herdr-app: every action is written down, `ls` answers whatever the case put in $HERDR_SPACES.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"ls "*) printf '%s\n' "$*" >>"$HERDR_LS_LOG" ;;
*) printf '%s\n' "$*" >>"$HERDR_LOG" ;;
esac
case "$1 $2" in
"do space.new") printf '{"space":"sp-new","tab":"tb-new","pane":"p-new","terminal":"t-new"}\n' ;;
"do tab.new") printf '{"space":"sp-new","tab":"tb-new","pane":"p-new","terminal":"t-new"}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
# The resume sweep is not what this file checks.
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/stub/herdr-resume.mjs"
chmod +x "$WORK/stub/"*
export PI_GUARD_RESUME_SCRIPT="$WORK/stub/herdr-resume.mjs"

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
clear_log() { : >"$HERDR_LOG"; : >"$HERDR_LS_LOG"; }
spaces() { printf '%s\n' "$1" >"$HERDR_SPACES"; }
field() { # <record> <field> — a scalar or a JSON array, as text
	node -e '
		const fs = require("fs");
		const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		const v = j[process.argv[2]];
		process.stdout.write(Array.isArray(v) ? JSON.stringify(v) : String(v ?? ""));
	' "$1" "$2"
}
tab_argv() { # <record> [tab-name]
	node -e '
		const fs = require("fs");
		const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		const want = process.argv[2] || "Boss";
		const t = (Array.isArray(j.tabs) ? j.tabs : []).find((x) => x && x.name === want);
		process.stdout.write(t ? JSON.stringify(t.argv || []) : "");
	' "$1" "${2:-}"
}
# A record the way `bin/space new` writes it, plus whatever the case adds.
make_record() { # <slug> <name> <project> <id> [extra-json]
	local extra=${5:-}
	[ -n "$extra" ] || extra='{}'
	node -e '
		const fs = require("fs"), [dir, name, project, id, extra] = process.argv.slice(1);
		fs.mkdirSync(dir + "/reports", { recursive: true });
		const rec = Object.assign({
			name, id, project, git: false, remote: "", created: "2026-01-01T00:00:00.000Z",
			boss: "Boss", uberboss_tab: "", terminals: [],
			tabs: [{ name: "Boss", folder: project, argv: [] }],
		}, JSON.parse(extra));
		fs.writeFileSync(dir + "/space.json", JSON.stringify(rec, null, 2) + "\n");
	' "$(sd "$1")" "$2" "$3" "$4" "$extra"
}
# A session file: its own first line carries the `cwd` the guard searches by, and its mtime is the
# only thing that says which one is newest.
mk_session() { # <folder-slug> <file> <cwd> <mtime-epoch>
	local dir="$WORK/sessions/$1"
	mkdir -p "$dir"
	printf '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"%s"}\n' "$3" >"$dir/$2"
	touch -d "@$4" "$dir/$2"
	printf '%s' "$dir/$2"
}
resume_entry() { # <terminal> <space-id> <session> <cwd> <argv-json>
	node -e '
		const fs = require("fs"), [dir, terminal, space, session, cwd, argv] = process.argv.slice(1);
		fs.writeFileSync(dir + "/" + terminal + ".json", JSON.stringify({
			version: 1, terminal, space, session_path: session, cwd,
			argv: JSON.parse(argv), updated_at: "2026-01-02T00:00:00.000Z",
		}, null, 2) + "\n");
	' "$PI_HERDR_RESUME_DIR" "$1" "$2" "$3" "$4" "$5"
}

PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"

# ------------------------------------------- the id disagrees: adopt, never recreate --
new_case 'a record whose id disagrees with the live space is adopted, not recreated'
make_record demo demo "$PROJ" sp-dead
spaces '{"spaces":[{"id":"sp-live","name":"demo","folder":"'"$PROJ"'","tabs":[{"id":"tb-boss","name":"Boss","terminals":[{"terminal":"t9","pane":"p9"}]}]}]}'
clear_log
run "$GUARD" --once --space demo
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if grep -qF 'do space.new' "$HERDR_LOG"; then fail 'the live space was recreated' "$(herdr)"; else pass 'no space.new: the live space is this record'; fi
if grep -qF 'do tab.new' "$HERDR_LOG"; then fail 'a Boss tab was opened into a space whose Boss tab is there' "$(herdr)"; else pass 'no tab.new'; fi
if [ "$(field "$(record demo)" id)" = "sp-live" ]; then pass "herdr's id is what the record now says"; else fail 'the record kept the dead id' "$(cat "$(record demo)")"; fi
if [ "$(field "$(record demo)" uberboss_tab)" = "tb-boss" ]; then pass 'the Boss tab id is adopted too'; else fail 'uberboss_tab was not adopted' "$(cat "$(record demo)")"; fi
if [ "$(field "$(record demo)" terminals)" = '["t9"]' ]; then pass 'the terminals that tab holds are adopted'; else fail 'terminals were not adopted' "$(cat "$(record demo)")"; fi
if printf '%s\n' "$OUT" | grep -qF 'adopted herdr'; then pass 'the log says it adopted'; else fail 'the adoption is not in the log' "$OUT"; fi
clear_log
run "$GUARD" --once --space demo
if [ -s "$HERDR_LOG" ]; then fail 'a second pass opened something' "$(herdr)"; else pass 'a second pass opens nothing'; fi
if printf '%s\n' "$OUT" | grep -qF 'adopted herdr'; then fail 'a second pass adopts again' "$OUT"; else pass 'a record that already agrees is not rewritten again'; fi

# --------------------------------------- two records on one folder: name, never a clone --
new_case 'two records on one folder match by name and neither is cloned'
make_record alpha alpha "$PROJ" sp-alpha-old
make_record beta beta "$PROJ" sp-beta-old
spaces '{"spaces":[{"id":"sp-alpha","name":"alpha","folder":"'"$PROJ"'","tabs":[{"id":"tb-alpha","name":"Boss"}]},{"id":"sp-beta","name":"beta","folder":"'"$PROJ"'","tabs":[{"id":"tb-beta","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if grep -qF 'do space.new' "$HERDR_LOG"; then fail 'one of them was cloned: two spaces for one folder' "$(herdr)"; else pass 'no space.new for either'; fi
if [ "$(field "$(record alpha)" id)" = "sp-alpha" ] && [ "$(field "$(record beta)" id)" = "sp-beta" ]; then
	pass 'each adopted the live space its name matched'
else
	fail 'a record adopted the other one' "$(cat "$(record alpha)")" "$(cat "$(record beta)")"
fi
# The hard half: neither name matches any more and both record ids are stale, so the folder is all
# there is — and it is claimed twice, so it decides nothing and nothing is created.
make_record gamma gamma "$PROJ" sp-gamma-old
spaces '{"spaces":[{"id":"sp-x","name":"one","folder":"'"$PROJ"'","tabs":[]},{"id":"sp-y","name":"two","folder":"'"$PROJ"'","tabs":[]}]}'
clear_log
run "$GUARD" --once --space gamma
if grep -qF 'do space.new' "$HERDR_LOG"; then fail 'a space was cloned onto a folder already claimed twice' "$(herdr)"; else pass 'no clone: a folder two records claim decides nothing'; fi
if printf '%s\n' "$OUT" | grep -qF 'is already open as'; then pass 'the space that is there is named in the log'; else fail 'the log names no space on that folder' "$OUT"; fi

# ----------------------------------------- a new terminal id: the newest session, by folder --
new_case 'a resume with a terminal the record never had opens the newest session for the folder'
OLDER=$(mk_session --proj-bakmark-- 2026-01-01T00-00-00Z_a.jsonl "$PROJ" 1767225600)
NEWER=$(mk_session --proj-bakmark-- 2026-03-01T00-00-00Z_b.jsonl "$PROJ" 1772323200)
# A session from another folder is newer still: cwd is what decides, not the clock alone.
mk_session --proj-elsewhere-- 2026-04-01T00-00-00Z_c.jsonl "$WORK/elsewhere" 1775001600 >/dev/null
make_record resume resume "$PROJ" sp-resume
resume_entry t-old sp-resume "$OLDER" "$PROJ" '["sh","-lc","pi"]'
spaces '{"spaces":[{"id":"sp-resume","name":"resume","folder":"'"$PROJ"'","tabs":[{"id":"tb-other","name":"other"}]}]}'
clear_log
run "$GUARD" --once --space resume
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if grep -qF "do tab.new --name Boss --space sp-resume --folder $PROJ --argv [\"sh\",\"-lc\",\"pi\",\"--session\",\"$NEWER\"]" "$HERDR_LOG"; then
	pass 'the Boss tab is opened on the newest session of the record folder'
else
	fail 'the newest session for the folder was not opened' "$(herdr)"
fi
if printf '%s\n' "$(herdr)" | grep -qF -- "$OLDER"; then
	fail 'the entry terminal id chose the session instead of the folder'
else
	pass 'the stale terminal id does not choose the session'
fi
if [ "$(printf '%s\n' "$(herdr)" | grep -o -- '--session' | wc -l)" -eq 1 ]; then
	pass 'exactly one --session: the argv never carries two'
else
	fail 'the argv carries more than one --session' "$(herdr)"
fi

# ------------------------------------------------- the Boss is bare: space new's default --
new_case 'space new writes pi-bare and refuses a sandboxed --argv'
clear_log
run "$SPACE" new --name bare --project "$PROJ"
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'space new failed' "$OUT"; fi
if [ "$(field "$(record bare)" boss_argv)" = "[\"$BARE\"]" ]; then pass 'the record keeps a bare Boss'; else fail 'the record does not keep a bare Boss' "$(cat "$(record bare)")"; fi
if grep -qF -- "--argv [\"$BARE\"]" "$HERDR_LOG"; then pass 'space.new is asked to open it bare'; else fail 'space.new was not given the bare argv' "$(herdr)"; fi
for sandboxed in "pi" "/home/mark/.pi/bin/pi-sandboxed" "pisandbox"; do
	clear_log
	run "$SPACE" new --name "sand-${sandboxed##*/}" --project "$PROJ" --argv "[\"$sandboxed\"]"
	if [ "$RC" -ne 0 ]; then pass "a sandboxed --argv ('$sandboxed') is refused"; else fail "a sandboxed --argv ('$sandboxed') was accepted"; fi
	if printf '%s\n' "$OUT" | grep -qF "$BARE" && printf '%s\n' "$OUT" | grep -qi 'bare'; then
		pass 'the refusal is one line naming the bare Boss'
	else
		fail 'the refusal does not say what to use' "$OUT"
	fi
	if [ -e "$(record "sand-${sandboxed##*/}")" ]; then fail 'a record was written anyway'; else pass 'no record was written'; fi
	if [ -s "$HERDR_LOG" ]; then fail 'the app was asked to open a space anyway' "$(herdr)"; else pass 'nothing was opened'; fi
done

# ---------------------------- a record from the retired checkout is rewritten, once --
new_case 'a record pointing into the retired checkout is rewritten to this tree, and nothing opens twice'
make_record retired retired "$PROJ" sp-retired \
	"{\"boss_argv\":[\"$PI_LEGACY_BOSS_ROOT/bin/pi-bare\"],\"tabs\":[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[\"$PI_LEGACY_BOSS_ROOT/bin/pi-bare\"]}]}"
spaces '{"spaces":[{"id":"sp-retired","name":"retired","folder":"'"$PROJ"'","tabs":[{"id":"tb-boss","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once --space retired
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ "$(field "$(record retired)" boss_argv)" = "[\"$BARE\"]" ]; then pass 'boss_argv is this tree'"'"'s pi-bare'; else fail 'boss_argv still points at the retired checkout' "$(cat "$(record retired)")"; fi
if [ "$(tab_argv "$(record retired)")" = "[\"$BARE\"]" ]; then pass 'the recorded Boss tab is bare too'; else fail 'the recorded Boss tab was left in the retired checkout' "$(cat "$(record retired)")"; fi
if [ -s "$HERDR_LOG" ]; then fail 'a space whose Boss tab is there had something opened' "$(herdr)"; else pass 'nothing is opened: the rewrite is not a repair'; fi
if [ "$(printf '%s\n' "$OUT" | grep -c 'Boss argv was not bare')" -eq 1 ]; then pass 'it says so, once'; else fail 'the rewrite is said zero or twice' "$OUT"; fi
clear_log
run "$GUARD" --once --space retired
if printf '%s\n' "$OUT" | grep -qF 'Boss argv was not bare'; then fail 'the same rewrite is said again on the next pass' "$OUT"; else pass 'a record that is bare already is left alone'; fi
if [ -s "$HERDR_LOG" ]; then fail 'the second pass opened something' "$(herdr)"; else pass 'the second pass opens nothing'; fi
# bakmark's shape: the sandboxing wrapper written down as `["pi"]`.
make_record wrapped wrapped "$PROJ" sp-wrapped '{"boss_argv":["pi"]}'
spaces '{"spaces":[{"id":"sp-wrapped","name":"wrapped","folder":"'"$PROJ"'","tabs":[{"id":"tb-boss","name":"Boss"}]}]}'
clear_log
run "$GUARD" --once --space wrapped
if [ "$(field "$(record wrapped)" boss_argv)" = "[\"$BARE\"]" ]; then pass 'a record holding ["pi"] is rewritten to the bare Boss'; else fail '["pi"] survived the pass' "$(cat "$(record wrapped)")"; fi
if grep -qF 'do tab.new' "$HERDR_LOG"; then fail 'a tab was opened to fix a record' "$(herdr)"; else pass 'no tab is opened for it'; fi

# ------------------------------------------------------ --dry-run: the plan, no space.new --
new_case '--dry-run names what it would do and calls no space.new'
make_record dry dry "$PROJ" sp-dry
spaces '{"spaces":[]}'
clear_log
run "$GUARD" --once --dry-run
if [ "$RC" -eq 0 ]; then pass 'the dry pass exits 0'; else fail 'the dry pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail 'the dry run opened something' "$(herdr)"; else pass 'no space.new and no tab.new'; fi
if printf '%s\n' "$OUT" | grep -qF 'dry-run'; then pass 'the plan is printed'; else fail 'a dry run says nothing' "$OUT"; fi

printf '\n%s: %d passed, %d failed\n' "${0##*/}" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
