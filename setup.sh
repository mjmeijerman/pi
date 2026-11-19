#!/usr/bin/env bash
# setup.sh — one command on a bare machine: prerequisites, questions, install, verify.
#
#   ./setup.sh                      ask per skill, per extension, per AGENT rule, per key
#   ./setup.sh -y                   accept every default (the full set)
#   ./setup.sh --skip-prereqs       never touch a package manager
#   ./setup.sh --rules=drop:3,7 --skills=github-workflow --no-keys --dry-run
#
# This file used to be `exec node setup.mjs "$@"`, which made node a precondition
# for installing node: a machine that had never had Node printed
# "setup: node not found — install Node 24, then re-run" and the person went
# looking for a download page. It now installs node (and git) itself through the
# platform's package manager, re-resolves `command -v node` afterwards — a fresh
# install is usually not on the PATH this shell inherited — and only then execs
# the engine. The package table is the same one the engine uses
# (PREREQ_PACKAGES in scripts/install-lib.mjs) and the same one docs/install.md
# prints; scripts/tests/prereqs.test.mjs checks the two agree.
#
# PI_SKIP_PREREQS=1 installs nothing: CI, and anyone who manages node with
# mise/nvm/asdf on purpose.
#
# Answers are recorded in ~/.pi/state/setup.json, so a dropped rule stays dropped
# and --reask asks again. See README.md for the flags and the per-OS behaviour.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '%s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# The node major mise.toml pins, read from its projection: .node-version is the
# file actions/setup-node reads and the one a reader can find before the clone's
# docs. 24 is the fallback if the file is missing.
PIN="$(sed -n 's/^[[:space:]]*v\{0,1\}\([0-9][0-9]*\).*/\1/p' "$HERE/.node-version" 2>/dev/null | head -1)"
[ -n "${PIN:-}" ] || PIN=24

case "$(uname -s 2>/dev/null || echo unknown)" in
Darwin) OS=darwin ;;
MINGW* | MSYS* | CYGWIN*) OS=win32 ;;
*) OS=linux ;;
esac

# The first manager on PATH for this OS. mise is last: it installs node and
# nothing else, so it is an answer for a machine with no system package manager.
MANAGER=""
pick_manager() {
	local candidates candidate
	case "$OS" in
	win32) candidates="winget mise" ;;
	darwin) candidates="brew mise" ;;
	*) candidates="apt-get dnf pacman brew mise" ;;
	esac
	for candidate in $candidates; do
		if have "$candidate"; then
			MANAGER="$candidate"
			return 0
		fi
	done
	return 1
}

# Mirrors PREREQ_PACKAGES in scripts/install-lib.mjs, tool by tool: the shell has
# to know these strings before node exists, which is why they are written twice
# and compared by a test.
pkg_for() { # manager, tool -> package name on stdout
	case "$1:$2" in
	apt-get:git | dnf:git | pacman:git | brew:git) printf 'git' ;;
	winget:git) printf 'Git.Git' ;;
	apt-get:node | dnf:node | pacman:node) printf 'nodejs' ;;
	brew:node) printf 'node@%s' "$PIN" ;;
	winget:node) printf 'OpenJS.NodeJS.LTS' ;;
	mise:node) printf 'node' ;;
	apt-get:npm | dnf:npm | pacman:npm) printf 'npm' ;;
	*) return 1 ;;
	esac
}

# Every install is announced with the exact command first, and root is named in
# its own line: `sudo` asking for a password out of nowhere is the wall that
# makes people abandon an install.
install_pkg() { # tool, package
	local tool=$1 pkg=$2 file args
	case "$MANAGER" in
	apt-get)
		file=sudo
		args="apt-get install -y $pkg"
		;;
	dnf)
		file=sudo
		args="dnf install -y $pkg"
		;;
	pacman)
		file=sudo
		args="pacman -S --needed --noconfirm $pkg"
		;;
	brew)
		file=brew
		args="install $pkg"
		;;
	winget)
		file=winget
		args="install --id $pkg -e --source winget --accept-source-agreements --accept-package-agreements"
		;;
	mise)
		file=mise
		args="use -g node@$PIN"
		;;
	*) return 1 ;;
	esac
	note "$tool: missing — installing with $MANAGER"
	note "   run: $file $args"
	if [ "$file" = sudo ]; then note '   note: sudo — this asks for your password'; fi
	# Word splitting on $args is the point: it is an argv list written as text.
	# shellcheck disable=SC2086
	$file $args
}

# A fresh install goes into a directory this shell's PATH predates. Homebrew's
# keg-only node is the case that needs the prefix lookup; mise keeps a shim
# directory nobody exports.
refresh_path() {
	local prefix dir
	for dir in "/opt/homebrew/bin" "/opt/homebrew/opt/node@$PIN/bin" "/usr/local/opt/node@$PIN/bin" /usr/local/bin "$HOME/.local/share/mise/shims"; do
		[ -d "$dir" ] || continue
		case ":$PATH:" in
		*":$dir:"*) ;;
		*) PATH="$dir:$PATH" ;;
		esac
	done
	if have brew; then
		prefix="$(brew --prefix "node@$PIN" 2>/dev/null)" || prefix=""
		if [ -n "$prefix" ] && [ -d "$prefix/bin" ]; then
			case ":$PATH:" in
			*":$prefix/bin:"*) ;;
			*) PATH="$prefix/bin:$PATH" ;;
			esac
		fi
	fi
	export PATH
}

say '== prerequisites'
if [ "${PI_SKIP_PREREQS:-}" = 1 ]; then
	say '== prerequisites: PI_SKIP_PREREQS=1 — nothing checked, nothing installed'
elif ! have node || ! have git || ! have npm; then
	if pick_manager; then
		note "package manager: $MANAGER"
	else
		warn 'no package manager found (apt-get, dnf, pacman, brew, winget, mise) — the manual lines are in docs/install.md#prerequisites-per-os'
	fi
	for tool in git node npm; do
		have "$tool" && continue
		if [ -z "$MANAGER" ]; then
			note "$tool: missing, and there is no package manager here to install it"
			continue
		fi
		if ! pkg="$(pkg_for "$MANAGER" "$tool")"; then
			# npm is not a package of its own on brew and winget: node carries it.
			if [ "$tool" = npm ]; then
				note "npm: missing — node carries it, so it arrives with the node install above"
			else
				note "$tool: missing, and $MANAGER has no command for it — see docs/install.md#prerequisites-per-os"
			fi
			continue
		fi
		install_pkg "$tool" "$pkg" || warn "$tool: the install failed — the manual line is in docs/install.md#prerequisites-per-os"
		refresh_path
	done
else
	note 'prerequisites: git, node and npm are on PATH — nothing to install'
fi

refresh_path
if ! have node; then
	warn 'node is still not on PATH — install it, reopen the shell, and re-run this script:'
	note '   Debian/Ubuntu:  sudo apt-get install -y nodejs npm'
	note '   Fedora/RHEL:    sudo dnf install -y nodejs npm'
	note '   Arch:           sudo pacman -S --needed nodejs npm'
	note '   macOS:          brew install node@'"$PIN"'   (then add its bin to PATH)'
	note '   Windows:        winget install --id OpenJS.NodeJS.LTS -e'
	note '   any of them:    mise use -g node@'"$PIN"''
	exit 1
fi

exec node "$HERE/setup.mjs" "$@"
