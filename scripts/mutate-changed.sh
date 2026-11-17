#!/usr/bin/env bash
# ============================================================================
# mutate-changed.sh — the mutation check, scoped to the lines this branch added.
#
# Radar basis: #2 mutation testing (Adopt). The full `mutate` run scores every
# file in agent/stryker.conf.json; on a branch that touches one file that is
# minutes of mutants nobody asked about. This derives the mutant range from the
# branch's own diff, so the run costs one hunk's worth of time.
#
# Why lines and not files. Mutating a whole changed file asks "is this file
# covered", not "did this branch weaken anything", and the two answers differ
# on any file that was not fully covered before the branch arrived:
# agent/extensions/secret-guard.ts carries 1042 mutants, ~20% of them survivors
# that predate every branch that touches it. With `break: 100` that is a gate
# no small change can pass — measured on learn/learn-15-58 (PR #110) and
# fix/secret-guard-mentions (PR #106), both cancelled at the 25-minute job
# budget with 140 survivors among the first 710 mutants. Scoping to the added
# lines asks the question the PR can answer: do the mutants this branch
# introduces die? A survivor that predates the branch stays the weekly
# `mutation` job's business.
#
# Scope rule, the same one stryker.conf.json can mutate:
#   agent/extensions/**/*.ts, test files excluded (agent/extensions/__tests__/
#   holds them, and a mutated test asserts nothing).
# Ranges reach stryker as `path:startLine-endLine`, relative to agent/, which
# is where stryker runs.
#
# An empty list never widens. `stryker run --mutate ''` does not mean
# "nothing"; it falls back to the config's mutate globs and quietly scores the
# whole suite. So `--list-only` may print nothing (the caller skips, green on
# purpose), while a bare run with nothing to mutate refuses loudly instead of
# scoring files the branch never touched.
#
# `--force` because incremental mode would otherwise answer from the cache:
# stryker 10.1.1 rejects `--incremental false` as a parse error, and --force is
# the documented way to re-run despite the incremental file (see
# specs/archive/merge-guard-mutants.md in big-boss-pi).
#
# Usage: scripts/mutate-changed.sh [--list-only] [--base REF] [--patch-file FILE]
#   --list-only        print the derived --mutate values, one per line, and stop
#                      (exit 0 even when there are none — the caller decides)
#   --base REF         diff against REF...HEAD (default origin/trunk)
#   --patch-file FILE  read `git diff -U0` output from FILE instead of running
#                      git; the test seam, not for daily use
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
MUTABLE_PREFIX='agent/extensions/'
# stryker runs in agent/, so its --mutate paths are relative to agent/: the
# derived list keeps the `extensions/` segment and drops only `agent/`.
STRIP_PREFIX='agent/'

BASE="origin/trunk"
PATCH_FILE=""
LIST_ONLY=0

while [ "$#" -gt 0 ]; do
	case "$1" in
	--list-only) LIST_ONLY=1; shift ;;
	--base) BASE="${2:?--base needs a ref}"; shift 2 ;;
	--patch-file) PATCH_FILE="${2:?--patch-file needs a path}"; shift 2 ;;
	-h | --help)
		sed -n '2,47p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		printf 'mutate-changed: unknown argument: %s\n' "$1" >&2
		exit 2
		;;
	esac
done

# the_patch — a zero-context diff of the changed extension sources.
the_patch() {
	if [ -n "$PATCH_FILE" ]; then
		cat -- "$PATCH_FILE"
	else
		# --diff-filter=ACMR drops deletions: a deleted file has no mutants.
		# Only .ts under agent/extensions is read; the test-file filter is in
		# the awk below, which is what decides every path anyway. -U0 makes
		# the added ranges exactly the lines the branch wrote.
		git -C "$ROOT" diff -U0 --no-color --diff-filter=ACMR "$BASE"...HEAD \
			-- ':(glob,top)agent/extensions/**/*.ts'
	fi
}

# mutate_ranges — one `path:start-end` per hunk with added lines, in diff order.
#
# A hunk header is `@@ -a,b +c,d @@`; the new side is what gets mutated, and
# `d == 0` is a pure deletion — it adds no line, so it adds no mutant. A `+++`
# line is read as a file header only straight after a `---` header: a patch
# body line that itself starts with `++` renders as `+++ ...`, and a path that
# is not under the mutable prefix is dropped anyway, so a spoofed header can
# only ever narrow this list, never widen it.
mutate_ranges() {
	the_patch |
		tr -d '\r' |
		awk -v prefix="$MUTABLE_PREFIX" -v strip="$STRIP_PREFIX" '
			/^--- (a\/|\/dev\/null)/ { minus = 1; next }
			minus && /^\+\+\+ / {
				path = substr($0, 7)
				sub(/^b\//, "", path)
				minus = 0
				mutable = (index(path, prefix) == 1) && (path !~ /\.test\.ts$/) && (path ~ /\.ts$/)
				next
			}
			{
				minus = 0
			}
			!mutable { next }
			/^@@ -[0-9]/ {
				match($0, /\+[0-9]+(,[0-9]+)?/)
				spec = substr($0, RSTART + 1, RLENGTH - 1)
				n = split(spec, part, ",")
				start = part[1] + 0
				count = (n > 1) ? part[2] + 0 : 1
				if (count <= 0) next
				rel = substr(path, length(strip) + 1)
				entry = rel ":" start "-" (start + count - 1)
				if (!seen[entry]++) print entry
			}
		'
}

ranges="$(mutate_ranges)"

if [ -z "$ranges" ]; then
	if [ "$LIST_ONLY" -eq 1 ]; then
		# Nothing added under agent/extensions: there is no mutant this branch
		# could introduce, so the caller skips green instead of scoring the
		# whole config. Silence here is a verdict, and the caller names it.
		exit 0
	fi
	if [ -n "$PATCH_FILE" ]; then
		against="the patch in $PATCH_FILE"
	else
		against="$BASE...HEAD"
	fi
	printf '== mutate-changed: no added line in a mutable file against %s\n' "$against" >&2
	printf '   looked for: added lines in %s**/*.ts, *.test.ts excluded\n' "$MUTABLE_PREFIX" >&2
	printf '   an empty --mutate list would widen to the whole stryker config,\n' >&2
	printf '   so this run is refused rather than scoring files the branch never touched.\n' >&2
	printf '   full scope on purpose: make mutate   (bare `mutate-changed` is not run)\n' >&2
	exit 1
fi

if [ "$LIST_ONLY" -eq 1 ]; then
	printf '%s\n' "$ranges"
	exit 0
fi

count="$(printf '%s\n' "$ranges" | wc -l | tr -d ' ')"
printf '== mutate-changed: %s added range(s) against %s\n' "$count" "$BASE"
printf '%s\n' "$ranges" | sed 's/^/   agent\//'
printf '== mutate-changed: npx stryker run --mutate <above> --force\n'

cd "$ROOT/agent" || {
	printf 'mutate-changed: %s/agent is missing — this is not a harness checkout, so there is nothing to run stryker in\n' "$ROOT" >&2
	exit 1
}
args=()
while IFS= read -r range; do
	if [ -n "$range" ]; then args+=(--mutate "$range"); fi
done <<<"$ranges"
if [ -x ./node_modules/.bin/stryker ]; then
	exec ./node_modules/.bin/stryker run "${args[@]}" --force
fi
exec npx stryker run "${args[@]}" --force
