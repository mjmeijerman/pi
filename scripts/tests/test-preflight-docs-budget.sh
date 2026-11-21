#!/usr/bin/env bash
# Tests for bin/preflight's docs budget — the file it measures must be the BRANCH's.
#
# Why these exist: measured on PR #217, the report said `docs budget: AGENTS.md 5225 B / 8192 B`
# while the branch's own AGENTS.md was 5530 B. The budget read --cwd — the trunk checkout the caller
# stood in — so a branch could break the budget and the gate stayed green. The cases below pin the
# two directions that one bug cannot pass: a branch whose file is over budget while trunk's is small
# FAILS, and a branch whose file fits while trunk's is over budget PASSES. Both also pin the printed
# path, because a budget that does not say which tree it read is the bug it just had.
#
# The check is a shell function in bin/preflight, so the test sources the real file (it dispatches
# only when executed) and drives pf_docs_budget directly against real temporary git repositories with
# real worktrees: no network, no model, nothing outside $WORK. PREFLIGHT may be pointed at another
# bin/preflight (the trunk copy) to show the case is red there.
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

PREFLIGHT=${PREFLIGHT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/../../bin" && pwd)/preflight"}
[ -f "$PREFLIGHT" ] || {
	printf 'FATAL: %s is missing\n' "$PREFLIGHT" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/stub" "$WORK/home"

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
RC=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}
case_start() { CASE_N=$((CASE_N + 1)); CASE=$1; }

expect_rc() { # <why> <0|nonzero>
	case $2 in
	0) [ "$RC" -eq 0 ] && pass "$1" || fail "$1" "exit $RC" "$OUT" ;;
	*) [ "$RC" -ne 0 ] && pass "$1" || fail "$1" "exit 0, expected a refusal" "$OUT" ;;
	esac
}
out_has() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
		pass "$2"
	else
		fail "$2" "missing: $1" "$OUT"
	fi
}

# bytes_of <n> — a file of exactly <n> bytes, so the budget is decided by the fixture and not by
# whatever this checkout's own AGENTS.md happens to weigh.
bytes_of() {
	local n=$1
	head -c "$n" /dev/zero | tr '\0' 'x'
}

# make_repo <dir> <trunk-bytes> <branch> <branch-bytes> — a repo on `trunk`, plus a worktree of
# <branch> whose AGENTS.md has its own size. The branch worktree is where a worker's branch lives in
# this harness, so it is the tree the budget has to read while the caller stands on trunk.
make_repo() {
	local dir=$1 tbytes=$2 branch=$3 bbytes=$4 wt="$1/.worktrees/$3"
	git init -q -b trunk "$dir"
	bytes_of "$tbytes" >"$dir/AGENTS.md"
	git -C "$dir" add AGENTS.md
	git -C "$dir" -c user.email=t@example.com -c user.name=t commit -q -m 'trunk: AGENTS.md'
	git -C "$dir" worktree add -q "$wt" -b "$branch" trunk
	mkdir -p "$dir/.worktrees"
	bytes_of "$bbytes" >"$wt/AGENTS.md"
	git -C "$wt" add AGENTS.md
	git -C "$wt" -c user.email=t@example.com -c user.name=t commit -q -m "$branch: AGENTS.md"
}

# run_budget <repo> <branch> [limit] — pf_docs_budget from the repo's trunk checkout, the way the
# preflight calls it: --cwd is the checkout the caller stands in, the branch is the tree under test.
run_budget() {
	local repo=$1 branch=$2 limit=${3:-8192}
	OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		AGENTS_MD_LIMIT="$limit" bash -c '. "$1" >/dev/null 2>&1 || true
			PF_CWD=$2 PF_BRANCH=$3 PF_SHAPE=other
			pf_docs_budget "$2" "$3"
			exit $?' _ "$PREFLIGHT" "$repo" "$branch" 2>&1)
	RC=$?
}

# ---------------------------------------------------------------------------
case_start "a branch over budget FAILS even though trunk fits"
make_repo "$WORK/over" 3000 big 9000
run_budget "$WORK/over" big
expect_rc "9000 B on the branch against an 8192 B budget is refused" nonzero
out_has "docs budget: AGENTS.md 9000 B / 8192 B (from .worktrees/big)" "it measured the branch's file, and says which tree"
out_has "over its 8192 B budget in .worktrees/big" "the failure names the tree an author has to edit"

# ---------------------------------------------------------------------------
case_start "a branch under budget PASSES even though trunk is over"
make_repo "$WORK/under" 9000 smallie 3000
run_budget "$WORK/under" smallie
expect_rc "3000 B on the branch against an 8192 B budget passes" 0
out_has "docs budget: AGENTS.md 3000 B / 8192 B (from .worktrees/smallie)" "the pass measured the branch, not trunk's 9000 B"

# ---------------------------------------------------------------------------
case_start "the branch the caller stands in is read in place"
run_budget "$WORK/over/.worktrees/big" big
expect_rc "the same refusal from inside the branch's own checkout" nonzero
out_has "9000 B / 8192 B (from .worktrees/big)" "the size is the branch's, and the line names the same tree from inside it"

# ---------------------------------------------------------------------------
case_start "a branch that only exists as a ref is still measured on the branch"
git -C "$WORK/over" worktree remove --force "$WORK/over/.worktrees/big" >/dev/null 2>&1
run_budget "$WORK/over" big
expect_rc "a ref-only branch over budget is refused" nonzero
out_has "9000 B" "the size came from the branch's blob, not from trunk's 3000 B"
out_has "(from big:AGENTS.md)" "the line says the tree it read was the branch's"

# ---------------------------------------------------------------------------
case_start "a checkout with no root AGENTS.md on the branch is a named skip, not a pass"
make_repo "$WORK/none" 3000 nofile 0
rm -f "$WORK/none/.worktrees/nofile/AGENTS.md"
git -C "$WORK/none/.worktrees/nofile" -c user.email=t@example.com -c user.name=t commit -q -am 'drop AGENTS.md'
run_budget "$WORK/none" nofile
expect_rc "a branch with no root AGENTS.md has nothing to measure" 0
out_has "no root AGENTS.md in this checkout — skipped" "the skip is said by name"
	# trunk still has one, so a budget that read trunk would have measured 3000 B here.

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
