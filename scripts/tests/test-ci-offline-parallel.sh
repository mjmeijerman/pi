#!/usr/bin/env bash
# Tests for scripts/ci-offline.sh — the offline gate runner, and its parallel pool.
#
# Why these exist: the runner was a serial `for suite in ...` loop, so a 30-suite checkout cost the
# sum of every suite (63s) when it could cost the slowest one. `--jobs N` is the pool, and this file
# pins the three things a pool can quietly break: the wall clock, the report a human reads, and the
# order that report is in. The runner is copied into a fixture so the suites it globs are the ones
# this test wrote, not the checkout's own.
#
# PR_CI_OFFLINE=<path> points the suite at another ci-offline.sh, which is how a new case is proved
# red on an older one.
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${PR_CI_OFFLINE:-$REPO/scripts/ci-offline.sh}"
[ -f "$RUNNER" ] || {
	printf 'FATAL: %s is missing\n' "$RUNNER" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
RC=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}
case_start() { CASE_N=$((CASE_N + 1)); CASE=$1; }
expect_rc() { # <why> <0|nonzero>
	case $2 in
	0) [ "$RC" -eq 0 ] && pass "$1" || fail "$1" "exit $RC" "$OUT" ;;
	*) [ "$RC" -ne 0 ] && pass "$1" || fail "$1" "exit 0, expected a refusal" "$OUT" ;;
	esac
}
out_has() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then pass "$2"; else fail "$2" "missing: $1" "$OUT"; fi
}

# --- the fixture: five suites, one slow, and a runner beside them ------------------------------
FIX=$WORK/fixture
mkdir -p "$FIX/scripts/tests"
cp "$RUNNER" "$FIX/scripts/ci-offline.sh"
write_suite() { # <name> <sleep-seconds> [exit]
	local name=$1 nap=$2 rc=${3:-0}
	cat >"$FIX/scripts/tests/test-$name.sh" <<SUITE
#!/usr/bin/env bash
printf 'suite $name running\n'
sleep $nap
printf 'suite $name done\n'
exit $rc
SUITE
}
write_suite a 2
write_suite b 0.5
write_suite c 0.5
write_suite d 0.5
write_suite e 0.5

run_runner() { # [args...]
	local start end
	start=$(date +%s%N)
	OUT=$(env -i PATH=/usr/bin:/bin HOME="$WORK" TMPDIR="$WORK" bash "$FIX/scripts/ci-offline.sh" "$@" 2>&1)
	RC=$?
	end=$(date +%s%N)
	ELAPSED_MS=$(((end - start) / 1000000))
}

# ---------------------------------------------------------------------------
case_start "--jobs 5 costs the slowest suite, not the sum"
run_runner --jobs 5
expect_rc "five green suites are a pass" 0
if [ "$ELAPSED_MS" -lt 3500 ]; then
	pass "it finished in ${ELAPSED_MS}ms, about the 2s suite and not the 4s sum"
else
	fail "it took ${ELAPSED_MS}ms, so the suites ran one after another" "$OUT"
fi
out_has '== ci-offline: bash tests/test-a.sh' "the report still names each suite the old way"
out_has '== ci-offline: 5 suite(s), 0 failed' "the last line is the count of suites and failures"
out_has 'suite a done' "a suite's own output is printed, not swallowed by the pool"

# ---------------------------------------------------------------------------
case_start "--jobs 1 is the serial run: the sum, in glob order"
run_runner --jobs 1
expect_rc "the serial run is a pass too" 0
if [ "$ELAPSED_MS" -ge 3500 ]; then
	pass "it took ${ELAPSED_MS}ms, the sum of the five suites"
else
	fail "it took ${ELAPSED_MS}ms, so --jobs 1 did not run them one at a time" "$OUT"
fi
ORDER=$(printf '%s\n' "$OUT" | grep -o '^== ci-offline: bash .*' | sed 's|.*/||' | tr '\n' ' ')
if [ "$ORDER" = "test-a.sh test-b.sh test-c.sh test-d.sh test-e.sh " ]; then
	pass "the suites are reported in glob order"
else
	fail "the report order is '${ORDER}'" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "the parallel report is in the same order as the serial one"
SERIAL=$(run_runner --jobs 1 && printf '%s\n' "$OUT" | grep -o '^== ci-offline: bash [^ ]*')
run_runner --jobs 5
PARALLEL=$(printf '%s\n' "$OUT" | grep -o '^== ci-offline: bash [^ ]*')
if [ "$SERIAL" = "$PARALLEL" ] && [ -n "$SERIAL" ]; then
	pass "five suites at a time print the same blocks in the same order"
else
	fail "the parallel order differs from the serial one" "serial: $SERIAL" "parallel: $PARALLEL"
fi

# ---------------------------------------------------------------------------
case_start "a red suite fails the run, is named, and does not stop the others"
write_suite c 0.1 1
run_runner --jobs 5
expect_rc "a red suite is a red run" nonzero
out_has '== ci-offline: FAILED tests/test-c.sh' "the failing suite is named"
out_has '== ci-offline: 5 suite(s), 1 failed' "the count says one failure out of five"
out_has 'suite e done' "the suites after the red one still ran"
if [ "$ELAPSED_MS" -lt 3500 ]; then
	pass "a red suite does not serialise the run (${ELAPSED_MS}ms)"
else
	fail "it took ${ELAPSED_MS}ms after one suite went red" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "--jobs takes a number, and a bad one is refused"
run_runner --jobs 0
expect_rc "zero jobs is refused, not run" nonzero
out_has '--jobs takes a positive number' "the refusal says what the flag takes"
run_runner --jobs nope
expect_rc "a word is refused, not run" nonzero

printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
