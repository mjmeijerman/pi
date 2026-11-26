#!/usr/bin/env bash
# Tests for the worker tail: `delegate spawn --patch`, the tree `preflight --slug` reads, and
# `delegate close --nothing`.
#
# Why these exist. Three refusals used to contradict the work they were guarding:
#
#   1. `spawn --patch` copied nothing and named nothing, so a worker sent to land a written patch had
#      no way to say which bytes it applied. The missing-file refusal is here too: it must come
#      before a space is made, or the boss cleans up a space for a patch that never existed.
#   2. `preflight --slug` read the changed paths out of `--cwd` — the trunk checkout — so a file the
#      branch added or broke in its own worktree was linted from trunk's copy. Now the branch's
#      checkout is the tree, and every file-reading check says `tree: <path>`.
#   3. `close --nothing` asked for a preflight run on a worker that landed nothing (no branch to
#      gate), and refused a report whose `Commit:` line named somebody else's commit — a sha that
#      ties nothing to this worker, refused forever.
#
# No network, no desktop app, no herdr, nothing written outside $WORK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE=${PI_TAIL_DELEGATE:-$ROOT/bin/delegate}
PREFLIGHT=${PI_TAIL_PREFLIGHT:-$ROOT/bin/preflight}
for tool in "$DELEGATE" "$PREFLIGHT"; do
	[ -x "$tool" ] || {
		printf 'FATAL: %s is not executable\n' "$tool" >&2
		exit 1
	}
done
command -v git >/dev/null 2>&1 || {
	printf 'FATAL: git is not on PATH\n' >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	printf 'FATAL: node is not on PATH\n' >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
mkdir -p "$HOME" "$WORK/stub" "$PI_SPACE_ROOT/state/spaces/demo/specs" \
	"$PI_SPACE_ROOT/state/spaces/demo/reports" "$PI_SPACE_ROOT/state/spaces/demo/state"

# herdr answers nothing: the record's own state stands, and no case here needs a live terminal.
printf '#!/usr/bin/env bash\nexit 1\n' >"$WORK/stub/hc"
chmod +x "$WORK/stub/hc"
export PATH="$WORK/stub:$PATH"

git_quiet() { git -c user.email=test@example.com -c user.name=test -c init.defaultBranch=trunk "$@" >/dev/null 2>&1; }

PASS_N=0
FAIL_N=0
CASE=""
new_case() {
	CASE="$1"
	printf '\n== %s\n' "$CASE"
}
pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	[ "$#" -eq 0 ] || printf '%s\n' "$@" | sed 's/^/     /'
}
run() { OUT=$("$@" 2>&1); RC=$?; }

# --------------------------------------------------- 1. spawn --patch refuses a file that is not there --
new_case 'spawn --patch with a file that does not exist'
EMPTY="$WORK/no-space-here"
mkdir -p "$EMPTY"
run "$DELEGATE" spawn w1 --cwd "$EMPTY" --patch "$WORK/nowhere.patch" "land the patch"
if [ "$RC" -ne 0 ]; then pass "it exits $RC, not 0"; else fail 'it accepted a patch file that does not exist'; fi
case $OUT in
*"nowhere.patch"*) pass 'it names the file it could not find' ;;
*) fail 'the missing file is not named' "$OUT" ;;
esac
case $OUT in
*"Refused before a space was made"*) pass 'it says the refusal came before any space was made' ;;
*) fail 'it does not say the space was never touched' "$OUT" ;;
esac
case $OUT in
*"space new"* | *"no space claims"*)
	fail 'it got as far as the space check, so the patch check is not first' "$OUT"
	;;
*) pass 'it never reached the space check' ;;
esac
if [ -e "$PI_SPACE_ROOT/state/spaces/w1" ] || [ -e "$PI_SPACE_ROOT/state/spaces/demo/specs/w1.md" ]; then
	fail 'a spec or a space was made for a patch that does not exist'
else
	pass 'nothing was created for it'
fi

# --------------------------------------------------- 2. preflight --slug reads the worktree --
new_case 'preflight --slug reads the changed files in the worktree'
REPO="$WORK/repo"
REMOTE="$WORK/remote.git"
mkdir -p "$REPO/bin"
git_quiet -C "$WORK" init --bare remote.git
git_quiet -C "$REPO" init
git_quiet -C "$REPO" remote add origin "$REMOTE"
printf '#!/usr/bin/env bash\nexit 0\n' >"$REPO/bin/good.sh"
git_quiet -C "$REPO" add -A
git_quiet -C "$REPO" commit -m 'base'
# trunk is trunk only when origin says so: preflight reads the trunk name from origin's HEAD or its
# own trunk/main/master refs, and a repo with no remote has no trunk to diff a branch against.
git_quiet -C "$REPO" push origin trunk
git_quiet -C "$REPO" worktree add -b work "$REPO/.worktrees/w1"
# The branch adds a shell file with a syntax error. Trunk never has it, so a gate that reads --cwd
# skips the path and passes; a gate that reads the branch's worktree fails on it.
printf '#!/usr/bin/env bash\nif [ 1 = 1; then\n\techo hi\n' >"$REPO/.worktrees/w1/bin/broken.sh"
git_quiet -C "$REPO/.worktrees/w1" add -A
git_quiet -C "$REPO/.worktrees/w1" commit -m 'broken'
WT=$(cd "$REPO/.worktrees/w1" && pwd -P)
run "$PREFLIGHT" --slug w1 --cwd "$REPO" --only syntax --fresh work
case $OUT in
*"tree: $WT"*) pass 'it prints tree: <the worktree it read>' ;;
*) fail 'no tree: line naming the worktree' "$OUT" ;;
esac
case $OUT in
*FAIL*syntax*) pass 'syntax FAILs on the file the branch broke' ;;
*) fail 'syntax passed: the gate read trunk, where the broken file does not exist' "$OUT" ;;
esac
case $OUT in
*"broken.sh"*) pass 'the failing file is named' ;;
*) fail 'the failed file is not named' "$OUT" ;;
esac

# --------------------------------------------------- 3. close --nothing --
SD="$PI_SPACE_ROOT/state/spaces/demo"
SPEC="$SD/specs/w1.md"
REPORT="$SD/reports/w1.md"
printf '# Worker w1\n\nMission: test fixture\n' >"$SPEC"
write_record() { # <branch>
	cat >"$SD/delegations.json" <<JSON
{"w1":{"slug":"w1","kind":"tab","space":"sp1","spaceName":"demo","tab":"tb1","terminal":"t1","cwd":"$REPO","mode":"sandboxed","thinking":"low","spec":"$SPEC","report":"$REPORT","branch":"${1:-work}"}}
JSON
}
# A report whose Evidence block names a preflight run, so the gate asks its own question rather than
# stopping on the Evidence block.
write_report() { # <commit-line: empty string or "Commit: <sha>">
	{
		printf '# Report — w1\n\nMission: the boss can close a worker that landed nothing\n\n'
		printf 'Review tier: Low\n\nTest change: none: no test file changed\n\n'
		printf '## Evidence\n\nCommand: `bin/preflight --slug w1`\n\nOutput (last 20 lines):\n\n```\npreflight: 0/0 passed on work in 0s\n```\n\n'
		[ -z "$1" ] || printf '%s\n' "$1"
	} >"$REPORT"
}

new_case 'close --nothing, no Commit line and no branch carrying it'
write_record gone-branch
# This report names no preflight run at all: the case is that no branch in the project carries this
# worker's `Agent-Slug:` trailer, so the preflight half of the gate is not asked of it. The sentence
# that says so names the lookup rather than one recorded branch: a worker that committed nothing has
# no branch of its own, and a branch ref that happens to exist is not that.
{
	printf '# Report — w1\n\nMission: the boss can close a worker that landed nothing\n\n'
	printf 'Review tier: Low\n\nTest change: none: no test file changed\n\n'
	printf '## Evidence\n\nCommand: `git status`\n\nOutput (last 20 lines):\n\n```\nnothing to commit\n```\n'
} >"$REPORT"
run "$DELEGATE" close w1 --nothing "short"
case $OUT in
*"names no Commit: line"*"carries a commit with Agent-Slug: w1"*) pass 'it says the preflight evidence is not asked for' ;;
*) fail 'it still asked a branchless worker for preflight evidence' "$OUT" ;;
esac
case $OUT in
*"characters"*) pass 'it went on to the next check (the reason length) instead of stopping' ;;
*) fail 'it stopped before the reason check, so the skip did not happen' "$OUT" ;;
esac

new_case 'close --nothing, a Commit line naming a commit with no trailer'
write_record work
TRUNK_SHA=$(git -C "$REPO" rev-parse --short=12 trunk)
write_report "Commit: $TRUNK_SHA"
run "$DELEGATE" close w1 --nothing "the patch was already in trunk, so nothing was committed here"
case $OUT in
*"no Agent-Slug: w1 trailer"*) pass 'it accepts a sha that carries no trailer for this worker' ;;
*) fail 'it refused a commit that ties nothing to this worker' "$OUT" ;;
esac
case $OUT in
*"records commit $TRUNK_SHA, and that commit resolves, so something did land"*)
	fail 'it still refuses a commit that is not this worker own' "$OUT"
	;;
*) pass 'it no longer refuses on "something did land"' ;;
esac

new_case 'close --nothing, a Commit line naming this worker own commit'
git_quiet -C "$REPO/.worktrees/w1" commit --allow-empty -m "work

Agent-Slug: w1"
OWN_SHA=$(git -C "$REPO/.worktrees/w1" rev-parse --short=12 work)
write_record work
write_report "Commit: $OWN_SHA"
run "$DELEGATE" close w1 --nothing "the patch was already in trunk, so nothing was committed here"
case $OUT in
*"carries Agent-Slug: w1"*) pass 'it refuses a commit that is this worker own work' ;;
*) fail 'it let a worker close as nothing over its own commit' "$OUT" ;;
esac
case $OUT in
*"close w1"*) pass 'it names the normal close as the fix' ;;
*) fail 'the fix is not named' "$OUT" ;;
esac

printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
