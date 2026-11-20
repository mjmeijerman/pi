#!/usr/bin/env bash
# ============================================================================
# scan-mutation.sh — the mutation check, at the last cheap moment before a push.
#
# Radar basis: #2 mutation testing (Adopt), #3 shorten feedback loops (Adopt).
#
# Why this exists. The mutation gate went red in CI six times on one day (PRs
# 159, 192, 193 and 194 among them), and every red round is a whole fix
# cycle: three mutants, one survivor, fifty seconds of the runner's time
# (specs/archive/fix-194-mutants.md). The same run locally costs seconds to a
# minute. Nothing between a branch and origin ran it, so the verdict always
# arrived after the push. learn.md even tells a learner that a local run "buys
# no verdict, only wall clock" — true only if the push itself is gated, and it
# was not. This hook is that gate.
#
# Scope, the same one scripts/mutate-changed.sh narrows to: the pushed range
# adds or changes lines in agent/extensions/**/*.ts outside __tests__/. A
# docs, shell or big-boss-pi push touches none of that, takes milliseconds and
# prints nothing — the gate is invisible until it has something to say.
#
# It shells out to scripts/mutate-changed.sh rather than re-deriving the mutant
# range, so the hook and the CI job answer the same question. It never stashes,
# checks out or writes a tracked file: the mutant run keeps its own scratch
# (.stryker-tmp, agent/reports) exactly as a hand run does.
#
# Ref shape: pre-push feeds "<local ref> <local sha> <remote ref> <remote sha>"
# on stdin, one line per ref, the same shape scan-prepush.sh reads.
#
# Override: SKIP_MUTATION_SCAN=1, or git push --no-verify.
# Budget: MUTATION_PREPUSH_CAP seconds (default 600). A capped run refuses.
# ============================================================================
set -u
[ "${SKIP_MUTATION_SCAN:-}" = "1" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$ROOT" ] || exit 0

ZERO="0000000000000000000000000000000000000000"
CAP="${MUTATION_PREPUSH_CAP:-600}"
SCOPE=':(glob,top)agent/extensions/**/*.ts'

# One named line, then green: a skip that says nothing is the silent exit this
# hook exists to prevent.
skip() {
	printf 'mutation-gate: skip — %s\n' "$1"
	exit 0
}

# scope_paths — the files in the pushed range that hold mutatable lines.
# Filter is the same as mutate-changed.sh: extension sources, tests excluded,
# additions and modifications only (a deleted file has no mutant).
scope_paths() {
	local local_sha="$1" remote_sha="$2"
	if [ "$remote_sha" = "$ZERO" ]; then
		# New branch: every pushed commit that no remote already has.
		git -C "$ROOT" log --format= --name-only --diff-filter=ACMR \
			"$local_sha" --not --remotes -- "$SCOPE" 2>/dev/null
	else
		git -C "$ROOT" diff --name-only --diff-filter=ACMR \
			"$remote_sha" "$local_sha" -- "$SCOPE" 2>/dev/null
	fi | grep -v '/__tests__/' | grep -v '^$'
}

IN_SCOPE=0
while read -r local_ref local_sha remote_ref remote_sha; do
	[ -z "${local_ref:-}" ] && continue
	[ "$local_sha" = "$ZERO" ] && continue # branch deletion — nothing to gate
	if [ -n "$(scope_paths "$local_sha" "$remote_sha")" ]; then
		IN_SCOPE=1
	fi
done

# Nothing in scope: stay silent and instant. This is the common case, and it is
# not a skip — there is no verdict to report because there is no mutant.
[ "$IN_SCOPE" -eq 1 ] || exit 0

[ -f "$ROOT/scripts/mutate-changed.sh" ] ||
	skip "scripts/mutate-changed.sh is missing in $ROOT — no mutation run, and none claimed"
[ -f "$ROOT/agent/stryker.conf.json" ] ||
	skip "agent/stryker.conf.json is missing in $ROOT — no mutation run, and none claimed"
command -v node >/dev/null 2>&1 ||
	skip "node is not on PATH, so stryker cannot run"

# stryker_from_main — the main checkout's stryker binary, for a git worktree.
#
# A worktree is a checkout without its own node_modules: `git worktree add`
# copies tracked files and nothing else. So the availability check below failed
# in every worker's worktree and the gate skipped by name — honestly, and
# uselessly, because the survivor then arrived in CI, which is the late red
# round this hook exists to prevent. Measured on 2026-11-20: 32 of the 44
# worktrees of this repo had no agent/node_modules.
#
# The binary is the same install either way. `--git-common-dir` is the main
# checkout's .git, so its parent is the tree that has node_modules. A normal
# checkout returns its own .git, and the `"$main" != "$1"` guard keeps this
# from claiming a fallback that is the tree itself.
stryker_from_main() {
	local common main
	common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
	[ -n "$common" ] || return 1
	main="$(dirname -- "$common")"
	[ "$main" != "$1" ] || return 1
	[ -x "$main/agent/node_modules/.bin/stryker" ] || return 1
	printf '%s\n' "$main/agent/node_modules/.bin/stryker"
}

STRYKER_BIN=""
if [ -x "$ROOT/agent/node_modules/.bin/stryker" ]; then
	STRYKER_BIN="$ROOT/agent/node_modules/.bin/stryker"
elif STRYKER_BIN="$(stryker_from_main "$ROOT")"; then
	printf 'mutation-gate: %s is a worktree with no node_modules; running the main checkout stryker\n' "$ROOT"
else
	STRYKER_BIN=""
	( cd "$ROOT/agent" && npx --no-install stryker --version >/dev/null 2>&1 ) ||
		skip "no stryker in $ROOT/agent/node_modules, no main checkout to borrow one from, and npx --no-install failed — run npm ci in agent/"
fi
# mutate-changed.sh prefers this over its own ./node_modules: it is the same
# install, and in a worktree it is the only one there is.
export STRYKER_BIN

# The pushed range and the range mutate-changed.sh derives are not the same
# question: it diffs against origin/trunk. A branch whose extension commits are
# already on trunk adds no line there, and a bare run refuses loudly on an empty
# range. That refusal is not a survivor, so ask first and skip by name instead.
RANGES="$( cd "$ROOT" && bash scripts/mutate-changed.sh --list-only 2>/dev/null )" || RANGES=""
[ -n "$RANGES" ] ||
	skip "the pushed range adds no extension line against origin/trunk, so there is no mutant to run"

LOG="$(mktemp)" || skip "could not make a temp file to capture the run"
trap 'rm -f -- "$LOG"' EXIT

START="$SECONDS"
# The cap is wall clock, and a capped run is a refusal: an undecided mutant is
# not a pass, so a run that ran out of time must never be read as green.
RC=0
if command -v timeout >/dev/null 2>&1; then
	( cd "$ROOT" && timeout -k 15 "$CAP" bash scripts/mutate-changed.sh ) 2>&1 | tee "$LOG"
	RC=${PIPESTATUS[0]}
else
	# No coreutils timeout: the same cap with a watchdog, at the cost of live
	# output (the run is printed when it ends).
	( cd "$ROOT" && bash scripts/mutate-changed.sh ) >"$LOG" 2>&1 &
	RUN_PID=$!
	( sleep "$CAP" && kill -TERM "$RUN_PID" 2>/dev/null ) &
	WATCH_PID=$!
	wait "$RUN_PID"
	RC=$?
	kill "$WATCH_PID" 2>/dev/null
	cat -- "$LOG"
fi
ELAPSED=$((SECONDS - START))

if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ] || { [ "$RC" -ge 128 ] && [ "$ELAPSED" -ge "$CAP" ]; }; then
	{
		printf 'mutation-gate: refusing the push — the run hit its %ss wall-clock cap after %ss\n' \
			"$CAP" "$ELAPSED"
		printf 'mutation-gate: how far it got (last 5 lines of the run):\n'
		tail -5 "$LOG" | sed 's/^/   /'
		printf 'mutation-gate: an undecided mutant is not a pass, and this cap is not one either.\n'
		printf 'mutation-gate: override on purpose: git push --no-verify (skips every local hook, the secret scan too)\n'
	} >&2
	exit 1
fi

if [ "$RC" -ne 0 ]; then
	{
		printf 'mutation-gate: refusing the push — scripts/mutate-changed.sh exited %s after %ss\n' "$RC" "$ELAPSED"
		SURVIVORS="$(grep -a -e '\[Survived\]' -e '\[NoCoverage\]' -e 'Final mutation score' -- "$LOG" | head -10)"
		if [ -n "$SURVIVORS" ]; then
			printf 'mutation-gate: the run printed:\n'
			printf '%s\n' "$SURVIVORS" | sed 's/^/   /'
		else
			printf 'mutation-gate: the run printed no survivor line; its last 5 lines:\n'
			tail -5 "$LOG" | sed 's/^/   /'
		fi
		printf 'mutation-gate: override on purpose: git push --no-verify (skips every local hook, the secret scan too)\n'
	} >&2
	exit 1
fi

# Exit 0 is not the verdict the PR gets. The checked-in agent/stryker.conf.json
# has `thresholds.break: null`, so a survivor there is a low score, not a failed
# run; the CI job derives a config with break 100 and fails on the same mutant.
# Reading that exit code as a pass is exactly the late red round this hook is
# here to prevent, so a printed survivor refuses the push too. Measured:
# flipping one comparison in agent/extensions/lib/usage-format.ts scores 80.00,
# prints `[Survived] EqualityOperator`, and exits 0 — CI red, local green.
#
# A mutant no test covers counts too. break 100 is a threshold on stryker's
# `mutationScore`, and that score's denominator is `totalValid = killed +
# timeout + survived + noCoverage` (mutation-testing-metrics
# calculateMetrics.js, toMetrics) — a line the branch added and no test runs is
# an undetected mutant and lands the score under 100, while it prints
# `[NoCoverage]`, not `[Survived]`. The grep that had only the survivor status
# therefore said "push allowed" about a run CI would fail.
UNDETECTED="$(grep -a -c -E '\[(Survived|NoCoverage)\]' -- "$LOG")"
if [ "${UNDETECTED:-0}" -gt 0 ]; then
	{
		printf 'mutation-gate: refusing the push — %s undetected mutant(s) after %ss\n' "$UNDETECTED" "$ELAPSED"
		printf 'mutation-gate: agent/stryker.conf.json has break null, so the local run exited 0;\n'
		printf 'mutation-gate: the PR job derives break 100 from the same config and fails on these,\n'
		printf 'mutation-gate: and "undetected" is survived + noCoverage, which is the score it reads.\n'
		printf 'mutation-gate: the run printed:\n'
		grep -a -A2 -E '\[(Survived|NoCoverage)\]' -- "$LOG" | head -20 | sed 's/^/   /'
		printf 'mutation-gate: override on purpose: git push --no-verify (skips every local hook, the secret scan too)\n'
	} >&2
	exit 1
fi

SCORE="$(grep -a 'All files' -- "$LOG" | tail -1)"
printf 'mutation-gate: %ss, push allowed — %s\n' "$ELAPSED" \
	"${SCORE:-scripts/mutate-changed.sh exited 0 with no survivor on the pushed range}"
exit 0
