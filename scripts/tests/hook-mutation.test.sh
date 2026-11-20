#!/usr/bin/env bash
# Tests for git-hooks/scan-mutation.sh — the pre-push mutation gate.
#
# Why these exist: this hook stands between a branch and origin, and its three
# failure modes are all silent. A gate that runs on every push burns a minute of
# every docs push; a gate that swallows a survivor turns the red CI round it was
# built to prevent into a late one; a gate that reads a capped run as a pass
# ships an undecided mutant. Each one is a case here, run against the real hook
# from git-hooks/ in a throwaway repo, with scripts/mutate-changed.sh stubbed in
# the temp repo so no stryker and no network is needed.
#
# Run it directly, or through `make scripts-test`, which globs
# scripts/tests/*.test.sh.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../git-hooks" && pwd)"
HOOK="$HOOKS/scan-mutation.sh"
[ -x "$HOOK" ] || {
	printf 'FATAL: %s is missing or not executable\n' "$HOOK" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# A throwaway repo must see this checkout's hook and nothing from the machine:
# a global hooksPath, template dir or user config would let a passing case prove
# the wrong thing.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export PI_GIT_HOOKS_DIR="$HOOKS"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-01-01T00:00:00 +0000'
unset SKIP_MUTATION_SCAN MUTATION_PREPUSH_CAP 2>/dev/null || true

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
REPO=""
OUT=""
ERR=""
RC=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

# case_start — a repo with a base commit, an extension-free branch, and a stub
# mutate-changed.sh plus agent/stryker.conf.json unless the case removes them.
case_start() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	REPO="$WORK/case$CASE_N"
	git init -q -b trunk "$REPO" || {
		printf 'FATAL: git init failed in %s\n' "$REPO" >&2
		exit 1
	}
	mkdir -p "$REPO/scripts" "$REPO/agent/node_modules/.bin"
	printf 'base\n' >"$REPO/README.md"
	printf '{}\n' >"$REPO/agent/stryker.conf.json"
	# A stryker that only has to exist: the hook checks for it and then runs the
	# stub script, so no runner, no node_modules install, no network.
	printf '#!/bin/sh\nexit 0\n' >"$REPO/agent/node_modules/.bin/stryker"
	chmod +x "$REPO/agent/node_modules/.bin/stryker"
	git -C "$REPO" add -A
	git -C "$REPO" commit -q -m 'base'
	BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"
}

# stub <body> — a mutate-changed.sh that records that it ran and then behaves.
stub() {
	cat >"$REPO/scripts/mutate-changed.sh" <<EOF
#!/usr/bin/env bash
printf 'ran\n' >>"$REPO/ran.txt"
if [ "\${1:-}" = "--list-only" ]; then
	printf 'extensions/foo.ts:1-1\n'
	exit 0
fi
$1
EOF
	chmod +x "$REPO/scripts/mutate-changed.sh"
}

# run_hook — feed one ref line, capture the hook's streams and its exit code.
run_hook() {
	OUT="$(cd "$REPO" && bash "$HOOK" <<<"refs/heads/x $1 refs/heads/x $BASE_SHA" 2>"$WORK/err")"
	RC=$?
	ERR="$(cat "$WORK/err")"
}

ran() { [ -f "$REPO/ran.txt" ]; }

# --- a push that touches no extension line is silent and instant -----------
case_start "docs-only push"
stub 'exit 42'
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -eq 0 ] && pass "exits 0" || fail "expected exit 0, got $RC" "stderr: $ERR"
ran && fail "the mutation run was started for a docs-only push" ||
	pass "scripts/mutate-changed.sh was never called"
[ -z "$OUT" ] && [ -z "$ERR" ] && pass "printed nothing" ||
	fail "printed something on a docs-only push" "stdout: $OUT" "stderr: $ERR"

# --- an extension push runs the check ---------------------------------------
case_start "extension push, stub passes"
(
	cd "$REPO" && mkdir -p agent/extensions && printf 'export const x = 1\n' >agent/extensions/foo.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
stub 'printf "Final mutation score 100.00\n"; exit 0'
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -eq 0 ] && pass "exits 0 when the run passes" || fail "expected exit 0, got $RC" "stderr: $ERR"
ran && pass "scripts/mutate-changed.sh was called" || fail "the hook skipped a real extension push"
case "$OUT" in
*"push allowed"*) pass "says the push is allowed" ;;
*) fail "no pass line" "stdout: $OUT" ;;
esac

# --- a survivor refuses the push, and quotes it ----------------------------
case_start "extension push, stub survives"
(
	cd "$REPO" && mkdir -p agent/extensions &&
		printf 'export const y = 2\n' >agent/extensions/bar.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
stub 'printf "[Survived] Regex /==/\n"; printf "Final mutation score 66.67 under breaking threshold 100, setting exit code to 1 (failure).\n"; exit 1'
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -ne 0 ] && pass "refuses the push (exit $RC)" || fail "expected a non-zero exit, got 0"
case "$ERR$OUT" in
*'[Survived] Regex'*) pass "quotes the survivor" ;;
*) fail "the survivor was not quoted" "stdout: $OUT" "stderr: $ERR" ;;
esac
case "$ERR$OUT" in
*'git push --no-verify'*) pass "names the override" ;;
*) fail "no override line" "stderr: $ERR" ;;
esac

# --- a survivor refuses even when the local config lets the run exit 0 ------
# agent/stryker.conf.json has break null, so stryker exits 0 on a survivor; only
# the PR job's derived break 100 fails it. That gap is the late red round, so a
# printed survivor is a refusal here, measured on a real run: 80.00, one
# [Survived] EqualityOperator, exit 0.
case_start "survivor printed, run exits 0"
(
	cd "$REPO" && mkdir -p agent/extensions &&
		printf 'export const s = 8\n' >agent/extensions/sur.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
stub 'printf "[Survived] EqualityOperator\nextensions/foo.ts:1:1\n"; exit 0'
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -ne 0 ] && pass "refuses the push (exit $RC)" ||
	fail "break null was read as a pass" "stdout: $OUT" "stderr: $ERR"
case "$ERR$OUT" in
*'[Survived] EqualityOperator'*) pass "quotes the survivor" ;;
*) fail "the survivor was not quoted" "stderr: $ERR" ;;
esac
case "$ERR$OUT" in
*'break 100'*) pass "says why the local exit 0 was not the verdict" ;;
*) fail "does not explain the break null gap" "stderr: $ERR" ;;
esac
case "$ERR$OUT" in
*'push allowed'*) fail "a survivor was reported as allowed" "stdout: $OUT" ;;
*) pass "no pass line" ;;
esac

# --- test files are not in scope -------------------------------------------
case_start "extension test-only push"
(
	cd "$REPO" && mkdir -p agent/extensions/__tests__ &&
		printf 'export const t = 3\n' >agent/extensions/__tests__/foo.test.ts &&
		git add -A && git commit -q -m 'test: extension test'
)
stub 'printf "Final mutation score 100.00\n"; exit 0'
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -eq 0 ] && pass "exits 0" || fail "expected exit 0, got $RC"
ran && fail "a mutated test file has no assertion that can kill it, yet it ran" ||
	pass "the gate stayed out of __tests__"

# --- a missing script is a named skip, never a crash -----------------------
case_start "scripts/mutate-changed.sh missing"
(
	cd "$REPO" && mkdir -p agent/extensions &&
		printf 'export const z = 4\n' >agent/extensions/baz.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
rm -f "$REPO/scripts/mutate-changed.sh"
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -eq 0 ] && pass "exits 0" || fail "expected exit 0, got $RC" "stderr: $ERR"
case "$OUT$ERR" in
*'skip'*'scripts/mutate-changed.sh is missing'*) pass "prints the named skip" ;;
*) fail "no named skip line" "stdout: $OUT" "stderr: $ERR" ;;
esac

# --- a missing stryker config is the other named skip ----------------------
case_start "agent/stryker.conf.json missing"
(
	cd "$REPO" && mkdir -p agent/extensions &&
		printf 'export const q = 5\n' >agent/extensions/qux.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
rm -f "$REPO/agent/stryker.conf.json"
stub 'exit 0'
run_hook "$(git -C "$REPO" rev-parse HEAD)"
[ "$RC" -eq 0 ] && pass "exits 0" || fail "expected exit 0, got $RC"
case "$OUT$ERR" in
*'skip'*'stryker.conf.json is missing'*) pass "prints the named skip" ;;
*) fail "no named skip line" "stdout: $OUT" "stderr: $ERR" ;;
esac
ran && fail "ran without a stryker config" || pass "no run without a config"

# --- no dependencies installed: npx --no-install fails, skip by name ------
case_start "deps not installed"
(
	cd "$REPO" && mkdir -p agent/extensions &&
		printf 'export const w = 6\n' >agent/extensions/ws.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
stub 'exit 0'
rm -rf "$REPO/agent/node_modules"
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
# node exists (the hook looks for it), npx exists and refuses, as it does with
# no node_modules: the skip must name that, not crash on it.
printf '#!/bin/sh\nexit 0\n' >"$FAKEBIN/node"
printf '#!/bin/sh\nexit 1\n' >"$FAKEBIN/npx"
chmod +x "$FAKEBIN/node" "$FAKEBIN/npx"
OUT="$(cd "$REPO" && PATH="$FAKEBIN:/usr/bin:/bin" bash "$HOOK" <<<"refs/heads/x $(git rev-parse HEAD) refs/heads/x $BASE_SHA" 2>"$WORK/err")"
RC=$?
ERR="$(cat "$WORK/err")"
[ "$RC" -eq 0 ] && pass "exits 0, no crash" || fail "expected exit 0, got $RC" "stderr: $ERR"
case "$OUT$ERR" in
*'skip'*'stryker'*) pass "names the missing stryker" ;;
*) fail "no named skip for the missing dependency" "stdout: $OUT" "stderr: $ERR" ;;
esac

# --- a capped run refuses, and never prints a pass ------------------------
case_start "cap hit"
(
	cd "$REPO" && mkdir -p agent/extensions &&
		printf 'export const c = 7\n' >agent/extensions/cap.ts &&
		git add -A && git commit -q -m 'feat: extension'
)
stub 'printf "== mutate-changed: 1 added range(s)\n"; sleep 30'
OUT="$(cd "$REPO" && MUTATION_PREPUSH_CAP=1 bash "$HOOK" <<<"refs/heads/x $(git rev-parse HEAD) refs/heads/x $BASE_SHA" 2>"$WORK/err")"
RC=$?
ERR="$(cat "$WORK/err")"
[ "$RC" -ne 0 ] && pass "refuses the push (exit $RC)" || fail "a capped run was allowed through"
case "$ERR" in
*cap*'not a pass'* | *cap*) pass "names the cap" ;;
*) fail "no cap line" "stderr: $ERR" ;;
esac
case "$OUT$ERR" in
*'push allowed'*) fail "a capped run reported a pass" "stdout: $OUT" "stderr: $ERR" ;;
*) pass "no pass line" ;;
esac

# --- the gate is installed by the same command as the secret scan ---------
case_start "install-hooks wiring"
if grep -q 'scan-mutation.sh' "$HOOKS/install-hooks.sh"; then
	pass "install-hooks.sh calls scan-mutation.sh in its pre-push arm"
else
	fail "install-hooks.sh does not install the mutation gate"
fi
if grep -q 'scan-mutation.sh' "$HOOKS/pre-push"; then
	pass "the checked-in pre-push wrapper calls it"
else
	fail "git-hooks/pre-push is stale; run git-hooks/install-hooks.sh"
fi

printf '\n== scan-mutation: %d case(s), %d ok, %d failed\n' \
	"$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
