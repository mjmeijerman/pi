#!/usr/bin/env bash
# Tests for bin/shell-resolve.sh: the one answer to "which bash runs this file", sourced at the top
# of every bash entry point in bin/.
#
# Why these exist: each of those files starts `#!/usr/bin/env bash` and then trusted it. On Windows
# the shell that runs them may be cmd.exe, PowerShell, or a minimal Git Bash where only sh.exe sits
# on PATH, so the first bash-only construct failed ten lines deep with "command not found" and the
# script's own message never appeared. The fix is: nothing runs until the shell running it *is* bash,
# and a shell that is not bash re-execs under one it resolves, original argv untouched, once. This
# file is the check that the "once", the argv and the one-line miss still hold — and that the file
# copied out of a separate checkout into ~/.pi/bin still parses under `sh`, which is the shell that
# reaches it before any of that.
#
# Cheap on purpose: no network, no pi session, no Windows host, temp dirs under one mktemp -d.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOLVE="$ROOT_DIR/bin/shell-resolve.sh"
[ -f "$RESOLVE" ] || {
	printf 'FATAL: %s is missing\n' "$RESOLVE" >&2
	exit 1
}
BASH_BIN="$(command -v bash)"
# The "not bash" shell. dash is what /bin/sh is on Debian, and the point is a shell that sets no
# BASH_VERSION; the first candidate that is not bash wins.
NOT_BASH="$(command -v dash || command -v sh)"

WORK="$(readlink -f "$(mktemp -d)")"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/log"

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
	: >"$WORK/log/bash-used"
}

has() { case $OUT in *"$1"*) return 0 ;; esac; return 1; }
err_has() { case $ERR in *"$1"*) return 0 ;; esac; return 1; }

# wrapper <name> — the shape every entry point in bin/ has: resolve the shell at top level, then do
# the work. `$*` is printed by the arriving shell, so a lost argument is visible rather than assumed.
wrapper() {
	local file="$WORK/$1"
	{
		printf '#!/bin/sh\n'
		printf '. %q\n' "$RESOLVE"
		printf 'printf "shell=%%s argv=%%s\\n" "${BASH_VERSION:+bash}" "$*"\n'
	} >"$file"
	chmod +x "$file"
	printf '%s' "$file"
}

W="$(wrapper w.sh)"

# ------------------------------------------- 1. already bash --
case_start "an already-bash run does nothing"
OUT=$(PI_SHELL_VERBOSE=1 "$BASH_BIN" "$W" a "b c" 2>"$WORK/stderr")
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 0 ] && [ "$OUT" = "shell=bash argv=a b c" ]; then pass 'runs in place, argv intact'; else fail "rc=$RC out=$OUT err=$ERR"; fi
if [ -z "$ERR" ]; then pass 'no resolution, no fork, not even in verbose mode'; else fail "stderr: $ERR"; fi

# ------------------------------------------- 2. not bash --
case_start "a non-bash run re-execs under bash"
if [ -z "$NOT_BASH" ] || [ -n "$("$NOT_BASH" -c 'printf %s "${BASH_VERSION:-}"')" ]; then
	fail 'no shell without BASH_VERSION on this host — this case cannot run'
else
	OUT=$(env -i PATH="/usr/bin:/bin" HOME="$WORK/home" "$NOT_BASH" "$W" a "b c" --json 2>"$WORK/stderr")
	RC=$?
	ERR="$(cat "$WORK/stderr")"
	if [ "$RC" -eq 0 ] && [ "$OUT" = "shell=bash argv=a b c --json" ]; then
		pass 'the arriving shell is bash, argv and quoting intact'
	else
		fail "rc=$RC out=$OUT err=$ERR"
	fi
	if [ -z "$ERR" ]; then pass 'quiet when PI_SHELL_VERBOSE is unset'; else fail "stderr: $ERR"; fi
fi

case_start "PI_GIT_BASH is the shell that runs it, and it wins over PATH"
cat >"$WORK/fakebash" <<EOF
#!/bin/sh
printf 'used %s\n' "\$*" >>"$WORK/log/bash-used"
exec "$BASH_BIN" "\$@"
EOF
chmod +x "$WORK/fakebash"
OUT=$(env -i PATH="/usr/bin:/bin" HOME="$WORK/home" PI_GIT_BASH="$WORK/fakebash" "$NOT_BASH" "$W" x 2>"$WORK/stderr")
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 0 ] && [ "$OUT" = "shell=bash argv=x" ]; then pass 're-execs under the named bash'; else fail "rc=$RC out=$OUT err=$ERR"; fi
if grep -q "^used $W x$" "$WORK/log/bash-used"; then pass 'the named bash is the one that ran the script'; else fail "log: $(cat "$WORK/log/bash-used")"; fi

case_start "a wrong PI_GIT_BASH is named and stopped at, not passed over"
: >"$WORK/log/bash-used"
OUT=$(env -i PATH="/usr/bin:/bin" HOME="$WORK/home" PI_GIT_BASH="$WORK/no-such-bash" "$NOT_BASH" "$W" x 2>"$WORK/stderr")
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 127 ]; then pass 'exits 127'; else fail "expected 127, got $RC"; fi
if err_has 'PI_GIT_BASH' && err_has 'not a runnable bash'; then pass 'names the variable and the file'; else fail "stderr: $ERR"; fi
if [ -z "$OUT" ] && [ ! -s "$WORK/log/bash-used" ]; then pass 'nothing ran: PATH was not used as a fallback'; else fail "out=$OUT log=$(cat "$WORK/log/bash-used")"; fi

case_start "no bash anywhere is one line and 127"
mkdir -p "$WORK/onlysh"
ln -sf "$NOT_BASH" "$WORK/onlysh/sh"
OUT=$(env -i PATH="$WORK/onlysh" HOME="$WORK/home" "$NOT_BASH" "$W" x 2>"$WORK/stderr")
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 127 ]; then pass 'exits 127'; else fail "expected 127, got $RC"; fi
if err_has 'no bash found' && err_has 'PI_GIT_BASH'; then pass 'names the fix on stderr'; else fail "stderr: $ERR"; fi
if [ -z "$OUT" ]; then pass 'prints nothing on stdout'; else fail "stdout: $OUT"; fi

case_start "a second re-exec does not happen: PI_SHELL_REEXEC is the guard"
OUT=$(env -i PATH="/usr/bin:/bin" HOME="$WORK/home" PI_SHELL_REEXEC="$BASH_BIN" "$NOT_BASH" "$W" x 2>"$WORK/stderr")
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 127 ]; then pass 'exits 127 instead of looping'; else fail "expected 127, got $RC"; fi
if err_has 'did not start bash'; then pass 'says the found file was not bash'; else fail "stderr: $ERR"; fi

case_start "verbose mode names the step and the real file"
ln -sf "$BASH_BIN" "$WORK/link-bash"
ln -sf "$WORK/link-bash" "$WORK/link-bash-2"
OUT=$(env -i PATH="/usr/bin:/bin" HOME="$WORK/home" PI_SHELL_VERBOSE=1 PI_GIT_BASH="$WORK/link-bash-2" "$NOT_BASH" "$W" x 2>"$WORK/stderr")
ERR="$(cat "$WORK/stderr")"
if err_has 'PI_GIT_BASH'; then pass 'says which step found bash'; else fail "stderr: $ERR"; fi
if err_has "$(readlink -f "$BASH_BIN")"; then pass 'names the resolved file, not the link'; else fail "stderr: $ERR"; fi

# ------------------------------------------- 3. the file sh parses --
case_start "the file is valid for sh, which is what reads it before any of this"
"$NOT_BASH" -n "$RESOLVE" 2>"$WORK/stderr"
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 0 ]; then pass 'dash -n is clean'; else fail "rc=$RC err=$ERR"; fi

# ------------------------------------------- verdict --
printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
