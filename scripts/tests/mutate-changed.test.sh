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

# ------------------------------------------------------- a test helper is out too ---
case_start "a test helper under __tests__ adds no mutant range"
cat >"$PATCH" <<'EOF'
diff --git a/agent/extensions/__tests__/helpers/fake-pi.ts b/agent/extensions/__tests__/helpers/fake-pi.ts
--- a/agent/extensions/__tests__/helpers/fake-pi.ts
+++ b/agent/extensions/__tests__/helpers/fake-pi.ts
@@ -199,0 +200,3 @@
+export async function whenChildrenIdle(): Promise<void> {
+	await Promise.resolve();
+}
EOF
run --list-only
[ -z "$OUT" ] && pass "the helper adds no range" ||
	fail "a test helper produced a mutant range" "$OUT"
[ "$STATUS" -eq 0 ] && pass "and list mode exits 0 so the caller skips green" ||
	fail "expected exit 0, got $STATUS" "$ERR"

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

# ---------------------------------------------------------------- the budget ---
# A pull request gets a mutant budget, not a line budget: 200 mutants is about
# five minutes at the measured 7.45 worker-seconds each, while a file's worth of
# mutants is the rest of an afternoon. The cap has to be (a) deterministic — the
# same diff must always test the same mutants, or a re-push scores a different
# question — and (b) loud: the number it deferred is the difference between a
# budget and a lie. These cases pin both, against a fixture mutant list so the
# arithmetic is checked without starting stryker.
# One fixture for every budget case: two files, seven mutants over four lines,
# handed over in a deliberately unsorted order so the cap has to sort. Lines 5
# and 20 carry more than one mutant each, so "the first N" cannot be met by
# slicing mid-line.
cat >"$WORK/budget.patch" <<'EOF'
diff --git a/agent/extensions/merge-guard.ts b/agent/extensions/merge-guard.ts
--- a/agent/extensions/merge-guard.ts
+++ b/agent/extensions/merge-guard.ts
@@ -19,0 +20,2 @@
+	if (a && b) {
+		return "x";
diff --git a/agent/extensions/lib/usage-format.ts b/agent/extensions/lib/usage-format.ts
--- a/agent/extensions/lib/usage-format.ts
+++ b/agent/extensions/lib/usage-format.ts
@@ -4,0 +5,3 @@
+const a = b * c;
+const d = 1;
+const e = a === d;
EOF
cat >"$WORK/mutants.jsonl" <<'EOF'
{"file":"extensions/merge-guard.ts","line":20,"column":5,"mutatorName":"EqualityOperator","replacement":"a >= b"}
{"file":"extensions/merge-guard.ts","line":20,"column":5,"mutatorName":"EqualityOperator","replacement":"a <= b"}
{"file":"extensions/merge-guard.ts","line":20,"column":5,"mutatorName":"ConditionalExpression","replacement":"true"}
{"file":"extensions/merge-guard.ts","line":21,"column":9,"mutatorName":"StringLiteral","replacement":"``"}
{"file":"extensions/lib/usage-format.ts","line":5,"column":11,"mutatorName":"ArithmeticOperator","replacement":"b / c"}
{"file":"extensions/lib/usage-format.ts","line":5,"column":11,"mutatorName":"ArithmeticOperator","replacement":"b - c"}
{"file":"extensions/lib/usage-format.ts","line":7,"column":11,"mutatorName":"EqualityOperator","replacement":"a !== d"}
EOF

case_start "a cap takes mutants in file-then-line order and says what it deferred"
run --patch-file "$WORK/budget.patch" --list-only --cap 6 --mutants-file "$WORK/mutants.jsonl"
expect_list "$(printf 'extensions/lib/usage-format.ts:5-5\nextensions/lib/usage-format.ts:7-7\nextensions/merge-guard.ts:20-20')"
case "$ERR" in
*"mutation: 6 of 7 mutants on changed lines (1 deferred to the weekly full run)"*)
	pass "the deferred count is printed, not swallowed"
	;;
*) fail "no budget line on stderr" "$ERR" ;;
esac

# A second run of the same diff must select the same set: a re-push that scores
# a different 6 mutants is not a gate, it is a lottery.
first_run="$OUT"
run --patch-file "$WORK/budget.patch" --list-only --cap 6 --mutants-file "$WORK/mutants.jsonl"
[ "$OUT" = "$first_run" ] && pass "a second run selects the identical set" ||
	fail "the cap is not deterministic" "first: $first_run" "second: $OUT"

case_start "a line is taken whole or not at all, so the cap is a ceiling"
# 3 of the 7 mutants fit; the two-mutant line 20 does not, and is not sliced.
run --patch-file "$WORK/budget.patch" --list-only --cap 4 --mutants-file "$WORK/mutants.jsonl"
expect_list "$(printf 'extensions/lib/usage-format.ts:5-5\nextensions/lib/usage-format.ts:7-7')"
case "$ERR" in
*"mutation: 3 of 7 mutants on changed lines (4 deferred to the weekly full run)"*)
	pass "a cap of 4 is reported as 3 selected, never 4"
	;;
*) fail "the cap overshot or did not report" "$ERR" ;;
esac

case_start "a cap larger than the mutant count takes everything and defers nothing"
run --patch-file "$WORK/budget.patch" --list-only --cap 100 --mutants-file "$WORK/mutants.jsonl"
expect_list "$(printf 'extensions/lib/usage-format.ts:5-5\nextensions/lib/usage-format.ts:7-7\nextensions/merge-guard.ts:20-21')"
case "$ERR" in
*"mutation: 7 of 7 mutants on changed lines (0 deferred to the weekly full run)"*)
	pass "nothing deferred is said out loud"
	;;
*) fail "no budget line for the uncapped-in-effect run" "$ERR" ;;
esac

case_start "no cap keeps the diff's own ranges and counts nothing"
run --patch-file "$WORK/budget.patch" --list-only --mutants-file "$WORK/mutants.jsonl"
expect_list "$(printf 'extensions/merge-guard.ts:20-21\nextensions/lib/usage-format.ts:5-7')"
[ -z "$ERR" ] && pass "a run with no cap prints no budget line" ||
	fail "--cap was not asked for but something was counted" "$ERR"

case_start "--cap that is not a number is refused before anything runs"
run --patch-file "$WORK/budget.patch" --list-only --cap two --mutants-file "$WORK/mutants.jsonl"
[ "$STATUS" -eq 2 ] && pass "exit 2 for a bad cap" || fail "expected exit 2, got $STATUS" "$ERR"
case "$ERR" in
*"--cap needs a whole number"*) pass "the refusal names the flag" ;;
*) fail "refusal does not name the flag" "$ERR" ;;
esac

# ------------------------------------------- the cap lives in one job only ---
# "The weekly full run must still sweep everything" is a property of the
# workflow, not of this script, so it is asserted where the workflow says it:
# exactly one --cap in test.yml, it asks for 200, and it is not in the weekly
# `mutation` job. A second cap sneaking into the schedule path would quietly
# stop the full sweep while every unit case above stayed green.
case_start "the weekly job sweeps everything and only the PR job is capped"
WF="$(cd "$(dirname "$SCRIPT")/.." && pwd)/.github/workflows/test.yml"
# Comments name the flag too, so only real invocations count: a line that is not
# a YAML comment and passes a numeric cap.
cap_sites="$(grep -v '^[[:space:]]*#' "$WF" | grep -c -- '--cap [0-9]')"
[ "$cap_sites" -eq 1 ] && pass "one place in the workflow passes a cap" ||
	fail "expected exactly 1 capped invocation in test.yml, found $cap_sites"
cap_value="$(grep -v '^[[:space:]]*#' "$WF" | grep -o -- '--cap [0-9]*' | head -1)"
[ "$cap_value" = "--cap 200" ] && pass "the PR budget is 200 mutants" ||
	fail "the cap is not 200" "got: ${cap_value:-nothing}"
weekly="$(awk '/^  mutation:/{f=1;next} /^  [a-z-]+:/{f=0} f' "$WF")"
case "$weekly" in
*--cap*) fail "the weekly mutation job is capped" ;;
*) pass "the schedule/dispatch job passes no cap, so --cap 0 there" ;;
esac

printf '\n== mutate-changed: %d case(s), %d ok, %d failed\n' \
	"$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
