#!/usr/bin/env bash
# Tests for `bin/delegate land` — the boss's landing loop in one command.
#
# Why these exist: after a report, the loop is four commands in one order (finish, pr-ready --wait,
# the mergeable poll, pr-ready again for the prose verdict), and each one has to see the answer of
# the one before. Typed by hand that was four turns and four chances to stop half-way; when a check
# went red the worker was already closed, so the fix had to become a new spawn. `land` runs the
# four, keeps the worker open while something is red so `delegate tell` can reach it, and closes it
# only on `ready:`.
#
# What is stubbed and what is real: `delegate finish` is stubbed in $PI_BOSS_ROOT/bin (the tree
# `land` calls it from) because the real one runs preflight and pushes; `pr-ready`, `gh`, `hc` and
# `herdr-app` are stubs on PATH. The wipe, the close, the delegation record and the report checks
# are the real ones — that is what "the worker is still open" means here.
#
# Run it directly, or through `make scripts-test` / `scripts/ci-offline.sh`, which glob
# scripts/tests/*.test.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE="$ROOT/bin/delegate"
SPACE="$ROOT/bin/space"
for f in "$DELEGATE" "$SPACE"; do
	[ -x "$f" ] || {
		printf 'FATAL: %s is not executable\n' "$f" >&2
		exit 1
	}
done

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
export DELEGATE_NO_REAP=1
export DELEGATE_LAND_INTERVAL=0
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT"

PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export PR_READY_LOG="$WORK/pr-ready.log"
export PR_READY_COUNT="$WORK/pr-ready.count"
export FINISH_LOG="$WORK/finish.log"
export HERDR_LOG="$WORK/herdr.log"
export GH_COUNT="$WORK/gh.count"

export GIT_AUTHOR_NAME="test"
export GIT_AUTHOR_EMAIL="test@example.invalid"
export GIT_COMMITTER_NAME="test"
export GIT_COMMITTER_EMAIL="test@example.invalid"
export GIT_CONFIG_NOSYSTEM=1

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
has() { case $OUT in *"$1"*) return 0 ;; esac; return 1; }

# --- the stubs ---------------------------------------------------------------------------------

# `delegate finish --keep-open`: the one line `land` reads, or the refusal of step 1.
cat >"$PI_SPACE_ROOT/bin/delegate" <<'STUB'
#!/usr/bin/env bash
printf 'delegate %s\n' "$*" >>"$FINISH_LOG"
case " $* " in
*" --keep-open "*) ;;
*)
	printf 'stub finish: land did not ask for --keep-open: %s\n' "$*" >&2
	exit 64
	;;
esac
if [ "${FINISH_MODE:-ok}" != ok ]; then
	printf 'FAIL preflight: syntax on bin/delegate\n' >&2
	printf 'delegate: finish stopped at step 1 of 4 (preflight) for w1: nothing was pushed, the PR body was not touched, nothing was wiped, nothing was closed, and the worker is still open.\n' >&2
	exit 1
fi
printf 'finish: w1 — 1/4 preflight\n'
printf 'preflight: 7/7 passed (0 cached, 7 ran)\n'
printf 'finish: w1 — 2/4 publish\n'
printf 'published w1: #7 now at 0123456 (OPEN, MERGEABLE)\n'
printf 'finish: w1 — 3/4 kept open: #7 at 0123456 (nothing wiped, nothing closed)\n'
exit 0
STUB

# `pr-ready`: one answer per mode. `prose` passes the rollup and refuses on the second call, which
# is the prose verdict, so a finding is found by the same command that judged the checks.
cat >"$WORK/stub/pr-ready" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >>"$PR_READY_LOG"
n=$(( $(cat "$PR_READY_COUNT" 2>/dev/null || printf 0) + 1 ))
printf '%s' "$n" >"$PR_READY_COUNT"
case ${PR_READY_MODE:-pass} in
pass)
	printf 'pr 7: head 0123456, checks 12, pending 0, fail 0\n'
	printf 'prose review: clean (5 checks)\n'
	exit 0
	;;
red)
	printf 'pr 7: head 0123456, checks 12, pending 0, fail 1, finished\n'
	printf '  not ready: 1 check(s) FAILED\n'
	exit 1
	;;
prose)
	if [ "$n" -eq 1 ]; then
		printf 'pr 7: head 0123456, checks 12, pending 0, fail 0, finished\n'
		exit 0
	fi
	printf 'pr 7: head 0123456, checks 12, pending 0, fail 0\n'
	printf 'prose review: 1 finding(s) open — contradiction\n'
	exit 1
	;;
esac
STUB

# `gh pr view`: the mergeable flag (with a counter, so UNKNOWN can be answered once) and the file
# list `land` reads to decide which pr-ready judges the branch.
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
[ "$1" = pr ] && [ "$2" = view ] || {
	printf 'gh stub: unexpected argv: %s\n' "$*" >&2
	exit 64
}
case " $* " in
*" --json mergeable "*)
	n=$(( $(cat "$GH_COUNT" 2>/dev/null || printf 0) + 1 ))
	printf '%s' "$n" >"$GH_COUNT"
	if [ -n "${GH_UNKNOWN_TIMES:-}" ] && [ "$n" -le "$GH_UNKNOWN_TIMES" ]; then
		printf 'UNKNOWN\n'
	else
		printf '%s\n' "${GH_MERGEABLE:-MERGEABLE}"
	fi
	;;
*" --json files "*)
	printf '%s\n' "${GH_FILES:-bin/delegate scripts/tests/test-delegate-land.test.sh}"
	;;
*)
	printf 'gh stub: unexpected --json: %s\n' "$*" >&2
	exit 64
	;;
esac
STUB

cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"sp1","tab":"tb1","pane":"p1","terminal":"t1"}\n' ;;
"do tab.close") printf '{}\n' ;;
"ls "*) printf '{"spaces":[]}\n' ;;
*) printf '{}\n' ;;
esac
STUB

cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
ls) printf '{"terminals":[{"id":"t-boss","state":"idle"}]}\n' ;;
*) printf '{}\n' ;;
esac
STUB
chmod +x "$WORK/stub/"* "$PI_SPACE_ROOT/bin/delegate"

# --- the fixture -------------------------------------------------------------------------------

PRJ="$WORK/proj"
git init -q --initial-branch=main "$PRJ"
printf 'a\n' >"$PRJ/a.txt"
git -C "$PRJ" add -A
git -C "$PRJ" commit -qm 'start'
git -C "$PRJ" checkout -q -b w1
printf 'b\n' >"$PRJ/b.txt"
git -C "$PRJ" add -A
git -C "$PRJ" commit -qm 'w1 work' -m 'Agent-Slug: w1'
git -C "$PRJ" checkout -q main
W1_SHA=$(git -C "$PRJ" rev-parse w1)

"$SPACE" new --name sp --project "$PRJ" >/dev/null
SPACE_DIR="$PI_SPACE_ROOT/state/spaces/sp"
REPORT="$SPACE_DIR/reports/w1.md"
mkdir -p "$SPACE_DIR/reports"
write_report() {
	cat >"$REPORT" <<REPORT
# Report — w1

Mission: a worker's pull request is walked to mergeable by one command.

Review tier: High — \`bin/delegate\` gained a command.

## Evidence

Command: \`bin/preflight --slug w1 --cwd $PRJ\`

\`\`\`
preflight: 7/7 passed (0 cached, 7 ran)
\`\`\`

## Thrown away

Nothing: the loop was typed, not written down.
REPORT
	printf 'Commit: %s\n' "$W1_SHA" >>"$REPORT"
}
write_delegations() {
	cat >"$SPACE_DIR/delegations.json" <<JSON
{"w1": {"slug":"w1","kind":"tab","space":"sp1","spaceName":"sp","tab":"tb2","pane":"p2","terminal":"t2","cwd":"$PRJ","mode":"sandboxed","thinking":"low","spec":"$SPACE_DIR/specs/w1.spawn.md","report":"$REPORT","branch":"main","started":"2026-01-01T00:00:00.000Z"}}
JSON
}
reset_run() {
	write_report
	write_delegations
	rm -f "$PR_READY_COUNT" "$GH_COUNT" "$PR_READY_LOG" "$FINISH_LOG" "$HERDR_LOG"
	: >"$SPACE_DIR/../decisions.jsonl"
}
worker_open() { grep -q '"w1"' "$SPACE_DIR/delegations.json"; }

# --- a green pull request lands ----------------------------------------------------------------

new_case 'a green, mergeable, answered PR closes the worker'
reset_run
run "$DELEGATE" land w1
if [ "$RC" -eq 0 ]; then pass 'land exits 0'; else fail 'land failed on a green PR' "$OUT"; fi
if has 'ready: #7 0123456, merge it'; then pass 'it prints the ready line'; else fail 'it printed no ready line' "$OUT"; fi
if worker_open; then fail 'the worker is still open after a green land' "$(cat "$SPACE_DIR/delegations.json")"; else pass 'the worker is closed'; fi
if grep -q '^delegate finish w1 --keep-open' "$FINISH_LOG"; then
	pass 'it published through finish --keep-open'
else
	fail 'it did not call finish --keep-open' "$(cat "$FINISH_LOG" 2>/dev/null)"
fi
if grep -q -- '--sha 0123456 --wait' "$PR_READY_LOG"; then
	pass 'the rollup was waited on, on the head publish verified'
else
	fail 'the rollup was not waited on the published head' "$(cat "$PR_READY_LOG" 2>/dev/null)"
fi
if has 'prose review: clean'; then pass 'the prose verdict was asked for'; else fail 'the prose verdict was never asked' "$OUT"; fi

# --- a red check leaves the worker open --------------------------------------------------------

new_case 'a red check leaves the worker open and names the tell command'
reset_run
PR_READY_MODE=red run "$DELEGATE" land w1
if [ "$RC" -ne 0 ]; then pass 'land exits non-zero'; else fail 'land exited 0 over a red check' "$OUT"; fi
if has 'not ready: 1 check(s) FAILED'; then pass 'the failing line is printed'; else fail 'the failing line is missing' "$OUT"; fi
if has "fix in place: bin/delegate tell w1 'not ready: 1 check(s) FAILED'"; then
	pass 'it says how to fix it in place, quoting the line'
else
	fail 'it does not print the tell line' "$OUT"
fi
if worker_open; then pass 'the worker is still open'; else fail 'a red check closed the worker'; fi
if has 'ready: #'; then fail 'it printed the ready line over a red check' "$OUT"; else pass 'no ready line'; fi
if grep -q '^delegate finish w1 --keep-open' "$FINISH_LOG"; then
	pass 'it still published first, so the PR exists'
else
	fail 'it never published' "$(cat "$FINISH_LOG" 2>/dev/null)"
fi

# --- an open prose finding leaves the worker open ----------------------------------------------

new_case 'an open prose finding leaves the worker open and names the finding'
reset_run
PR_READY_MODE=prose run "$DELEGATE" land w1
if [ "$RC" -ne 0 ]; then pass 'land exits non-zero'; else fail 'land exited 0 over an open finding' "$OUT"; fi
if has 'prose review: 1 finding(s) open — contradiction'; then
	pass 'the open finding is named'
else
	fail 'the finding is not named' "$OUT"
fi
if has "fix in place: bin/delegate tell w1 'prose review: 1 finding(s) open — contradiction'"; then
	pass 'the tell line quotes the finding'
else
	fail 'no tell line for the finding' "$OUT"
fi
if worker_open; then pass 'the worker is still open'; else fail 'an open finding closed the worker'; fi
if has 'ready: #'; then fail 'it printed the ready line with a finding open' "$OUT"; else pass 'no ready line'; fi

# --- UNKNOWN is not a refusal ---------------------------------------------------------------

new_case 'a mergeable flag that is UNKNOWN at first is polled, not refused'
reset_run
GH_UNKNOWN_TIMES=2 run "$DELEGATE" land w1
if [ "$RC" -eq 0 ]; then pass 'land succeeds once GitHub answers MERGEABLE'; else fail 'land gave up on UNKNOWN' "$OUT"; fi
if has 'ready: #7 0123456, merge it'; then pass 'it prints the ready line'; else fail 'it printed no ready line' "$OUT"; fi
if [ "$(cat "$GH_COUNT")" -ge 3 ]; then pass 'it asked again instead of refusing'; else fail 'it did not retry the mergeable flag'; fi

new_case 'a pull request that never becomes mergeable is refused and named'
reset_run
GH_MERGEABLE=CONFLICTING run "$DELEGATE" land w1
if [ "$RC" -ne 0 ]; then pass 'land exits non-zero'; else fail 'land exited 0 over a CONFLICTING PR' "$OUT"; fi
if has 'mergeable: CONFLICTING after 5 checks'; then pass 'it names the mergeable verdict it read'; else fail 'the reason is not named' "$OUT"; fi
if worker_open; then pass 'the worker is still open'; else fail 'an unmergeable PR closed the worker'; fi

# --- finish refusing stops land at the first step ---------------------------------------------

new_case 'a red preflight in finish stops land and quotes the FAIL line'
reset_run
FINISH_MODE=fail run "$DELEGATE" land w1
if [ "$RC" -ne 0 ]; then pass 'land exits non-zero'; else fail 'land carried on after a refused finish' "$OUT"; fi
if has 'FAIL preflight: syntax on bin/delegate'; then pass 'the FAIL line is printed'; else fail 'the FAIL line is missing' "$OUT"; fi
if has "fix in place: bin/delegate tell w1 'FAIL preflight: syntax on bin/delegate'"; then
	pass 'the tell line quotes it'
else
	fail 'no tell line for the refused finish' "$OUT"
fi
if [ -s "$PR_READY_LOG" ]; then fail 'the gate ran over a PR that was never published' "$(cat "$PR_READY_LOG")"; else pass 'the gate was never reached'; fi
if worker_open; then pass 'the worker is still open'; else fail 'a refused finish closed the worker'; fi

# --- a branch that changes bin/pr-ready judges itself -----------------------------------------

new_case 'the worktree copy of pr-ready judges a branch that changes it'
reset_run
WT="$PRJ/.worktrees/w1"
git -C "$PRJ" worktree add -q "$WT" w1
mkdir -p "$WT/bin"
cat >"$WT/bin/pr-ready" <<'STUB'
#!/usr/bin/env bash
printf 'worktree-pr-ready %s\n' "$*" >>"$PR_READY_LOG"
printf 'pr 7: head 0123456, checks 12, pending 0, fail 0\n'
printf 'prose review: clean (5 checks)\n'
exit 0
STUB
chmod +x "$WT/bin/pr-ready"
GH_FILES='bin/pr-ready bin/delegate' run "$DELEGATE" land w1
if [ "$RC" -eq 0 ]; then pass 'land exits 0'; else fail 'land failed' "$OUT"; fi
if grep -q '^worktree-pr-ready ' "$PR_READY_LOG"; then
	pass 'the branch own pr-ready judged it'
else
	fail 'the trunk copy judged a branch that changes pr-ready' "$(cat "$PR_READY_LOG" 2>/dev/null)"
fi
if grep -q '^pr-ready ' "$PR_READY_LOG"; then
	fail 'the copy on PATH was run as well' "$(cat "$PR_READY_LOG")"
else
	pass 'no other pr-ready ran'
fi
git -C "$PRJ" worktree remove --force "$WT"

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
