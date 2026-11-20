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
# specs/archive/merge-guard-mutants.md in big-boss-pi). A person running this
# by hand has no cache to trust, so --force stays the default here. The CI
# pull-request job differs on purpose: it restores a cache keyed on the whole
# agent/extensions tree, calls stryker itself without --force, and says why in
# .github/workflows/test.yml. That key is what makes its warm run sound. A person running this
# by hand has no cache to trust, so --force is the right default here; the CI
# pull-request job calls stryker itself with its own restored cache and no
# --force, and says why in .github/workflows/test.yml.
#
# `--cap N` is the budget: a pull request does not get to spend 25 minutes on
# mutants nobody asked about. The cap is taken on mutants, not on lines, in a
# fixed order (file, then line) so the same diff always tests the same N, and
# the count it deferred is printed, never swallowed — a silent cap is a lie.
# `--cap 0` (the default) means no cap, which is what the weekly full run wants
# and what an uncapped invocation gets by passing nothing. The arithmetic lives
# in scripts/mutant-list.mjs, which asks stryker's own instrumenter how many
# mutants a range holds, so the number printed is the number stryker would have
# reported after the run rather than an estimate of it.
#
# Usage: scripts/mutate-changed.sh [--list-only] [--base REF] [--patch-file FILE]
#                                 [--cap N] [--mutants-file FILE]
#   --list-only        print the derived --mutate values, one per line, and stop
#                      (exit 0 even when there are none — the caller decides)
#   --base REF         diff against REF...HEAD (default origin/trunk)
#   --patch-file FILE  read `git diff -U0` output from FILE instead of running
#                      git; the test seam, not for daily use
#   --cap N            test at most N mutants, first by file then line, and
#                      print how many were deferred to the weekly run (0 = no cap)
#   --mutants-file FILE  read the mutant enumeration from FILE instead of
#                      instrumenting; the test seam for --cap
#
# STRYKER_BIN names the stryker to run. git-hooks/scan-mutation.sh sets it to the
# main checkout's binary when the gate fires inside a worktree, which has no
# node_modules of its own; unset (CI, `make mutate-changed`) it resolves to
# ./node_modules/.bin/stryker and then npx, as before.
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
CAP=0
MUTANTS_FILE=""

while [ "$#" -gt 0 ]; do
	case "$1" in
	--list-only) LIST_ONLY=1; shift ;;
	--base) BASE="${2:?--base needs a ref}"; shift 2 ;;
	--patch-file) PATCH_FILE="${2:?--patch-file needs a path}"; shift 2 ;;
	--cap) CAP="${2:?--cap needs a number}"; shift 2 ;;
	--mutants-file) MUTANTS_FILE="${2:?--mutants-file needs a path}"; shift 2 ;;
	-h | --help)
		sed -n '2,67p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
				# Nothing under __tests__ is a mutant host: a test helper has no
				# assertion that can kill it, so its survivors would fail every PR
				# that touched one (measured on the desktop-notify pull request:
				# 4 of 10 mutants survived in fake-pi.ts).
				mutable = (index(path, prefix) == 1) && (path !~ /__tests__/) && (path ~ /\.ts$/)
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

case "$CAP" in
'' | *[!0-9]*)
	printf 'mutate-changed: --cap needs a whole number, not "%s"\n' "$CAP" >&2
	exit 2
	;;
esac

ranges="$(mutate_ranges)"

# The cap, when one is asked for, replaces the range list with the ranges the
# first N mutants of the changed lines live on. Nothing here filters the diff
# itself: the count comes from stryker's instrumenter (scripts/mutant-list.mjs)
# so it is the same number stryker would have reported after the run.
CAPPED_EMPTY=0
if [ -n "$ranges" ] && [ "$CAP" -gt 0 ]; then
	cap_args=(--cap "$CAP")
	if [ -n "$MUTANTS_FILE" ]; then cap_args+=(--mutants-file "$MUTANTS_FILE"); fi
	spec_args=()
	while IFS= read -r range; do
		if [ -n "$range" ]; then spec_args+=("$range"); fi
	done <<<"$ranges"
	capped="$(node "$DIR/mutant-list.mjs" "${cap_args[@]}" "${spec_args[@]}")" || {
		printf 'mutate-changed: --cap %s could not count the mutants (node or agent/node_modules is missing)\n' "$CAP" >&2
		exit 1
	}
	ranges="$capped"
	if [ -z "$ranges" ]; then CAPPED_EMPTY=1; fi
fi

if [ -z "$ranges" ] && [ "$CAPPED_EMPTY" -eq 1 ] && [ "$LIST_ONLY" -eq 1 ]; then
	# Nothing under the cap: the changed lines hold no mutant at all, which is
	# the same verdict as an empty diff — print nothing, exit green.
	exit 0
fi

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
	if [ "$CAPPED_EMPTY" -eq 1 ]; then
		printf '== mutate-changed: no mutant on the changed lines of %s\n' "$against" >&2
		printf '   the cap had nothing to keep, and an empty --mutate list would widen\n' >&2
		printf '   to the whole stryker config, so this run is refused instead.\n' >&2
		exit 1
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
if [ "$CAP" -gt 0 ]; then
	printf '== mutate-changed: %s capped range(s) against %s, cap %s mutants\n' "$count" "$BASE" "$CAP"
else
	printf '== mutate-changed: %s added range(s) against %s\n' "$count" "$BASE"
fi
printf '%s\n' "$ranges" | sed 's/^/   agent\//'
printf '== mutate-changed: npx stryker run --mutate <above, comma joined> --force\n'

cd "$ROOT/agent" || {
	printf 'mutate-changed: %s/agent is missing — this is not a harness checkout, so there is nothing to run stryker in\n' "$ROOT" >&2
	exit 1
}
# One comma-separated --mutate, not one flag per range: stryker 10.1.1 splits
# the value on commas and keeps only the last --mutate it is given, so a
# repeated flag silently mutates one hunk and calls the rest covered.
specs="$(printf '%s\n' "$ranges" | paste -sd, -)"
# An explicit binary wins: the caller may be a worktree borrowing the main
# checkout's install through STRYKER_BIN (git-hooks/scan-mutation.sh).
if [ -n "${STRYKER_BIN:-}" ] && [ -x "${STRYKER_BIN}" ]; then
	exec "$STRYKER_BIN" run --mutate "$specs" --force
fi
if [ -x ./node_modules/.bin/stryker ]; then
	exec ./node_modules/.bin/stryker run --mutate "$specs" --force
fi
exec npx stryker run --mutate "$specs" --force
