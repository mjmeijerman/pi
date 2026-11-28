#!/usr/bin/env bash
# Tests for git-hooks/scan-identity.sh — the pre-push gate on who is pushing.
#
# Why these exist: the gate is the one thing that stands between an agent and the owner's own
# GitHub key, and it got the two answers it cannot get wrong backwards in the same week. First it
# let an agent push as Mark; then it refused every agent push to github.com, including the harness
# publishing its own work, so `bin/delegate finish` died at publish with no way through but
# PI_ALLOW_HUMAN_IDENTITY=1. The rule is now in the record (`identity: "owner"`), and each case
# here pins one side of it:
#
#   1. a space whose record says the pushes are the owner's is allowed, and says so;
#   2. the same record without that field is refused;
#   3. no record matching the url is refused, even when other records exist;
#   4. `$PI_SPACE` names the space when the url alone would not match;
#   5. the escape variable is still allowed, and still names itself;
#   6. the agent alias, a non-github url, and a human session are allowed as before.
#
# No network, no real repo: the hook is fed a ref line on stdin, the way git feeds it. Point
# PI_IDENTITY_HOOKS at another `git-hooks/` (trunk's, before this change) to run the same cases
# against older code, which is how the report shows the first case failing before the fix.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS=${PI_IDENTITY_HOOKS:-$ROOT/git-hooks}
HOOK="$HOOKS/scan-identity.sh"
[ -x "$HOOK" ] || {
	printf 'FATAL: %s is missing or not executable\n' "$HOOK" >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	printf 'FATAL: node is not on PATH\n' >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
RECORDS="$PI_SPACE_ROOT/state/spaces"
mkdir -p "$HOME" "$RECORDS/harness" "$RECORDS/other" "$RECORDS/side"

URL='git@github.com:mjmeijerman/pi.git'
OTHER_URL='git@github.com:acme/other.git'

# record <space> <json> — one space record, exactly as the case wrote it.
record() {
	printf '%s\n' "$2" >"$RECORDS/$1/space.json"
}

record harness "{\"name\":\"harness\",\"remote\":\"$URL\",\"identity\":\"owner\"}"
record other "{\"name\":\"other\",\"remote\":\"$OTHER_URL\"}"

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
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

# run_hook <url> [env assignments...] — feed one ref line, capture both streams and the code.
# The environment is reset to an agent session on every call, so a case cannot pass on a variable
# the case before it left behind.
run_hook() {
	local url=$1
	shift
	CASE_N=$((CASE_N + 1))
	OUT="$(env -u PI_SPACE -u PI_ALLOW_HUMAN_IDENTITY -u PI_SESSION_ID -u PI_WORKER \
		PI_WORKER=w1 "$@" bash "$HOOK" origin "$url" \
		<<<"refs/heads/fix/x 1111111111111111111111111111111111111111 refs/heads/fix/x 0000000000000000000000000000000000000000" \
		2>"$WORK/err")"
	RC=$?
	ERR="$(cat "$WORK/err")"
}

# --- 1. the owner's own space is allowed, and says which record allowed it -----
CASE="owner record"
run_hook "$URL"
[ "$RC" -eq 0 ] && pass "the push is allowed (exit 0)" || fail "expected exit 0, got $RC" "stderr: $ERR"
case "$ERR" in
*harness*eigenaar*) pass "names the space and the reason" ;;
*) fail "no line naming the record that allowed it" "stderr: $ERR" ;;
esac

# --- 2. a record without the field is refused --------------------------------
CASE="agent record"
run_hook "$OTHER_URL"
[ "$RC" -ne 0 ] && pass "the push is refused (exit $RC)" || fail "an agent space was allowed to push as the owner"
case "$ERR" in
*'de sleutel van Mark'*) pass "says whose key it is" ;;
*) fail "no refusal line" "stderr: $ERR" ;;
esac
case "$ERR" in
*PI_ALLOW_HUMAN_IDENTITY=1*) pass "names the escape" ;;
*) fail "no escape line" "stderr: $ERR" ;;
esac

# --- 3. no record matches the url -------------------------------------------
CASE="no record"
run_hook 'git@github.com:someone/else.git'
[ "$RC" -ne 0 ] && pass "refused with no record to read" || fail "a push with no record was allowed"
case "$ERR" in
*'de sleutel van Mark'*) pass "says whose key it is" ;;
*) fail "no refusal line" "stderr: $ERR" ;;
esac

# --- 4. $PI_SPACE names the space the url alone would not reach --------------
# The named space must be the one that decides: allowed when it says owner, refused when it does
# not, whatever the url alone would have found.
CASE="PI_SPACE names the owner's space"
record side "{\"name\":\"side\",\"remote\":\"$URL\",\"identity\":\"owner\"}"
run_hook "$URL" PI_SPACE=harness
[ "$RC" -eq 0 ] && pass "the push is allowed (exit 0)" || fail "expected exit 0, got $RC" "stderr: $ERR"
case "$ERR" in
*harness*eigenaar*) pass "names the space it read" ;;
*) fail "no line naming the space" "stderr: $ERR" ;;
esac
run_hook "$OTHER_URL" PI_SPACE=side
[ "$RC" -eq 0 ] && pass "a space that says owner is allowed when named" ||
	fail "expected exit 0 for the named owner's space, got $RC" "stderr: $ERR"
run_hook "$URL" PI_SPACE=other
[ "$RC" -ne 0 ] && pass "a named space without the field is still refused" ||
	fail "naming an agent space as PI_SPACE let it through"

# --- 5. the escape variable ----------------------------------------------------
CASE="escape variable"
run_hook "$URL" PI_ALLOW_HUMAN_IDENTITY=1
[ "$RC" -eq 0 ] && pass "the push is allowed (exit 0)" || fail "expected exit 0, got $RC" "stderr: $ERR"
case "$ERR" in
*PI_ALLOW_HUMAN_IDENTITY=1*) pass "says it went through the escape" ;;
*) fail "the escape was silent" "stderr: $ERR" ;;
esac

# --- 6. what was allowed before is still allowed -------------------------------
CASE="agent alias"
run_hook 'git@github-vlek:mjmeijerman/pi.git'
[ "$RC" -eq 0 ] && [ -z "$ERR" ] && pass "allowed, and silent" ||
	fail "the agent alias was refused or noisy" "exit: $RC" "stderr: $ERR"

CASE="not github"
run_hook 'ssh://git@gitlab.com/acme/other.git'
[ "$RC" -eq 0 ] && [ -z "$ERR" ] && pass "allowed, and silent" ||
	fail "a non-github push was refused or noisy" "exit: $RC" "stderr: $ERR"

CASE="the person, not a session"
OUT="$(env -u PI_SESSION_ID -u PI_WORKER bash "$HOOK" origin "$URL" <<<"refs/heads/x 1111 refs/heads/x 0000" 2>"$WORK/err")"
RC=$?
ERR="$(cat "$WORK/err")"
[ "$RC" -eq 0 ] && [ -z "$ERR" ] && pass "a human push is allowed, and silent" ||
	fail "a push with no PI session was refused or noisy" "exit: $RC" "stderr: $ERR"

# --- the gate is installed by the same command as the other push scans --------
CASE="install-hooks wiring"
if grep -q 'scan-identity.sh' "$HOOKS/install-hooks.sh"; then
	pass "install-hooks.sh calls scan-identity.sh in its pre-push arm"
else
	fail "install-hooks.sh does not install the identity gate"
fi

printf '\n== scan-identity: %d case(s), %d ok, %d failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
