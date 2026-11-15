#!/usr/bin/env bash
# ============================================================================
# mutate-changed.sh — the mutation check, scoped to the files this branch touched.
#
# Radar basis: #2 mutation testing (Adopt). The full `mutate` run scores every
# file in agent/stryker.conf.json; on a branch that touches one file that is
# minutes of mutants nobody asked about. This derives the mutant list from the
# branch's own diff, so the run costs one file's worth of time and the score it
# prints is the score of the thing that changed.
#
# Scope rule, the same one stryker.conf.json can mutate:
#   agent/extensions/**/*.ts, test files excluded (agent/extensions/__tests__/
#   holds them, and a mutated test asserts nothing).
# Paths reach stryker relative to agent/, which is where stryker runs.
#
# An empty list is refused, loudly. `stryker run --mutate ''` does not mean
# "nothing"; it falls back to the config's mutate globs and quietly scores the
# whole suite. A scoped command that silently widens its scope is worse than
# the slow command it replaced.
#
# `--force` because incremental mode would otherwise answer from the cache:
# stryker 10.1.1 rejects `--incremental false` as a parse error, and --force is
# the documented way to re-run despite the incremental file (see
# specs/archive/merge-guard-mutants.md in big-boss-pi).
#
# Usage: scripts/mutate-changed.sh [--list-only] [--base REF] [--diff-file FILE]
#   --list-only        print the derived glob list and stop (no stryker run)
#   --base REF         diff against REF...HEAD (default origin/trunk)
#   --diff-file FILE   read a `git diff --name-only` listing from FILE instead
#                      of running git; the test seam, not for daily use
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
MUTABLE_PREFIX='agent/extensions/'
# stryker runs in agent/, so its --mutate globs are relative to agent/: the
# derived list keeps the `extensions/` segment and drops only `agent/`.
STRIP_PREFIX='agent/'

BASE="origin/trunk"
DIFF_FILE=""
LIST_ONLY=0

while [ "$#" -gt 0 ]; do
	case "$1" in
	--list-only) LIST_ONLY=1; shift ;;
	--base) BASE="${2:?--base needs a ref}"; shift 2 ;;
	--diff-file) DIFF_FILE="${2:?--diff-file needs a path}"; shift 2 ;;
	-h | --help)
		sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		printf 'mutate-changed: unknown argument: %s\n' "$1" >&2
		exit 2
		;;
	esac
done

# changed_paths — the branch's changed files, one per line.
changed_paths() {
	if [ -n "$DIFF_FILE" ]; then
		cat -- "$DIFF_FILE"
	else
		# --diff-filter=ACMR drops deletions: a deleted file has no mutants.
		git -C "$ROOT" diff --name-only --diff-filter=ACMR "$BASE"...HEAD
	fi
}

# mutable_files — changed paths stryker can mutate, relative to agent/.
mutable_files() {
	changed_paths |
		tr -d '\r' |
		sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
		awk -v prefix="$MUTABLE_PREFIX" -v strip="$STRIP_PREFIX" '
			$0 == "" { next }
			index($0, prefix) != 1 { next }
			/\.test\.ts$/ { next }
			/\.ts$/ { path = substr($0, length(strip) + 1); if (!seen[path]++) print path }
		'
}

files="$(mutable_files)"

if [ -z "$files" ]; then
	if [ -n "$DIFF_FILE" ]; then
		against="the diff listing in $DIFF_FILE"
	else
		against="$BASE...HEAD"
	fi
	printf '== mutate-changed: no mutable file changed against %s\n' "$against" >&2
	printf '   looked for: %s**/*.ts, *.test.ts excluded\n' "$MUTABLE_PREFIX" >&2
	printf '   an empty --mutate list would widen to the whole stryker config,\n' >&2
	printf '   so this run is refused rather than scoring files the branch never touched.\n' >&2
	printf '   full scope on purpose: make mutate   (bare `mutate-changed` is not run)\n' >&2
	exit 1
fi

if [ "$LIST_ONLY" -eq 1 ]; then
	printf '%s\n' "$files"
	exit 0
fi

count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
printf '== mutate-changed: %s mutable file(s) changed against %s\n' "$count" "$BASE"
printf '%s\n' "$files" | sed 's/^/   agent\//'
printf '== mutate-changed: npx stryker run --mutate <above> --force\n'

list="$(printf '%s\n' "$files" | paste -sd, -)"

cd "$ROOT/agent" || exit 1
if [ -x ./node_modules/.bin/stryker ]; then
	exec ./node_modules/.bin/stryker run --mutate "$list" --force
fi
exec npx stryker run --mutate "$list" --force
