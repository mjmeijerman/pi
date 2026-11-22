#!/usr/bin/env bash
# Tests for the ledger `bin/ci` reads — the content key and the shared tier.
#
# Why these exist: `bin/receipts.sh` keyed a receipt on `git rev-parse HEAD` plus the dirty list, so
# `.worktrees/a` and `.worktrees/b` holding the same bytes never shared one verdict, and the point of
# a cache in a space — four worktrees, one answer — was lost. The key is now the content of the
# working tree (`git write-tree` on a throwaway index), and inside a space the receipts live in
# `state/spaces/<space>/cache/ci/`. This file proves the three ways that can lie: two worktrees must
# share, a changed byte must not, and a job whose verdict reads an ignored file must never be
# answered by any receipt.
#
# A stub job table keeps it to seconds: the job writes one line to $MARKER, so the marker's line
# count is exactly "how many times did the job run".
#
# CI_UNDER_TEST=<path> points the suite at another bin/ci, which is how a new case is proved red on
# an older one: CI_UNDER_TEST=/tmp/trunk/bin/ci bash scripts/tests/test-ci-cache.sh
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI="${CI_UNDER_TEST:-$REPO/bin/ci}"
[ -f "$CI" ] || {
	printf 'FATAL: %s is missing\n' "$CI" >&2
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
expect_rc() {
	case $2 in
	0) [ "$RC" -eq 0 ] && pass "$1" || fail "$1" "exit $RC" "$OUT" ;;
	*) [ "$RC" -ne 0 ] && pass "$1" || fail "$1" "exit 0, expected a refusal" "$OUT" ;;
	esac
}
out_has() {
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then pass "$2"; else fail "$2" "missing: $1" "$OUT"; fi
}
out_lacks() {
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then fail "$2" "unexpectedly present: $1" "$OUT"; else pass "$2"; fi
}
marker_count() { # <file>
	if [ -f "$1" ]; then wc -l <"$1" | tr -d ' '; else printf 0; fi
}

# --- the space, its cache, and two worktrees of the same content -------------------------------
ROOT=$WORK/root
SPACE=testspace
mkdir -p "$ROOT/state/spaces/$SPACE" "$WORK/repo/scripts"
printf '{"name":"%s","project":"%s"}\n' "$SPACE" "$WORK/repo" >"$ROOT/state/spaces/$SPACE/space.json"

cat >"$WORK/repo/scripts/stub-job.sh" <<'JOB'
#!/usr/bin/env bash
printf 'ran\n' >>"$MARKER"
printf 'stub job ran\n'
JOB
printf 'tracked content\n' >"$WORK/repo/tracked.txt"

(
	cd "$WORK/repo" || exit 1
	git init -q .
	git config user.email test@example.com
	git config user.name test
	git add -A
	git commit -qm 'the fixture tree'
	git worktree add -q "$WORK/wt1" -b one HEAD
	git worktree add -q "$WORK/wt2" -b two HEAD
) || {
	printf 'FATAL: could not build the fixture repo\n' >&2
	exit 1
}

TABLE=$WORK/jobs.table
cat >"$TABLE" <<'TABLE'
stub|bash scripts/stub-job.sh|-|yes
TABLE

MARKER=$WORK/marker
: >"$MARKER"

run_ci() { # <cwd> [args...]
	local cwd=$1
	shift
	OUT=$(env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" MARKER="$MARKER" PI_SPACE_ROOT="$ROOT" \
		bash "$CI" --table "$TABLE" --space "$SPACE" --cwd "$cwd" --jobs 1 "$@" 2>&1)
	RC=$?
}

# ---------------------------------------------------------------------------
case_start "the first run has no receipt and the job runs"
run_ci "$WORK/wt1"
expect_rc "one green stub job is a pass" 0
out_has 'stub job ran' "the job's own output is kept"
out_lacks '(receipt' "a run with no receipt reached nothing older"
if [ "$(marker_count "$MARKER")" = 1 ]; then pass "the job ran once"; else fail "the job ran $(marker_count "$MARKER") time(s)"; fi

# ---------------------------------------------------------------------------
case_start "another worktree of the same content answers from the space's shared cache"
run_ci "$WORK/wt2"
expect_rc "a receipt is a pass" 0
out_has '(receipt, shared)' "the line says which tier answered"
if [ "$(marker_count "$MARKER")" = 1 ]; then
	pass "the second worktree did not run the job again (1 line, not 2)"
else
	fail "the marker holds $(marker_count "$MARKER") line(s), so the job ran twice" "$OUT"
fi

# ---------------------------------------------------------------------------
case_start "a changed byte is a different tree, and runs"
printf 'changed content\n' >"$WORK/wt1/tracked.txt"
run_ci "$WORK/wt1"
expect_rc "the changed tree is a pass" 0
out_lacks '(receipt' "a changed tree is not answered by the old receipt"
if [ "$(marker_count "$MARKER")" = 2 ]; then pass "the job ran again"; else fail "the marker holds $(marker_count "$MARKER") line(s), expected 2" "$OUT"; fi

# ---------------------------------------------------------------------------
case_start "--no-cache ignores both tiers"
run_ci "$WORK/wt1" --no-cache
expect_rc "the uncached run is a pass" 0
out_lacks '(receipt' "nothing was read from the ledger"
if [ "$(marker_count "$MARKER")" = 3 ]; then pass "the job ran despite the receipt the previous run wrote"; else fail "the marker holds $(marker_count "$MARKER") line(s), expected 3" "$OUT"; fi
run_ci "$WORK/wt1" --no-cache
if [ "$(marker_count "$MARKER")" = 4 ]; then pass "a --no-cache run writes no receipt for the next one"; else fail "the marker holds $(marker_count "$MARKER") line(s), expected 4" "$OUT"; fi

# ---------------------------------------------------------------------------
case_start "a no-cache row is never answered by a receipt"
cat >"$WORK/uncached.table" <<'TABLE'
stub|bash scripts/stub-job.sh|-|yes|no: it reads a file the content hash cannot see
TABLE
run_ci "$WORK/wt1"
before=$(marker_count "$MARKER")
OUT=$(env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" MARKER="$MARKER" PI_SPACE_ROOT="$ROOT" \
	bash "$CI" --table "$WORK/uncached.table" --space "$SPACE" --cwd "$WORK/wt1" --jobs 1 2>&1)
RC=$?
expect_rc "a no-cache job is a pass" 0
out_lacks '(receipt' "it is never answered from the ledger"
after=$(marker_count "$MARKER")
if [ "$after" -eq $((before + 1)) ]; then pass "it ran again"; else fail "the marker holds $after line(s), expected $((before + 1))" "$OUT"; fi

# ---------------------------------------------------------------------------
case_start "--receipts prints the key a job would use"
OUT=$(env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" MARKER="$MARKER" PI_SPACE_ROOT="$ROOT" \
	bash "$CI" --table "$TABLE" --space "$SPACE" --cwd "$WORK/wt1" --jobs 1 --receipts 2>&1)
RC=$?
out_has 'receipt stub ' "it names the job"
out_has 'script:scripts/stub-job.sh' "it names the unit the key is made for"
out_has '(shared)' "it names the tier"
KEY=$(printf '%s\n' "$OUT" | sed -n 's/^receipt stub  *[^ ]*  *\([0-9a-f]*\).*/\1/p')
if [ "${#KEY}" -eq 64 ]; then pass "the key is a sha256"; else fail "the key reads '${KEY}'" "$OUT"; fi

printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
