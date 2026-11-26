#!/usr/bin/env bash
# Tests for bin/guard — the supervisor that puts a recorded space back.
#
# Why these exist: a space outlives the terminals in it (`state/spaces/<slug>/space.json`), so the
# record is only worth having if something makes it true again after a space, a tab or a reboot
# takes the terminals away. That something is bin/guard, and every promise it makes is visible in
# the argv a stub herdr-app saw and in the one log line per action — so that is what is checked
# here: the space is rebuilt from the record (never from a new name or folder), a missing Boss tab
# comes back bare on the session its resume entry remembers (the entry supplies a session, never a
# command), a Boss tab that is there is left alone, a worker's tab is never
# rebuilt, a space whose folder is gone is refused with the command that fixes it, a forgotten space
# is not recreated, --dry-run calls no app at all, --once exits, and nothing is ever closed or
# renamed. No network, no desktop app, nothing written outside $WORK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$ROOT/bin/guard"
# `bin/space` is what removes a tab's entry from the record; the guard is what rebuilds from it.
SPACE="$ROOT/bin/space"
# The Boss is bare: the argv a resumed Boss tab is opened with starts with this tree's `bin/pi-bare`
# and never with an interpreter a resume entry remembers.
BARE="$ROOT/bin/pi-bare"
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
# hc: answers `get <terminal> --json` from $HC_FACTS_FILE, so a case can say what program is in a
# terminal; a line in $HC_LOG is what the guard asked, and a *write* verb there is a fail below.
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HC_LOG"
if [ -f "${HC_FACTS_FILE:-/nonexistent}" ]; then cat "$HC_FACTS_FILE"; else printf '{}\n'; fi
STUB
export HC_FACTS_FILE="$WORK/hc-facts.json"
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
set_rec() { # <slug> <json-patch-object>
	PATCH="$2" node -e '
		const fs = require("fs");
		const file = process.argv[1];
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		Object.assign(j, JSON.parse(process.env.PATCH));
		fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
	' "$(record "$1")"
}
rec_field() { # <slug> <expr-on-j>  — one value out of a record, for an assertion
	EXPR="$2" node -e '
		const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const v = new Function("j", "return (" + process.env.EXPR + ")")(j);
		process.stdout.write(String(v === undefined || v === null ? "" : v));
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
# hc_facts <terminal> <shell|pi> — what herdr-core says about one terminal: `shell` is the reboot's
# empty Boss (a live plain PowerShell), `pi` a live Boss (node in the foreground, `app: pi`).
hc_facts() {
	node -e '
		const fs = require("fs"), [file, terminal, kind] = process.argv.slice(1);
		const shell = { address: terminal, state: "live", foreground: { argv: ["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"], pid: 16328 } };
		const pi = { address: terminal, state: "live", foreground: { argv: ["node.exe", "C:/pi/cli.js"], pid: 4242 }, status: { app: "pi", state: "idle" } };
		fs.writeFileSync(file, JSON.stringify(kind === "pi" ? pi : shell) + "\n");
	' "$HC_FACTS_FILE" "$1" "$2"
}
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
*"do tab.new --name Boss --space s-boss --folder $PROJ --argv [\"$BARE\",\"--session\",\"$SESSION\"] --focus false"*)
	pass 'the tab is started from this tree'"'"'s pi-bare plus the entry'"'"'s session, in the recorded space id'
	;;
*) fail 'the Boss tab was not respawned bare from its resume entry'"'"'s session' "$(herdr)" ;;
esac
# The entry in this case carries `["/bin/sh","-lc","pi"]`: an interpreter that would sandbox the
# Boss. It decides the session above and nothing else.
if printf '%s\n' "$(herdr)" | grep -qF -- '-lc'; then
	fail 'the entry argv reached the app: the entry decides the session, not the command' "$(herdr)"
else
	pass 'the entry argv never reaches the app'
fi
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
if [ -s "$HC_LOG" ]; then
	if grep -qE '(^| )(send|keys|interrupt|put|kill|rm) ' "$HC_LOG"; then
		fail 'a terminal was written to, not just read' "$(cat "$HC_LOG")"
	else
		pass 'nothing was typed into any tab'
	fi
else pass 'nothing was typed into any tab'; fi

# --------------------------------- the Boss tab is there, and the shell is empty --
# The reboot this whole file is about, in the shape herdr leaves behind: every tab comes back as a
# plain shell *in the same tab*, in the same folder, so the space and the Boss tab both exist and
# the record is satisfied. `herdr-app ls` cannot tell those two apart — it names the app a terminal
# reports and nothing about the program in front of it — so the guard asks herdr-core, and judges
# the answer with the same two witnesses `scripts/herdr-resume.mjs` uses.
new_case 'an empty Boss shell is respawned with the session its terminal recorded'
set_tabs demo "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[],\"terminals\":[\"t-demo\"]}]"
spaces '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-boss","name":"Boss","terminals":[{"terminal":"t-demo"}]}]}]}'
hc_facts t-demo shell
clear_log
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
# The record and the entry are read back rather than rebuilt in the assertion: the fixture writes
# both through node, so on a Windows host they hold the drive-lettered spelling of the same path.
rec_project=$(node -e 'console.log(require(process.argv[1]).project)' "$(record demo)")
entry_session=$(node -e 'console.log(require(process.argv[1]).session_path)' "$PI_HERDR_RESUME_DIR/t-demo.json")
tab_line=$(grep -F 'do tab.new --name Boss --space s-boss ' "$HERDR_LOG" 2>/dev/null | head -n 1)
if [ -n "$tab_line" ]; then pass 'a Boss tab is opened again, in the space the record is in'; else fail 'an empty Boss tab was left an empty shell' "$(herdr)"; fi
if printf '%s' "$tab_line" | grep -qF -- "--folder $rec_project"; then
	pass "the new tab is put in the record's project folder"
else
	fail 'the new tab went somewhere else' "$tab_line"
fi
if printf '%s' "$tab_line" | grep -qF -- "\"--session\",\"$entry_session\""; then
	pass 'it is started on the session the record remembers'
else
	fail 'the session was not carried into the new tab' "$tab_line"
fi
if printf '%s' "$tab_line" | grep -qF 'pi-bare'; then
	pass "the Boss comes back bare, from this tree's pi-bare"
else
	fail 'the new Boss is not bare' "$tab_line"
fi
if printf '%s\n' "$OUT" | grep -qF 'empty shell'; then
	pass 'the line says the tab was a shell, not a Boss'
else
	fail 'the respawn line does not say why it opened a tab' "$OUT"
fi
if grep -qF 'get t-demo' "$HC_LOG"; then
	pass 'the terminal itself was asked what program it holds'
else
	fail 'the guard never asked herdr-core about the Boss tab' "$(cat "$HC_LOG")"
fi
if grep -qE '(^| )(send|keys|interrupt|put) ' "$HC_LOG"; then
	fail 'the guard typed into the empty shell: a tab is opened, a shell is never typed into' "$(cat "$HC_LOG")"
else
	pass 'nothing was typed into the shell it replaced'
fi

new_case 'a Boss tab that has pi in it is left alone'
hc_facts t-demo pi
clear_log
run "$GUARD" --once
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then
	fail 'a Boss that runs was opened a second time: two pi on one session file' "$(herdr)"
else
	pass 'no tab was opened for a Boss that runs'
fi
if printf '%s\n' "$OUT" | grep -qE 'empty shell|nothing says pi'; then
	fail 'a running Boss was reported as empty or unreadable' "$OUT"
else
	pass 'a Boss that runs is reported as nothing at all'
fi

new_case 'a terminal nothing answers for is left alone, and the line says so'
rm -f "$HC_FACTS_FILE"
clear_log
run "$GUARD" --once
if [ -s "$HERDR_LOG" ]; then
	fail 'a guess opened a second Boss tab on the same session file' "$(herdr)"
else
	pass 'no tab was opened on a terminal that did not answer'
fi
if printf '%s\n' "$OUT" | grep -qF 'nothing says pi is in it'; then
	pass 'the line says the tab was left alone and why'
else
	fail 'the refusal is missing: silence and a pass with nothing to do read the same' "$OUT"
fi
if tail -n 20 "$PI_SPACE_ROOT/state/guard.log" 2>/dev/null | grep -qF 'nothing says pi is in it'; then
	pass 'the same line is in state/guard.log, which is all a hidden logon run leaves behind'
else
	fail 'the line never reached state/guard.log' "$(tail -n 5 "$PI_SPACE_ROOT/state/guard.log" 2>/dev/null)"
fi

# ------------------------------------------ the Boss tab was renamed: same tab, new name --
# Measured bug: the record said `Boss`, the tab said `Bakker`, `boss_present` read the name only
# and answered `no`, so the guard opened a second Boss tab and two `pi` appended one session.
new_case 'a renamed Boss tab is adopted by its id, not opened a second time'
make_record renamed renamed "$PROJ" s-renamed
set_rec renamed '{"uberboss_tab":"tb-r1","terminals":["t-r1"]}'
set_tabs renamed "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces "{\"spaces\":[{\"id\":\"s-renamed\",\"name\":\"renamed\",\"tabs\":[{\"id\":\"tb-r1\",\"name\":\"Bakker\",\"terminals\":[\"t-r1\"]}]}]}"
clear_log
run "$GUARD" --once --space renamed
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then
	fail 'a second Boss tab was opened for a renamed tab: two pi appending one session' "$(herdr)"
else
	pass 'no tab was opened: the id named the tab the name did not'
fi
if [ "$(rec_field renamed 'j.boss')" = Bakker ]; then
	pass 'the record adopted the name the tab answers to'
else
	fail 'the record still calls the Boss by its old name' "$(cat "$(record renamed)")"
fi
if [ "$(rec_field renamed '(j.tabs&&j.tabs[0]||{}).name')" = Bakker ]; then
	pass 'tabs[0] carries the adopted name too'
else
	fail 'tabs[0] still names the old tab' "$(cat "$(record renamed)")"
fi
ADOPT_N=$(printf '%s\n' "$OUT" | grep -c 'adopted')
if [ "$ADOPT_N" -eq 1 ]; then pass 'exactly one line says the name was adopted'; else fail "the adoption is $ADOPT_N lines, not one" "$OUT"; fi
# The fixture is gone before the next case: a record left behind is a space the full passes below
# would rebuild, and their `-s $HERDR_LOG` assertions would be reading this case's argv.
rm -rf -- "$(sd renamed)"

# ---------------------------------- a Boss tab the app gave no name: its terminal id answers --
new_case 'a Boss tab with no name is found by the terminal id the record remembers'
make_record noname noname "$PROJ" s-noname
set_rec noname '{"uberboss_tab":"","terminals":["t-n1"]}'
set_tabs noname "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces "{\"spaces\":[{\"id\":\"s-noname\",\"name\":\"noname\",\"tabs\":[{\"id\":\"tb-n1\",\"terminals\":[\"t-n1\"]}]}]}"
clear_log
run "$GUARD" --once --space noname
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then
	fail 'a tab was opened beside the one the terminal id named' "$(herdr)"
else
	pass 'the remembered terminal id found the Boss tab, unnamed or not'
fi
if [ -z "$(rec_field noname 'j.boss')" ]; then
	pass 'a tab with no name adopts nothing'
else
	fail 'the record was renamed from a tab that has no name' "$(cat "$(record noname)")"
fi
rm -rf -- "$(sd noname)"

# ------------------------------------------- two passes in the same second, one Boss tab --
# Both read `no Boss tab` out of the same stale snapshot; only the record lock, taken before
# `tab.new`, tells the second pass that the first one already opened it.
new_case 'two passes in the same second open exactly one Boss tab'
make_record dup dup "$PROJ" s-dup
set_tabs dup "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces "{\"spaces\":[{\"id\":\"s-dup\",\"name\":\"dup\",\"tabs\":[{\"id\":\"tb-other\",\"name\":\"other\"}]}]}"
clear_log
"$GUARD" --once --space dup >"$WORK/dup1.out" 2>&1 &
DUP1=$!
"$GUARD" --once --space dup >"$WORK/dup2.out" 2>&1 &
DUP2=$!
wait "$DUP1"
DUP_RC1=$?
wait "$DUP2"
DUP_RC2=$?
if [ "$DUP_RC1" -eq 0 ] && [ "$DUP_RC2" -eq 0 ]; then pass 'both passes exit 0'; else fail 'a pass failed' "$(cat "$WORK/dup1.out")" "$(cat "$WORK/dup2.out")"; fi
DUP_N=$(grep -c 'do tab.new --name Boss' "$HERDR_LOG" 2>/dev/null || true)
if [ "${DUP_N:-0}" -eq 1 ]; then
	pass 'exactly one tab.new for the Boss tab in the stub log'
else
	fail "$DUP_N Boss tabs were opened in one second" "$(herdr)"
fi
rm -rf -- "$(sd dup)"

# --------------------------------------------- a Boss tab that is genuinely gone comes back --
# The control for the case above: the lock must not turn a dead Boss tab into a permanent absence.
new_case 'a Boss tab that is genuinely gone is still recreated'
make_record gone gone "$PROJ" s-gone
set_tabs gone "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces "{\"spaces\":[{\"id\":\"s-gone\",\"name\":\"gone\",\"tabs\":[{\"id\":\"tb-other\",\"name\":\"other\"}]}]}"
clear_log
run "$GUARD" --once --space gone
if grep -q 'do tab.new --name Boss' "$HERDR_LOG"; then
	pass 'the missing Boss tab was opened'
else
	fail 'a space whose Boss tab is gone came back without one' "$(herdr)" "$OUT"
fi
if [ "$(rec_field gone 'j.boss')" != other ]; then pass 'the name of an unrelated tab was not adopted'; else fail 'a tab that is not the Boss was adopted as it' "$(cat "$(record gone)")"; fi
rm -rf -- "$(sd gone)"

# ------------------------------------------ a claim from an old pass is not evidence of a tab --
new_case 'a claim from an old pass does not keep a dead Boss tab alive'
make_record stale stale "$PROJ" s-stale
set_rec stale '{"boss_claim":{"tab":"tb-old","terminal":"t-old","at":"2020-01-01T00:00:00.000Z"}}'
set_tabs stale "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces "{\"spaces\":[{\"id\":\"s-stale\",\"name\":\"stale\",\"tabs\":[{\"id\":\"tb-x\",\"name\":\"other\"}]}]}"
clear_log
run "$GUARD" --once --space stale
if grep -q 'do tab.new --name Boss' "$HERDR_LOG"; then
	pass 'a stale claim is a moment, not a fact: the Boss tab came back'
else
	fail 'a claim from 2020 kept the Boss tab from being reopened' "$(herdr)" "$OUT"
fi
rm -rf -- "$(sd stale)"

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

# --------------------------------------------- a forgotten tab stays closed --
# The point of `bin/space tab forget`: `tabs[]` is the whole mechanism the guard rebuilds a space
# from, so the entry removed from the record is the tab that stops coming back. The first pass is the
# control — it proves the entry would have been rebuilt — and the second pass is the same reboot
# after the verb, with no `Extra` in it.
new_case 'a tab forgotten from the record is not rebuilt with the space'
make_record forgot1 forgot1 "$PROJ" s-forgot1
set_tabs forgot1 "[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[]},{\"name\":\"Extra\",\"folder\":\"$PROJ\",\"argv\":[]}]"
spaces '{"spaces":[]}'
clear_log
run "$GUARD" --once --space forgot1
if grep -qF -- '--name Extra' "$HERDR_LOG"; then pass 'the control pass rebuilds Extra from the record'; else fail 'the fixture never rebuilt Extra, so the second pass proves nothing' "$(herdr)"; fi
run "$SPACE" tab forget forgot1 Extra
if [ "$RC" -eq 0 ]; then pass 'the verb removes the entry'; else fail 'tab forget failed' "$OUT"; fi
clear_log
run "$GUARD" --once --space forgot1
if grep -qF -- '--name Extra' "$HERDR_LOG"; then fail 'the forgotten tab came back after a reboot' "$(herdr)"; else pass 'the forgotten tab is not re-created'; fi
if grep -qF -- '--tab Boss' "$HERDR_LOG"; then pass 'the Boss tab is still rebuilt, beside it'; else fail 'the space came back without its Boss tab' "$(herdr)"; fi

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

# --------------------------------------- a drive that is not readable gets a watcher, once --
new_case 'a drive that is not readable gets one watcher, not a refusal'
# `X:/` is a drive root by spelling and unreadable wherever this test runs, which is the shape a
# BitLocker volume has at logon. The watcher is the stub below: what is under test is that the
# guard starts exactly one, survives a second pass, and asks herdr for nothing.
WATCH_LOG=$WORK/unlock-watch-calls.log
WATCH_STUB=$WORK/unlock-watch-stub.mjs
cat >"$WATCH_STUB" <<'STUB'
import { appendFileSync } from "node:fs";
appendFileSync(process.env.WATCH_STUB_LOG, `${process.argv.slice(2).join(" ")}\n`);
setInterval(() => {}, 1000);
STUB
make_record watchy watchy 'X:/' s-watchy
clear_log
: >"$WATCH_LOG"
export WATCH_STUB_LOG=$WATCH_LOG
OUT=$(PI_UNLOCK_WATCH_SCRIPT=$WATCH_STUB PI_UNLOCK_WATCH_STATE=$WORK/unlockstate \
	PI_UNLOCK_LOG=$WORK/unlockstate/unlock-watch.log "$GUARD" --once --space watchy 2>&1)
RC=$?
if printf '%s\n' "$OUT" | grep -qF 'guard: watchy: project folder X:/ is not readable yet'; then
	pass 'the pass says the drive is not readable, instead of calling the folder gone'
else
	fail 'a locked drive is still reported as a gone folder' "$OUT"
fi
if printf '%s\n' "$OUT" | grep -qF 'started the unlock watcher'; then pass 'the pass says it started one'; else fail 'the start is not announced' "$OUT"; fi
# The watcher is a detached node process: the pass exits as soon as it is started, so its first
# line is not in the log yet when this line runs — a `-s` check on the file raced node's own
# start and failed in about a millisecond on a loaded machine. Bounded, so a watcher that never
# says anything still fails: the assertion below is unchanged.
waited=0
while [ ! -s "$WATCH_LOG" ] && [ "$waited" -lt 100 ]; do
	sleep 0.02
	waited=$((waited + 1))
done
if [ "$(wc -l <"$WATCH_LOG" | tr -d ' ')" = 1 ]; then pass 'one watcher was started'; else fail "expected one watcher, got $(cat "$WATCH_LOG")"; fi
if grep -qF -- '--space watchy' "$WATCH_LOG"; then pass 'the watcher was told which space to fix'; else fail 'the watcher does not know the space' "$(cat "$WATCH_LOG")"; fi
WATCH_PID_FILE=$WORK/unlockstate/unlock-watch-watchy.pid
WATCH_PID=$(cat "$WATCH_PID_FILE" 2>/dev/null)
if [ -n "$WATCH_PID" ] && kill -0 "$WATCH_PID" 2>/dev/null; then pass 'its pid is recorded, so the next pass can find it'; else fail 'no live pid was written to the pid file' "$(ls -l "$WORK/unlockstate" 2>&1)"; fi
OUT=$(PI_UNLOCK_WATCH_SCRIPT=$WATCH_STUB PI_UNLOCK_WATCH_STATE=$WORK/unlockstate \
	PI_UNLOCK_LOG=$WORK/unlockstate/unlock-watch.log "$GUARD" --once --space watchy 2>&1)
if [ "$(wc -l <"$WATCH_LOG" | tr -d ' ')" = 1 ]; then pass 'a second pass starts no second watcher'; else fail 'a watcher was started twice' "$(cat "$WATCH_LOG")"; fi
if printf '%s\n' "$OUT" | grep -qiF 'already waiting'; then pass 'the second pass says the watcher is already there'; else fail 'the second pass does not say why nothing started' "$OUT"; fi
if [ -s "$HERDR_LOG" ]; then fail 'herdr-app was asked about a space whose drive is locked' "$(herdr)"; else pass 'nothing was opened for a space that cannot be read'; fi
kill "$WATCH_PID" 2>/dev/null
rm -f "$WATCH_PID_FILE"
new_case 'the watcher can be turned off, and says so'
: >"$WATCH_LOG"
OUT=$(PI_GUARD_UNLOCK_WATCH=0 PI_UNLOCK_WATCH_SCRIPT=$WATCH_STUB PI_UNLOCK_WATCH_STATE=$WORK/unlockstate2 \
	PI_UNLOCK_LOG=$WORK/unlockstate2/unlock-watch.log "$GUARD" --once --space watchy 2>&1)
if [ -s "$WATCH_LOG" ]; then fail 'a watcher was started although PI_GUARD_UNLOCK_WATCH=0' "$(cat "$WATCH_LOG")"; else pass 'PI_GUARD_UNLOCK_WATCH=0 starts nothing'; fi
if printf '%s\n' "$OUT" | grep -qF 'PI_GUARD_UNLOCK_WATCH=0'; then pass 'the skipped watcher is explained by name'; else fail 'nothing says why no watcher was started' "$OUT"; fi
unset WATCH_STUB_LOG

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

# -------------------------------------------- a pass with no herdr-app anywhere says so --
# The logon entry runs the guard through a hidden `.vbs`, so stdout goes nowhere: a refusal that is
# only printed is a refusal nobody reads, and the pass used to look identical to one with nothing
# to do. Measured 2026-11-26: with a machine-only PATH the guard printed "herdr-app did not answer"
# (a program that was never even found) and supervised nothing, while the live guard left herdr's
# new space unsupervised for five minutes after the person made it.
new_case 'a pass that cannot find herdr-app logs a refusal instead of doing nothing in silence'
LOG_PATH="$PI_SPACE_ROOT/state/guard.log"
: >"$LOG_PATH"
: >"$HERDR_LOG"
# herdr-app is on the real PATH of this machine: the point of the case is the environment the logon
# task hands over, so the pass gets a PATH with node and bash and no app at all — its own directory,
# because the `env -i` case above puts a stub app in the one it made.
mkdir -p "$WORK/min-nohrdr"
for tool in node bash cat date dirname readlink sleep grep sed printf mkdir; do
	real=$(command -v "$tool" 2>/dev/null) || continue
	ln -sf "$real" "$WORK/min-nohrdr/$tool" 2>/dev/null || true
done
OUT=$(timeout 60 env -i PATH="$WORK/min-nohrdr:/usr/bin:/bin" HOME="$WORK/home" PI_SPACE_ROOT="$PI_SPACE_ROOT" \
	HERDR_LOG="$HERDR_LOG" HERDR_LS_LOG="$HERDR_LS_LOG" HERDR_SPACES="$HERDR_SPACES" \
	PI_HERDR_RESUME_DIR="$PI_HERDR_RESUME_DIR" PI_GUARD_RESUME_SCRIPT="$PI_GUARD_RESUME_SCRIPT" "$GUARD" --once 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'a pass with no app is not an error' "$OUT"; fi
if printf '%s\n' "$OUT" | grep -qF 'herdr-app was not found'; then
	pass 'it says the app was not found, not that a found app did not answer'
else
	fail 'the refusal is missing' "$OUT"
fi
if printf '%s\n' "$OUT" | grep -qF 'PI_GUARD_HERDR_APP'; then
	pass 'the refusal names the variable that fixes it'
else
	fail 'the refusal names no fix' "$OUT"
fi
if tail -n 20 "$LOG_PATH" 2>/dev/null | grep -qF 'herdr-app was not found'; then
	pass 'the same line is in state/guard.log, the only place a hidden run is read'
else
	fail 'the refusal never reached state/guard.log: a hidden logon run has nothing to read' "$(cat "$LOG_PATH" 2>/dev/null)"
fi
if [ -s "$HERDR_LOG" ]; then
	fail 'something was opened although no app was found' "$(cat "$HERDR_LOG")"
else
	pass 'nothing was opened on a pass that could not see any space'
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
