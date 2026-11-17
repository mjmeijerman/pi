#!/usr/bin/env bash
# Tests that a gate which fails says why — the failure paths, not the source.
#
# Why these exist: agent/retro/2026-11-15.md records "(no output) Command exited
# with code 1" 9 times and the code-2 twin 4 times, the two most common silent
# failures in 707 recorded problems. A person reading that line learns nothing:
# which gate refused, over what, and what to do next are all missing.
#
# Grepping the sources for a bare `exit 1` is not a guard — it passes on a tree
# where the message exists but the path that reaches it does not. So every case
# here runs a real failure path of a real script in a throwaway tree and asserts
# two things together: the exit status, and that stderr carried something. The
# success cases assert the other half of the contract: a passing run stays off
# stderr, so the messages stay worth reading.
#
# Cheap on purpose: no network, no model, no stryker, temp dirs under one
# mktemp -d. Run it by hand, or through `make scripts-test`, which globs
# scripts/tests/*.test.sh.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
ERR=""
STATUS=0

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
	DIR="$WORK/case$CASE_N"
	mkdir -p "$DIR"
	OUT=""
	ERR=""
	STATUS=0
}

# run — the command's verdict in STATUS, its two streams in OUT and ERR.
run() {
	OUT="$("$@" 2>"$DIR/stderr")"
	STATUS=$?
	ERR="$(cat "$DIR/stderr")"
}

# expect_failed — nonzero, and stderr says something (optionally: a needle).
expect_failed() {
	local needle=${1:-}
	if [ "$STATUS" -eq 0 ]; then
		fail "expected a non-zero exit" "stdout: ${OUT:-<empty>}" "stderr: ${ERR:-<empty>}"
		return 1
	fi
	if [ -z "$ERR" ]; then
		fail "the failure was silent: exit $STATUS, nothing on stderr" "stdout: ${OUT:-<empty>}"
		return 1
	fi
	if [ -n "$needle" ] && ! printf '%s' "$ERR" | grep -qF -- "$needle"; then
		fail "stderr does not say '$needle'" "$ERR"
		return 1
	fi
	pass "exit $STATUS, stderr names the failure"
}

# expect_quiet_success — exit 0, and nothing on stderr.
expect_quiet_success() {
	if [ "$STATUS" -ne 0 ]; then
		fail "expected exit 0, got $STATUS" "$ERR"
		return 1
	fi
	if [ -n "$ERR" ]; then
		fail "a passing run wrote to stderr (noise)" "$ERR"
		return 1
	fi
	pass "exit 0, stderr empty"
}

# ------------------------------------------------- mutate-changed, no agent/ ---
# A patch that adds one line under agent/extensions: the script reads a real
# `git diff -U0` body now, so a list of paths is no longer something it can
# answer. The range it derives is `extensions/merge-guard.ts:2-2`.
patch_adds_one_line() {
	cat >"$1" <<'PATCH'
diff --git a/agent/extensions/merge-guard.ts b/agent/extensions/merge-guard.ts
--- a/agent/extensions/merge-guard.ts
+++ b/agent/extensions/merge-guard.ts
@@ -1,0 +2,1 @@
+export const guard = 1;
PATCH
}

case_start "mutate-changed in a tree with no agent/ says which directory is missing"
mkdir -p "$DIR/bin"
cp -- "$ROOT_DIR/scripts/mutate-changed.sh" "$DIR/bin/mutate-changed.sh"
patch_adds_one_line "$DIR/diff.txt"
run bash "$DIR/bin/mutate-changed.sh" --patch-file "$DIR/diff.txt"
expect_failed 'agent is missing'

# --------------------------------------- harness-check --write-skills-lock ---
case_start "a skills lock that cannot be written is a failure, not 'written'"
mkdir -p "$DIR/root/agent/skills/demo"
printf '# demo\n' >"$DIR/root/agent/skills/demo/SKILL.md"
chmod 555 "$DIR/root/agent"
run bash "$ROOT_DIR/scripts/harness-check.sh" --root "$DIR/root" --write-skills-lock
chmod 755 "$DIR/root/agent"
expect_failed 'cannot write'

case_start "a lock directory where the lock file belongs is named, not written into"
mkdir -p "$DIR/root/agent/skills/demo" "$DIR/root/agent/skills.lock"
printf '# demo\n' >"$DIR/root/agent/skills/demo/SKILL.md"
run bash "$ROOT_DIR/scripts/harness-check.sh" --root "$DIR/root" --write-skills-lock
expect_failed 'not the lock file'

# --------------------------------------------------------------- pr-gate red ---
case_start "pr-gate red puts the verdict on stderr, not only on stdout"
mkdir -p "$DIR/repo"
printf 'Title only, no Mission line, no tier\n' >"$DIR/body.md"
printf 'agent/extensions/x.ts\n' >"$DIR/paths.txt"
run bash "$ROOT_DIR/scripts/pr-gate.sh" --body "$DIR/body.md" --paths "$DIR/paths.txt"
expect_failed 'pr-gate: red'

# ------------------------------------------------ scan-prepush, unreadable ref ---
case_start "a pre-push scan that cannot list commits fails instead of passing"
git init -q "$DIR/repo"
printf 'nothing to see\n' >"$DIR/repo/README.md"
git -C "$DIR/repo" add -A >/dev/null 2>&1
git -C "$DIR/repo" commit -q --no-gpg-sign -m 'init' >/dev/null 2>&1
OUT="$(cd "$DIR/repo" && printf 'refs/heads/x 1111111111111111111111111111111111111111 refs/heads/x 0000000000000000000000000000000000000000\n' |
	SKIP_SECRET_SCAN=0 bash "$ROOT_DIR/git-hooks/scan-prepush.sh" 2>"$DIR/stderr")"
STATUS=$?
ERR="$(cat "$DIR/stderr")"
expect_failed 'NOT scanned'

# ----------------------------------------------------- agent-pane, no such slug ---
case_start "agent-pane names the program and the next step, not just the slug"
run env STATE="$DIR/state.json" bash "$ROOT_DIR/scripts/agent-pane.sh" show nosuch
expect_failed "no entry for 'nosuch'"

# ------------------------------------------- a passing run stays off stderr ---
case_start "mutate-changed --list-only on a good listing is silent on stderr"
patch_adds_one_line "$DIR/diff.txt"
run bash "$ROOT_DIR/scripts/mutate-changed.sh" --patch-file "$DIR/diff.txt" --list-only
expect_quiet_success
if [ "$OUT" != "extensions/merge-guard.ts:2-2" ]; then
	fail "the glob list changed" "got: ${OUT:-<empty>}"
else
	pass "the list is still the branch's file"
fi

case_start "an override that skips the scan is a success and says nothing"
OUT="$(printf 'refs/heads/x 1111111111111111111111111111111111111111 refs/heads/x 0000000000000000000000000000000000000000\n' |
	SKIP_SECRET_SCAN=1 bash "$ROOT_DIR/git-hooks/scan-prepush.sh" 2>"$DIR/stderr")"
STATUS=$?
ERR="$(cat "$DIR/stderr")"
expect_quiet_success

# ------------------------------------------------------------------- summary ---
printf '\n== quiet-failures: %d case(s), %d ok, %d failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
