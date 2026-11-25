#!/usr/bin/env bash
# herdr-resume — the launcher for scripts/herdr-resume.mjs.
#
# Radar basis: #95 Herdr.
#
# Why a shell wrapper for a node script: a systemd user unit and a login shell
# disagree about PATH. `node` on this machine can come from /usr/bin, fnm or
# pnpm, and a unit that says `env node` finds none of them before the first
# login. This is the same resolution `scripts/pi-bare` does for `pi`.
#
# The logic lives in the .mjs file; this only finds node and execs.
#
# A Windows caller hands bash a backslash path as `$0` — Task Scheduler's launcher does,
# `"C:\Users\..\bash.exe" -lc "exec 'C:\Users\..\herdr-resume.sh'"` — and `readlink -f`
# answers `C:\c\Users\..` for it, so node was told to open a file that is nowhere (measured
# 2026-11-24: "Cannot find module 'C:\c\Users\markm\.pi\scripts\herdr-resume.mjs'"). Asking
# cygpath once, only for a drive-lettered path, keeps the POSIX path POSIX.
set -uo pipefail

self=${BASH_SOURCE[0]}
case $self in
[A-Za-z]:*) self=$(cygpath -u -- "$self" 2>/dev/null || printf '%s' "$self") ;;
esac
here=$(cd -- "$(dirname -- "$(readlink -f -- "$self")")" && pwd)
script="$here/herdr-resume.mjs"
# node is a native program: it reads /c/Users/.. as C:\c\Users\.., so hand it the Windows
# spelling of the same file. cygpath is Git-for-Windows' own and is absent on Linux, where
# the POSIX path is already the one node wants.
if command -v cygpath >/dev/null 2>&1; then
	script=$(cygpath -w -- "$script")
fi
[ -f "$script" ] || { printf 'herdr-resume: %s not found\n' "$script" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
	for candidate in "$HOME/.local/share/pnpm/bin" "/usr/local/bin" "/usr/bin"; do
		if [ -x "$candidate/node" ]; then
			PATH="$candidate:$PATH"
			export PATH
			break
		fi
	done
fi

if ! command -v node >/dev/null 2>&1; then
	printf 'herdr-resume: node not found in PATH (%s)\n' "$PATH" >&2
	exit 1
fi

exec node "$script" "$@"
