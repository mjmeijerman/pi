#!/usr/bin/env bash
# Tests for the truth of `bin/delegate status` and `bin/delegate wait` about a worker that is still
# working — in particular one a `tell` sent back to work.
#
# Why these exist: seen on this machine with worker `durable-key-ui`. It wrote its report, `delegate
# tell` sent it back to work twice, and while it was editing and running preflight, `delegate status`
# printed `reported` and `delegate wait --forever` returned at once on the old file. The boss then ran
# `delegate finish`, which ran preflight against a half-finished branch and stopped at step 1: the
# gate did its job, the state line lied.
#
#   1. a told worker reads `working`, and `--json` names the tell as the fact that decided it;
#   2. `wait` does not return on the report the worker left behind the tell, and returns on the next
#      one it writes;
#   3. a commit made after the tell and after the report is the fact that decides `working` again;
#   4. a worker that was never told behaves exactly as it did: `reported`, and `wait` returns;
#   5. `close` refuses a worker that is working, and says why, instead of tearing down a live tab;
#   6. `--forever` blocks on the tell and only returns on the report written after it.
#
# No network, no desktop app, nothing written outside $WORK. Set PI_WAIT_TRUTH_DELEGATE to another
# `bin/delegate` (trunk's) to run the same cases against older code, which is how the report shows a
# case failing before the fix.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE=${PI_WAIT_TRUTH_DELEGATE:-$ROOT/bin/delegate}
[ -x "$DELEGATE" ] || {
	printf 'FATAL: %s is not executable\n' "$DELEGATE" >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	printf 'FATAL: node is not on PATH\n' >&2
	exit 1
}
command -v timeout >/dev/null 2>&1 || {
	printf 'FATAL: timeout is not on PATH\n' >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
mkdir -p "$HOME" "$WORK/stub" "$WORK/proj" \
	"$PI_SPACE_ROOT/state/spaces/demo/specs" "$PI_SPACE_ROOT/state/spaces/demo/reports" \
	"$PI_SPACE_ROOT/state/spaces/demo/state"

# hc: `ls` answers $WORK/terminals.json when a case writes one, and lists nothing otherwise (a herdr
# this side cannot see, which reads as "the record stands"). `send` is logged, so a case can say
# whether the worker was actually told.
cat >"$WORK/stub/hc" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$WORK/hc.log"
if [ "\$1" = ls ]; then
	if [ -f "$WORK/terminals.json" ]; then cat "$WORK/terminals.json"; else printf '{"terminals":[]}\n'; fi
	exit 0
fi
exit 0
STUB
chmod +x "$WORK/stub/hc"
export PATH="$WORK/stub:$PATH"
# The forever loop's real poll is 20 seconds: a test cannot spend a minute watching it block.
export DELEGATE_POLL_SECONDS=1

SD="$PI_SPACE_ROOT/state/spaces/demo"
SPEC="$SD/specs/w1.md"
REPORT="$SD/reports/w1.md"
PROJ="$WORK/proj"
printf '# Worker w1\n\nMission: test fixture\n' >"$SPEC"

# A git repo with a `work` branch, so the commit half of the state has something to read.
git_quiet() { git -c user.name=t -c user.email=t@example.com "$@" >/dev/null 2>&1; }
git_quiet -C "$PROJ" init -b trunk
printf 'x\n' >"$PROJ/a.txt"
git_quiet -C "$PROJ" add a.txt
git_quiet -C "$PROJ" commit -m "trunk"
git_quiet -C "$PROJ" checkout -b work

write_record() { # [told-at-epoch]
	local told=${1:-}
	cat >"$SD/delegations.json" <<JSON
{"w1":{"slug":"w1","kind":"tab","space":"sp1","spaceName":"demo","tab":"tb1","terminal":"t1","cwd":"$PROJ","mode":"sandboxed","thinking":"low","spec":"$SPEC","report":"$REPORT","branch":"work"${told:+,"toldAt":$told,"toldAtISO":"$(date -u -d "@$told" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'x')"}}}
JSON
}

# The report shape the tool calls written: every required field filled, no placeholder left.
write_report() { # <one line of prose to tell this report from the last one>
	{
		printf '# Report — w1\n\nMission: the boss never publishes a half-finished branch\n\n'
		printf '%s\n\n' "${1:-}"
		printf 'Review tier: Low\n\nTest change: none: no test file changed\n\n'
		printf '## Evidence\n\nCommand: `bin/preflight --slug w1`\n\nOutput (last 20 lines):\n\n'
		printf '```\npreflight: 0/0 passed on demo in 0s\n```\n'
	} >"$REPORT"
}

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

# ------------------------------------------- 1. a told worker reads working --
new_case 'a worker that was told to continue'
write_record
write_report 'first answer'
run "$DELEGATE" status w1
if [ "$RC" -eq 0 ] && [ "$OUT" = reported ]; then pass 'it reads reported before the tell'; else fail "before the tell it read '$OUT' (exit $RC)"; fi
sleep 1
run "$DELEGATE" tell w1 "the check is red: fix it"
if [ "$RC" -eq 0 ]; then pass 'the tell is accepted'; else fail "the tell was refused (exit $RC)" "$OUT"; fi
run "$DELEGATE" status w1
if [ "$OUT" = working ]; then pass 'the same report now reads working'; else fail "it still reads '$OUT'" "$OUT"; fi
run "$DELEGATE" status w1 --json
if printf '%s' "$OUT" | grep -qF '"decided":"tell"'; then pass 'it names the tell as the fact that decided it'; else fail 'the fact is not named' "$OUT"; fi
if printf '%s' "$OUT" | grep -qF '"status":"working"'; then pass 'the JSON word agrees with the plain one'; else fail 'the JSON word disagrees' "$OUT"; fi
if grep -qF 'first answer' "$REPORT"; then pass 'the tell wrote nothing to the report'; else fail 'the tell rewrote the report' "$(cat "$REPORT" 2>/dev/null)"; fi

# ------------- 2. wait blocks on the tell and returns on the next report --
new_case 'wait on a told worker'
run timeout 30 "$DELEGATE" wait w1 --timeout 3
if [ "$RC" -ne 0 ]; then pass 'it does not return on the report behind the tell'; else fail 'it returned a report the tell had already overtaken' "$OUT"; fi
case $OUT in
*"first answer"*) fail 'it printed the old report anyway' "$OUT" ;;
*) pass 'it does not print the old report' ;;
esac
case $OUT in
*"not reported after 3s"*) pass 'it says it waited and did not see a report' ;;
*) fail 'it does not say what it waited for' "$OUT" ;;
esac
write_report 'second answer'
run timeout 30 "$DELEGATE" wait w1 --timeout 5
if [ "$RC" -eq 0 ]; then pass 'it returns on the report written after the tell'; else fail "it did not return (exit $RC)" "$OUT"; fi
case $OUT in
*"second answer"*) pass 'it prints the new report' ;;
*) fail 'it does not print the new report' "$OUT" ;;
esac
case $OUT in
*"finish w1"*) pass 'it names the one command that publishes it' ;;
*) fail 'it does not name the next command' "$OUT" ;;
esac
run "$DELEGATE" status w1 --json
if printf '%s' "$OUT" | grep -qF '"decided":"report"'; then pass 'the new report is the fact that decided it'; else fail 'the report is not the deciding fact' "$OUT"; fi

# ------------------------- 3. a commit after the tell reopens it again --
new_case 'a commit made after the tell'
write_record
sleep 1
run "$DELEGATE" tell w1 "commit it and report again"
sleep 1
write_report 'third answer'
sleep 1
printf 'y\n' >>"$PROJ/a.txt"
git_quiet -C "$PROJ" commit -am "work

Agent-Slug: w1"
run "$DELEGATE" status w1
if [ "$OUT" = working ]; then pass 'the report the commit overtook reads working'; else fail "it reads '$OUT'" "$OUT"; fi
run "$DELEGATE" status w1 --json
if printf '%s' "$OUT" | grep -qF '"decided":"commit"'; then pass 'it names the commit as the fact that decided it'; else fail 'the commit is not named as the fact' "$OUT"; fi
write_report 'fourth answer'
run "$DELEGATE" status w1
if [ "$OUT" = reported ]; then pass 'a report written after the commit is reported again'; else fail "it reads '$OUT'" "$OUT"; fi

# ------------------- 4. a worker that was never told behaves as before --
new_case 'a worker that was never told'
write_record
write_report 'ordinary answer'
run "$DELEGATE" status w1
if [ "$OUT" = reported ]; then pass 'it reads reported'; else fail "it reads '$OUT'" "$OUT"; fi
run "$DELEGATE" status w1 --json
if printf '%s' "$OUT" | grep -qF '"decided":"report"'; then pass 'the report is the fact'; else fail 'the fact is not the report' "$OUT"; fi
run timeout 30 "$DELEGATE" wait w1 --timeout 5
if [ "$RC" -eq 0 ]; then pass 'wait returns at once'; else fail "wait did not return (exit $RC)" "$OUT"; fi
case $OUT in
*"ordinary answer"*) pass 'it prints the report' ;;
*) fail 'it does not print the report' "$OUT" ;;
esac
if grep -q '"toldAt"' "$SD/delegations.json"; then fail 'the ordinary path grew a tell that never happened' "$(cat "$SD/delegations.json")"; else pass 'no tell state on the ordinary path'; fi

# ---------------------------------- 5. close refuses a working worker --
new_case 'close on a working worker'
: >"$WORK/hc.log"
printf '# Report — w1\n\nMission: <fill in: who is better off>\n' >"$REPORT"
write_record
run "$DELEGATE" close w1
if [ "$RC" -ne 0 ]; then pass "it exits $RC, not 0"; else fail 'it closed a worker that is typing'; fi
case $OUT in
*"refusing to close w1"*"working"*) pass 'it says the worker is working' ;;
*) fail 'the refusal does not name the state' "$OUT" ;;
esac
case $OUT in
*"delegate wait w1 --forever"*) pass 'it names the wait that follows' ;;
*) fail 'it does not say how to wait for it' "$OUT" ;;
esac
if [ -f "$SD/delegations.json" ] && grep -qF '"w1"' "$SD/delegations.json"; then pass 'the record is kept, so the worker is still tracked'; else fail 'the record was dropped'; fi
write_report 'fifth answer'
run "$DELEGATE" tell w1 "one more thing"
if [ "$RC" -eq 0 ]; then pass 'a reported worker is still tellable'; else fail "the tell was refused (exit $RC)" "$OUT"; fi
run "$DELEGATE" close w1
if [ "$RC" -ne 0 ]; then pass 'close refuses it again once the tell reopened it'; else fail 'it closed a worker the tell had reopened'; fi
case $OUT in
*"working again"*) pass 'the refusal says the tell reopened it' ;;
*) fail 'the refusal does not name the tell' "$OUT" ;;
esac

# ---------------------------- 6. --forever blocks on the tell too --
new_case 'wait --forever on a told worker'
write_record
write_report 'sixth answer'
run "$DELEGATE" tell w1 "keep going"
run timeout 4 "$DELEGATE" wait w1 --forever
if [ "$RC" -eq 124 ]; then pass 'it is still blocked when the timeout kills it'; else fail "it returned early (exit $RC)" "$OUT"; fi
case $OUT in
*"working"*"tell"*) pass 'its poll line names the tell' ;;
*) fail 'the poll line does not name the tell' "$OUT" ;;
esac
case $OUT in
*"sixth answer"*) fail 'it printed the report the tell overtook' "$OUT" ;;
*) pass 'it does not print the overtaken report' ;;
esac
write_report 'seventh answer'
run timeout 30 "$DELEGATE" wait w1 --forever
if [ "$RC" -eq 0 ]; then pass 'it returns once the new report is written'; else fail "it did not return (exit $RC)" "$OUT"; fi
case $OUT in
*"seventh answer"*) pass 'it prints the new report' ;;
*) fail 'it does not print the new report' "$OUT" ;;
esac

printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
