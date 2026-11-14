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
set -uo pipefail

here=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)
script="$here/herdr-resume.mjs"
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
