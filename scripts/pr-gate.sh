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
#   scripts/pr-gate.sh --body FILE --paths FILE
#       all gates; changed paths are read from FILE, one per line. An empty
#       FILE is a gate handed nothing, so the diff gates fail, not pass.
#   scripts/pr-gate.sh --body FILE --gate mission|tier|test-change
#       one gate only, the way each CI job runs it. Mission needs no diff;
#       tier and test-change fail when they cannot see one.
#
#   make pr-check BODY=pr.md [BASE=origin/trunk] [HEAD=HEAD] [PATHS=paths.txt]
#
# Exit codes: 0 every gate that ran passed, 1 a gate failed or was handed no
# file list it needs (CI would be red), 2 bad usage, unreadable input, or a diff
# that cannot be resolved. Output is the CI verdict verbatim: the
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

# DIFF_CHECKED is the point of this file: green means checked. A gate that
# needs the changed files and never got them is red (PR 67: the local run was
# handed zero files, called that "nothing to justify", and printed green for a
# body the same CI run rejected).
CHANGED=()
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
	DIFF_CHECKED=1
	DIFF_WHY="${base_rev}...${head_rev} (${#CHANGED[@]} changed files)"
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

ORDER=()
case "$GATES" in
all) ORDER=(mission tier test-change) ;;
*) ORDER=("$GATES") ;;
esac

# Only read a diff when a gate needs one: `--gate mission` is the body-only CI
# job, and it must keep working in a checkout with no usable diff.
for gate in "${ORDER[@]}"; do
	case "$gate" in
	tier | test-change)
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
	esac
done

if ((FAILED == 0)); then
	echo "pr-gate: green${GATES:+ (${GATES})}"
	exit 0
fi
printf 'pr-gate: red (%s) — CI rejects this body, and a gate handed no file list counts as red until it can check\n' "${ORDER[*]}"
exit 1
