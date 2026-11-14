#!/usr/bin/env bash
# pi-sandbox.sh — run the pi coding agent inside a bubblewrap sandbox.
#
# Radar Vol. 35: blip 1 (agent sandboxing, Adopt), blip 29 (harness quality
# evaluation — the policy is only as good as the check that it still holds).
#
#   pi-sandbox.sh [--no-net] [--rw DIR]... -- <pi args...>
#
# See README.md in this directory for the policy and the known gaps.
set -euo pipefail

prog=${0##*/}

die() { printf '%s: error: %s\n' "$prog" "$*" >&2; exit 1; }
note() { printf '%s: %s\n' "$prog" "$*" >&2; }

usage() {
	cat <<'EOF'
usage: pi-sandbox.sh [options] -- [pi arguments...]

options:
  --no-net       run with an unshared network namespace (no network at all)
  --rw DIR       mount DIR read-write inside the sandbox (repeatable)
  --exec         run the command after -- directly instead of pi (test hook)
  -h, --help     show this help

Everything after -- is passed to pi:
  pi-sandbox.sh -- -p "summarise this repo"
  pi-sandbox.sh --no-net -- --continue
  pi-sandbox.sh --rw ~/scratch --
EOF
}

# ---------------------------------------------------------------- arguments
no_net=0
exec_mode=0
rw_extra=()
while [ "$#" -gt 0 ]; do
	case $1 in
	--no-net) no_net=1; shift ;;
	--rw)
		[ "$#" -ge 2 ] || die "--rw needs a directory argument"
		rw_extra+=("$2")
		shift 2
		;;
	--exec) exec_mode=1; shift ;;
	--help | -h) usage; exit 0 ;;
	--) shift; break ;;
	*) die "unknown argument '$1' (pi arguments go after --)" ;;
	esac
done
payload=("$@")

# ---------------------------------------------------------------- toolchain
bwrap=$(command -v bwrap || true)
[ -n "$bwrap" ] || die "bwrap (bubblewrap) is not installed — see README.md"

home=${HOME:-}
[ -n "$home" ] || home=$(getent passwd "$(id -un)" | cut -d: -f6)
home=$(readlink -f -- "$home")
[ -d "$home" ] || die "home directory '$home' does not exist"

[ -d /usr ] || die "required directory /usr does not exist"
[ -d /etc ] || die "required directory /etc does not exist"
[ -d "$home/.pi" ] || die "required directory $home/.pi does not exist"

# The current directory drives the policy below, and $HOME itself needs its
# read-only bind *before* the read-write binds that live inside it.
cwd=$(pwd -P)
home_ro=0
if [ "$cwd" = "$home" ]; then home_ro=1; fi

pi_bin=$(command -v pi || true)
[ -n "$pi_bin" ] || die "pi is not on PATH (looked for an executable named 'pi')"
pi_bin=$(readlink -f -- "$pi_bin")
pi_bindir=$(dirname "$pi_bin")
# The pnpm shim lives in <prefix>/bin and loads the package from <prefix>/global.
# Bind the whole prefix read-only so the shim, its NODE_PATH and the store resolve.
pi_prefix=$(dirname "$pi_bindir")

node_bin=$(command -v node || true)
[ -n "$node_bin" ] || die "node is not on PATH — pi cannot run without it"
node_real=$(readlink -f -- "$node_bin")
node_bindir=$(dirname "$node_real")
# .../fnm/node-versions/vX/installation/bin/node -> .../fnm/node-versions/vX/installation
node_prefix=$(dirname "$node_bindir")
[ -e "$node_real" ] || die "node at '$node_real' does not exist"

# A directory is already covered when it is /usr, /bin, /lib* or /etc (read-only),
# or lives inside one of the read-write binds.
path_covered_ro() {
	local p=$1 d
	for d in /usr /bin /sbin /lib /lib32 /lib64 /etc; do
		case $p in "$d" | "$d"/*) return 0 ;; esac
	done
	return 1
}

# Directories that are too broad to hand out read-write: they hold credentials
# (browsers, docker, 1Password, ssh agent sockets) or the whole home directory.
too_broad() {
	local p=$1 d
	# A read-only mount of a broad parent buys nothing, and a read-write one
	# exposes every other process on the machine.
	case $p in / | /home | /root | /tmp | /var | /var/tmp | /run | /dev | /proc | /sys) return 0 ;; esac
	[ "$p" = "$home" ] && return 0
	for d in "$home/.local" "$home/.config" "$home/.cache" "$home/.docker" "$home/.ssh" "$home/.gnupg" "$home/.aws" "$home/.kube"; do
		case $p in "$d" | "$d"/*) return 0 ;; esac
	done
	# An ancestor of $home is just as bad as $home itself.
	case $home in "$p"/*) return 0 ;; esac
	return 1
}

rw_dirs=()
# Resolve and validate a read-write bind, then print the real path.
resolve_rw() {
	local src=$1 resolved
	resolved=$(readlink -f -- "$src" 2>/dev/null) || die "cannot resolve '$src'"
	[ -e "$resolved" ] || die "'$src' does not exist"
	if too_broad "$resolved"; then
		die "refusing to bind '$resolved' read-write: it exposes credentials or the whole home directory — bind a project directory instead"
	fi
	printf '%s\n' "$resolved"
}

# ---------------------------------------------------------------- base policy
args=(
	--die-with-parent
	--new-session
	--unshare-pid
	--unshare-ipc
	--unshare-uts
	--hostname pi-sandbox
)

# Read-only system tree. /lib32 and friends are missing on most hosts; skip them.
for d in /usr /bin /sbin /lib /lib32 /lib64 /etc; do
	if [ -e "$d" ]; then args+=(--ro-bind "$d" "$d"); fi
done

# Started in $HOME: mount the home tree read-only instead of refusing to start.
# The read-write binds below ($HOME/.pi, the allow-listed trees, --rw) are mounted
# afterwards and win, and the credential masks further down still apply.
if [ "$home_ro" -eq 1 ]; then args+=(--ro-bind "$home" "$home"); fi

# Read-only toolchain (node + the pi package tree) unless it already lives in /usr.
for d in "$node_prefix" "$pi_prefix"; do
	if [ -e "$d" ] && ! path_covered_ro "$d"; then
		args+=(--ro-bind "$d" "$d")
	fi
done

# ~/.local/bin: gh, uv/uvx, gitleaks, semgrep, trivy, herdr, git-vuln-scan live
# here, and without it a sandboxed session cannot run the commands AGENTS.md
# tells it to run. Binaries only: their config directories (~/.config/gh,
# ~/.config/herdr) stay masked below, so a tool that needs a token says it has
# none instead of quietly using one the sandbox was meant to withhold.
if [ -d "$home/.local/bin" ] && ! path_covered_ro "$home/.local/bin"; then
	args+=(--ro-bind "$home/.local/bin" "$home/.local/bin")
fi
# Those binaries point into their tool homes: pipx venvs (semgrep), uv tools,
# npm/pnpm prefixes. Mount the stores read-only so the symlinks resolve.
for d in "$home/.local/share/pipx" "$home/.local/share/uv"; do
	if [ -d "$d" ] && ! path_covered_ro "$d"; then
		args+=(--ro-bind "$d" "$d")
	fi
done

# A symlink in ~/.local/bin can point outside every tree bound so far: jev and
# local-run are symlinks into ~/big-boss-pi/bin, so inside the sandbox the link
# dangled and a worker's mandatory `jev route` check died with "command not
# found". Bind the resolved target's directory read-only: jev.mjs imports its
# sibling jev-model.mjs, so binding the single file is not enough, and the
# surrounding repo stays unmounted — nothing under ~/big-boss-pi is writable
# and no tree is handed out beyond the directory the binary actually lives in.
link_dirs=()
covered_link_dir() {
	local d=$1 x
	for x in "$home/.local/bin" "$home/.local/share/pipx" "$home/.local/share/uv" "$home/.pi"; do
		case $d in "$x" | "$x"/*) return 0 ;; esac
	done
	for x in "$node_prefix" "$pi_prefix"; do
		case $d in "$x" | "$x"/*) return 0 ;; esac
	done
	return 1
}
for link in "$home/.local/bin"/*; do
	[ -L "$link" ] || continue
	resolved=$(readlink -f -- "$link" 2>/dev/null) || continue
	[ -e "$resolved" ] || continue
	dir=$(dirname -- "$resolved")
	too_broad "$dir" && continue
	path_covered_ro "$dir" && continue
	covered_link_dir "$dir" && continue
	link_dirs+=("$dir")
done
if [ "${#link_dirs[@]}" -gt 0 ]; then
	while IFS= read -r d; do args+=(--ro-bind "$d" "$d"); done \
		< <(printf '%s\n' "${link_dirs[@]}" | sort -u)
fi

args+=(--tmpfs /tmp --dev /dev --proc /proc)

# Read-write: pi's own config/state directory, git identity, project trees.
args+=(--bind "$home/.pi" "$home/.pi")
rw_dirs+=("$home/.pi")
for f in .gitconfig .gitignore_global; do
	if [ -e "$home/$f" ]; then args+=(--bind "$home/$f" "$home/$f"); fi
done
if [ -d "$home/.git-templates" ]; then args+=(--ro-bind "$home/.git-templates" "$home/.git-templates"); fi
if [ -d "$home/.config/git" ]; then args+=(--ro-bind "$home/.config/git" "$home/.config/git"); fi

for d in projects agent-office achterhoek-uitagenda pi-projects; do
	[ -d "$home/$d" ] || continue
	args+=(--bind "$home/$d" "$home/$d")
	rw_dirs+=("$home/$d")
done

for d in "${rw_extra[@]+"${rw_extra[@]}"}"; do
	resolved=$(resolve_rw "$d")
	args+=(--bind "$resolved" "$resolved")
	rw_dirs+=("$resolved")
done

# The current directory, when the policy does not already cover it.
cwd_covered=0
for d in "${rw_dirs[@]+"${rw_dirs[@]}"}"; do
	case $cwd in "$d" | "$d"/*) cwd_covered=1; break ;; esac
done
if [ "$home_ro" -eq 1 ]; then
	note '$HOME is read-only inside the sandbox; pass --rw DIR to make a directory writable'
elif [ "$cwd_covered" -eq 0 ] && ! path_covered_ro "$cwd"; then
	if too_broad "$cwd"; then
		die "the current directory '$cwd' cannot be mounted read-write — cd into a project directory or pass --rw DIR"
	fi
	args+=(--bind "$cwd" "$cwd")
	rw_dirs+=("$cwd")
fi

# ---------------------------------------------------------------- npm quarantine
# npm 11 keeps the supply-chain quarantine in ~/.npmrc, which the masks below
# blank out — so a sandboxed harness-check could not read the setting and FAILed.
# Forward the one number that matters instead of the file: NPM_CONFIG_MIN_RELEASE_AGE
# is the effective value to npm, and only a value matching ^[0-9]+$ crosses the
# boundary. No other key, comment or token of that file is read into the argument
# list or the log (blip 99 Safe Chain, blip 1 agent sandboxing, blip 29 harness
# quality evaluation).
host_npm_release_age() {
	local line value
	if command -v npm >/dev/null 2>&1; then
		value=$(npm config get min-release-age 2>/dev/null | tr -d '[:space:]')
	else
		line=$(grep -m1 -E '^[[:space:]]*min-release-age[[:space:]]*=' "$home/.npmrc" 2>/dev/null) || return 1
		value=$(printf '%s' "${line#*=}" | tr -d '[:space:]')
	fi
	case "$value" in '' | *[!0-9]*) return 1 ;; esac
	printf '%s\n' "$value"
}
if release_age=$(host_npm_release_age); then
	args+=(--setenv NPM_CONFIG_MIN_RELEASE_AGE "$release_age")
	note "npm min-release-age forwarded: $release_age days"
else
	note "npm min-release-age not forwarded (no numeric value on the host)"
fi

# ---------------------------------------------------------------- credential masks
# These come after the binds above, so the masks win. The path still exists
# inside the sandbox, but it is empty (or an empty file). A path that does not
# exist on the host needs no mask: it is absent inside too, and bwrap cannot
# create a mountpoint under a read-only $HOME.
for rel in .ssh .gnupg .aws .kube .config/gh .docker .config/1Password; do
	if [ -e "$home/$rel" ]; then args+=(--tmpfs "$home/$rel"); fi
done
for rel in .netrc .npmrc; do
	if [ -e "$home/$rel" ]; then args+=(--ro-bind /dev/null "$home/$rel"); fi
done

# Provider credentials: pi needs them, the agent should not get *every* key.
# Rebuild the credential store with only the providers allowed for this run
# (default: the configured defaultProvider). An empty store stays empty.
auth_src="$home/.pi/agent/auth.json"
auth_tmp=""
if [ -f "$auth_src" ]; then
	allowed=${PI_SANDBOX_AUTH_PROVIDERS-}
	if [ -z "$allowed" ]; then
		allowed=$(node -e '
			try { const s = JSON.parse(require("node:fs").readFileSync(process.env.HOME + "/.pi/agent/settings.json", "utf8")); process.stdout.write(s.defaultProvider || ""); } catch {}
		' 2>/dev/null || true)
	fi
	auth_tmp=$(mktemp "${TMPDIR:-/tmp}/pi-sandbox-auth.XXXXXX")
	chmod 600 "$auth_tmp"
	if node -e '
		const { readFileSync, writeFileSync } = require("node:fs");
		const [src, dest, allowed] = process.argv.slice(1);
		let store = {};
		try { store = JSON.parse(readFileSync(src, "utf8")) || {}; } catch { store = {}; }
		const keep = allowed.split(",").map((s) => s.trim()).filter(Boolean);
		const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep.includes(k)));
		let out = store;
		if (store.providers) out = { ...store, providers: pick(store.providers) };
		else out = pick(store);
		writeFileSync(dest, JSON.stringify(out, null, 2));
	' "$auth_src" "$auth_tmp" "$allowed"; then
		chmod 600 "$auth_tmp"
		args+=(--ro-bind "$auth_tmp" "$auth_src")
		note "credentials limited to: ${allowed:-none}"
	else
		args+=(--ro-bind /dev/null "$auth_src")
		note "credential store unreadable (filter failed)"
	fi
fi

# Mask dotenv files under every read-write tree. They hold API keys and DB
# passwords, and prompt-injected code likes to read them.
find_dotenv() {
	local dir=$1
	find "$dir" \( -path "$dir/node_modules" -o -path "$dir/.git" \) -prune -o \
		-type f \( -name '.env' -o -name '.env.*' -o -name '*.env' \) -print 2>/dev/null
}
mask_count=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	args+=(--ro-bind /dev/null "$f")
	mask_count=$((mask_count + 1))
	if [ "$mask_count" -ge 500 ]; then
		note "warning: masked 500 dotenv files, stopping there"
		break
	fi
done < <(
	for d in "${rw_dirs[@]+"${rw_dirs[@]}"}"; do
		find_dotenv "$d"
	done | sort -u
)
if [ "$mask_count" -gt 0 ]; then
	note "masked $mask_count dotenv file(s) as empty — git reports tracked dotenv files as modified, so do not run 'git commit -a' or 'git add -A' in here"
fi

# ---------------------------------------------------------------- network
if [ "$no_net" -eq 1 ]; then args+=(--unshare-net); fi

# ---------------------------------------------------------------- environment
# The environment is inherited (so provider API keys and PI_* variables survive);
# only the paths that must match the sandbox layout are overridden.
sandbox_path="$home/.local/bin:$node_bindir:$pi_bindir:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
# The markers are the only honest answer to "is this agent contained?": the
# session itself reads them, so the pane title can say it (extension
# `sandbox-badge.ts`, Radar blip 1). An unset marker therefore means "not
# sandboxed", which is exactly what should show up in Herdr.
sandbox_net=on
[ "$no_net" -eq 1 ] && sandbox_net=off
args+=(
	--setenv HOME "$home"
	--setenv USER "$(id -un)"
	--setenv LOGNAME "$(id -un)"
	--setenv PATH "$sandbox_path"
	--setenv TMPDIR /tmp
	--setenv PI_SANDBOX_MODE bwrap
	--setenv PI_SANDBOX_NET "$sandbox_net"
)

# ---------------------------------------------------------------- run
if [ "$exec_mode" -eq 1 ]; then
	[ "${#payload[@]}" -gt 0 ] || die "--exec needs a command after --"
	args+=(-- "${payload[@]}")
else
	args+=(-- "$pi_bin" "${payload[@]+"${payload[@]}"}")
fi

if [ "${PI_SANDBOX_DEBUG:-0}" = 1 ]; then
	printf '%q ' "$bwrap" "${args[@]}" >&2
	echo >&2
fi

set +e
"$bwrap" "${args[@]}"
status=$?
set -e
[ -n "$auth_tmp" ] && rm -f "$auth_tmp"
exit "$status"
