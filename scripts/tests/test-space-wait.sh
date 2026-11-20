#!/usr/bin/env bash
# Tests for `bin/delegate wait --forever` — the boss's loop: poll, say one line, and start the same
# spec again when the terminal died without a report.
#
# Why these exist: spec/space-core.md makes "--forever" the only wait a boss is told to use, and a
# boss that waits forever on a dead worker is the failure this replaces. The restart has to be the
# same work (same slug, same spec, appended not rewritten), it has to stop at three, and it has to
# say what it saw when it stops. All three are observable offline, so all three are here.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
DELEGATE="$ROOT/bin/delegate"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub"
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export HERDR_COUNT="$WORK/herdr.count"
# The loop's real poll is 20 seconds; a test cannot spend a minute watching three restarts.
export DELEGATE_POLL_SECONDS=0

cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"sp1","tab":"tb-boss","pane":"p-boss","terminal":"t-boss"}\n' ;;
"do tab.new")
	n=$(($(cat "$HERDR_COUNT" 2>/dev/null || echo 0) + 1))
	printf '%s' "$n" >"$HERDR_COUNT"
	printf '{"space":"sp1","tab":"tb%s","pane":"p%s","terminal":"tr%s"}\n' "$n" "$n" "$n"
	;;
"do tab.close") printf '{}\n' ;;
"ls "*) printf '{"spaces":[]}\n' ;;
*) printf '{}\n' ;;
esac
STUB
# hc: the worker's terminal is never listed, so every poll reads "gone". $WAIT_REPORT, when set, is
# handed to the report path on the second poll — the case where a restarted worker does report.
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
ls)
	extra=""
	if [ -n "${WAIT_REPORT:-}" ] && [ -n "${WAIT_FILE:-}" ]; then
		n=$(($(cat "$WORK_CALLS" 2>/dev/null || echo 0) + 1))
		printf '%s' "$n" >"$WORK_CALLS"
		# From the second poll the worker is back: its terminal is listed and the report it wrote
		# is on disk, so the loop must read "working", then "reported", and stop.
		if [ "$n" -ge 2 ]; then
			cp "$WAIT_REPORT" "$WAIT_FILE"
			extra=',{"id":"t1","state":"idle"}'
		fi
	fi
	printf '{"terminals":[{"id":"t-boss","state":"idle"}%s]}\n' "$extra"
	;;
read) printf 'escape interrupt\n' ;;
send) exit 0 ;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-bare"
chmod +x "$WORK/stub/"* "$PI_SPACE_ROOT/bin/"*
export WORK_CALLS="$WORK/hc.calls"

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

PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"
"$SPACE" new --name demo --project "$PROJ" >/dev/null
SPEC="$(sd demo)/specs/w1.md"
REPORT="$(sd demo)/reports/w1.md"
mkdir -p "$(sd demo)/specs" "$(sd demo)/reports"
printf '# Worker w1\n\nMission: test fixture\n' >"$SPEC"
printf '# Report — w1\n\nMission: <fill in: who is better off>\n' >"$REPORT"
cat >"$(sd demo)/delegations.json" <<JSON
{"w1":{"slug":"w1","space":"sp1","tab":"tb1","terminal":"t1","cwd":"$PROJ","mode":"bare","thinking":"medium","spec":"$SPEC","report":"$REPORT"}}
JSON

# ------------------------------------------- a dead worker, restarted three times --
new_case 'a worker whose terminal is gone and whose report is a skeleton'
run "$DELEGATE" wait w1 --forever
if [ "$RC" -ne 0 ]; then pass 'it exits non-zero'; else fail 'it reported success' "$OUT"; fi
case $OUT in
*"restarted 3 times"*) pass 'it says it restarted three times' ;;
*) fail 'it does not say how many restarts it tried' "$OUT" ;;
esac
case $OUT in
*"What I saw"*) pass 'it says what it saw' ;;
*) fail 'it does not say what it saw' "$OUT" ;;
esac
RESTARTS=$(grep -c -- '--name w1-r' "$HERDR_LOG")
if [ "$RESTARTS" = 3 ]; then pass 'three tabs were started'; else fail "tab.new ran $RESTARTS times, not 3"; fi
for n in 1 2 3; do
	if grep -q -- "--name w1-r$n" "$HERDR_LOG"; then pass "restart $n is tab w1-r$n"; else fail "restart $n is not named w1-r$n"; fi
done
if [ "$(grep -c '^Restart ' "$SPEC")" = 3 ]; then pass 'the spec records each restart'; else fail 'the spec does not record three restarts'; fi
if grep -q 'Mission: test fixture' "$SPEC"; then pass 'the spec is appended to, not rewritten'; else fail 'the spec lost its original text'; fi
if grep -q '<fill in' "$REPORT"; then pass 'the report is a fresh skeleton'; else fail 'the report was not reset for the restart'; fi
if grep -q '"restarts": 3' "$(sd demo)/delegations.json"; then pass 'the record counts three restarts'; else fail 'the record does not count the restarts' "$(cat "$(sd demo)/delegations.json")"; fi
if grep -q '"restart"' "$PI_SPACE_ROOT/state/decisions.jsonl" 2>/dev/null; then pass 'each restart is in the decision log'; else fail 'no restart decision was recorded'; fi
LINES=$(printf '%s\n' "$OUT" | grep -c 'restart [123]/3')
if [ "$LINES" -ge 3 ]; then pass 'one line per poll'; else fail "poll lines: $LINES" "$OUT"; fi
case $OUT in
*"$(sd demo)/reports/w1.md"*) pass 'the stop message names the report it wanted' ;;
*) fail 'the stop message does not name the report' "$OUT" ;;
esac

# ------------------------------------------------ a restarted worker that reports --
new_case 'a worker that reports after a restart'
: >"$HERDR_LOG"
rm -f "$(sd demo)/delegations.json" "$WORK_CALLS"
printf '# Report — w1\n\nMission: <fill in: who is better off>\n' >"$REPORT"
cat >"$(sd demo)/delegations.json" <<JSON
{"w1":{"slug":"w1","space":"sp1","tab":"tb1","terminal":"t1","cwd":"$PROJ","mode":"bare","thinking":"medium","spec":"$SPEC","report":"$REPORT"}}
JSON
FILLED="$WORK/filled.md"
cat >"$FILLED" <<'REPORT'
Mission: the person can stop waiting, because the report is here

Review tier: Low

Test change: none: no test file changed

## Evidence

Command: `true`

Output (last 20 lines):

```
```

Commit: none — this project has no git; the changed files are named above
REPORT
WAIT_REPORT="$FILLED"
WAIT_FILE="$REPORT"
export WAIT_REPORT WAIT_FILE
run "$DELEGATE" wait w1 --forever
unset WAIT_REPORT WAIT_FILE
if [ "$RC" -eq 0 ]; then pass 'it exits 0 when the report arrives'; else fail 'it failed although the report arrived' "$OUT"; fi
case $OUT in
*"w1 reported"*) pass 'it says the worker reported' ;;
*) fail 'it does not say the worker reported' "$OUT" ;;
esac
case $OUT in
*"the person can stop waiting"*) pass 'it prints the report' ;;
*) fail 'it does not print the report' "$OUT" ;;
esac
case $OUT in
*"delegate finish w1"*) pass 'it names the next command' ;;
*) fail 'it does not name the next command' "$OUT" ;;
esac
if grep -q -- '--name w1-r' "$HERDR_LOG"; then pass 'the restart happened before the report'; else fail 'the restarted worker was never started'; fi

# ------------------------------------------------------- --forever is opt-in --
new_case 'without --forever nothing is restarted'
: >"$HERDR_LOG"
rm -f "$WORK_CALLS"
printf '# Report — w1\n\nMission: <fill in: who is better off>\n' >"$REPORT"
run "$DELEGATE" wait w1 --timeout 1
if [ "$RC" -ne 0 ]; then pass 'it gives up'; else fail 'it claims a report it does not have' "$OUT"; fi
case $OUT in
*"not reported after 1s"*) pass 'it says how long it waited' ;;
*) fail 'it does not say how long it waited' "$OUT"; ;;
esac
if grep -q -- '--name w1-r' "$HERDR_LOG"; then fail 'a worker was restarted without --forever'; else pass 'no worker was restarted'; fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
