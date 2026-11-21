#!/usr/bin/env bash
# pi-resolve.sh — one answer to "where is pi, and how does this shell start it?".
#
# Sourced by bin/pi-bare, bin/pi-sandboxed and bin/pi-nonet. Run directly it prints the path it
# found and exits 0, or exits 127 with the reason, which is what scripts/tests/test-pi-resolve.sh
# drives.
#
# Why it exists: each wrapper used to carry one developer's Linux home
# (`/home/<user>/.local/share/pnpm/bin/pi`). On a Windows machine that path does not
# exist, so the tab the guard opened died on "no such file or directory", both Herdr menu entries
# started nothing, and the failure looked like five unrelated bugs. This file carries no home
# directory at all: every candidate below is built from $PI_BIN, $PATH, $PNPM_HOME, $HOME or
# %APPDATA% at runtime, so each platform resolves its own pi.
#
# Order — the first hit wins:
#   1. $PI_BIN, or $PI_BIN_PATH (the old name), when it is a file this shell can start
#   2. `pi` on PATH
#   3. $PNPM_HOME/pi, then $HOME/.local/share/pnpm/bin/pi
#   4. $HOME/.local/bin/pi
#   5. %APPDATA%\npm\pi, then %APPDATA%\npm\pi.cmd — native Windows, where npm's global prefix is
#      not usually on the PATH Git Bash inherits. Git Bash runs the extensionless `pi` (npm writes
#      it as a sh script); `pi.cmd` needs the shell to start it, which is what pi_exec does.
#
# A miss is one line naming PI_BIN and exit 127 — never a bare "not found" from the kernel.

# pi_is_win — is this shell the Git Bash / MSYS / Cygwin one? PI_PLATFORM=win32 is how a test says
# the same thing without a Windows host. Same reading as bin/guard, so the two agree.
pi_is_win() {
	case ${PI_PLATFORM:-} in win32 | win64 | windows*) return 0 ;; esac
	case ${OSTYPE:-} in msys* | cygwin* | win32) return 0 ;; esac
	[ -n "${MSYSTEM:-}" ] && return 0
	case $(uname -s 2>/dev/null) in MINGW* | MSYS* | CYGWIN*) return 0 ;; esac
	return 1
}

# pi_posix <path> — the spelling bash can open. %APPDATA% reaches Git Bash as a native Windows
# path (C:\Users\<you>\...), which no test or `[ -f ]` here can read; cygpath translates it.
pi_posix() {
	local p=${1:-}
	[ -n "$p" ] || return 0
	if pi_is_win && command -v cygpath >/dev/null 2>&1; then
		cygpath -u "$p" 2>/dev/null || printf '%s' "$p"
	else
		printf '%s' "$p"
	fi
}

# pi_runnable <path> — a file this shell can start. On Windows an .cmd has no shebang and still
# counts: the shell, not the kernel, is what starts it.
pi_runnable() {
	[ -n "${1:-}" ] && [ -f "$1" ] || return 1
	[ -x "$1" ] && return 0
	pi_is_win
}

# pi_take <path> — record the hit as an absolute path and the directory the wrappers put on PATH.
pi_take() {
	local dir
	dir=$(cd -- "$(dirname -- "$1")" 2>/dev/null && pwd) || dir=$(dirname -- "$1")
	PI_RESOLVED=$dir/$(basename -- "$1")
	PI_RESOLVED_DIR=$dir
}

# pi_resolve — set PI_RESOLVED and PI_RESOLVED_DIR, or print the one line and return 127.
pi_resolve() {
	local c
	PI_RESOLVED=
	PI_RESOLVED_DIR=

	# 1. an explicit override. An override that does not point at a runnable file falls through:
	#    a half-configured environment should still find a pi, and the message below names it.
	for c in "${PI_BIN:-}" "${PI_BIN_PATH:-}"; do
		[ -n "$c" ] || continue
		c=$(pi_posix "$c")
		if pi_runnable "$c"; then
			pi_take "$c"
			return 0
		fi
	done

	# 2. whatever `pi` is on PATH.
	c=$(command -v pi 2>/dev/null || true)
	if pi_runnable "$c"; then
		pi_take "$c"
		return 0
	fi

	# 3. the pnpm bin directory: PNPM_HOME when set, else pnpm's default under the home.
	for c in "${PNPM_HOME:+$PNPM_HOME/pi}" "${HOME:+$HOME/.local/share/pnpm/bin/pi}"; do
		[ -n "$c" ] || continue
		c=$(pi_posix "$c")
		if pi_runnable "$c"; then
			pi_take "$c"
			return 0
		fi
	done

	# 4. ~/.local/bin, where ~/.local/bin/pi or a hand-made symlink lives.
	c=$(pi_posix "${HOME:+$HOME/.local/bin/pi}")
	if pi_runnable "$c"; then
		pi_take "$c"
		return 0
	fi

	# 5. native Windows: %APPDATA%\npm, npm's global prefix there.
	if pi_is_win; then
		local appdata
		appdata=$(pi_posix "${APPDATA:-${HOME:+$HOME/AppData/Roaming}}")
		for c in "${appdata:+$appdata/npm/pi}" "${appdata:+$appdata/npm/pi.cmd}"; do
			[ -n "$c" ] || continue
			if pi_runnable "$c"; then
				pi_take "$c"
				return 0
			fi
		done
	fi

	printf 'pi-resolve: cannot find pi; set PI_BIN to the pi executable (tried PI_BIN_PATH, PATH, %s, %s)\n' \
		"${PNPM_HOME:-${HOME:-~}/.local/share/pnpm/bin}/pi" "${HOME:-~}/.local/bin/pi" >&2
	return 127
}

# pi_exec <args...> — replace this shell with the pi that pi_resolve found. The caller exports the
# environment it wants (PI_BARE, PI_WORKER) instead of going through `env`: `env` is a bare exec,
# and a .cmd on the Windows path has no shebang for it, so the shell has to be the one that starts
# it. For an ordinary executable this is the same process replacement as before.
pi_exec() {
	[ -n "${PI_RESOLVED:-}" ] || pi_resolve || return 127
	exec "$PI_RESOLVED" "$@"
}

# Executed, not sourced: print the answer, so a test can drive the resolution on its own.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	pi_resolve && printf '%s\n' "$PI_RESOLVED"
fi
