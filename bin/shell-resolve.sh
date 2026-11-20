# shell-resolve.sh — one answer to "which bash runs this file", and the re-exec that makes it true.
#
# Sourced, never executed, at the very top of every bash entry point in bin/, at top level and
# before anything else runs:
#
#   self_dir=$(dirname -- "$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")")
#   . "$self_dir/shell-resolve.sh"
#
# Top level matters: this file hands `$@` to the bash it starts, and `$@` inside a function is the
# function's arguments, not the script's.
#
# The source above is conditional, and that is not politeness: the installer copies a wrapper onto
# PATH on Windows instead of linking it, so the copy sits beside no resolver. Such a copy is always
# started by the `.cmd` shim next to it, which names a bash — the resolver is only needed when the
# shell is *not* bash, and a missing one is then the honest line and exit 127 the prelude prints,
# not a "cannot open" from a file the script never got to. An engine that copies a wrapper should
# copy this file beside it; ~/.pi\install.mjs does not yet, which the report for this change names.
#
# Why it exists: each of those files starts `#!/usr/bin/env bash` and then trusted it. On Windows
# the shell that runs them may be `cmd.exe` (that is what the generated `delegate.cmd` shim hands
# over), PowerShell, or a minimal Git Bash where `bash` is not on PATH and only `sh.exe` sits in
# `usr\bin`. A shebang is a promise only a Linux kernel keeps, so the first bash-only construct
# then fails ten lines deep with "command not found" and the script's own message never appears.
# So: nothing runs until the shell running it *is* bash. If it is not, re-exec under a bash that
# was resolved here, original argv untouched, once.
#
# The test is `$BASH_VERSION`: any shell that sets it is bash or is emulating it, which is exactly
# the question being asked. An already-bash run does nothing here at all — no resolution, no fork —
# which is what keeps a script that sources another (bin/publish sources bin/delegate) cheap.
#
# Order — the first hit wins, and `PI_SHELL_VERBOSE=1` says which step it was:
#   1. $PI_GIT_BASH — explicit, and it wins over a `bash` on PATH on purpose,
#   2. `bash` on PATH,
#   3. %ProgramFiles%\Git\bin\bash.exe,
#   4. %ProgramFiles%\Git\usr\bin\bash.exe,
#   5. %ProgramFiles(x86)%\Git\bin\bash.exe,
#   6. %LOCALAPPDATA%\Programs\Git\bin\bash.exe.
#
# 3–6 are the candidates `scripts/install-lib.mjs:gitBashCandidates` in ~/.pi resolves, in the same
# order and for the same reasons: that file is the source of truth, and it is the list the `.cmd`
# shim beside a wrapper is built from, so the shim a person runs and the script it starts agree on
# where bash is. Read the two together when either changes.
#
# A hit is resolved through `readlink -f`, so the exec target is the real file: `~/.local/bin/bash`
# is a link on a pnpm-style install, and handing a link to exec is how a wrapper re-execs itself
# forever. A miss is one line and exit 127 — never the kernel's "not found" from ten lines deep.
#
# Sourced by `sh` before the re-exec, so nothing below uses bash-only syntax. shellcheck lints it as
# bash because bash is the shell this file ends up running under.
# shellcheck shell=bash

shell_prog() { printf '%s' "${0##*/}"; }

shell_verbose() { [ -n "${PI_SHELL_VERBOSE:-}" ]; }

# shell_say <message> — the one thing verbose mode adds: which step found bash, and which step was
# passed over and why. Silent otherwise, and always returns 0 so `set -e` in a caller stays quiet.
shell_say() {
	shell_verbose && printf '%s: %s\n' "$(shell_prog)" "$*" >&2
	return 0
}

shell_is_bash() { [ -n "${BASH_VERSION:-}" ]; }

shell_is_win() {
	case ${OSTYPE:-} in msys* | cygwin* | win32) return 0 ;; esac
	case ${PI_PLATFORM:-} in win32 | win64 | windows*) return 0 ;; esac
	[ -n "${MSYSTEM:-}" ]
}

# shell_real <path> — the file behind the link, or the path itself when there is no link to resolve
# (a test fixture, a file that is already real, a host without `readlink -f`).
shell_real() {
	local r
	if command -v readlink >/dev/null 2>&1; then
		r=$(readlink -f -- "$1" 2>/dev/null || true)
		[ -n "$r" ] && {
			printf '%s\n' "$r"
			return 0
		}
	fi
	printf '%s\n' "$1"
}

# shell_usable <path> — a file this shell can hand to exec. On Git Bash an .exe runs without the
# executable bit, which is why the mode test is not the whole answer.
shell_usable() {
	[ -n "${1:-}" ] && [ -f "$1" ] || return 1
	[ -x "$1" ] && return 0
	shell_is_win
}

# shell_resolve — set SHELL_BASH (and SHELL_FROM, the step that found it), or print the one line
# and return 127.
shell_resolve() {
	local c base pf pf86 la

	SHELL_BASH=
	SHELL_FROM=

	# 1. the explicit override. A wrong one is named and stopped at, not passed over: PI_GIT_BASH
	#    exists for the machine whose bash is not where PATH says (WSL's launcher is named bash and
	#    is not Git Bash), so falling through to PATH is how the wrapper quietly starts the shell
	#    the person set this variable to avoid. install-lib.mjs makes the same promise.
	if [ -n "${PI_GIT_BASH:-}" ]; then
		if shell_usable "${PI_GIT_BASH}"; then
			SHELL_BASH=$(shell_real "${PI_GIT_BASH}")
			SHELL_FROM=PI_GIT_BASH
			return 0
		fi
		printf '%s: PI_GIT_BASH=%s is not a runnable bash\n' "$(shell_prog)" "${PI_GIT_BASH}" >&2
		return 127
	fi

	# 2. whatever `bash` is on PATH — unless it is %SystemRoot%\System32\bash.exe, which is WSL's
	#    launcher: it is named bash, it is not Git Bash, and a C:\ script path handed to it is a
	#    Linux shell that cannot open the file. install-lib filters the same path out of PATH.
	c=$(command -v bash 2>/dev/null || true)
	if shell_usable "$c"; then
		base=$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')
		case $base in
		*/system32/bash.exe) shell_say "passing over $c (WSL's launcher, not Git Bash)" ;;
		*)
			SHELL_BASH=$(shell_real "$c")
			SHELL_FROM=PATH
			return 0
			;;
		esac
	fi

	# 3–6. Git for Windows, spelled with forward slashes: bash reads
	#      `C:/Program Files/Git/bin/bash.exe`, and so does a test whose fixture is a directory of
	#      that name — a backslash spelling can only be read on Windows itself.
	pf=${PROGRAMFILES:-${ProgramFiles:-}}
	pf86=$(printenv 'ProgramFiles(x86)' 2>/dev/null || printenv 'PROGRAMFILES(X86)' 2>/dev/null || true)
	la=${LOCALAPPDATA:-${LocalAppData:-}}
	for c in \
		"${pf:+$pf/Git/bin/bash.exe}" \
		"${pf:+$pf/Git/usr/bin/bash.exe}" \
		"${pf86:+$pf86/Git/bin/bash.exe}" \
		"${la:+$la/Programs/Git/bin/bash.exe}"; do
		[ -n "$c" ] || continue
		if shell_usable "$c"; then
			SHELL_BASH=$(shell_real "$c")
			SHELL_FROM="Git for Windows"
			return 0
		fi
	done

	printf '%s: no bash found — set PI_GIT_BASH=/path/to/bash.exe\n' "$(shell_prog)" >&2
	return 127
}

# The whole point of sourcing this file, at top level so `$@` and `$0` are the script's own.
if ! shell_is_bash; then
	# Re-exec'ed once already and still not bash: what was found is not bash. Naming the file beats
	# looping, which is the other way this can fail.
	if [ -n "${PI_SHELL_REEXEC:-}" ]; then
		printf '%s: %s did not start bash — set PI_GIT_BASH=/path/to/bash.exe\n' \
			"$(shell_prog)" "${PI_SHELL_REEXEC}" >&2
		exit 127
	fi
	shell_resolve || exit 127
	# In the environment before the exec, so the arriving shell cannot re-exec a second time.
	PI_SHELL_REEXEC=$SHELL_BASH
	export PI_SHELL_REEXEC
	shell_say "not bash ($0): re-exec under $SHELL_BASH (from $SHELL_FROM)"
	exec "$SHELL_BASH" "$0" "$@"
fi
