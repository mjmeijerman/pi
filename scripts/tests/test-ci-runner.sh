#!/usr/bin/env bash
# Tests for bin/ci — the whole GitHub pipeline, locally, in parallel.
#
# Why these exist: `bin/ci` is the answer to "will GitHub's checks pass" without a push, and every
# claim it makes is one the prose cannot prove — that three jobs finish in the slow one's time, that
# a red job fails the run and names its log, that a skip is never counted green, that `--timeout`
# actually kills what it started, and that a job the ledger already answered is not started again.
# Each case drives a job table of its own (`--table`), so the timing is the runner's and not the
# checkout's, and each case is red with no `bin/ci` at all (trunk).
#
# CI_BIN=<path> points the suite at another runner, which is how a new rule is proved red on an
# older one. PI_RECEIPT_DIR is pinned to a scratch directory, so no case writes a receipt into the
# checkout it runs in, and the two flags that mean "trust nothing on disk" are unpinned: bin/ci
# exports PI_RECEIPT_NOCACHE into every job it runs, and bin/preflight --fresh exports
# PI_RECEIPT_FRESH, so a suite started by a gate that bypassed the ledger would otherwise inherit
# "never reuse" and report the reuse case red for a rule it correctly obeyed. The one case that
# wants a forged answer sets PI_RECEIPT_FRESH on that command itself.
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../bin" && pwd)"
CI_BIN="${CI_BIN:-$BIN/ci}"
[ -f "$CI_BIN" ] || {
	printf 'FATAL: %s is missing\n' "$CI_BIN" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export PI_RECEIPT_DIR="$WORK/receipts"
mkdir -p "$PI_RECEIPT_DIR"
unset PI_RECEIPT_NOCACHE PI_RECEIPT_FRESH

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

out_has() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then pass "$2"; else fail "$2" "missing: $1" "$OUT"; fi
}
out_lacks() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then fail "$2" "unexpectedly present: $1" "$OUT"; else pass "$2"; fi
}
expect_rc() { # <0|nonzero> <why>
	case $1 in
	0) [ "$RC" -eq 0 ] && pass "$2" || fail "$2" "exit $RC" "$OUT" ;;
	*) [ "$RC" -ne 0 ] && pass "$2" || fail "$2" "exit 0, expected a failure" "$OUT" ;;
	esac
}

# run_ci [args...] — run one case's runner. Every case but the receipt one bypasses the ledger
# (LEDGER_OFF=1), so a repeat of the same slow job is measured instead of remembered.
run_ci() {
	if [ "${LEDGER_OFF:-1}" = 1 ]; then
		OUT=$(PI_RECEIPT_FRESH=1 "$CI_BIN" "$@" 2>&1)
	else
		OUT=$("$CI_BIN" "$@" 2>&1)
	fi
	RC=$?
}

real_seconds() { # the run's own wall-clock line: `ci: real 2s (at most 3 at a time), logs ...`
	printf '%s\n' "$OUT" | sed -nE 's/^ci: real ([0-9]+)s .*/\1/p' | tail -n 1
}

# --- a plan of three jobs finishes in about the slow one's time ---------------------------------
case_start "parallel"
cat >"$WORK/three.table" <<'TABLE'
slow|sleep 2|-|yes
fast-a|sleep 1|-|yes
fast-b|sleep 1|-|yes
TABLE
run_ci --table "$WORK/three.table" --cwd "$WORK" --jobs 3
expect_rc 0 "three green jobs exit 0"
out_has "ok   slow" "the slow job is reported ok"
out_has "ok   fast-a" "the first fast job is reported ok"
parallel_real=$(real_seconds)
run_ci --table "$WORK/three.table" --cwd "$WORK" --jobs 1
expect_rc 0 "--jobs 1 is green too"
serial_real=$(real_seconds)
[ -n "$parallel_real" ] && [ -n "$serial_real" ] &&
	pass "both runs print their own real line (${parallel_real}s vs ${serial_real}s)" ||
	fail "a run printed no real line" "$OUT"
if [ -n "$parallel_real" ] && [ "$parallel_real" -le 3 ]; then
	pass "--jobs 3 costs about the slow job, not the sum (${parallel_real}s)"
else
	fail "--jobs 3 took ${parallel_real:-?}s, not the slow job's 2s" "$OUT"
fi
if [ -n "$serial_real" ] && [ -n "$parallel_real" ] && [ "$serial_real" -gt "$parallel_real" ]; then
	pass "--jobs 1 is measurably slower (${serial_real}s vs ${parallel_real}s)"
else
	fail "--jobs 1 (${serial_real:-?}s) was not slower than --jobs 3 (${parallel_real:-?}s)" "$OUT"
fi

# --- a red job fails the run, exits non-zero, and names its log ---------------------------------
case_start "red job"
cat >"$WORK/red.table" <<'TABLE'
boom|echo "boom: 2 case(s) red"; exit 3|-|yes
TABLE
run_ci --table "$WORK/red.table" --cwd "$WORK" --jobs 2
expect_rc nonzero "a red job fails the run"
out_has "FAIL boom" "the failing job is named"
out_has "boom.log" "the failing job's log path is printed"
out_has "1 failed" "the summary counts the failure"

# --- a skipped job appears as skipped and is not in the green count ------------------------------
case_start "skipped job"
cat >"$WORK/skip.table" <<'TABLE'
noskipper||-|skip: needs a runner this machine is not
TABLE
run_ci --table "$WORK/skip.table" --cwd "$WORK"
out_has "skipped: noskipper — needs a runner this machine is not" "the skip prints its own reason"
out_has "0/0 runnable green, 1 skipped" "a skip is not counted green"
expect_rc 0 "a skip alone fails nothing: nothing runnable failed"

# --- --timeout fails a job that sleeps past it, and kills it ------------------------------------
case_start "timeout"
cat >"$WORK/hang.table" <<'TABLE'
hang|echo "$$" > "$HANG_PID"; sleep 5; echo finished|-|yes
TABLE
export HANG_PID="$WORK/hang.pid"
run_ci --table "$WORK/hang.table" --cwd "$WORK" --timeout 1
expect_rc nonzero "--timeout 1 fails a job that sleeps 5"
out_has "FAIL hang" "the timed-out job is reported as a failure"
if [ -s "$WORK/hang.pid" ]; then
	pass "the job wrote the pid of its own shell"
else
	fail "the job never wrote $WORK/hang.pid" "$OUT"
fi
hang_pid=$(cat "$WORK/hang.pid" 2>/dev/null || true)
killed=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
	[ -n "$hang_pid" ] || break
	kill -0 "$hang_pid" 2>/dev/null || {
		killed=1
		break
	}
	sleep 0.2
done
if [ "$killed" = 1 ]; then
	pass "the timed-out job's process is gone (pid $hang_pid)"
else
	fail "the timed-out job is still running as pid ${hang_pid:-?}" "a timeout that leaves the work running is not a timeout"
fi

# --- --only runs one job, --dry-run starts nothing ----------------------------------------------
case_start "only"
cat >"$WORK/two.table" <<'TABLE'
alpha|echo ran-alpha|-|yes
beta|echo ran-beta|-|yes
TABLE
run_ci --table "$WORK/two.table" --cwd "$WORK" --only alpha
expect_rc 0 "--only one job exits 0"
out_has "ran-alpha" "the named job ran"
out_lacks "ran-beta" "the other job did not run"
out_has "1/1 runnable green" "the plan held one job"

case_start "dry run"
cat >"$WORK/touch.table" <<'TABLE'
toucher|touch "$DRY_MARKER"|-|yes
TABLE
export DRY_MARKER="$WORK/dry-marker"
run_ci --table "$WORK/touch.table" --cwd "$WORK" --dry-run
expect_rc 0 "--dry-run exits 0"
out_has "plan: toucher" "the plan names the job it would run"
if [ -e "$WORK/dry-marker" ]; then
	fail "--dry-run started the job" "the marker exists: $WORK/dry-marker"
else
	pass "--dry-run started nothing"
fi

# --- two runs of the same job start it once: the receipt path -----------------------------------
# The only case that reads the ledger, so it is also the proof the ledger is consulted at all.
case_start "receipt"
cat >"$WORK/count.table" <<'TABLE'
counter|echo started >> "$COUNTER_MARKER"|-|yes
TABLE
export COUNTER_MARKER="$WORK/counter.marker"
LEDGER_OFF=0
run_ci --table "$WORK/count.table" --cwd "$WORK" --only counter
expect_rc 0 "the first run is green"
first_starts=$(wc -l <"$COUNTER_MARKER" 2>/dev/null || printf 0)
run_ci --table "$WORK/count.table" --cwd "$WORK" --only counter
expect_rc 0 "the second run is green"
second_starts=$(wc -l <"$COUNTER_MARKER" 2>/dev/null || printf 0)
out_has "(receipt, tree)" "the second run says where its answer came from, and which tier it was"
if [ "$first_starts" = 1 ] && [ "$second_starts" = 1 ]; then
	pass "the job started once across two runs (receipt answered the second)"
else
	fail "the job started $first_starts then $second_starts time(s), expected 1 then 1" "$OUT"
fi

# --- scripts-test: the table row and its citation agree with the workflows ---------------------------------
# The scripts tests moved out of harness-check.yml's job into test.yml's `scripts tests`. Every claim
# here is a grep of a file, so a citation that rots — a comment still naming the old workflow, a row
# that stopped running `make scripts-test` — is red instead of quietly wrong.
case_start "scripts-test citation"
run_ci --dry-run --cwd "$BIN/.."
expect_rc 0 "--dry-run is green"
out_has "plan: scripts-test   make --no-print-directory scripts-test" \
	"the scripts-test row still runs make scripts-test"
if grep -Fq 'scripts-test  test.yml job `scripts tests`: `make scripts-test`' "$CI_BIN"; then
	pass "bin/ci's header names test.yml, where the job lives now"
else
	fail "bin/ci's header does not cite test.yml for the scripts-test row" \
		"expected: scripts-test  test.yml job \`scripts tests\`: \`make scripts-test\`"
fi
if grep -Fq 'make scripts-test' "$BIN/../.github/workflows/test.yml"; then
	pass "test.yml runs the same target the row does"
else
	fail "test.yml has no 'make scripts-test' step" \
		"the row and the workflow must be the same command, or a local green proves nothing"
fi
if grep -Fq 'name: scripts tests (make scripts-test)' "$BIN/../.github/workflows/harness-check.yml"; then
	fail "the scripts tests are back in harness-check.yml" \
		"the 58s step was moved out on purpose: a red suite must name itself"
else
	pass "harness-check.yml no longer carries the scripts tests step"
fi

# --- prose-review: three states, and no silent green ---------------------------------------------
# The prose job reads a PR's diff and a model key, so these cases drive the real job row out of the
# real table (`--only prose-review`, no `--table`) against a fake root: a stub review script that
# prints one finding, and a `gh` on PATH that answers `pr diff`. Every case is red on a runner with
# no such row, because `--only` refuses a job name the table does not have.
prose_root() { # <dir> [prose|none] — a tree with the machinery, a stub review and a stub gh
	mkdir -p "$1/.github/scripts" "$1/ghbin"
	cat >"$1/.github/scripts/prose-review.mjs" <<'STUB'
process.argv.slice(2);
process.stdout.write(
	"<!-- prose-review -->\n**prose-review** — five questions (stub).\n\n" +
		"1. **contradiction** — agent/AGENTS.md:12 says wait forever, agent/AGENTS.md:20 says sleep.\n" +
		"2. **missing command** — no finding\n3. **uncheckable rule** — no finding\n" +
		"4. **duplicated rule** — no finding\n5. **older sentence now false** — no finding\n",
);
STUB
	if [ "${2:-prose}" = prose ]; then
		cat >"$1/ghbin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"pr diff")
	printf '%s\n' \
		'diff --git a/agent/AGENTS.md b/agent/AGENTS.md' \
		'--- a/agent/AGENTS.md' \
		'+++ b/agent/AGENTS.md' \
		'@@ -1,2 +1,2 @@' \
		'-old sentence' \
		'+new sentence'
	;;
*) printf 'gh stub: unhandled %s\n' "$*" >&2; exit 1 ;;
esac
STUB
	else
		cat >"$1/ghbin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"pr diff")
	printf '%s\n' \
		'diff --git a/README.md b/README.md' \
		'--- a/README.md' \
		'+++ b/README.md' \
		'@@ -1,2 +1,2 @@' \
		'-old line' \
		'+new line'
	;;
*) printf 'gh stub: unhandled %s\n' "$*" >&2; exit 1 ;;
esac
STUB
	fi
	chmod +x "$1/ghbin/gh"
}

case_start "prose finding"
LEDGER_OFF=1 # the receipt case above turned the ledger on; these cases read a live job
prose_root "$WORK/prose-found"
REAL_PATH=$PATH
export PATH="$WORK/prose-found/ghbin:$PATH"
export PROSE_REVIEW_API_KEY=dummy-key-for-a-stub
run_ci --only prose-review --cwd "$WORK/prose-found" --pr 7
expect_rc nonzero "a prose finding fails the job"
out_has "FAIL prose-review" "the prose job is the one that is red"
out_has "agent/AGENTS.md:12" "the finding line is printed, not only logged"
prose_log=$(printf '%s\n' "$OUT" | sed -nE 's/^FAIL +prose-review +[0-9]+s +log (.+)$/\1/p' | head -n 1)
if [ -n "$prose_log" ] && [ -f "$prose_log" ]; then
	pass "the failing job's log exists ($prose_log)"
else
	fail "the failing job named no log that exists" "log: ${prose_log:-none}" "$OUT"
fi

case_start "prose no key"
unset PROSE_REVIEW_API_KEY
run_ci --only prose-review --cwd "$WORK/prose-found" --pr 7
expect_rc 0 "a missing key skips the job and fails nothing"
out_has "skipped: prose-review — no PROSE_REVIEW_API_KEY, the offline parser tests ran instead" \
	"the skip names the key and what ran instead"
out_has "0/1 runnable green, 1 skipped, 0 failed" "the skip is not counted green and fails nothing"

case_start "prose paths untouched"
# A key, so the paths filter is what decides this case instead of the key check above it.
export PROSE_REVIEW_API_KEY=dummy-key-for-a-stub
prose_root "$WORK/prose-none" none
export PATH="$WORK/prose-none/ghbin:$PATH"
run_ci --only prose-review --cwd "$WORK/prose-none" --pr 7
unset PROSE_REVIEW_API_KEY
expect_rc 0 "a diff with no prose path skips the job"
out_has "skipped: prose-review — no prose path changed" "the skip mirrors the workflow's paths filter"

case_start "prose offline"
export PATH=$REAL_PATH
run_ci --only prose-offline --cwd "$BIN/.."
expect_rc 0 "the offline parser tests pass on this repository"
out_has "ok   prose-offline" "prose-offline is a green job of its own"
out_has "1/1 runnable green" "it is counted green, not skipped"

printf '\n%s: %d case(s), %d passed, %d failed\n' "test-ci-runner" "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
