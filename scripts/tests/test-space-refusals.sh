#!/usr/bin/env bash
# Tests for the three refusals a space carries and for a space without git.
#
# Why these exist: "one worker per space", "merged before the next", and the live ceiling are the
# rules that keep two workers from editing the same project at once; a rule that is only prose is
# a rule that gets skipped. Each is refused here, by name, with the command that comes next. The
# non-git half is the same care the other way: a folder with no repository must not be sent
# looking for a branch, a worktree or a pull request it cannot have.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
DELEGATE="$ROOT/bin/delegate"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/state"
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export GH_LOG="$WORK/gh.log"
export PF_LOG="$WORK/preflight.log"
export DELEGATE_POLL_SECONDS=0

cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"sp1","tab":"tb1","pane":"p1","terminal":"t1"}\n' ;;
"do tab.new") printf '{"space":"sp1","tab":"tb2","pane":"p2","terminal":"t2"}\n' ;;
"do space.close") printf '{}\n' ;;
"do tab.close") printf '{}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
# The boss's own terminal is always listed; the worker terminals come from $HC_TERMS, so one case
# can say "w1 is still running" and the next can say "it is gone".
ls)
	printf '{"terminals":[{"id":"t-boss","state":"idle"}'
	if [ -f "${HC_TERMS:-/nonexistent}" ]; then
		while IFS= read -r t; do [ -n "$t" ] && printf ',{"id":"%s","state":"idle"}' "$t"; done <"$HC_TERMS"
	fi
	printf ']}\n'
	;;
read) printf 'escape interrupt\n' ;;
send) exit 0 ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [ -f "${GH_PRS:-/nonexistent}" ]; then cat "$GH_PRS"; else printf '[]\n'; fi
STUB
cat >"$PI_SPACE_ROOT/bin/jev" <<'STUB'
#!/usr/bin/env bash
case "$1" in
plan) printf '{"mode":"bare","route":"remote","thinking":"medium","reason":"stub jev","answered":{"mode":"bare","route":"remote","thinking":"medium"}}\n' ;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$PF_LOG"\nexit 0\n' >"$PI_SPACE_ROOT/bin/preflight"
printf '#!/usr/bin/env bash\nprintf "publish was called\\n" >>"$HERDR_LOG"\nexit 0\n' >"$PI_SPACE_ROOT/bin/publish"
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-bare"
# `finish` runs the programs in the tree it lives in (bin/preflight, bin/publish), never whichever
# copies PATH happens to hold, so the harness under test is a copy of that tree beside the stubs —
# the layout a real install has, where $PI_BOSS_ROOT/bin is the delegate's own bin.
cp "$ROOT/bin/delegate" "$ROOT/bin/space-lib.sh" "$ROOT/bin/records-lib.sh" "$PI_SPACE_ROOT/bin/"
DELEGATE="$PI_SPACE_ROOT/bin/delegate"
chmod +x "$WORK/stub/"* "$PI_SPACE_ROOT/bin/"*

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
sd() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1"; }

# A worker whose record exists, with a report that is still the unfilled skeleton — the shape a
# started worker has before it writes.
mkworker() {
	local space=$1 slug=$2 terminal=$3
	mkdir -p "$(sd "$space")/reports"
	printf '# Report — %s\n\nMission: <fill in: what shows it>\n\nReview tier: <fill in: High|Medium|Low>\n' \
		"$slug" >"$(sd "$space")/reports/$slug.md"
	SLUG=$slug TERM=$terminal SPACE=$space DIR=$(sd "$space") node -e '
		const fs=require("fs");const [file,slug,term,space]=process.argv.slice(1);
		let j={};try{j=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
		j[slug]={slug,space:"sp1",tab:"tb1",terminal:term,cwd:process.env.DIR,mode:"bare",
			thinking:"medium",spec:process.env.DIR+"/specs/"+slug+".md",
			report:process.env.DIR+"/reports/"+slug+".md"};
		fs.writeFileSync(file,JSON.stringify(j,null,2)+"\n");' "$(sd "$space")/delegations.json" "$slug" "$terminal" "$space"
	mkdir -p "$(sd "$space")/specs"
	printf '# Worker %s\n\nMission: test fixture\n' "$slug" >"$(sd "$space")/specs/$slug.md"
}

PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"
"$SPACE" new --name demo --project "$PROJ" >/dev/null

# ------------------------------------------------------- one live worker per space --
new_case 'a space with a live worker'
printf 't1\n' >"$WORK/terms"
HC_TERMS="$WORK/terms"; export HC_TERMS
mkworker demo w1 t1
run "$DELEGATE" spawn w2 --space demo --cwd "$PROJ" "write another line in a.txt"
if [ "$RC" -ne 0 ]; then pass 'the second spawn is refused'; else fail 'two workers were allowed in one space' "$OUT"; fi
case $OUT in
*"already has a live worker: w1"*) pass 'the refusal names the live worker' ;;
*) fail 'the refusal does not name the live worker' "$OUT" ;;
esac
case $OUT in
*"wait w1 --forever"*) pass 'the refusal names the wait command' ;;
*) fail 'the refusal does not name delegate wait' "$OUT" ;;
esac

new_case 'the same space once that worker is gone'
printf '' >"$WORK/terms"
run "$DELEGATE" spawn w2 --space demo --cwd "$PROJ" "write another line in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn goes ahead'; else fail 'a gone worker still blocked the space' "$OUT"; fi

# --------------------------------------------------------- merged before the next --
GITPROJ="$WORK/gitproj"
mkdir -p "$GITPROJ"
printf 'x\n' >"$GITPROJ/a.txt"
git -C "$GITPROJ" init -q
git -C "$GITPROJ" -c core.hooksPath=/dev/null -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
git -C "$GITPROJ" remote add origin git@github.com:me/gitproj.git
gh_set() { printf '%s\n' "$1" >"$WORK/prs"; GH_PRS="$WORK/prs"; export GH_PRS; }
: >"$GH_LOG"

new_case 'a git space with an open pull request'
"$SPACE" new --name gitdemo --project "$GITPROJ" >/dev/null
gh_set '[{"number":7,"headRefName":"feat/elsewhere","updatedAt":"2026-11-19T10:00:00Z","url":"https://example.invalid/pull/7"}]'
run "$DELEGATE" spawn gw1 --space gitdemo --cwd "$GITPROJ" "write one line"
if [ "$RC" -ne 0 ]; then pass 'the spawn is refused'; else fail 'a spawn went ahead with an open PR' "$OUT"; fi
case $OUT in
*"PR #7"*) pass 'the refusal names the pull request' ;;
*) fail 'the refusal does not name the PR' "$OUT"; ;;
esac
case $OUT in
*"asking the person to merge"*) pass 'the refusal says what the next move is' ;;
*) fail 'the refusal does not say to ask the person' "$OUT" ;;
esac
if grep -q 'pr list' "$GH_LOG"; then pass 'it asked gh for the open PRs'; else fail 'gh was never asked'; fi

new_case 'a pull request an old commit carries the trailer for'
# The branch is a real ref in the project with a real Agent-Slug trailer, so the trailer path — not
# the 30-day fallback — is what decides: the date is deliberately ancient.
(
	cd "$GITPROJ" || exit 1
	git -c core.hooksPath=/dev/null -c user.email=t@e -c user.name=t checkout -q -b feat/trailer
	git -c core.hooksPath=/dev/null -c user.email=t@e -c user.name=t commit -q --allow-empty \
		-m 'feat: a worker change' -m 'Agent-Slug: gw1'
	git checkout -q -
	git update-ref refs/remotes/origin/feat/trailer "$(git rev-parse feat/trailer)"
)
mkdir -p "$(sd gitdemo)/specs"
printf '# Worker gw1\n\nMission: the worker that opened PR #9\n' >"$(sd gitdemo)/specs/gw1.md"
gh_set '[{"number":9,"headRefName":"feat/trailer","updatedAt":"2020-01-01T00:00:00Z","url":"https://example.invalid/pull/9"}]'
run "$DELEGATE" spawn gw2 --space gitdemo --cwd "$GITPROJ" "write two lines"
if [ "$RC" -ne 0 ]; then pass 'the spawn is refused'; else fail 'the trailer did not block the spawn' "$OUT"; fi
case $OUT in
*"PR #9"*"feat/trailer"*) pass 'the refusal names PR #9 on that branch' ;;
*) fail 'the refusal does not name the PR and branch' "$OUT" ;;
esac

new_case 'a pull request another space owns'
(
	cd "$GITPROJ" || exit 1
	git -c core.hooksPath=/dev/null -c user.email=t@e -c user.name=t checkout -q feat/trailer
	git -c core.hooksPath=/dev/null -c user.email=t@e -c user.name=t commit -q --allow-empty \
		-m 'fix: someone else' -m 'Agent-Slug: someone-else'
	SHA=$(git rev-parse HEAD)
	git checkout -q -
	git update-ref refs/remotes/origin/feat/trailer "$SHA"
)
run "$DELEGATE" spawn gw3 --space gitdemo --cwd "$GITPROJ" "write three lines"
if [ "$RC" -eq 0 ]; then
	pass 'a PR whose trailer names another worker does not block'
else
	fail 'a PR that belongs to someone else blocked this space' "$OUT"
fi

# ------------------------------------------------------------------ the ceiling --
new_case 'eight live spaces is the ceiling'
gh_set '[]'
for n in 1 2 3 4 5 6 7 8; do
	mkworker demo "c$n" "t-c$n"
done
printf 't-boss\n' >"$WORK/terms"
run "$DELEGATE" spawn c9 --space demo --cwd "$PROJ" "write nine lines"
if [ "$RC" -ne 0 ]; then pass 'the ninth worker is refused'; else fail 'nine workers were tracked' "$OUT"; fi
case $OUT in
*"live ceiling of 8"*) pass 'the refusal names the ceiling' ;;
*) fail 'the refusal does not name the ceiling' "$OUT" ;;
esac

# ------------------------------------------------------------- a space without git --
new_case 'a non-git space never looks for a branch'
NG="$WORK/nogit"
mkdir -p "$NG"
printf 'x\n' >"$NG/note.txt"
"$SPACE" new --name nogit --project "$NG" >/dev/null
rm -f "$(sd demo)/delegations.json"
run "$DELEGATE" spawn ng1 --space nogit --cwd "$NG" "append one line to note.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
SPEC="$(sd nogit)/specs/ng1.spawn.md"
if grep -qi 'work directly in' "$SPEC"; then pass 'the spec says work directly in the folder'; else fail 'the spec does not say work directly in the folder'; fi
if grep -qi 'worktree add' "$SPEC"; then fail 'the spec still asks for a worktree'; else pass 'the spec asks for no worktree'; fi
if grep -q 'no git; the changed files' "$(sd nogit)/reports/ng1.md" || [ ! -f "$(sd nogit)/reports/ng1.md" ]; then
	pass 'the report skeleton asks for files, not a sha'
else
	fail 'the skeleton still asks for a commit sha'
fi
if grep -qi 'Agent-Slug' "$SPEC"; then fail 'the spec still asks for the commit trailers'; else pass 'the spec asks for no commit trailers'; fi

new_case 'finish on a non-git space records the change and closes'
sleep 1
printf 'changed\n' >>"$NG/note.txt"
mkdir -p "$(sd nogit)/reports"
cat >"$(sd nogit)/reports/ng1.md" <<'REPORT'
Mission: one line appended to note.txt, checked by reading it back

Review tier: Low

Test change: none: the folder has no test suite

## Evidence

Command: `cat note.txt`

Output (last 20 lines):

```
x
changed
```

Commit: none — the change is in the folder
REPORT
: >"$PF_LOG"
run "$DELEGATE" finish ng1
if [ "$RC" -eq 0 ]; then pass 'finish succeeds without git'; else fail 'finish failed on a non-git space' "$OUT"; fi
case $OUT in
*"no git"*) pass 'it says there is no git' ;;
*) fail 'it does not say why publish was skipped' "$OUT" ;;
esac
case $OUT in
*note.txt*) pass 'it lists the changed file' ;;
*) fail 'it does not name the changed file' "$OUT" ;;
esac
if grep -q -- '--only syntax' "$PF_LOG"; then pass 'preflight ran the code checks'; else fail 'preflight was not asked for the code checks' "$PF_LOG"; fi
if grep -q -- '--only behind' "$PF_LOG" || grep -q -- '--only body' "$PF_LOG"; then
	fail 'preflight was asked for the branch and PR checks' "$PF_LOG"
else
	pass 'preflight was not asked for behind or body'
fi
if grep -q 'publish was called' "$HERDR_LOG"; then fail 'publish ran without git'; else pass 'publish never ran'; fi
if [ -s "$(sd nogit)/delegations.json" ] && grep -q '"ng1"' "$(sd nogit)/delegations.json"; then
	fail 'the worker is still recorded after finish'
else
	pass 'the worker record is closed'
fi
DEC="$(sd nogit)/state/decisions.jsonl"
if grep -q '"publish".*"none"' "$DEC"; then pass 'the decision log records that nothing was published'; else fail 'no publish decision was recorded'; fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
