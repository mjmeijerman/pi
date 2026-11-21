#!/usr/bin/env bash
# Tests for systemd/pi-guard.service — the unit that starts the space
# supervisor at login.
#
# Why this exists: the unit used to start a guard from another checkout, the
# pre-space copy that knows one hard-coded workspace and can restore nothing
# recorded in `~/.pi/state/spaces/`. That unit installed cleanly and kept one
# space alive while every other space which vanished stayed vanished — a green
# `systemctl --user status` over the wrong promise. So the line itself is pinned
# here: `ExecStart` must be `%h/.pi/bin/guard`, and the `Description=` must say
# what the supervisor does instead of naming the one workspace it no longer is.
#
# The unit is read off the disk, not grepped out of an installer: a test that
# asserts on install.mjs would pass while the unit still points at the old guard.
#
# Run it directly, or through `scripts/ci-offline.sh`, which globs
# scripts/tests/test-*.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT="$ROOT/systemd/pi-guard.service"

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""

begin() {
	CASE="$1"
	CASE_N=$((CASE_N + 1))
}
ok() {
	PASS_N=$((PASS_N + 1))
	printf '   ok   %s\n' "$1"
}
bad() {
	FAIL_N=$((FAIL_N + 1))
	printf '   FAIL %s\n' "$1"
}
# check <description> <expected> <actual>
check() {
	if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi
}

if [ ! -f "$UNIT" ]; then
	printf 'FATAL: %s is missing — the login entry has no unit to install\n' "$UNIT" >&2
	exit 1
fi

TEXT="$(cat "$UNIT")"

begin 'the unit starts the supervisor in ~/.pi'
# Exactly one ExecStart, and it is the supervisor's path: two lines would let the
# old guard be the one systemd runs.
exec_starts="$(printf '%s\n' "$TEXT" | grep -c '^ExecStart=' || true)"
check 'one ExecStart line' '1' "$exec_starts"
exec_line="$(printf '%s\n' "$TEXT" | grep '^ExecStart=' || true)"
check 'ExecStart is %h/.pi/bin/guard' 'ExecStart=%h/.pi/bin/guard' "$exec_line"

begin 'the unit starts this tree and nothing else'
# The copy that knew one hard-coded workspace restored no recorded space: any
# second program path in the unit means that copy is back.
paths="$(printf '%s\n' "$TEXT" | grep -oE '/[^ "]*bin/guard' | sort -u | tr '\n' ' ')"
case "$paths" in
'/.pi/bin/guard ') ok 'the only program path in the unit is %h/.pi/bin/guard' ;;
*) bad "the unit names a second program path: [$paths]" ;;
esac

begin 'the description says what it does, not which workspace it is'
description="$(printf '%s\n' "$TEXT" | sed -n 's/^Description=//p' | head -n 1)"
if [ -z "$description" ]; then
	bad 'the unit has no Description='
else
	ok 'Description= is present'
fi
case "$description" in
*'every recorded space'*) ok 'the description names the recorded spaces' ;;
*) bad "the description does not say it keeps every recorded space: [$description]" ;;
esac
case "$description" in
*'Boss tab'*) ok 'the description names the Boss tab' ;;
*) bad "the description does not name the Boss tab: [$description]" ;;
esac
case "$description" in
*login*) ok 'the description says it runs at login' ;;
*) bad "the description does not say it opens them on login: [$description]" ;;
esac
# One workspace named in the description is the old promise in new words.
for workspace in "$(basename "$HOME")-bespoke" archive; do
	case "$description" in
	*"$workspace"*) bad "the description names a single workspace: [$description]" ;;
	*) ok "the description does not name $workspace" ;;
	esac
done

begin 'it can be enabled into a login entry'
wanted="$(printf '%s\n' "$TEXT" | sed -n 's/^WantedBy=//p' | head -n 1)"
check 'WantedBy=default.target' 'default.target' "$wanted"

printf '\n== test-guard-unit: %d case(s), %d assertion(s), %d failed\n' "$CASE_N" "$((PASS_N + FAIL_N))" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
