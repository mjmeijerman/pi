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
# Why it hands off instead of pushing: the learner runs sandboxed, and the
# sandbox has no git credentials and no `gh` login (`gh auth status` → hosts.yml
# missing), so a push from there cannot succeed — which is exactly what the old
# version asked `pi-bare` to do, and then recorded the network failure as "the
# agent did not open a PR". The hand-off is now a big-boss-pi agent space
# (`scripts/agent-pane.sh spawn <slug>-pr`) started in `/home/mark/big-boss-pi`,
# where `gh` and the ssh key live: that agent pushes, opens the PR, appends the
# publish-log row and closes its own space. The learner closes its own space
# after the hand-off and never needs host access.
#
# The rule this file enforces: publication is not "hand the branch to an agent",
# it is "a pull request for that head exists" — and when this machine cannot ask
# GitHub, the script says so (exit 2) instead of claiming there is no PR.
#
# Usage:
#   scripts/learn-publish.sh <slug> --proposal FILE [--tier T]
#       spawn the big-boss-pi agent space, then verify. Exit 0 = PR exists,
#       1 = no PR (and the row is appended here), 2 = gh could not be asked.
#   scripts/learn-publish.sh <slug> --check
#       verify only, spawn nothing. Exit 0 = PR exists, 1 = none, 2 = gh
#       could not be asked (read-only: no spawn, no log row).
#   scripts/learn-publish.sh <slug> --dry-run
#       print the spec the publishing agent would get; spawn nothing.
#
# Options:
#   --repo DIR     checkout holding the branch (default $LEARN_PUBLISH_ROOT or
#                  /home/mark/.pi)
#   --pane SCRIPT  agent-pane.sh (default $LEARN_PUBLISH_PANE or
#                  <repo>/scripts/agent-pane.sh); tests stub it
#   --bbp DIR      where the publishing agent starts (default
#                  $LEARN_PUBLISH_BBP or /home/mark/big-boss-pi)
#   --gh CMD       gh command (default $LEARN_PUBLISH_GH or gh); tests stub it
#   --tier T       review tier, read from the proposal when omitted
#
# This script never pushes, never opens a PR and never merges: it starts the
# agent that may, then holds it to the PR.
# ============================================================================
set -uo pipefail

REPO="${LEARN_PUBLISH_ROOT:-/home/mark/.pi}"
BBP="${LEARN_PUBLISH_BBP:-/home/mark/big-boss-pi}"
PANE="${LEARN_PUBLISH_PANE:-$REPO/scripts/agent-pane.sh}"
GH_CMD="${LEARN_PUBLISH_GH:-gh}"
PROPOSAL=""
TIER=""
MODE="run"
SLUG=""

die() { echo "learn-publish: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="$2"; [ -z "${LEARN_PUBLISH_PANE:-}" ] && PANE="$REPO/scripts/agent-pane.sh"; shift 2 ;;
		--pane) [ $# -ge 2 ] || die "--pane needs a value"; PANE="$2"; shift 2 ;;
		--bbp) [ $# -ge 2 ] || die "--bbp needs a value"; BBP="$2"; shift 2 ;;
		--gh) [ $# -ge 2 ] || die "--gh needs a value"; GH_CMD="$2"; shift 2 ;;
		--proposal) [ $# -ge 2 ] || die "--proposal needs a value"; PROPOSAL="$2"; shift 2 ;;
		--tier) [ $# -ge 2 ] || die "--tier needs a value"; TIER="$2"; shift 2 ;;
		--check) MODE="check"; shift ;;
		--dry-run) MODE="dry-run"; shift ;;
		-h|--help) sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) die "unknown option $1" ;;
		*) [ -z "$SLUG" ] || die "unexpected argument $1"; SLUG="$1"; shift ;;
	esac
done

[ -n "$SLUG" ] || die "usage: learn-publish.sh <slug> [--proposal FILE] [--check|--dry-run]"
BRANCH="learn/$SLUG"
SPACE="$SLUG-pr"
PROPOSAL_DIR="$REPO/agent/proposals"
LOG="$PROPOSAL_DIR/publish-log.jsonl"
SPEC_DIR="$PROPOSAL_DIR/publish"
SPEC="$SPEC_DIR/$SPACE.md"

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
# gh's stderr is kept: "gh could not be asked" is useless without its reason,
# and in a sandbox the reason is always the same missing credential.
GH_ERR=""
PR_JSON=""
pr_json() {
	local err rc
	GH_ERR=""
	PR_JSON=""
	err=$(mktemp) || return 2
	PR_JSON=$("$GH_CMD" pr list --head "$BRANCH" --state all --json number,url,state --limit 5 2>"$err")
	rc=$?
	GH_ERR=$(tr '\n' ' ' <"$err" | cut -c1-200)
	rm -f "$err"
	[ "$rc" -eq 0 ] || return 2
	[ -n "$PR_JSON" ] || return 2
	return 0
}

# Sets PR_NUM. 1 = gh answered and there is no PR; 2 = gh could not be asked.
PR_NUM=""
pr_number() {
	local num
	PR_NUM=""
	pr_json || return 2
	num=$(printf '%s' "$PR_JSON" | grep -o '"number": *[0-9]\+' | head -1 | grep -o '[0-9]\+')
	[ -n "$num" ] || return 1
	PR_NUM=$num
	return 0
}

report() {
	local rc
	pr_number; rc=$?
	case $rc in
		0) echo "learn-publish: PR #$PR_NUM exists for $BRANCH — published"; return 0 ;;
		1) echo "learn-publish: no PR for $BRANCH yet"; return 1 ;;
		*)
			echo "learn-publish: could not ask $GH_CMD for a PR on $BRANCH from here${GH_ERR:+ — $GH_ERR}" >&2
			echo "learn-publish: that is unverified, not unpublished" >&2
			return 2
			;;
	esac
}

record() {
	local why="$1"
	mkdir -p "$PROPOSAL_DIR" 2>/dev/null
	printf '{"ts":"%s","slug":"%s","branch":"%s","sha":"%s","pr":null,"reason":"%s"}\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SLUG" "$BRANCH" "$SHA" "${why//\"/\'}" >>"$LOG"
}

# owner/name, so the agent can open the PR from its own workspace with --repo.
# Both remote forms end in the same two path segments: git@host:owner/name.git
# and https://host/owner/name.
ORIGIN=$(git -C "$REPO" remote get-url origin 2>/dev/null | sed -e 's#\.git$##')
ORIGIN=$(printf '%s' "$ORIGIN" | awk -F'[/:]' 'NF >= 2 { print $(NF-1)"/"$NF }')
[ -n "$ORIGIN" ] || ORIGIN="(no origin remote in $REPO — push before you open the PR)"

# The spec the big-boss-pi agent reads. Written without backticks so a shell
# never expands them, and named loudly: this agent is the only one here that may
# push, and it has to close its own space.
spec_body() {
	printf '%s\n' \
		"# Publish $BRANCH" \
		"" \
		"You are a big-boss-pi agent space, started by scripts/learn-publish.sh." \
		"The learner that wrote this branch runs sandboxed and has no git or gh" \
		"credentials, so it could commit and nothing more. You run on the host," \
		"where gh and the ssh key live: push, open the pull request, log it, and" \
		"close your own space." \
		"" \
		"- repo: $REPO (read and push from it; never switch its checkout)" \
		"- branch: $BRANCH" \
		"- commit: $SHA" \
		"- review tier: $TIER — carry this tier in the pull request body" \
		"- proposal: $PROPOSAL" \
		"" \
		"## Do this" \
		"" \
		"1. Push the branch:" \
		"" \
		"    git -C $REPO push -u origin $BRANCH" \
		"" \
		"2. Open the pull request for $BRANCH against trunk. The body carries the" \
		"   review tier ($TIER) and the proposal path, and says a learner wrote it:" \
		"" \
		"    gh pr create --repo $ORIGIN --head $BRANCH --title 'learn: $SLUG' --body 'Tier: $TIER. Proposal: $PROPOSAL. Written by a self-learn learner; published by a big-boss-pi agent.'" \
		"" \
		"3. Append the row to $LOG (one line, pr filled in):" \
		"" \
		"    {\"ts\":\"<UTC now>\",\"slug\":\"$SLUG\",\"branch\":\"$BRANCH\",\"sha\":\"$SHA\",\"pr\":<number>,\"reason\":\"published\"}" \
		"" \
		"4. Close your own space, whatever the outcome:" \
		"" \
		"    $PANE close $SPACE || true" \
		"" \
		"Never merge. Never push onto trunk."
}

case "$MODE" in
	check)
		# Read-only: no spawn, no log row, and exit 2 when gh cannot answer.
		report
		exit $?
		;;
	dry-run)
		echo "learn-publish: would run: $PANE spawn $SPACE $SPEC --cwd $BBP"
		echo "learn-publish: the spec would say:"
		spec_body
		exit 0
		;;
esac

# Already published: do not spawn a second agent to open a second PR.
RC=0
report || RC=$?
[ "$RC" = 0 ] && exit 0

mkdir -p "$SPEC_DIR" 2>/dev/null || die "cannot write $SPEC_DIR"
spec_body >"$SPEC" || die "cannot write $SPEC"

# The publishing agent is only bare because it starts in the workspace whose gh and
# ssh credentials are the host's. A missing workspace means an agent without them,
# so it is an error here and not a "no PR" later.
[ -d "$BBP" ] || die "$BBP is not a directory — no big-boss-pi workspace to hand $BRANCH to"

echo "learn-publish: handing $BRANCH ($SHA) to a big-boss-pi agent space $SPACE"
if ! "$PANE" spawn "$SPACE" "$SPEC" --cwd "$BBP"; then
	echo "learn-publish: the pane script could not start $SPACE (see above)" >&2
	echo "learn-publish: $BRANCH is unverified and unpublished; run $PANE spawn $SPACE $SPEC --cwd $BBP by hand" >&2
	exit 2
fi

RC=0
report || RC=$?
case $RC in
	0) exit 0 ;;
	1)
		record "no PR after $SPACE was spawned"
		echo "learn-publish: FAIL — $BRANCH is still unpublished; the row is in $LOG and $SPACE may still be working: $PANE show $SPACE" >&2
		exit 1
		;;
	*)
		echo "learn-publish: handed $BRANCH ($SHA) to $SPACE; this machine cannot ask GitHub, so the PR is unverified — check from the host: bash $0 $SLUG --check" >&2
		exit 2
		;;
esac
