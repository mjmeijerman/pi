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
# Hermetic on purpose, because the first version was not: it gave setup.sh a
# `PATH` that was only a stub directory, but setup.sh added this machine's own
# directories to that PATH, so on a host that keeps a node in /usr/local/bin the
# real node ran instead of the stub. The suite was green on a laptop and red on
# a runner — the test was measuring the host, which is the one thing a CI test
# must never do. Two things fix that here:
#
#   - every case builds its own PATH, with the stub package managers and the stub
#     git/node/npm it placed there, and nothing else;
#   - the stub node writes a marker file. If anything else answers `node`, the
#     marker is missing and the case FAILS by name instead of passing on the
#     host's binary.
#
# setup.sh's own PATH refresh is pinned by the third case: after a system
# package manager ran it must add nothing (that was the leak), and after brew or
# mise it must add exactly the directory that manager reports.
#
# Cheap on purpose: no network, no package manager, no node of this machine.
# Run it by hand, through `make scripts-test`, or under a PATH with no git and no
# node at all to prove it does not care: `unshare -rm` + a bind mount, see the
# report.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP_SH="$ROOT_DIR/setup.sh"

# bash by absolute path: the cases run with a PATH the test builds, and `bash`
# itself is not in it. If this shell cannot name itself the suite says so instead
# of failing every case for the wrong reason.
BASH_BIN="${BASH:-$(command -v bash || true)}"
WORK="$(mktemp -d)"
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
	RECORD="$DIR/record"
	# bin/ is the only PATH a case gets: node and git exist only if the case puts
	# them there, which is how "the machine has no node" is spelled.
	mkdir -p "$DIR/bin" "$RECORD"
}

# link_tools — the POSIX tools setup.sh itself calls, linked into the stub PATH
# so a case controls every other command name too. A missing one is a failure
# with its name in it, not a silent hole a later assertion has to explain.
link_tools() {
	local tool
	for tool in uname sed head dirname cat chmod rm; do
		ln -sf "$(command -v "$tool" || true)" "$DIR/bin/$tool" 2>/dev/null
		[ -e "$DIR/bin/$tool" ] || {
			fail "this host has no '$tool' — the stub PATH cannot be built"
			return 1
		}
	done
}

# fake <name> <body> — an executable in the stub PATH.
fake() {
	printf '#!/bin/sh\n%s\n' "$2" >"$DIR/bin/$1"
	chmod +x "$DIR/bin/$1"
}

# sudo records the command it is about to run as root and then runs it: the line
# a person sees announced has to be the line that happens.
fake_sudo() {
	fake sudo 'printf "%s\n" "sudo $*" >>"'"$RECORD"'/argv"
exec "$@"'
}

# node stub: records its argv AND leaves a marker. The marker is what proves the
# stub answered `node` — a host node that leaked into the PATH would run the real
# engine and leave no marker, which is exactly the failure this suite saw first.
fake_node() {
	fake node ': >"'"$RECORD"'/node-ran"
printf "%s\n" "node $*" >>"'"$RECORD"'/argv"
exit 0'
}

# A package manager that records every call, and — when asked for node — creates
# the node stub in the same PATH, the way a real install updates the shell's
# world.
fake_manager() { # name
	fake "$1" 'printf "%s\n" "'"$1"' $*" >>"'"$RECORD"'/argv"
case "$*" in
	*node*) printf "#!/bin/sh\n: >'"$RECORD"'/node-ran\nprintf \"%%s\\n\" \"node \$*\" >>'"$RECORD"'/argv\nexit 0\n" >'"$DIR"'/bin/node; chmod +x '"$DIR"'/bin/node ;;
esac
exit 0'
}

run_setup() { # env assignments..., then the command
	OUT="$(env -i PATH="$DIR/bin" HOME="$DIR/home" TMPDIR="$WORK" "$@" 2>"$DIR/stderr")"
	STATUS=$?
	ERR="$(cat "$DIR/stderr")"
	ARGV="$(cat "$RECORD/argv" 2>/dev/null)"
}

# The stub node — and only the stub node — answered. A case that reached the
# engine through any other binary fails here, by name.
stub_ran() {
	[ -e "$RECORD/node-ran" ] && return 0
	fail "the harness's own node stub did not run — something else on PATH answered 'node'" "${OUT:-<empty>}" "${ERR:-<empty>}"
	return 1
}

# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# The refresh is what a fresh install needs and what leaked the host's node: a
# system package manager writes into a directory that is already on PATH, so it
# must add nothing. brew and mise name their own directory and nothing else.
case_start "the PATH refresh adds the running manager's directory, never this machine's"
link_tools
head -n "$(($(grep -n '^say .== prerequisites' "$SETUP_SH" | head -1 | cut -d: -f1) - 1))" "$SETUP_SH" >"$DIR/head.sh"
fake brew 'case "$*" in *--prefix\ node*) printf "%s\n" "'"$DIR"'/keg" ;; *) printf "%s\n" "'"$DIR"'/brewprefix" ;; esac'
mkdir -p "$DIR/keg/bin" "$DIR/brewprefix/bin" "$DIR/home/.local/share/mise/shims"
# HOME is the case's own directory, so the mise shim lookup cannot reach this
# machine's shims either — that is the same leak in a second spelling.
HOME="$DIR/home"
# shellcheck disable=SC1090
. "$DIR/head.sh"
bad=0
MANAGER=apt-get
PATH_SAVED="$PATH"
PATH="$DIR/bin"
refresh_path
[ "$PATH" = "$DIR/bin" ] || {
	fail "after apt-get the refresh added directories: $PATH"
	bad=1
}
MANAGER=brew
PATH="$DIR/bin"
refresh_path
case ":$PATH:" in
*":$DIR/keg/bin:"*) ;;
*)
	fail "brew's node keg is not on PATH after the refresh: $PATH"
	bad=1
	;;
esac
case ":$PATH:" in
*"/opt/homebrew/bin:"* | *"/usr/local/bin:"*)
	fail "the refresh added a host directory this machine happens to have: $PATH"
	bad=1
	;;
esac
MANAGER=mise
PATH="$DIR/bin"
refresh_path
case ":$PATH:" in
*":$DIR/home/.local/share/mise/shims:"*) ;;
*)
	fail "mise's shim directory is not on PATH after the refresh: $PATH"
	bad=1
	;;
esac
PATH="$PATH_SAVED"
[ "$bad" = 0 ] && pass "apt-get adds nothing, brew adds its keg, mise adds its shims"

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
	[ "$bad" = 0 ] && stub_ran && pass "apt-get installed git, nodejs and npm, and this suite's node stub ran setup.mjs --dry-run --no-keys"
fi

# --------------------------------------------- everything present: no install --
case_start "node and git present: no package manager is touched at all"
link_tools
fake_manager apt-get
fake_sudo
fake git 'exit 0'
fake_node
fake npm 'exit 0'
run_setup PI_SKIP_PREREQS= "$BASH_BIN" "$SETUP_SH" --dry-run
if [ "$STATUS" -ne 0 ]; then
	fail "setup.sh exited $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
elif printf '%s\n' "$ARGV" | grep -qF -- 'apt-get'; then
	fail "apt-get was called on a machine that needs nothing" "$ARGV"
elif ! printf '%s\n' "$ARGV" | grep -qF -- 'setup.mjs --dry-run'; then
	fail "the engine did not run" "${ARGV:-<empty>}" "${OUT:-<empty>}"
else
	stub_ran && pass "nothing installed, engine still ran"
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
fake npm 'exit 0'
run_setup PI_SKIP_PREREQS= "$BASH_BIN" "$SETUP_SH" --dry-run
if [ "$STATUS" -ne 0 ]; then
	fail "setup.sh exited $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
elif ! printf '%s\n' "$ARGV" | grep -qxF -- 'mise use -g node@24'; then
	fail "mise was not asked for the pinned node major" "${ARGV:-<empty>}"
else
	stub_ran && pass "mise use -g node@24, then the engine"
fi

# ------------------------------------------- a manager with no npm package -----
case_start "brew carries no npm of its own: the message says who brings it, and npm is never installed alone"
link_tools
fake_manager brew
fake git 'exit 0'
run_setup PI_SKIP_PREREQS= "$BASH_BIN" "$SETUP_SH" --dry-run
if [ "$STATUS" -ne 0 ]; then
	fail "setup.sh exited $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
elif printf '%s\n' "$ARGV" | grep -qxF -- 'brew install npm'; then
	fail "brew was asked to install npm, which brew has no package for" "$ARGV"
elif ! printf '%s\n' "$OUT" | grep -qF -- 'node carries it'; then
	fail "the npm line does not say node brings it" "${OUT:-<empty>}"
else
	stub_ran && pass "node installed by brew, npm named as carried by node"
fi

# ---------------------------------------------------------- the shim parses ---
case_start "setup.sh and install.sh still parse"
if bash -n "$SETUP_SH" "$ROOT_DIR/install.sh"; then pass "bash -n is clean"; else fail "bash -n reported a syntax error"; fi

printf '\n== setup-bootstrap: %d case(s), %d ok, %d failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
