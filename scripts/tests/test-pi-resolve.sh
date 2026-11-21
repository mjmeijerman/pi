#!/usr/bin/env bash
# Tests for bin/pi-resolve.sh: the one answer to "where is pi" that bin/pi-bare,
# bin/pi-sandboxed and bin/pi-nonet all source.
#
# Why these exist: each wrapper used to carry one developer's home directory, so the tab the guard
# opened died on "no such file or directory" on a machine with a different home, and the failure
# looked like five unrelated bugs. The fix is one resolver with a documented order, and this file is
# the check that the order is still that order. The ported tree is the other half: the resolver was
# copied out of a separate checkout into ~/.pi/bin, and a copy that still needed that checkout would pass
# a syntax check and fail the first tab — hence the last case, which runs the same file from a
# directory that is not the repo and asserts the same answer.
#
# Cheap on purpose: no network, no pi session, temp dirs under one mktemp -d, every candidate a
# fixture of this test.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOLVE="$ROOT_DIR/bin/pi-resolve.sh"
[ -f "$RESOLVE" ] || {
	printf 'FATAL: %s is missing\n' "$RESOLVE" >&2
	exit 1
}
BASH_BIN="$(command -v bash)"

WORK="$(readlink -f "$(mktemp -d)")"
trap 'rm -rf -- "$WORK"' EXIT

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
	[ "$#" -eq 0 ] || printf '%s\n' "$@" | sed 's/^/     /'
}

case_start() {
	CASE_N=$((CASE_N + 1))
	CASE="$1"
	OUT=""
	ERR=""
	RC=0
}

# resolve <resolver> [VAR=value ...] — run the resolver in a stripped environment: no inherited
# PATH, no inherited PI_BIN, so the only candidates are the fixtures this case planted.
resolve() {
	local resolver=$1
	shift
	OUT=$(env -i HOME="$WORK/home" PATH="${CASE_PATH:-$WORK/empty}" "$@" "$BASH_BIN" "$resolver" 2>"$WORK/stderr")
	RC=$?
	ERR="$(cat "$WORK/stderr")"
}
has() { case $OUT in *"$1"*) return 0 ;; esac; return 1; }
err_has() { case $ERR in *"$1"*) return 0 ;; esac; return 1; }

# pi_at <path> — an executable named pi, the thing every candidate is looking for.
pi_at() {
	mkdir -p "$(dirname -- "$1")"
	printf '#!/bin/sh\n' >"$1"
	chmod +x "$1"
}

mkdir -p "$WORK/home" "$WORK/empty" "$WORK/bin" "$WORK/custom" "$WORK/pnpm" "$WORK/appdata/npm" \
	"$WORK/home/.local/bin" "$WORK/elsewhere" "$WORK/core"
# pi_take needs dirname, and the hit cases must run with no pi on PATH: a PATH of two symlinks is
# both. Anything that is not listed here is absent on purpose, including any pi the host has.
ln -s "$(command -v dirname)" "$WORK/core/dirname"
ln -s "$(command -v basename)" "$WORK/core/basename"
ln -s "$(command -v uname)" "$WORK/core/uname"
CORE_PATH="$WORK/core"

# ------------------------------------------- 1. the explicit override --
case_start "PI_BIN wins"
pi_at "$WORK/custom/pi"
CASE_PATH="$WORK/bin:/usr/bin:/bin"
resolve "$RESOLVE" PI_BIN="$WORK/custom/pi"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/custom/pi" ]; then pass 'prints the PI_BIN path'; else fail "rc=$RC out=$OUT err=$ERR"; fi

case_start "PI_BIN_PATH, the old name, still works"
resolve "$RESOLVE" PI_BIN_PATH="$WORK/custom/pi"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/custom/pi" ]; then pass 'prints the PI_BIN_PATH path'; else fail "rc=$RC out=$OUT err=$ERR"; fi

# ------------------------------------------- 2. PATH --
case_start "a pi on PATH is found"
pi_at "$WORK/bin/pi"
resolve "$RESOLVE"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/bin/pi" ]; then pass 'prints the PATH hit'; else fail "rc=$RC out=$OUT err=$ERR"; fi

case_start "a useless PI_BIN falls through to PATH"
printf 'not a program\n' >"$WORK/custom/notpi"
resolve "$RESOLVE" PI_BIN="$WORK/custom/notpi"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/bin/pi" ]; then pass 'a half-configured environment still finds a pi'; else fail "rc=$RC out=$OUT err=$ERR"; fi

# ------------------------------------------- 3. and 4. the home candidates --
case_start "PNPM_HOME is searched"
rm -f "$WORK/bin/pi"
pi_at "$WORK/pnpm/pi"
CASE_PATH="$CORE_PATH"
resolve "$RESOLVE" PNPM_HOME="$WORK/pnpm"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/pnpm/pi" ]; then pass 'prints the pnpm hit'; else fail "rc=$RC out=$OUT err=$ERR"; fi

case_start "HOME/.local/bin is searched"
pi_at "$WORK/home/.local/bin/pi"
resolve "$RESOLVE"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/home/.local/bin/pi" ]; then pass 'prints the ~/.local/bin hit'; else fail "rc=$RC out=$OUT err=$ERR"; fi
rm -f "$WORK/home/.local/bin/pi"

# ------------------------------------------- 5. native Windows --
case_start "win32: %APPDATA%\\npm is searched, and needs no exec bit"
pi_at "$WORK/appdata/npm/pi"
chmod -x "$WORK/appdata/npm/pi"
resolve "$RESOLVE" PI_PLATFORM=win32 APPDATA="$WORK/appdata"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$WORK/appdata/npm/pi" ]; then pass 'prints the npm hit without the executable bit'; else fail "rc=$RC out=$OUT err=$ERR"; fi

case_start "win32: a miss is still the one line and 127"
rm -rf "$WORK/appdata/npm"
resolve "$RESOLVE" PI_PLATFORM=win32 APPDATA="$WORK/appdata"
if [ "$RC" -eq 127 ]; then pass 'exits 127'; else fail "expected 127, got $RC"; fi
if err_has 'cannot find pi' && err_has 'PI_BIN'; then pass 'names PI_BIN on stderr'; else fail "stderr: $ERR"; fi
if [ -z "$OUT" ]; then pass 'prints nothing on stdout'; else fail "stdout: $OUT"; fi

# ------------------------------------------- 6. the ported tree --
# The whole port in one case: the same file, copied out of the repo, answers the same question.
case_start "the resolver's answer does not depend on the tree it sits in"
cp "$RESOLVE" "$WORK/elsewhere/pi-resolve.sh"
pi_at "$WORK/custom/pi"
CASE_PATH="$WORK/bin:/usr/bin:/bin"
HERE_ONLY=$(env -i HOME="$WORK/home" PATH="$CASE_PATH" PI_BIN="$WORK/custom/pi" "$BASH_BIN" "$RESOLVE" 2>&1)
ELSEWHERE=$(env -i HOME="$WORK/home" PATH="$CASE_PATH" PI_BIN="$WORK/custom/pi" "$BASH_BIN" "$WORK/elsewhere/pi-resolve.sh" 2>&1)
if [ -n "$HERE_ONLY" ] && [ "$HERE_ONLY" = "$ELSEWHERE" ]; then
	pass "both copies print $HERE_ONLY"
else
	fail 'the copies disagree' "repo: $HERE_ONLY" "elsewhere: $ELSEWHERE"
fi
OUT=$HERE_ONLY
if case "$OUT" in */pi-master/*) false ;; *) true ;; esac; then pass 'neither answer points into a deleted tree'; else fail "answer: $OUT"; fi

# ------------------------------------------- verdict --
printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
