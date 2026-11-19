#!/usr/bin/env bash
# setup.sh has to install node on a machine that has no node.
#
# Why this exists: the shim used to be `exec node setup.mjs`, so a bare machine
# could not install Node with the installer — node was a precondition for
# installing node, and INSTALL.md was the only place that said so. The bootstrap
# now calls the platform's package manager, re-resolves `command -v node` (a
# fresh install is usually not on the PATH this shell inherited), and then execs
# the engine.
#
# So this test builds a PATH with NO node and NO git in it, and a fake package
# manager that records its argv and drops a fake `node` into that PATH — which is
# exactly what a real install does to a shell. What is asserted is the argv the
# bootstrap ran, that it re-found node without a new shell, and that it handed the
# engine the arguments it was given.
#
# Cheap on purpose: no network, no package manager, no node of this machine.
# Run it by hand, or through `make scripts-test`.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP_SH="$ROOT_DIR/setup.sh"

WORK="$(mktemp -d)"
BASH_BIN="$(command -v bash)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""

pass() {
	PASS_N=$((PASS_N + 1))
	printf 'ok   %s: %s\n' "$CASE" "$1"
}
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do
		printf '       %s\n' "$1"
		shift
	done
}

case_start() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	DIR="$WORK/case$CASE_N"
	# bin/ is the only PATH this case gets: node and git exist only if a fake
	# puts them there, which is how "the machine has no node" is spelled.
	mkdir -p "$DIR/bin" "$DIR/record"
	RECORD="$DIR/record"
}

# link_tools — the POSIX tools the bootstrap itself calls, linked into the fake
# PATH so the case controls every other command name too.
link_tools() {
	local tool
	for tool in uname sed head dirname cat chmod rm; do
		ln -sf "$(command -v "$tool")" "$DIR/bin/$tool"
	done
}

# sudo records the command it is about to run as root and then runs it: the line
# a person sees announced has to be the line that happens.
fake_sudo() {
	fake sudo 'printf "%s\n" "sudo $*" >>"'"$RECORD"'/argv"
exec "$@"'
}

# fake <name> <body> — an executable in the fake PATH.
fake() {
	printf '#!/bin/sh\n%s\n' "$2" >"$DIR/bin/$1"
	chmod +x "$DIR/bin/$1"
}

# node shim that records its argv and exits 0: the engine is out of scope here,
# what matters is that the bootstrap got far enough to exec it.
fake_node() {
	fake node 'printf "%s\n" "node $*" >>"'"$RECORD"'/argv"; exit 0'
}

# A package manager that records every call, and — when asked for node — creates
# the node shim in the same PATH, the way a real install updates the shell's
# world.
fake_manager() { # name
	fake "$1" 'printf "%s\n" "'"$1"' $*" >>"'"$RECORD"'/argv"
case "$*" in
	*node*) printf "#!/bin/sh\nprintf \"%%s\\n\" \"node \$*\" >>'"$RECORD"'/argv\nexit 0\n" >'"$DIR"'/bin/node; chmod +x '"$DIR"'/bin/node ;;
esac
exit 0'
}

run_setup() { # env assignments..., then the command
	OUT="$(env -i PATH="$DIR/bin" HOME="$DIR/home" TMPDIR="$WORK" "$@" 2>"$DIR/stderr")"
	STATUS=$?
	ERR="$(cat "$DIR/stderr")"
	ARGV="$(cat "$RECORD/argv" 2>/dev/null)"
}

# The table in setup.sh and the table in scripts/install-lib.mjs are two copies
# of the same package names (the shell has to know them before node exists). This
# sources the shell copy — everything above the first install attempt — and asks
# it directly, so a rename on one side cannot pass.
case_start "the package table in setup.sh answers the same names the engine plans with"
link_tools
head -n "$(($(grep -n '^say .== prerequisites' "$SETUP_SH" | head -1 | cut -d: -f1) - 1))" "$SETUP_SH" >"$DIR/head.sh"
# shellcheck disable=SC1090
. "$DIR/head.sh"
expected_pairs='
apt-get:git=git
dnf:git=git
pacman:git=git
brew:git=git
winget:git=Git.Git
apt-get:node=nodejs
dnf:node=nodejs
pacman:node=nodejs
brew:node=node@24
winget:node=OpenJS.NodeJS.LTS
mise:node=node
apt-get:npm=npm
dnf:npm=npm
pacman:npm=npm
'
bad=0
while IFS='=' read -r pair want; do
	[ -n "$pair" ] || continue
	manager=${pair%%:*}
	tool=${pair#*:}
	got="$(pkg_for "$manager" "$tool")"
	if [ "$got" != "$want" ]; then
		fail "pkg_for $manager $tool printed '$got', the engine plans '$want'"
		bad=1
	fi
done <<<"$expected_pairs"
if [ "$bad" = 0 ] && ! pkg_for mise git >/dev/null; then
	pass "15 manager/tool pairs agree, and mise/git has no package"
else
	[ "$bad" = 0 ] && fail "pkg_for mise git answered a package — mise installs node only"
fi

# ---------------------------------------------------- node missing, apt-get ---
case_start "node missing and apt-get present: it installs, re-finds node, and execs the engine with its args"
link_tools
fake_manager apt-get
fake_sudo
run_setup PI_SKIP_PREREQS= "$BASH_BIN" "$SETUP_SH" --dry-run --no-keys
if [ "$STATUS" -ne 0 ]; then
	fail "setup.sh exited $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
else
	bad=0
	for needle in 'sudo apt-get install -y git' 'sudo apt-get install -y nodejs' 'sudo apt-get install -y npm'; do
		printf '%s\n' "$ARGV" | grep -qxF -- "$needle" || {
			fail "the argv does not carry '$needle'" "$ARGV"
			bad=1
		}
	done
	printf '%s\n' "$ARGV" | grep -qxF -- 'node '"$ROOT_DIR"'/setup.mjs --dry-run --no-keys' || {
		fail "the engine was not exec'd with the arguments the bootstrap was given" "$ARGV"
		bad=1
	}
	printf '%s\n' "$OUT" | grep -qF -- 'note: sudo' || {
		fail "sudo ran without a line saying so" "${OUT:-<empty>}"
		bad=1
	}
	[ "$bad" = 0 ] && pass "apt-get installed git, nodejs and npm, and node ran setup.mjs --dry-run --no-keys"
fi

# --------------------------------------------- everything present: no install --
case_start "node and git present: no package manager is touched at all"
link_tools
fake_manager apt-get
fake_sudo
fake git 'exit 0'
fake_node
printf '#!/bin/sh\nexit 0\n' >"$DIR/bin/npm"
chmod +x "$DIR/bin/npm"
run_setup PI_SKIP_PREREQS= "$BASH_BIN" "$SETUP_SH" --dry-run
if [ "$STATUS" -ne 0 ]; then
	fail "setup.sh exited $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
elif printf '%s\n' "$ARGV" | grep -qF -- 'apt-get'; then
	fail "apt-get was called on a machine that needs nothing" "$ARGV"
else
	printf '%s\n' "$ARGV" | grep -qF -- 'setup.mjs --dry-run' &&
		pass "nothing installed, engine still ran"
fi

# ---------------------------------------- PI_SKIP_PREREQS=1 and no node: stop --
case_start "PI_SKIP_PREREQS=1 installs nothing, and a missing node names the manual lines"
link_tools
fake_manager apt-get
fake_sudo
fake git 'exit 0'
run_setup PI_SKIP_PREREQS=1 "$BASH_BIN" "$SETUP_SH" --dry-run
if [ "$STATUS" -eq 0 ]; then
	fail "setup.sh exited 0 with no node — a CI run would look green and do nothing" "${OUT:-<empty>}"
elif printf '%s\n' "$ARGV" | grep -qF -- 'apt-get'; then
	fail "PI_SKIP_PREREQS=1 still reached a package manager" "$ARGV"
elif ! printf '%s\n' "$ERR" | grep -qF -- 'node is still not on PATH'; then
	fail "the failure does not say what to do" "${ERR:-<empty>}"
else
	pass "nothing installed, exit $STATUS, and the manual lines are named"
fi

# ------------------------------------------------ mise only: it installs node --
case_start "no apt-get, mise present: the node answer is mise, and node still runs"
link_tools
fake_manager mise
fake git 'exit 0'
printf '#!/bin/sh\nexit 0\n' >"$DIR/bin/npm"
chmod +x "$DIR/bin/npm"
run_setup PI_SKIP_PREREQS= "$BASH_BIN" "$SETUP_SH" --dry-run
if [ "$STATUS" -ne 0 ]; then
	fail "setup.sh exited $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
elif ! printf '%s\n' "$ARGV" | grep -qxF -- 'mise use -g node@24'; then
	fail "mise was not asked for the pinned node major" "${ARGV:-<empty>}"
else
	pass "mise use -g node@24, then the engine"
fi

# ---------------------------------------------------------- the shim parses ---
case_start "setup.sh and install.sh still parse"
if bash -n "$SETUP_SH" "$ROOT_DIR/install.sh"; then pass "bash -n is clean"; else fail "bash -n reported a syntax error"; fi

printf '\n== setup-bootstrap: %d case(s), %d ok, %d failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
