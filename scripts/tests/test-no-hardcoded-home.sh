#!/usr/bin/env bash
# Tests for the port itself: every executable that used to live only in the checkout this harness
# replaces now lives in bin/ of this repo, and none of them resolves a path from that checkout.
#
# Why these exist: that checkout is going away, and the copies in it were the only ones on the
# machine for thirteen programs — three of which (pi-bare, pi-sandboxed, pi-nonet) are on the path
# of every tab that starts. A copy that still needs the old tree is the failure this file is written
# against, and it is invisible in every other test: the file runs, the syntax check passes, and the
# machine stops starting sessions the day the old directory is gone. So the check is what a ported
# program may resolve at all — never a directory under $HOME that it did not come from — plus the
# two resolution shapes that replaced the old tree (pi-resolve.sh for the pi binary, a root derived
# from $here/.. for the workspace). Which files may still name the retired tree is a separate
# question with a short answer, and the retirement test in this directory is where it is measured.
#
# Cheap on purpose: grep over thirteen files, no network, no model, no temp tree.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="$ROOT_DIR/bin"

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""

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
}

# PORTED — the thirteen programs the spec ports, by the names they keep. The list is the contract:
# a name dropped from here is a name nobody checks any more.
PORTED="jev jev.mjs jev-model.mjs local-run local-run.mjs local-model.mjs pi-bare pi-nonet
pi-resolve.sh pi-sandboxed shell-resolve.sh stats.mjs usage.mjs"
# STARTUP — the five that are sourced, or run, every time a tab opens.
STARTUP="pi-bare pi-sandboxed pi-nonet pi-resolve.sh shell-resolve.sh"
# LAUNCHABLE — the ones a person runs and therefore must be executable.
LAUNCHABLE="jev local-run pi-bare pi-nonet pi-sandboxed"

# ------------------------------------------- 1. they are all here --
case_start "all thirteen are in bin/"
missing=""
for f in $PORTED; do [ -f "$BIN/$f" ] || missing="$missing $f"; done
if [ -z "$missing" ]; then pass 'every ported program exists in this repo'; else fail "missing:$missing"; fi

case_start "the launchable ones are executable"
notx=""
for f in $LAUNCHABLE; do [ -x "$BIN/$f" ] || notx="$notx $f"; done
if [ -z "$notx" ]; then pass 'chmod +x survived the copy'; else fail "not executable:$notx"; fi

# ------------------------------------------- 2. no hardcoded home --
case_start "no ported file carries a home directory"
hits=""
for f in $PORTED; do
	hits="$hits$(grep -nE '/(home|Users)/[A-Za-z0-9_.-]+|C:\\\\Users' "$BIN/$f" | sed "s|^|$f:|")"$'\n'
done
[ -z "$hits" ] || hits=$(printf '%s\n' "$hits" | sed '/^$/d')
if [ -z "$hits" ]; then pass 'a hardcoded home is a red test'; else fail 'one of them assumes a home directory' "$hits"; fi

# ------------------------------------------- 3. no path outside its own tree --
# The failure mode, stated as a rule instead of as one name: a ported program may not resolve a
# directory it did not come from. `$HOME/something/bin` and `$HOME/something/state` are exactly the
# shape the retired checkout had, so they are what this greps for — a future rename is covered
# without editing this file, and a program that only knows its own `$here/..` passes.
case_start "no ported file resolves a directory under the home it did not come from"
hits=""
for f in $PORTED; do
	hits="$hits$(grep -nE '(~|\$HOME|\$\{HOME[^}]*\})/[A-Za-z0-9_-][A-Za-z0-9_.-]*/(bin|state|lib)' "$BIN/$f" | sed "s|^|$f:|")"$'\n'
done
[ -z "$hits" ] || hits=$(printf '%s\n' "$hits" | sed '/^$/d')
if [ -z "$hits" ]; then pass 'no ported program reaches into a home directory'; else fail 'a ported program still reaches under $HOME' "$hits"; fi

# ------------------------------------------- 4. the startup set names no legacy root --
case_start "the five startup files do not mention a legacy root at all"
hits=""
for f in $STARTUP; do
	hits="$hits$(grep -nE 'PI_BOSS_ROOT|PI_MASTER_ROOT|SPACE_LEGACY_ROOT' "$BIN/$f" | grep -vE '^[0-9]+:[[:space:]]*#' | sed "s|^|$f:|")"$'\n'
done
[ -z "$hits" ] || hits=$(printf '%s\n' "$hits" | sed '/^$/d')
if [ -z "$hits" ]; then pass 'no variable can point a startup file at an older tree'; else fail 'a startup file still takes a root from the environment' "$hits"; fi

case_start "the three runners derive the workspace from their own tree"
hits=""
for f in pi-bare pi-sandboxed pi-nonet pi-resolve.sh; do
	hits="$hits$(grep -nE 'PI_BOSS_ROOT|PI_MASTER_ROOT' "$BIN/$f" | grep -vE '^[0-9]+:[[:space:]]*#' | sed "s|^|$f:|")"$'\n'
done
[ -z "$hits" ] || hits=$(printf '%s\n' "$hits" | sed '/^$/d')
if [ -z "$hits" ]; then pass 'no environment variable decides where the runner lives'; else fail 'a runner still takes its tree from the environment' "$hits"; fi
roots=0
for f in pi-sandboxed pi-nonet; do
	grep -qF 'root=$(cd -- "$here/.." && pwd)' "$BIN/$f" && roots=$((roots + 1))
done
if [ "$roots" -eq 2 ]; then pass 'both sandboxed runners spell root as $here/..'; else fail "only $roots of 2 derive root from their own tree"; fi

# ------------------------------------------- 5. the two resolvers are what they source --
case_start "the runners source the resolver, the launchers source the shell resolver"
n=0
for f in pi-bare pi-sandboxed pi-nonet; do grep -qF '. "$here/pi-resolve.sh"' "$BIN/$f" && n=$((n + 1)); done
if [ "$n" -eq 3 ]; then pass 'all three runners source pi-resolve.sh'; else fail "$n of 3 runners source pi-resolve.sh"; fi
n=0
for f in jev local-run; do grep -qF 'shell-resolve.sh' "$BIN/$f" && n=$((n + 1)); done
if [ "$n" -eq 2 ]; then pass 'both node launchers source shell-resolve.sh'; else fail "$n of 2 launchers source shell-resolve.sh"; fi

# ------------------------------------------- 6. the node imports are siblings --
case_start "every relative import in the ported node programs is a file next to it"
bad=""
for f in jev.mjs local-run.mjs stats.mjs usage.mjs; do
	for dep in $(grep -oE 'from "\./[^"]+"' "$BIN/$f" | sed -e 's|^from "\./||' -e 's|"$||'); do
		[ -f "$BIN/$dep" ] || bad="$bad $f->$dep"
	done
done
if [ -z "$bad" ]; then pass 'jev.mjs, local-run.mjs, stats.mjs and usage.mjs find their siblings'; else fail "unresolved imports:$bad"; fi

# ------------------------------------------- verdict --
printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
