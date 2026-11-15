#!/usr/bin/env bash
# Tests for scripts/mutate-changed.sh — the branch-scoped mutation check.
#
# Why these exist: the target's whole point is that the mutant list is derived
# from the diff. Get the filter wrong and the run scores files the branch never
# touched (slow, and the number lies); leave the empty case unguarded and
# stryker widens an empty --mutate to the whole config without saying so. Both
# are silent, so both are asserted here against the real script, on fixture
# diff listings.
#
# Stryker is never started: --list-only prints the exact glob list --mutate
# receives, and the refusal case exits before any runner is picked.
#
# Run it directly, or through `make scripts-test` / `npm test` in agent/, which
# glob scripts/tests/*.test.sh the same way this file was picked up.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/mutate-changed.sh"
[ -x "$SCRIPT" ] || {
	printf 'FATAL: %s is missing or not executable\n' "$SCRIPT" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

case_start() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	DIFF="$WORK/case$CASE_N.diff"
	: >"$DIFF"
}

# run — runs the script against the case's fixture listing; sets OUT/ERR/STATUS.
run() {
	OUT="$("$SCRIPT" --diff-file "$DIFF" "$@" 2>"$WORK/err")"
	STATUS=$?
	ERR="$(cat "$WORK/err")"
}

# expect_files — the derived list equals the expected lines, in order.
expect_files() {
	local expected="$1"
	if [ "$OUT" != "$expected" ]; then
		fail "expected the glob list" "want: $(printf '%s' "$expected" | paste -sd' ' -)" \
			"got:  $(printf '%s' "$OUT" | paste -sd' ' -)"
		return 1
	fi
	[ "$STATUS" -eq 0 ] || {
		fail "expected exit 0, got $STATUS" "$ERR"
		return 1
	}
	pass "glob list is ${expected//$'\n'/ }"
}

# ---------------------------------------------------------------- one file ---
case_start "a branch that touches one extension prints that one file"
printf 'agent/extensions/merge-guard.ts\n' >"$DIFF"
run --list-only
expect_files "merge-guard.ts"

# ------------------------------------------------------------- mixed diff ---
case_start "docs, tests and untouched areas are filtered out"
cat >"$DIFF" <<'EOF'
agent/extensions/merge-guard.ts
agent/AGENTS.md
docs/radar-conformance.md
agent/extensions/__tests__/merge-guard.test.ts
agent/extensions/lib/tokens.ts
Makefile
agent/extensions/cost-optimizer.ts
scripts/mutate-changed.sh
EOF
run --list-only
expect_files "$(printf 'merge-guard.ts\nlib/tokens.ts\ncost-optimizer.ts')"

# ---------------------------------------------------------- no .ts in diff ---
case_start "a nested extension path survives, a test file never does"
cat >"$DIFF" <<'EOF'
agent/extensions/lib/nested/helper.ts
agent/extensions/lib/nested/helper.test.ts
EOF
run --list-only
expect_files "lib/nested/helper.ts"

# ------------------------------------------------- empty list is refused ---
case_start "a branch with no mutable file is refused, not widened"
cat >"$DIFF" <<'EOF'
README.md
agent/extensions/__tests__/secret-guard.test.ts
EOF
run
if [ "$STATUS" -eq 0 ]; then
	fail "expected a nonzero exit for an empty scope, got 0" "stdout: $OUT"
else
	case "$ERR" in
	*"no mutable file changed"*) pass "refusal says why: $STATUS" ;;
	*) fail "refusal message does not say why" "$ERR" ;;
	esac
	case "$ERR" in
	*"whole stryker config"*) pass "refusal names the widening it prevents" ;;
	*) fail "refusal does not name the widening" "$ERR" ;;
	esac
fi

# ----------------------------------------------------- empty diff, no file ---
case_start "an empty listing is refused too"
: >"$DIFF"
run
[ "$STATUS" -ne 0 ] && pass "empty listing exits nonzero ($STATUS)" ||
	fail "empty listing exited 0" "stdout: $OUT"

# ------------------------------------------------------- order and dedupe ---
case_start "the list keeps the order of the diff and drops a repeated path"
cat >"$DIFF" <<'EOF'
agent/extensions/usage-footer.ts
agent/extensions/config-guard.ts
agent/extensions/usage-footer.ts
EOF
run --list-only
expect_files "$(printf 'usage-footer.ts\nconfig-guard.ts')"

printf '\n== mutate-changed: %d case(s), %d ok, %d failed\n' \
	"$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
