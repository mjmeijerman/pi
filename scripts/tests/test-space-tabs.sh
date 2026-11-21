#!/usr/bin/env bash
# Tests for a worker arriving as a tab in the space that asked for it.
#
# Why these exist: a space is one project and a worker was one space of its own. A worker that is
# now a tab is only worth the change if three things hold — `spawn` opens the tab in the space's
# id and never makes a space, `close` closes that tab and never the space (a finished worker must
# not take the boss's desk with it), and a record from before the change still closes the space it
# was started under. All three are visible in the argv the stub host records, so all three are
# checked here: no network, no real herdr-app, nothing written outside $WORK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
DELEGATE="$ROOT/bin/delegate"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/state"
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export GH_LOG="$WORK/gh.log"
export PF_LOG="$WORK/preflight.log"
export DELEGATE_POLL_SECONDS=0

# herdr-app: the two things that make a space or a tab answer with ids, the two closes are quiet,
# and `ls` answers whatever the case put in HERDR_SPACES (by default: nothing listed, so a close
# that herdr no longer lists is a close this side can confirm).
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"s-boss","tab":"tb-boss","pane":"p-boss","terminal":"t-boss"}\n' ;;
"do tab.new") printf '{"space":"s-boss","tab":"tb2","pane":"p2","terminal":"t2"}\n' ;;
"do space.close") printf '{}\n' ;;
"do tab.close") printf '{}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
# hc: the boss's terminal is always listed; the worker terminals come from $HC_TERMS, so one case
# can say "w1 is still running" and the next can say "it is gone".
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
ls)
	printf '{"terminals":[{"id":"t-boss","state":"idle"}'
	if [ -f "${HC_TERMS:-/nonexistent}" ]; then
		while IFS= read -r t; do [ -n "$t" ] && printf ',{"id":"%s","state":"idle"}' "$t"; done <"$HC_TERMS"
	fi
	printf ']}\n'
	;;
read) printf 'escape interrupt\n' ;;
send) exit 0 ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
printf '[]\n'
STUB
cat >"$PI_SPACE_ROOT/bin/jev" <<'STUB'
#!/usr/bin/env bash
case "$1" in
plan) printf '{"mode":"bare","route":"remote","thinking":"medium","reason":"stub jev","answered":{"mode":"bare","route":"remote","thinking":"medium"}}\n' ;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$PF_LOG"\nexit 0\n' >"$PI_SPACE_ROOT/bin/preflight"
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-bare"
# A non-git space publishes nothing, but `finish` still asks whether publish could run before it
# takes that branch, so the program is here and never called.
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/publish"
# `finish` runs the programs in the tree it lives in (bin/preflight, bin/publish), never whichever
# copies PATH happens to hold, so the harness under test is a copy of that tree beside the stubs —
# the layout a real install has, where $PI_BOSS_ROOT/bin is the delegate's own bin.
cp "$ROOT/bin/delegate" "$ROOT/bin/space-lib.sh" "$PI_SPACE_ROOT/bin/"
DELEGATE="$PI_SPACE_ROOT/bin/delegate"
chmod +x "$WORK/stub/"* "$PI_SPACE_ROOT/bin/"*

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
run() { OUT=$("$@" 2>&1); RC=$?; }
sd() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1"; }
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }

PROJ="$WORK/proj"
OTHER="$WORK/other"
STRAY="$WORK/stray"
for d in "$PROJ" "$OTHER" "$STRAY"; do mkdir -p "$d"; printf 'x\n' >"$d/a.txt"; done
"$SPACE" new --name demo --project "$PROJ" >/dev/null
"$SPACE" new --name other --project "$OTHER" >/dev/null
: >"$HERDR_LOG"

# ------------------------------------------------ spawn opens a tab, never a space --
new_case 'a spawn in a space opens a tab in it'
run "$DELEGATE" spawn w1 --cwd "$PROJ" "write one line in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
TABLINE=$(grep -F 'do tab.new' "$HERDR_LOG" | head -n 1)
if [ -n "$TABLINE" ]; then pass 'tab.new is what opens the worker'; else fail 'tab.new was never called' "$(cat "$HERDR_LOG")"; fi
case $TABLINE in
*"--space s-boss"*) pass 'it names the space by its herdr id' ;;
*) fail 'tab.new does not name the space id' "$TABLINE" ;;
esac
case $TABLINE in
*"--focus false"*) pass 'it does not take the person off what they were reading' ;;
*) fail 'tab.new would show the new tab' "$TABLINE" ;;
esac
case $TABLINE in
*"--name w1"*) pass 'the tab is named after the worker' ;;
*) fail 'the tab is not named after the worker' "$TABLINE" ;;
esac
if grep -qF 'do space.new' "$HERDR_LOG"; then
	fail 'spawn still makes a space of its own' "$(cat "$HERDR_LOG")"
else
	pass 'spawn never calls space.new'
fi
if grep -q '"kind": "tab"' "$(sd demo)/delegations.json"; then pass 'the record says the worker is a tab'; else fail 'the record does not say tab' "$(cat "$(sd demo)/delegations.json" 2>/dev/null)"; fi
if grep -q '"space": "s-boss"' "$(sd demo)/delegations.json"; then pass 'the record keeps the space it sits in'; else fail 'the record lost the space' "$(cat "$(sd demo)/delegations.json")"; fi

new_case 'list prints the space and the tab'
run "$DELEGATE" list
if printf '%s\n' "$OUT" | grep -q '^w1 .*s-boss/tb2'; then pass 'the row carries the tab, and the space it is in'; else fail 'the row hides which tab the worker is' "$OUT"; fi

# ---------------------------------------------------- one live worker is still one --
new_case 'a space with a live worker refuses a second spawn, before any tab'
printf 't2\n' >"$WORK/terms"
HC_TERMS="$WORK/terms"; export HC_TERMS
: >"$HERDR_LOG"
run "$DELEGATE" spawn w2 --space demo --cwd "$PROJ" "write two lines in a.txt"
if [ "$RC" -ne 0 ]; then pass 'the second spawn is refused'; else fail 'two workers were allowed in one space' "$OUT"; fi
case $OUT in
*"already has a live worker: w1"*) pass 'the refusal names the live worker' ;;
*) fail 'the refusal does not name the live worker' "$OUT" ;;
esac
if grep -qF 'do tab.new' "$HERDR_LOG"; then fail 'a tab was opened for a refused spawn' "$(cat "$HERDR_LOG")"; else pass 'no tab was opened'; fi
printf '' >"$WORK/terms"

# ------------------------------------------- --space against another space's folder --
new_case '--space that contradicts the folder is refused, naming both'
: >"$HERDR_LOG"
run "$DELEGATE" spawn w3 --space other --cwd "$PROJ" "write three lines in a.txt"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a worker was started in a space that does not own the folder' "$OUT"; fi
case $OUT in
*"--space other"*"--cwd $PROJ"*"belongs to space demo"*)
	pass 'the refusal names the space asked for, the folder and the space that owns it'
	;;
*) fail 'the refusal does not name both sides' "$OUT" ;;
esac
if grep -qF 'do tab.new' "$HERDR_LOG"; then fail 'a tab was opened for a refused spawn' "$(cat "$HERDR_LOG")"; else pass 'no tab was opened'; fi

# --------------------------------------------------- a record from before the id field --
new_case 'a space record with no herdr id is filled in from herdr by name'
printf '{"spaces":[{"id":"s-other","name":"other","tabs":[]}]}\n' >"$WORK/spaces.json"
HERDR_SPACES="$WORK/spaces.json"; export HERDR_SPACES
node -e '
	const fs=require("fs");const f=process.argv[1];
	const j=JSON.parse(fs.readFileSync(f,"utf8"));delete j.id;
	fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' "$(record other)"
: >"$HERDR_LOG"
run "$DELEGATE" spawn w9 --space other --cwd "$STRAY" "write nine lines in a.txt"
unset HERDR_SPACES
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
if grep -q '"id": "s-other"' "$(record other)"; then pass 'the id is written into the record'; else fail 'the record still has no id' "$(cat "$(record other)")"; fi
if grep -qF 'tab.new' "$HERDR_LOG" && grep -qF -- '--space s-other' "$HERDR_LOG"; then
	pass 'the tab was opened in the id herdr gave'
else
	fail 'the tab was not opened in the space herdr named' "$(cat "$HERDR_LOG")"
fi
if grep -q '"project"' "$(record other)"; then pass 'the rest of the record is untouched'; else fail 'the migration rewrote the record' "$(cat "$(record other)")"; fi

# ------------------------------------------------------------- close closes the tab --
report() {
	local file=$1
	cat >"$file" <<'REPORT'
Mission: the person can close a finished worker without their own space going with it

Review tier: Low

Test change: none: no test file changed

## Evidence

Command: `true`

Output (last 20 lines):

```
```

Commit: none — this project has no git; the change is in the folder
REPORT
}

new_case 'close on a tab worker closes the tab and never the space'
report "$(sd demo)/reports/w1.md"
printf 't2\n' >"$WORK/terms"
HC_TERMS="$WORK/terms"; export HC_TERMS
printf '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-boss"}]}]}\n' >"$WORK/spaces.json"
HERDR_SPACES="$WORK/spaces.json"; export HERDR_SPACES
: >"$HERDR_LOG"
run "$DELEGATE" finish w1
unset HERDR_SPACES
if [ "$RC" -eq 0 ]; then pass 'the worker closes'; else fail 'the close was refused' "$OUT"; fi
if grep -qF 'do tab.close --id tb2' "$HERDR_LOG"; then pass 'tab.close closed the worker tab'; else fail 'the worker tab was not closed' "$(cat "$HERDR_LOG")"; fi
if grep -qF 'do space.close' "$HERDR_LOG"; then
	fail 'space.close was called: a finished worker could take the space with it' "$(cat "$HERDR_LOG")"
else
	pass 'the space is never closed'
fi
if grep -qF '"tb-boss"' "$HERDR_LOG"; then fail 'the Boss tab was closed' "$(cat "$HERDR_LOG")"; else pass 'the Boss tab is left alone'; fi

# --------------------------------------------- a record from before workers were tabs --
new_case 'an old space-kind record still closes its space'
mkdir -p "$(sd other)/reports" "$(sd other)/specs"
printf '# Worker oldw\n\nMission: test fixture\n' >"$(sd other)/specs/oldw.md"
report "$(sd other)/reports/oldw.md"
OWN=$(cd "$OTHER" && pwd)
OLDW=oldw SPEC=oldw CWD=$OWN DIR=$(sd other) node -e '
	const fs=require("fs");const file=process.argv[1];
	let j={};try{j=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
	// Written by hand, the way an older spawn wrote it: no kind, and a space of its own.
	j.oldw={slug:"oldw",space:"s-old",tab:"tbold",terminal:"t-old",cwd:process.env.CWD,mode:"bare",
		thinking:"medium",spec:process.env.DIR+"/specs/oldw.md",report:process.env.DIR+"/reports/oldw.md"};
	fs.writeFileSync(file,JSON.stringify(j,null,2)+"\n");' "$(sd other)/delegations.json"
: >"$HERDR_LOG"
run "$DELEGATE" finish oldw
if [ "$RC" -eq 0 ]; then pass 'the worker closes'; else fail 'the close was refused' "$OUT"; fi
if grep -qF 'do space.close --id s-old' "$HERDR_LOG"; then pass 'space.close closed the space it owned'; else fail 'its space was not closed' "$(cat "$HERDR_LOG")"; fi
if grep -qF 'do tab.close' "$HERDR_LOG"; then
	fail 'a tab was closed for a space-kind record' "$(cat "$HERDR_LOG")"
else
	pass 'no tab is touched for a space-kind record'
fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
