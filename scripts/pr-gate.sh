#!/usr/bin/env bash
# ============================================================================
# pr-gate.sh — the PR body gates, in one place, for CI and for the author.
#
# Radar basis: #3 path-to-production mapping (Adopt), #17 risk-tiered human
# oversight (Trial), #41 coding throughput as a measure of productivity (Hold),
# #42 human-in-the-loop theater (Caution).
#
# These gates used to live inside .github/workflows/pr-tier.yml only, so the
# first time anyone learned a body would fail was a red check minutes after the
# push, and a local dry run could not exist at all. One implementation, two
# callers: the workflow runs this file and `make pr-check` runs it, so CI and a
# local run cannot disagree about a body.
#
# Usage:
#   scripts/pr-gate.sh --body FILE
#       all gates. With no file list, the changed files come from the merge base
#       of origin/trunk and HEAD — a diff that cannot be resolved is an error
#       naming why, never an empty list that passes.
#   scripts/pr-gate.sh --body FILE --base REV --head REV
#       all gates; changed paths come from `git diff --name-only REV...REV`.
#       BASE_SHA/HEAD_SHA in the environment, as CI sets them, do the same.
#   scripts/pr-gate.sh --body FILE --branch REV [--base REV]
#       all gates for another branch without switching this checkout: changed
#       paths come from the merge base of --base (default origin/trunk) and REV.
#   scripts/pr-gate.sh --body FILE --paths FILE
#       all gates; changed paths are read from FILE, one per line. An empty
#       FILE is a gate handed nothing, so the diff gates fail, not pass.
#   scripts/pr-gate.sh --body FILE --gate mission|tier|test-change|radar
#       one gate only, the way each CI job runs it. Mission needs no diff;
#       tier, test-change and radar fail when they cannot see one.
#
#   make pr-check BODY=pr.md [BRANCH=my-branch] [BASE=origin/trunk] [HEAD=HEAD]
#                  [PATHS=paths.txt]
#
# An empty diff is never a pass: when BASE and HEAD (or the merge base and HEAD)
# resolve to the same commit, the run says `unverifiable: no changed files` and
# names the command that shows the real diff. That is the gap PR 88 fell
# through - a checkout sitting on trunk diffed trunk against trunk, the rules
# saw nothing, and a green local verdict hid the red CI one.
#
# Exit codes: 0 every gate that ran passed, 1 a gate failed or was handed no
# file list it needs (CI would be red), 2 bad usage, unreadable input, a diff
# that cannot be resolved, or an empty diff (nothing was checked). Output is the CI verdict verbatim: the
# `::error::` / `::notice::` annotations, plus the markdown summary block.
# In CI the block goes to $GITHUB_STEP_SUMMARY; anywhere else it goes to stdout.
# ============================================================================
set -uo pipefail
shopt -s nocasematch

# Untrusted text (the PR body) is only ever matched here, never expanded into a
# command line (injection, blip 38).

BODY_FILE=""
PATHS_FILE=""
BASE_REV=""
HEAD_REV=""
BRANCH_REV=""
GATES="all"

# DIFF_CHECKED is the point of this file: green means checked. A gate that
# needs the changed files and never got them is red (PR 67: the local run was
# handed zero files, called that "nothing to justify", and printed green for a
# body the same CI run rejected).
CHANGED=()
TRUNK_HINT="origin/trunk"
DIFF_CHECKED=0
DIFF_WHY="no changed-file list and no diff range were given"
FAILED=0

usage() { sed -n '/^# Usage:/,/^# In CI the block/p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'; }
die() {
	printf 'pr-gate: %s\n' "$*" >&2
	exit 2
}
fail() {
	printf '::error::%s\n' "$*"
	FAILED=1
}
note() { printf '::notice::%s\n' "$*"; }

# Markdown block for the job summary. Local runs read the same block on stdout,
# so "which harness path forced High" is answerable before the push.
summary() {
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		cat >>"$GITHUB_STEP_SUMMARY"
	else
		cat
	fi
}

while [ $# -gt 0 ]; do
	case "$1" in
	--body)
		shift
		BODY_FILE="${1:-}"
		;;
	--paths)
		shift
		PATHS_FILE="${1:-}"
		;;
	--base)
		shift
		BASE_REV="${1:-}"
		;;
	--head)
		shift
		HEAD_REV="${1:-}"
		;;
	--branch)
		shift
		BRANCH_REV="${1:-}"
		;;
	--gate)
		shift
		GATES="${1:-}"
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "unknown argument: $1 (see --help)"
		;;
	esac
	shift
done

[ -n "$BODY_FILE" ] || die "no --body FILE (see --help)"
[ -f "$BODY_FILE" ] || die "no such body file: $BODY_FILE"
case "$GATES" in
all | mission | tier | test-change | radar) ;;
*) die "--gate takes all|mission|tier|test-change|radar, not '$GATES'" ;;
esac

BODY="$(cat -- "$BODY_FILE")"

# ---------------------------------------------------------------- changed paths --
# One place decides what "the diff" means, in this order: an explicit --paths
# file, an explicit --base/--head pair (flags, or the BASE_SHA/HEAD_SHA CI puts
# in the environment), then the merge base of origin/trunk and HEAD. Deriving
# is what makes `make pr-check BODY=pr.md` alone honest: handed nothing, the old
# version diffed nothing, found no test file, and printed green.

# origin/trunk, or a local trunk when the remote-tracking ref is absent.
resolve_trunk() {
	local ref
	for ref in origin/trunk trunk; do
		if git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null 2>&1; then
			printf '%s\n' "$ref"
			return 0
		fi
	done
	return 1
}

# Read REV...REV into CHANGED. Failure is loud and names the fix: a ref that
# does not resolve (no origin/trunk, a shallow clone, a detached head with no
# merge base) used to become an empty list — a green verdict for a diff nobody
# looked at.
diff_range() {
	local base_rev="$1" head_rev="$2" out=""
	if ! out="$(git diff --name-only "${base_rev}...${head_rev}" 2>&1)"; then
		die "cannot diff ${base_rev}...${head_rev}: ${out}
  The harness-path and test-change rules need the changed files, and guessing
  'nothing changed' is how a local green hid a red CI (PR 67). Fix one of:
  'git fetch origin trunk' (a merge base is required), '--paths FILE' with
  'git diff --name-only BASE..HEAD', or '--base REV --head REV'."
	fi
	mapfile -t CHANGED < <(printf '%s\n' "$out" | awk 'NF')
	# A diff that resolves to no commits is the PR 88 gap: a checkout sitting on
	# trunk diffs trunk against itself, every rule sees nothing, and the old
	# version printed green over it. Zero files is 'unverifiable', never a pass.
	if ((${#CHANGED[@]} == 0)); then
		die "unverifiable: no changed files between ${base_rev} and ${head_rev} (git diff --name-only ${base_rev}...${head_rev} is empty)
  Nothing was checked, so this is not a green verdict: ${base_rev} and ${head_rev}
  are the same commit, or the commit you meant to check is not in this tree.
  Show the real diff of a branch without leaving this checkout:
    git diff --name-only ${TRUNK_HINT}...<branch>
  and check it with:
    make pr-check BRANCH=<branch> BODY=${BODY_FILE}"
	fi
	DIFF_CHECKED=1
	DIFF_WHY="${base_rev}...${head_rev} (${#CHANGED[@]} changed files)"
}

# Another branch, from a checkout that stays where it is: the boss's tree sits
# on trunk and keeps being read, so checking a worker's branch must not mean
# switching to it (PR 88: the switch never happened, so trunk was diffed
# against trunk and the gate blessed a body CI rejected).
branch_diff() {
	local branch="$1" trunk base
	git rev-parse --verify --quiet "${branch}^{commit}" >/dev/null 2>&1 ||
		die "no such branch or commit to check: '${branch}' (git rev-parse --verify ${branch}^{commit} failed)"
	if [ -n "$BASE_REV" ]; then
		trunk="$BASE_REV"
	else
		trunk="$(resolve_trunk)" || die "no origin/trunk to diff '${branch}' against (and no --base)
  Run 'git fetch origin trunk', or pass '--base REV --branch ${branch}'."
	fi
	if ! base="$(git merge-base "$trunk" "$branch" 2>&1)"; then
		die "no merge base between ${trunk} and ${branch}: ${base}
  Fetch the history ('git fetch origin trunk'), or diff explicit commits with
  '--base REV --head REV'."
	fi
	diff_range "$base" "$branch"
	DIFF_WHY="merge base of ${trunk} and ${branch} (${base}), ${#CHANGED[@]} changed files"
}

load_changed() {
	local trunk base
	if [ -n "$PATHS_FILE" ]; then
		[ -f "$PATHS_FILE" ] || die "no such paths file: $PATHS_FILE"
		mapfile -t CHANGED < <(awk 'NF' "$PATHS_FILE")
		if ((${#CHANGED[@]} == 0)); then
			# An empty list is the bug, not the answer: the gate was handed no
			# files, so require_diff makes it red instead of green.
			DIFF_WHY="the paths file ${PATHS_FILE} lists no files"
		else
			DIFF_CHECKED=1
			DIFF_WHY="paths file ${PATHS_FILE} (${#CHANGED[@]} changed files)"
		fi
	elif [ -n "$BRANCH_REV" ]; then
		if [ -n "$HEAD_REV" ]; then
			die "--branch names the head itself; drop --head (or use --base REV --head REV)"
		fi
		branch_diff "$BRANCH_REV"
	elif [ -n "$BASE_REV" ] || [ -n "$HEAD_REV" ]; then
		if [ -z "$BASE_REV" ] || [ -z "$HEAD_REV" ]; then
			die "--base and --head go together (base='$BASE_REV' head='$HEAD_REV')"
		fi
		diff_range "$BASE_REV" "$HEAD_REV"
	elif [ -n "${BASE_SHA:-}" ] && [ -n "${HEAD_SHA:-}" ]; then
		# CI's form: both shas arrive in the environment and no flags are passed.
		diff_range "$BASE_SHA" "$HEAD_SHA"
	else
		trunk="$(resolve_trunk)" || die "no origin/trunk to diff HEAD against (and no --base/--head or --paths)
  A gate with no file list cannot check its rule, so it does not pass. Run
  'git fetch origin trunk', or pass '--paths FILE' / '--base REV --head REV'."
		TRUNK_HINT="$trunk"
		if ! base="$(git merge-base "$trunk" HEAD 2>&1)"; then
			die "no merge base between ${trunk} and HEAD: ${base}
  A shallow clone or an unrelated HEAD has nothing to diff; fetch the history
  ('git fetch --unshallow origin' or 'git fetch origin trunk'), or pass
  '--paths FILE' / '--base REV --head REV'."
		fi
		diff_range "$base" HEAD
		DIFF_WHY="merge base of ${trunk} and HEAD (${base}), ${#CHANGED[@]} changed files"
	fi
	# Which diff was checked belongs in the output: "green" over the wrong diff
	# is the failure this file exists to stop.
	printf 'diff: %s\n' "$DIFF_WHY"
}

# A gate that needs a file list and was handed no usable one is red. Second
# requirement of PR 67: "green (all)" is only ever printed for rules that
# actually ran, so a local green cannot hide the red CI check.
require_diff() {
	local gate="$1"
	((DIFF_CHECKED == 1)) && return 0
	fail "the ${gate} gate was given no changed-file list (${DIFF_WHY}), so the rule was never applied — a gate that checked nothing is not green. Pass --paths FILE, --base REV --head REV, or run where 'git merge-base origin/trunk HEAD' resolves"
	{
		echo "## ${gate}: not checked"
		echo ""
		echo "This gate needs the changed files. This run supplied none:"
		echo ""
		echo "\`${DIFF_WHY}\`"
		echo ""
		echo "The rule was not applied, so the verdict is red rather than green."
		echo "Pass \`--paths FILE\` (\`git diff --name-only BASE..HEAD\`),"
		echo "\`--base REV --head REV\`, or run from a checkout with \`origin/trunk\`."
	} | summary
	return 1
}

# ------------------------------------------------------------------- mission --
# A literal `Mission:` line of at least 20 characters after the prefix,
# emphasis stripped. A `## Mission` heading is not a line a gate reads: it has
# `##` in front of the word, so the prefix never matches.
gate_mission() {
	local flat found line mission
	flat="${BODY//\*/}"

	found=0
	mission=""
	while IFS= read -r line; do
		if [[ $line =~ ^[[:space:]]*mission[[:space:]]*:[[:space:]]*(.*)$ ]]; then
			found=1
			mission="${BASH_REMATCH[1]}"
			break
		fi
	done <<<"$flat"

	if ((found == 0)); then
		fail "the PR body states no mission (blip 41: effort is not mission). Add a line: Mission: <who is better off, and how you would see it>"
		{
			echo "## Mission: missing"
			echo ""
			echo "No \`Mission:\` line in the PR body."
			echo "Define it as \`docs/kent-beck-craft-harness.md\` does: who is better off,"
			echo "and the observation that shows the gain. Effort is not mission."
		} | summary
		return 1
	fi

	# Trailing whitespace would make a short mission look long enough.
	mission="$(printf '%s' "$mission" | sed -e 's/[[:space:]]*$//')"
	echo "mission: ${mission:-<empty>}"

	# Still the template's hint, angle brackets and all: a placeholder names no
	# one, so it is the same failure as an empty line, with a longer body.
	if [[ $mission == \<*\> ]]; then
		fail "the Mission line is still the template placeholder: ${mission} — replace it with who is better off and how we would see it"
		{
			echo "## Mission: placeholder"
			echo ""
			echo "The \`Mission:\` line is the template hint, not a mission:"
			echo ""
			echo "\`${mission}\`"
			echo ""
			echo "Replace it with the person or system that gains and the observation"
			echo "that shows the gain. Effort is not mission."
		} | summary
		return 1
	fi

	if ((${#mission} < 20)); then
		fail "the Mission line is ${#mission} characters after the prefix; a mission names who gains and how we would see it, at least 20 characters"
		{
			echo "## Mission: too short"
			echo ""
			echo "\`Mission:\` is filled in, but only with \`${mission:-<empty>}\`."
			echo "A mission names the person or system that gains and the observation that shows it."
			echo "Example: \`Mission: a reviewer sees which gate failed without opening the logs.\`"
		} | summary
		return 1
	fi

	note "mission stated: ${mission}"
	{
		echo "## Mission: stated"
		echo ""
		echo "${mission}"
	} | summary
	return 0
}

# ---------------------------------------------------------------------- tier --
# `Review tier: High|Medium|Low` in the body, and High whenever the diff
# touches a harness path, whatever the body claims. The path mapping is here
# and nowhere else: a second copy is how the two answers drift apart.
gate_tier() {
	local path tier
	local -a harness=()

	tier=""
	if [[ $BODY =~ review[[:space:]]+tier[[:space:]]*:[[:space:]]*\*{0,2}[[:space:]]*(high|medium|low) ]]; then
		tier="${BASH_REMATCH[1],,}"
	fi
	if [ -z "$tier" ]; then
		fail "the PR body states no review tier (blips 17, 42). Add one of: Review tier: High / Medium / Low"
		{
			echo "## Review tier: missing"
			echo ""
			echo "No \`Review tier: High|Medium|Low\` line in the PR body."
			echo "Tiers are defined in \`agent/AGENTS.md\`."
		} | summary
		return 1
	fi
	echo "tier: $tier"

	require_diff tier || return 1

	for path in "${CHANGED[@]}"; do
		case "$path" in
		agent/extensions/* | git-hooks/* | sandbox/* | .github/* | agent/AGENTS.md)
			harness+=("$path")
			;;
		esac
	done
	echo "changed files: ${#CHANGED[@]}"

	# The backticks in this summary block are markdown, not expansion.
	# shellcheck disable=SC2016
	{
		echo "## Review tier: ${tier}"
		echo ""
		echo "Changed files: ${#CHANGED[@]}"
		if ((${#harness[@]} > 0)); then
			echo ""
			echo "Harness paths in the diff (tier must be High):"
			echo ""
			printf -- '- `%s`\n' "${harness[@]}"
		fi
	} | summary

	if ((${#harness[@]} > 0)) && [ "$tier" != high ]; then
		fail "$(printf 'harness paths changed; tier must be High (blips 17, 42) — offending paths: %s' "${harness[*]}")"
		return 1
	fi

	note "tier check passed: $tier"
	return 0
}

# --------------------------------------------------------------- test change --
# A test change and a source change in the same pull request have to explain
# themselves. Accepted: a `Test change: <reason>` line with an actual reason,
# not a placeholder. Measurement: red on a source+test diff without that line.
gate_test_change() {
	local path flat found reason line
	local -a tests=() source=()

	require_diff test-change || return 1

	# Any recognised test suffix counts, not just the one this repo happens to
	# use today: a .test.mjs is as much a test as a .test.ts, and a gate that
	# cannot see a test cannot ask for its reason. `.test.sh` is here because
	# this repo's own gate tests are shell (scripts/tests/*.test.sh, run by
	# `make scripts-test`); without it a PR that edited a bash test beside the
	# script it covers was told "no test file changed", so the rule that asks
	# for the reason looked at nothing (blips 29, 42).
	#
	# Each suffix is anchored by the whole-match glob: the pattern needs the
	# literal `.test.` segment, so `contest.sh` is source, not a test.
	for path in "${CHANGED[@]}"; do
		case "$path" in
		*.test.ts | *.test.tsx | *.test.js | *.test.mjs | *.test.cjs | *.test.py | *.test.sh) tests+=("$path") ;;
		*.ts | *.tsx | *.js | *.mjs | *.cjs | *.sh | *.py) source+=("$path") ;;
		esac
	done

	echo "tests changed: ${#tests[@]}; source changed: ${#source[@]}"

	if ((${#tests[@]} == 0)); then
		echo "no test file changed; nothing to justify"
		return 0
	fi
	if ((${#source[@]} == 0)); then
		echo "tests changed without source beside them; not this gate"
		return 0
	fi

	# `Test change: the retry needed a fake clock` and `**Test change:** ...`
	# both count: emphasis is stripped first, and the label has to start a line,
	# so a sentence that happens to mention "Test change:" is not a reason (and
	# neither is the template comment that explains where the label goes).
	flat="${BODY//\*/}"
	found=0
	reason=""
	while IFS= read -r line; do
		if [[ $line =~ ^[[:space:]]*test[[:space:]]+change[[:space:]]*:[[:space:]]*(.*)$ ]]; then
			found=1
			reason="${BASH_REMATCH[1]}"
			break
		fi
	done <<<"$flat"
	# Trailing whitespace would make an empty reason look long enough.
	reason="$(printf '%s' "$reason" | sed -e 's/[[:space:]]*$//')"
	echo "reason: ${reason:-<none>}"

	# Still the template hint: angle brackets name no reason, so the line is
	# there without being filled in.
	if [[ $reason == \<*\> ]]; then
		fail "the Test change line is still the template placeholder: ${reason} — say why the test had to change, or delete the line when no test changed"
		return 1
	fi

	if ((${#reason} < 10)); then
		# The backticks below are markdown, not expansion.
		# shellcheck disable=SC2016
		{
			echo "## Test change: reason missing"
			echo ""
			echo "This pull request changes a test file next to source:"
			echo ""
			printf -- '- test: `%s`\n' "${tests[@]}"
			printf -- '- source: `%s`\n' "${source[@]}"
			echo ""
			echo "Add a line to the PR body:"
			echo ""
			echo '`Test change: <why the test had to change>`'
		} | summary
		fail "a test file and its source changed together; the PR body needs a 'Test change: <reason>' line"
		return 1
	fi

	note "test change justified: ${reason}"
	{
		echo "## Test change: justified"
		echo ""
		echo "${reason}"
	} | summary
	return 0
}

# --------------------------------------------------------------------- radar --
# agent/AGENTS.md: "Harness changes cite a Thoughtworks Radar blip (Vol. 35,
# Adopt preferred): the problem it fixes and how it is measured." Nothing
# checked it — measured 2026-11-22, none of the last 25 commits on trunk cited a
# blip. This gate is that check for a diff that changes code. The code-path list
# below is `scripts/` and `bin/` on top of exactly the paths gate_tier calls
# harness paths: move one list and move the other, or the two answers drift.
# A docs-only diff (docs/, README.md, a report, a spec) needs no citation.
RADAR_TSV_REL="docs/radar-blips.tsv"

# The body with fenced code blocks dropped and markdown emphasis stripped: a
# `Radar:` line inside a ``` block is an example, not the body's claim.
body_unfenced() {
	local line trimmed fence=0 flat="${BODY//\*/}"
	while IFS= read -r line; do
		trimmed="${line#"${line%%[![:space:]]*}"}"
		case "$trimmed" in
		'```'* | '~~~'*)
			fence=$((1 - fence))
			continue
			;;
		esac
		((fence == 0)) && printf '%s\n' "$line"
	done <<<"$flat"
}

# The blip vocabulary, from the repo root when git knows one, else beside this
# script (a copy in $RUNNER_TEMP still has this repo's file to read), else the
# working directory. $RADAR_TSV wins, for a test that wants another file.
radar_tsv() {
	local cand root=""
	if [ -n "${RADAR_TSV:-}" ]; then
		printf '%s\n' "$RADAR_TSV"
		return 0
	fi
	root="$(git rev-parse --show-toplevel 2>/dev/null)" || root=""
	for cand in "${root:+$root/$RADAR_TSV_REL}" \
		"$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/$RADAR_TSV_REL" \
		"$RADAR_TSV_REL"; do
		if [ -n "$cand" ] && [ -f "$cand" ]; then
			printf '%s\n' "$cand"
			return 0
		fi
	done
	return 1
}

gate_radar() {
	local path line radar tsv n last tail measured
	local -a code=() nums=() unknown=()

	require_diff radar || return 1

	for path in "${CHANGED[@]}"; do
		case "$path" in
		bin/* | scripts/* | agent/extensions/* | git-hooks/* | sandbox/* | .github/*)
			code+=("$path")
			;;
		esac
	done
	echo "code files changed: ${#code[@]} (of ${#CHANGED[@]})"

	if ((${#code[@]} == 0)); then
		note "radar: not applicable — no code changed, so no blip is required"
		{
			echo "## Radar: not applicable"
			echo ""
			echo "The diff changes no code path (\`bin/\`, \`scripts/\`," 
			echo "\`agent/extensions/\`, \`git-hooks/\`, \`sandbox/\`, \`.github/\`), so"
			echo "no Radar citation is required."
		} | summary
		return 0
	fi

	radar=""
	while IFS= read -r line; do
		if [[ $line =~ ^[[:space:]]*radar[[:space:]]*:[[:space:]]*(.*)$ ]]; then
			radar="${BASH_REMATCH[1]}"
			break
		fi
	done <<<"$(body_unfenced)"
	radar="$(printf '%s' "$radar" | sed -e 's/[[:space:]]*$//')"
	echo "radar: ${radar:-<none>}"

	# `blip 20`, `blip #20` and `#20` all name the same blip; a `#` in a heading
	# is not on this line, so the loose form costs nothing.
	mapfile -t nums < <(printf '%s\n' "$radar" |
		grep -oiE '(blip[[:space:]]*#?|#)[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | sort -un)

	if ((${#nums[@]} == 0)); then
		fail "the PR body states no Radar blip, and this diff changes code (blip 20). Add a line: Radar: blip <n> — <the problem it fixes and how it is measured>"
		{
			echo "## Radar: missing"
			echo ""
			echo "The diff changes code:"
			echo ""
			printf -- '- `%s`\n' "${code[@]}"
			echo ""
			echo "Add a line to the PR body, citing a Thoughtworks Radar blip from"
			echo "\`${RADAR_TSV_REL}\` and how the change is measured:"
			echo ""
			echo '`Radar: blip 20 — the guard fails loudly instead of repairing silently, checked by scripts/tests/guard.test.sh`'
		} | summary
		return 1
	fi

	if ! tsv="$(radar_tsv)"; then
		fail "cannot find ${RADAR_TSV_REL} to check the cited blip against — the allowlist is what makes a citation mean something, so a run without it is not green"
		{
			echo "## Radar: unverifiable"
			echo ""
			echo "No \`${RADAR_TSV_REL}\` found from the repo root, beside this"
			echo "script, or in the working directory."
		} | summary
		return 1
	fi

	for n in "${nums[@]}"; do
		if ! awk -F'\t' -v n="$n" 'NR > 1 && $1 == n { found = 1 } END { exit !found }' "$tsv"; then
			unknown+=("$n")
		fi
	done
	if ((${#unknown[@]} > 0)); then
		fail "$(printf 'the Radar line cites blip %s, which is not in %s — a fabricated blip reads well and means nothing; cite a real one or drop the claim' "${unknown[*]}" "$RADAR_TSV_REL")"
		{
			echo "## Radar: unknown blip"
			echo ""
			echo "Cited but not in \`${RADAR_TSV_REL}\`:"
			echo ""
			printf -- '- blip `%s`\n' "${unknown[@]}"
			echo ""
			echo "The first column of that file is the list of blips that exist."
		} | summary
		return 1
	fi

	# The measurement: everything after the last number, with punctuation and
	# whitespace removed, has to say something. "Radar: blip 20" alone names a
	# blip and no way to see the change working.
	last="${nums[-1]}"
	tail=""
	if [[ $radar =~ ^(.*)(blip[[:space:]]*#?|#)[[:space:]]*${last}(.*)$ ]]; then
		tail="${BASH_REMATCH[3]}"
	fi
	measured="$(printf '%s' "$tail" | sed -e 's/[^[:alnum:]]//g')"
	echo "radar: blip ${last}, ${#measured} characters of measurement"

	if ((${#measured} < 15)); then
		fail "the Radar line names blip ${last} but does not say how the change is measured, and at least 15 characters after the number are required. Add: Radar: blip ${last} — <the problem it fixes and how it is measured>"
		{
			echo "## Radar: how it is measured, missing"
			echo ""
			echo "The line names a blip and stops:"
			echo ""
			echo "\`${radar}\`"
			echo ""
			echo "At least 15 characters after the last number, excluding"
			echo "punctuation and whitespace, have to say how the change is measured."
		} | summary
		return 1
	fi

	note "radar blip ${nums[*]} cited, measurement stated"
	{
		echo "## Radar: blip ${nums[*]}"
		echo ""
		echo "${radar}"
	} | summary
	return 0
}


ORDER=()
case "$GATES" in
all) ORDER=(mission tier test-change radar) ;;
*) ORDER=("$GATES") ;;
esac

# Only read a diff when a gate needs one: `--gate mission` is the body-only CI
# job, and it must keep working in a checkout with no usable diff.
for gate in "${ORDER[@]}"; do
	case "$gate" in
	tier | test-change | radar)
		load_changed
		break
		;;
	esac
done

for gate in "${ORDER[@]}"; do
	case "$gate" in
	mission) gate_mission || FAILED=1 ;;
	tier) gate_tier || FAILED=1 ;;
	test-change) gate_test_change || FAILED=1 ;;
	radar) gate_radar || FAILED=1 ;;
	esac
done

if ((FAILED == 0)); then
	echo "pr-gate: green${GATES:+ (${GATES})}"
	exit 0
fi
printf 'pr-gate: red (%s) — CI rejects this body, and a gate handed no file list counts as red until it can check\n' "${ORDER[*]}"
# The verdict goes to stderr as well: CI reads stdout, a person or a script that
# captured only stderr used to see a bare exit 1 with nothing next to it.
printf 'pr-gate: red (%s) — the per-gate reasons are above (::error:: lines)\n' "${ORDER[*]}" >&2
exit 1
