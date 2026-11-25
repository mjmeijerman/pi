# worker-argv.sh — one spelling of the argv a worker's tab is started with.
#
# Sourced, never executed, by `bin/delegate` (the spawn and the restart) and by
# `scripts/agent-pane.sh` (the tab and the visible space). Two spellings of this
# drifted once and the cost was a worker that never started: `bin/delegate` handed
# herdr `["sh","-lc","…"]`, herdr types that argv into the tab's own shell, and on
# Windows that shell is PowerShell — no `sh` on its PATH, so the tab printed
# "The term 'sh' is not recognized" and exited. `delegate spawn` still printed its
# JSON and the record said `working`, so the failure was silent, and the follow-up
# `hc send` landed in the same dead prompt.
#
# So the first word is resolved, never assumed:
#   - not Windows: `sh`, exactly as before. A `/bin/bash` path here would replace a
#     portable name with one machine's layout, and nothing on Linux or macOS needed
#     fixing.
#   - Windows: the absolute Git for Windows bash (`bin/shell-resolve.sh`
#     `shell_resolve`), spelled the way PowerShell resolves it — forward slashes and
#     a drive letter (`shell_win_path`). A `/c/Program Files/...` path is a miss there.
#   - no bash at all: return 127 and say which line fixes it (`PI_GIT_BASH`), because a
#     tab that types nothing is worse than a spawn that refuses.
#
# `-lc` and the quoting in the command line stay: bash interprets those, and they are
# correct on every platform.

# shellcheck shell=bash

# The resolver is the source of truth for "which bash", so this file needs it; a caller that
# already sourced it pays nothing. Resolved from the sourced path with `${x%/*}` and not
# `dirname`, because this runs before a worker's argv exists and a stripped PATH is exactly the
# case it is for.
worker_argv_lib=${BASH_SOURCE[0]%/*}
if ! command -v shell_is_win >/dev/null 2>&1 && [ -f "$worker_argv_lib/shell-resolve.sh" ]; then
	# shellcheck source=bin/shell-resolve.sh
	. "$worker_argv_lib/shell-resolve.sh"
fi
unset worker_argv_lib

# worker_argv_interpreter — the first word of a worker's argv: `sh`, or the absolute
# Windows bash. Prints it on success; on failure prints the line that fixes it and
# returns 127, so the caller can stop before a tab is opened.
worker_argv_interpreter() {
	local bash
	command -v shell_is_win >/dev/null 2>&1 || {
		printf '%s: bin/shell-resolve.sh was not sourced beside bin/worker-argv.sh, so the first word a tab is started with is unknown\n' "${0##*/}" >&2
		return 127
	}
	if ! shell_is_win; then
		printf 'sh'
		return 0
	fi
	SHELL_BASH=
	SHELL_FROM=
	shell_resolve || return 127
	bash=$(shell_win_path "$SHELL_BASH") && [ -n "$bash" ] && {
		printf '%s' "$bash"
		return 0
	}
	printf '%s: %s is not a Windows path PowerShell can run — set PI_GIT_BASH=C:/Program Files/Git/bin/bash.exe\n' \
		"${0##*/}" "$SHELL_BASH" >&2
	return 127
}

# worker_tab_argv <command line> — the JSON array `herdr-app do tab.new --argv` takes:
# `[<interpreter>, "-lc", <one command string>]`. One word per argument, so the command
# line is handed over as one string and not re-split by whatever shell types it.
worker_tab_argv() {
	local line=${1:-} interpreter
	[ -n "$line" ] || {
		printf '%s: worker_tab_argv needs the command line the tab runs\n' "${0##*/}" >&2
		return 2
	}
	interpreter=$(worker_argv_interpreter) || return $?
	command -v node >/dev/null 2>&1 || {
		printf '%s: node is not on PATH, so the argv a tab is started with cannot be written\n' "${0##*/}" >&2
		return 127
	}
	node -e 'process.stdout.write(JSON.stringify([process.argv[1],"-lc",process.argv[2]]))' "$interpreter" "$line"
}
