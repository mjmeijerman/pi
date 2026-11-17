#!/usr/bin/env bash
# Tests for scripts/mutate-changed.sh — the branch-scoped mutation check.
#
# Why these exist: the target's whole point is that the mutant range is derived
# from the diff. Get the filter wrong and the run scores files the branch never
# touched (slow, and the number lies); read a hunk's old side instead of its new
# side and the gate mutates lines the branch deleted. Both are silent, so both
# are asserted here against the real script, on fixture patches.
#
# The second reason is today's two cancelled runs (PR #106, PR #110): a
# file-level scope mutates 1042 mutants in secret-guard.ts, ~20% of them
# survivors that predate the branch, so `break: 100` could not be satisfied by
# any small change and the job was killed by its own 25-minute budget at 68%.
# A case here pins the line-level contract that replaced it.
#
# Stryker is never started: --list-only prints the exact --mutate values, and
# the refusal case exits before any runner is picked.
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
	PATCH="$WORK/case$CASE_N.patch"
	: >"$PATCH"
}

# run — runs the script against the case's fixture patch; sets OUT/ERR/STATUS.
run() {
	OUT="$("$SCRIPT" --patch-file "$PATCH" "$@" 2>"$WORK/err")"
	STATUS=$?
	ERR="$(cat "$WORK/err")"
}

# expect_list — the derived list equals the expected lines, in order.
expect_list() {
	local expected="$1"
	if [ "$OUT" != "$expected" ]; then
		fail "expected the mutate list" "want: $(printf '%s' "$expected" | paste -sd' ' -)" \
			"got:  $(printf '%s' "$OUT" | paste -sd' ' -)"
		return 1
	fi
	[ "$STATUS" -eq 0 ] || {
		fail "expected exit 0, got $STATUS" "$ERR"
		return 1
	}
	pass "list is ${expected//$'\n'/ }"
}

# -------------------------------------------------- one added line, one range ---
case_start "one added line mutates that line and nothing else"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/secret-guard.ts b/agent/extensions/secret-guard.ts
index 1111111..2222222 100644
--- a/agent/extensions/secret-guard.ts
+++ b/agent/extensions/secret-guard.ts
@@ -712,0 +713 @@ export function mentions(text: string) {
+	return /\.env/.test(text);
EOF
run --list-only
expect_list "extensions/secret-guard.ts:713-713"

# ------------------------------------------------------- a block of added lines ---
case_start "a three-line addition is one range spanning them"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/lib/usage-format.ts b/agent/extensions/lib/usage-format.ts
--- a/agent/extensions/lib/usage-format.ts
+++ b/agent/extensions/lib/usage-format.ts
@@ -4,0 +5,3 @@
+const a = 1;
+const b = 2;
+const c = 3;
EOF
run --list-only
expect_list "extensions/lib/usage-format.ts:5-7"

# ------------------------------------------------------------- two hunks, one file ---
case_start "two hunks in one file stay two ranges, in diff order"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/merge-guard.ts b/agent/extensions/merge-guard.ts
--- a/agent/extensions/merge-guard.ts
+++ b/agent/extensions/merge-guard.ts
@@ -20 +20 @@
-	if (x) {
+	if (x && y) {
@@ -90,0 +91,2 @@
+	// note
+	return x;
EOF
run --list-only
expect_list "$(printf 'extensions/merge-guard.ts:20-20\nextensions/merge-guard.ts:91-92')"

# ------------------------------------------------------------ deletions add nothing ---
case_start "a hunk that only deletes lines contributes no mutant"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/config-guard.ts b/agent/extensions/config-guard.ts
--- a/agent/extensions/config-guard.ts
+++ b/agent/extensions/config-guard.ts
@@ -30,3 +29,0 @@ export function check() {
-	const a = 1;
-	const b = 2;
-	const c = 3;
EOF
run --list-only
[ -z "$OUT" ] && pass "deletion-only hunk is skipped" ||
	fail "deletion-only hunk produced a range" "$OUT"
[ "$STATUS" -eq 0 ] && pass "and --list-only still exits 0" ||
	fail "expected exit 0, got $STATUS" "$ERR"

# ------------------------------------------------------------- out of scope paths ---
case_start "docs, nested tests and other repos' files are filtered out"
cat >"$PATCH" <<'EOF'
diff --git a/agent/AGENTS.md b/agent/AGENTS.md
--- a/agent/AGENTS.md
+++ b/agent/AGENTS.md
@@ -1,0 +2 @@
+
diff --git a/agent/extensions/__tests__/merge-guard.test.ts b/agent/extensions/__tests__/merge-guard.test.ts
--- a/agent/extensions/__tests__/merge-guard.test.ts
+++ b/agent/extensions/__tests__/merge-guard.test.ts
@@ -5,0 +6 @@
+	assert.equal(1, 1);
diff --git a/agent/extensions/lib/nested/helper.ts b/agent/extensions/lib/nested/helper.ts
--- a/agent/extensions/lib/nested/helper.ts
+++ b/agent/extensions/lib/nested/helper.ts
@@ -1,0 +2 @@
+export const kept = true;
EOF
run --list-only
expect_list "extensions/lib/nested/helper.ts:2-2"

# -------------------------------------------------- a +++ line inside the body ---
case_start "a body line that renders as +++ is not read as a new file header"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/self-learn.ts b/agent/extensions/self-learn.ts
--- a/agent/extensions/self-learn.ts
+++ b/agent/extensions/self-learn.ts
@@ -40,0 +41,2 @@
+const banner = "note";
++ + b/agent/AGENTS.md
EOF
run --list-only
expect_list "extensions/self-learn.ts:41-42"

# ----------------------------------------------------- an empty patch, list mode ---
case_start "nothing added anywhere is silent in list mode, never a widening"
: >"$PATCH"
run --list-only
[ -z "$OUT" ] && pass "empty patch prints nothing" || fail "empty patch printed a list" "$OUT"
[ "$STATUS" -eq 0 ] && pass "and exits 0 so the caller can skip green" ||
	fail "expected exit 0, got $STATUS" "$ERR"

# ------------------------------------------------- empty scope on a bare run ---
case_start "a bare run with nothing to mutate is refused, not widened"
cat >"$PATCH" <<'EOF'
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,0 +2 @@
+hello
EOF
run
if [ "$STATUS" -eq 0 ]; then
	fail "expected a nonzero exit for an empty scope, got 0" "stdout: $OUT"
else
	case "$ERR" in
	*"no added line in a mutable file"*) pass "refusal says why: $STATUS" ;;
	*) fail "refusal message does not say why" "$ERR" ;;
	esac
	case "$ERR" in
	*"whole stryker config"*) pass "refusal names the widening it prevents" ;;
	*) fail "refusal does not name the widening" "$ERR" ;;
	esac
fi

# ------------------------------------------------------------ duplicate hunks ---
case_start "a repeated identical range is printed once"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/usage-footer.ts b/agent/extensions/usage-footer.ts
--- a/agent/extensions/usage-footer.ts
+++ b/agent/extensions/usage-footer.ts
@@ -3,0 +4 @@
+x
@@ -3,0 +4 @@
+x
EOF
run --list-only
expect_list "extensions/usage-footer.ts:4-4"

printf '\n== mutate-changed: %d case(s), %d ok, %d failed\n' \
	"$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
