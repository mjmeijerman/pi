#!/usr/bin/env bash
# Tests for scripts/scripts-test.sh — the bash half of `make scripts-test`, and its pool.
#
# Why these exist: the target ran the eleven bash suites in a serial `for t in
# scripts/tests/*.test.sh` loop, so the wall clock was their sum — 58s of CI and 47s locally, a
# third of what the target is for. `scripts/scripts-test.sh` is the pool, and this file pins what a
# pool can quietly break: the wall clock, the report a human reads, the order it is in, and the exit
# status that decides whether the target is red.
#
# PR_SCRIPTS_TEST=<path> points the suite at another scripts-test.sh, which is how a new case is
# proved red on an older one — on trunk there is no such file, so every case here is red by
# construction.
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${PR_SCRIPTS_TEST:-$REPO/scripts/scripts-test.sh}"
[ -f "$RUNNER" ] || {
	printf 'FATAL: %s is missing (trunk ran the loop inside the Makefile)\n' "$RUNNER" >&2
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
ELAPSED_MS=0

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
	*) [ "$RC" -ne 0 ] && pass "$1" || fail "$1" "exit 0, expected a failure" "$OUT" ;;
	esac
}
out_has() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then pass "$2"; else fail "$2" "missing: $1" "$OUT"; fi
}

# --- the fixture: five suites, one slow, and a copy of the runner beside them ------------------
FIX=$WORK/fixture
mkdir -p "$FIX/suites"
cp "$RUNNER" "$FIX/scripts-test.sh"
write_suite() { # <name> <sleep-seconds> [exit]
	local name=$1 nap=$2 rc=${3:-0}
	cat >"$FIX/suites/$name.test.sh" <<SUITE
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

run_runner() { # [args...] — a clean environment, so JOBS or TMPDIR from this shell cannot decide a case
	local start end
	start=$(date +%s%N)
	OUT=$(env -i PATH=/usr/bin:/bin HOME="$WORK" TMPDIR="$WORK" "${RUNNER_ENV[@]}" \
		bash "$FIX/scripts-test.sh" "$@" 2>&1)
	RC=$?
	end=$(date +%s%N)
	ELAPSED_MS=$(((end - start) / 1000000))
}
RUNNER_ENV=()

# ---------------------------------------------------------------------------
case_start "--jobs 5 costs the slowest suite, not the sum"
run_runner --dir "$FIX/suites" --jobs 5
expect_rc "five green suites are a pass" 0
if [ "$ELAPSED_MS" -lt 3500 ]; then
	pass "it finished in ${ELAPSED_MS}ms, about the 2s suite and not the 4s sum"
else
	fail "it took ${ELAPSED_MS}ms, so the suites ran one after another" "$OUT"
fi
out_has "== scripts-test: bash $FIX/suites/a.test.sh" "the report still names each suite the old way"
out_has "suite a done" "a suite's own output is printed, not swallowed by the pool"
if [ -z "$(printf '%s\n' "$OUT" | grep -v '^== scripts-test:\|^suite ')" ]; then
	pass "nothing but the old block shape is printed"
else
	fail "the pool printed lines the serial loop never did" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "--jobs 1 is the serial run: the sum, in glob order"
run_runner --dir "$FIX/suites" --jobs 1
expect_rc "the serial run is a pass too" 0
if [ "$ELAPSED_MS" -ge 3500 ]; then
	pass "it took ${ELAPSED_MS}ms, the sum of the five suites"
else
	fail "it took ${ELAPSED_MS}ms, so --jobs 1 did not run them one at a time" "$OUT"
fi
ORDER=$(printf '%s\n' "$OUT" | grep -o '^== scripts-test: bash .*' | sed 's|.*/||' | tr '\n' ' ')
if [ "$ORDER" = "a.test.sh b.test.sh c.test.sh d.test.sh e.test.sh " ]; then
	pass "the suites are reported in glob order"
else
	fail "the report order is '${ORDER}'" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "JOBS in the environment is the pool size, and the report order does not move"
SERIAL=$(run_runner --dir "$FIX/suites" --jobs 1 && printf '%s\n' "$OUT" | grep -o '^== scripts-test: bash [^ ]*')
RUNNER_ENV=(JOBS=5)
run_runner --dir "$FIX/suites"
RUNNER_ENV=()
PARALLEL=$(printf '%s\n' "$OUT" | grep -o '^== scripts-test: bash [^ ]*')
if [ "$SERIAL" = "$PARALLEL" ] && [ -n "$SERIAL" ]; then
	pass "JOBS=5 prints the same blocks in the same order as JOBS=1"
else
	fail "the parallel order differs from the serial one" "serial: $SERIAL" "parallel: $PARALLEL"
fi
if [ "$ELAPSED_MS" -lt 3500 ]; then
	pass "JOBS=5 was the pool, not a serial run (${ELAPSED_MS}ms)"
else
	fail "JOBS=5 took ${ELAPSED_MS}ms, so the environment was ignored" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "a red suite fails the run, is named, and does not stop the others"
write_suite c 0.1 1
run_runner --dir "$FIX/suites" --jobs 5
expect_rc "a red suite is a red run" nonzero
out_has "== scripts-test: FAILED $FIX/suites/c.test.sh (exit 1)" "the failing suite is named with its exit status"
out_has "suite e done" "the suites after the red one still ran"
if [ "$ELAPSED_MS" -lt 3500 ]; then
	pass "a red suite does not serialise the run (${ELAPSED_MS}ms)"
else
	fail "it took ${ELAPSED_MS}ms after one suite went red" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "the exit status is the failure count, capped at 1"
write_suite c 0.1 3
write_suite d 0.1 7
run_runner --dir "$FIX/suites" --jobs 5
expect_rc "two red suites are a red run" nonzero
out_has "== scripts-test: FAILED $FIX/suites/c.test.sh (exit 3)" "the first failure keeps its own exit status"
out_has "== scripts-test: FAILED $FIX/suites/d.test.sh (exit 7)" "the second failure is named too"
if [ "$RC" -eq 1 ]; then
	pass "the run exits 1, not 3 or 7 or 2"
else
	fail "the run exited $RC; the count is capped at 1" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "an empty suite directory is missing tests, not a green run"
mkdir -p "$WORK/empty"
run_runner --dir "$WORK/empty" --jobs 2
expect_rc "no suites at all is a failure" nonzero
out_has "the gate tests are missing, not green" "the refusal says what an empty glob means"

# ---------------------------------------------------------------------------
case_start "--jobs and --dir take a value, and a bad one is refused"
run_runner --dir "$FIX/suites" --jobs 0
expect_rc "zero jobs is refused, not run" nonzero
out_has '--jobs takes a positive number' "the refusal says what the flag takes"
run_runner --dir "$FIX/suites" --jobs nope
expect_rc "a word is refused, not run" nonzero

printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
