#!/usr/bin/env bash
# Tests for `bin/delegate tell <slug> "<text>"` — the one message into a running worker's own
# terminal, the other half of a refused `delegate finish`.
#
# Why these exist: a `finish` stops at a failing preflight and leaves the worker open, and the fix
# belongs in that worker's tab. Before `tell`, the only way to put a line there was for the person to
# type it, so the loop ended at the boss's screen. The refusals matter as much as the send: a worker
# whose report is written has its tab closed by rule, so a message sent there lands nowhere and
# proves nothing, and a slug nothing tracks has nothing to send to at all.
#
#   1. a slug nothing tracks is refused, and nothing is sent;
#   2. a working worker gets the text on its own terminal, the state word is printed, and the send
#      is on the record in state/decisions.jsonl;
#   3. a worker whose report is written is refused with the word `reported`, and nothing is sent;
#   4. a tell with no text is refused with its usage;
#   5. a record with no terminal is refused, naming that, rather than sending into nothing.
#
# No network, no desktop app, nothing written outside $WORK. Set PI_TELL_DELEGATE to another
# `bin/delegate` (trunk's) to run the same cases against older code, which is how the report shows a
# case failing before the fix.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE=${PI_TELL_DELEGATE:-$ROOT/bin/delegate}
[ -x "$DELEGATE" ] || {
	printf 'FATAL: %s is not executable\n' "$DELEGATE" >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	printf 'FATAL: node is not on PATH\n' >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
mkdir -p "$HOME" "$WORK/stub" "$PI_SPACE_ROOT/state/spaces/demo/specs" \
	"$PI_SPACE_ROOT/state/spaces/demo/reports" "$PI_SPACE_ROOT/state/spaces/demo/state"

# Two stubs, and both are the fixture: `hc` logs the send so a case can say whether one happened,
# and `hc ls` answers nothing, so herdr is a herdr this side cannot see and the record's own state
# stands — which is how a record with no report reads as `working`.
cat >"$WORK/stub/hc" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$WORK/hc.log"
exit 0
STUB
chmod +x "$WORK/stub/hc"
export PATH="$WORK/stub:$PATH"

SD="$PI_SPACE_ROOT/state/spaces/demo"
SPEC="$SD/specs/w1.md"
REPORT="$SD/reports/w1.md"
DECISIONS="$SD/state/decisions.jsonl"
# The row lands under the space the record selects when the space has a record of its own, and under
# the tree's own state when it does not: this fixture is a record folder, so both are read.
decisions_file() {
	if [ -f "$DECISIONS" ]; then printf '%s' "$DECISIONS"; else printf '%s' "$PI_SPACE_ROOT/state/decisions.jsonl"; fi
}
printf '# Worker w1\n\nMission: test fixture\n' >"$SPEC"

write_record() { # [terminal]
	cat >"$SD/delegations.json" <<JSON
{"w1":{"slug":"w1","kind":"tab","space":"sp1","spaceName":"demo","tab":"tb1","terminal":"${1:-t1}","cwd":"$WORK","mode":"sandboxed","thinking":"low","spec":"$SPEC","report":"$REPORT"}}
JSON
}

# A report with every required field filled in: the worker is done, so its tab is gone by rule.
cat >"$WORK/finished.md" <<'REPORT'
# Report — w1

Mission: the person can read what the worker found, in one place

Review tier: Low

Test change: none: no test file changed

Now possible: read the finding and decide.

## Evidence

Command: `bin/preflight --slug w1`

Output (last 20 lines):

```
preflight: 0/0 passed on demo in 0s
```
REPORT

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
hc_log() { [ -f "$WORK/hc.log" ] && cat "$WORK/hc.log" || printf ''; }
clear_hc() { rm -f "$WORK/hc.log"; }
clear_report() { rm -f "$REPORT"; }

# ------------------------------------------------ 1. a slug nothing tracks --
new_case 'a slug nothing tracks'
write_record
clear_report
clear_hc
run "$DELEGATE" tell no-such-worker "run preflight again"
if [ "$RC" -ne 0 ]; then pass "it exits $RC, not 0"; else fail 'it exited 0 for a slug nothing tracks'; fi
case $OUT in
*"no such worker"*) pass 'it says there is no such worker' ;;
*) fail 'it does not name the missing worker' "$OUT" ;;
esac
if [ -z "$(hc_log)" ]; then pass 'nothing was sent'; else fail 'it sent something anyway' "$(hc_log)"; fi

# --------------------------------------------- 2. a working worker is told --
new_case 'a working worker'
write_record
clear_report
clear_hc
rm -f "$DECISIONS" "$PI_SPACE_ROOT/state/decisions.jsonl"
run "$DELEGATE" tell w1 "the failing line is bin/delegate: syntax error at line 4"
if [ "$RC" -eq 0 ]; then pass 'it exits 0'; else fail "it exited $RC" "$OUT"; fi
case $OUT in
working*) pass 'it prints the state word working first' ;;
*) fail "it did not print 'working' first" "$OUT" ;;
esac
LOG=$(hc_log)
case $LOG in
*t1*) pass 'the message went to the terminal the record names (t1)' ;;
*) fail 'the terminal id is not in what was sent' "$LOG" ;;
esac
case $LOG in
*"syntax error at line 4"*) pass 'the text arrived whole' ;;
*) fail 'the text did not arrive whole' "$LOG" ;;
esac
if [ -f "$(decisions_file)" ] && grep -q '"command":"tell"' "$(decisions_file)"; then
	pass 'the send is on the record as command=tell'
else
	fail 'no command=tell row in state/decisions.jsonl' "$(cat "$(decisions_file)" 2>/dev/null || printf '<no decisions file>')"
fi

# ------------------------------------- 3. a worker whose report is written --
new_case 'a worker whose report is written'
write_record
cp "$WORK/finished.md" "$REPORT"
clear_hc
run "$DELEGATE" tell w1 "please fix it"
if [ "$RC" -ne 0 ]; then pass "it exits $RC, not 0"; else fail 'it sent to a finished worker'; fi
case $OUT in
reported*) pass 'it prints the word reported first' ;;
*) fail "it did not print 'reported'" "$OUT" ;;
esac
case $OUT in
*"refusing to tell"*) pass 'it refuses in words, not silently' ;;
*) fail 'the refusal is not named' "$OUT" ;;
esac
if [ -z "$(hc_log)" ]; then pass 'nothing was sent'; else fail 'it sent to a closed tab' "$(hc_log)"; fi

# ------------------------------------------------- 4. a tell with no text --
new_case 'a tell with no text'
write_record
clear_report
clear_hc
run "$DELEGATE" tell w1
if [ "$RC" -ne 0 ]; then pass "it exits $RC, not 0"; else fail 'it accepted an empty message'; fi
case $OUT in
*"delegate tell w1"*) pass 'it prints the usage' ;;
*) fail 'the usage is not in the refusal' "$OUT" ;;
esac
if [ -z "$(hc_log)" ]; then pass 'nothing was sent'; else fail 'it sent an empty message' "$(hc_log)"; fi

# ------------------------------------------- 5. a record with no terminal --
new_case 'a record with no terminal'
cat >"$SD/delegations.json" <<JSON
{"w1":{"slug":"w1","kind":"tab","space":"sp1","spaceName":"demo","tab":"tb1","terminal":"","cwd":"$WORK","mode":"sandboxed","thinking":"low","spec":"$SPEC","report":"$REPORT"}}
JSON
clear_report
clear_hc
run "$DELEGATE" tell w1 "hello"
if [ "$RC" -ne 0 ]; then pass "it exits $RC, not 0"; else fail 'it claimed to send with no terminal'; fi
case $OUT in
*"names no terminal"*) pass 'it says the record names no terminal' ;;
*) fail 'the reason is not named' "$OUT" ;;
esac
if [ -z "$(hc_log)" ]; then pass 'nothing was sent'; else fail 'it sent anyway' "$(hc_log)"; fi

printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
