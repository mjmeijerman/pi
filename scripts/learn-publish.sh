#!/usr/bin/env bash
# ============================================================================
# learn-publish.sh — the learner's last step, as a verdict instead of a hope.
#
# Radar basis: #11 feedback flywheel (Trial), #18 self-improving harness
# (Trial), #42 human-in-the-loop theater (Caution).
#
# Why this exists: `agent/prompts/learn.md` ends with "publish, then close
# yourself" — prose, obeyed by nobody. By 2026-11-15 three `learn/*` branches
# existed (`learn/learn-20-27`, `learn/learn-10-07`, …) with one commit each and
# zero pull requests ever opened for any of them (`gh pr list --head
# learn/… --state all` → empty, while every other branch on the repo has one).
# The fix a learner wrote for the stale `/suggest` note sat unlanded on
# `learn/learn-10-07` while the same note started a fourth learner session. A
# branch nobody pushed is a turn spent and a lesson learned by nobody (#36).
#
# The rule this file enforces: publication is not "hand the branch to an agent",
# it is "a pull request for that head exists". So the agent gets spawned, and
# then the branch is asked for a PR. No PR → exit 1 and a line in
# agent/proposals/publish-log.jsonl, which is what the next learner reads.
#
# Usage:
#   scripts/learn-publish.sh <slug> --proposal FILE [--tier T]
#       open the PR (spawns the bare agent), then verify. Exit 0 = PR exists.
#   scripts/learn-publish.sh <slug> --check
#       verify only, spawn nothing. Exit 0 = PR exists, 1 = none, 2 = gh failed.
#   scripts/learn-publish.sh <slug> --dry-run
#       print the prompt the agent would get; spawn nothing.
#
# Options:
#   --repo DIR     checkout holding the branch (default $LEARN_PUBLISH_ROOT or
#                  /home/mark/.pi)
#   --agent BIN    publishing agent (default $LEARN_PUBLISH_AGENT or
#                  /home/mark/big-boss-pi/bin/pi-bare)
#   --gh CMD       gh command (default $LEARN_PUBLISH_GH or gh); tests stub it
#   --tier T       review tier, read from the proposal when omitted
#
# This script never pushes and never merges: it runs the agent that is allowed
# to, then holds it to the PR.
# ============================================================================
set -uo pipefail

REPO="${LEARN_PUBLISH_ROOT:-/home/mark/.pi}"
AGENT="${LEARN_PUBLISH_AGENT:-/home/mark/big-boss-pi/bin/pi-bare}"
GH_CMD="${LEARN_PUBLISH_GH:-gh}"
PROPOSAL=""
TIER=""
MODE="run"
SLUG=""

die() { echo "learn-publish: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
		--agent) [ $# -ge 2 ] || die "--agent needs a value"; AGENT="$2"; shift 2 ;;
		--gh) [ $# -ge 2 ] || die "--gh needs a value"; GH_CMD="$2"; shift 2 ;;
		--proposal) [ $# -ge 2 ] || die "--proposal needs a value"; PROPOSAL="$2"; shift 2 ;;
		--tier) [ $# -ge 2 ] || die "--tier needs a value"; TIER="$2"; shift 2 ;;
		--check) MODE="check"; shift ;;
		--dry-run) MODE="dry-run"; shift ;;
		-h|--help) sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) die "unknown option $1" ;;
		*) [ -z "$SLUG" ] || die "unexpected argument $1"; SLUG="$1"; shift ;;
	esac
done

[ -n "$SLUG" ] || die "usage: learn-publish.sh <slug> [--proposal FILE] [--check|--dry-run]"
BRANCH="learn/$SLUG"
LOG="$REPO/agent/proposals/publish-log.jsonl"

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout"
SHA=$(git -C "$REPO" rev-parse --verify --quiet "refs/heads/$BRANCH" 2>/dev/null) \
	|| die "no branch $BRANCH in $REPO — nothing to publish"
SHA=$(git -C "$REPO" rev-parse --short=12 "$SHA")

if [ -z "$TIER" ] && [ -n "$PROPOSAL" ] && [ -r "$PROPOSAL" ]; then
	TIER=$(grep -m1 -E '^\*\*Risk tier:\*\*' "$PROPOSAL" \
		| sed -E 's/^\*\*Risk tier:\*\*[[:space:]]*//; s/^[`"*]+//; s/[`"*(].*$//' \
		| awk '{print $1}')
fi
[ -n "$TIER" ] || TIER="Medium"
[ -n "$PROPOSAL" ] || PROPOSAL="(proposal not named — write it before publishing)"

# The first PR whose head is this branch. Empty array JSON = no PR yet.
pr_json() { "$GH_CMD" pr list --head "$BRANCH" --state all --json number,url,state --limit 5 2>/dev/null; }

# Prints the PR number on success; 1 = no PR; 2 = gh could not be asked.
pr_number() {
	local json
	json=$(pr_json) || return 2
	[ -n "$json" ] || return 2
	printf '%s' "$json" | grep -o '"number": *[0-9]\+' | head -1 | grep -o '[0-9]\+'
}

report() {
	local n
	n=$(pr_number); local rc=$?
	case $rc in
		0) echo "learn-publish: PR #$n exists for $BRANCH — published"; return 0 ;;
		1) echo "learn-publish: no PR for $BRANCH yet"; return 1 ;;
		*) echo "learn-publish: could not ask $GH_CMD for a PR on $BRANCH (exit $rc)"; return 2 ;;
	esac
}

record() {
	local why="$1" n
	mkdir -p "$(dirname "$LOG")" 2>/dev/null
	printf '{"ts":"%s","slug":"%s","branch":"%s","sha":"%s","pr":null,"reason":"%s"}\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SLUG" "$BRANCH" "$SHA" "${why//\"/\'}" >>"$LOG"
}

PROMPT="Push branch $BRANCH (commit $SHA) of $REPO, review tier $TIER, proposal $PROPOSAL. Open the pull request. Do not merge."

case "$MODE" in
	check)
		report
		exit $?
		;;
	dry-run)
		echo "learn-publish: would run: $AGENT -p \"$PROMPT\""
		exit 0
		;;
esac

# Already published: do not spawn a second agent to open a second PR.
if report; then exit 0; fi

echo "learn-publish: handing $BRANCH ($SHA) to $AGENT"
if ! "$AGENT" -p "$PROMPT"; then
	echo "learn-publish: the publishing agent exited non-zero"
fi

if report; then exit 0; fi

record "no PR after the publishing agent ran"
echo "learn-publish: FAIL — $BRANCH is still unpublished; say so in the proposal and in bash scripts/learn-publish.sh $SLUG --check" >&2
exit 1
