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
#       body-only gates (mission). The diff gates are reported as skipped.
#   scripts/pr-gate.sh --body FILE --base REV --head REV
#       all gates; changed paths come from `git diff --name-only REV...REV`.
#   scripts/pr-gate.sh --body FILE --paths FILE
#       all gates; changed paths are read from FILE, one per line.
#   scripts/pr-gate.sh --body FILE --gate mission|tier|test-change
#       one gate only, the way each CI job runs it.
#
#   make pr-check BODY=pr.md [BASE=origin/trunk] [HEAD=HEAD] [PATHS=paths.txt]
#
# Exit codes: 0 every gate that ran passed, 1 a gate failed (CI would be red),
# 2 bad usage or unreadable input. Output is the CI verdict verbatim: the
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
GATES="all"

CHANGED=()
HAS_DIFF=0
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
all | mission | tier | test-change) ;;
*) die "--gate takes all|mission|tier|test-change, not '$GATES'" ;;
esac

BODY="$(cat -- "$BODY_FILE")"

# ---------------------------------------------------------------- changed paths --
# One place decides what "the diff" means: an explicit --paths file, or the
# merge-base diff CI already has both endpoints for. No paths at all is legal
# for a body-only run, and the diff gates then say so instead of guessing.
load_changed() {
	if [ -n "$PATHS_FILE" ]; then
		[ -f "$PATHS_FILE" ] || die "no such paths file: $PATHS_FILE"
		mapfile -t CHANGED < <(awk 'NF' "$PATHS_FILE")
		HAS_DIFF=1
		return 0
	fi
	if [ -z "$BASE_REV" ] && [ -z "$HEAD_REV" ]; then
		return 0
	fi
	if [ -z "$BASE_REV" ] || [ -z "$HEAD_REV" ]; then
		die "--base and --head go together (base='$BASE_REV' head='$HEAD_REV')"
	fi
	local out=""
	if ! out="$(git diff --name-only "${BASE_REV}...${HEAD_REV}" 2>&1)"; then
		die "cannot read the diff ${BASE_REV}...${HEAD_REV}: $out"
	fi
	mapfile -t CHANGED < <(printf '%s\n' "$out" | awk 'NF')
	HAS_DIFF=1
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

	if ((HAS_DIFF == 0)); then
		printf 'pr-gate: review tier %s stated; no diff given, so the harness-path rule was not checked — pass --base/--head or --paths to check it\n' "$tier"
		return 0
	fi

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

	if ((HAS_DIFF == 0)); then
		printf 'pr-gate: no diff given, so the test-change rule was not checked — pass --base/--head or --paths to check it\n'
		return 0
	fi

	# Any recognised test suffix counts, not just the one this repo happens to
	# use today: a .test.mjs is as much a test as a .test.ts, and a gate that
	# cannot see a test cannot ask for its reason.
	for path in "${CHANGED[@]}"; do
		case "$path" in
		*.test.ts | *.test.tsx | *.test.js | *.test.mjs | *.test.cjs | *.test.py) tests+=("$path") ;;
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

load_changed

ORDER=()
case "$GATES" in
all) ORDER=(mission tier test-change) ;;
*) ORDER=("$GATES") ;;
esac

for gate in "${ORDER[@]}"; do
	case "$gate" in
	mission) gate_mission || FAILED=1 ;;
	tier) gate_tier || FAILED=1 ;;
	test-change) gate_test_change || FAILED=1 ;;
	esac
done

if ((FAILED == 0)); then
	echo "pr-gate: green${GATES:+ (${GATES})}"
	exit 0
fi
printf 'pr-gate: red — a PR body like this one fails CI (%s)\n' "${ORDER[*]}"
exit 1
