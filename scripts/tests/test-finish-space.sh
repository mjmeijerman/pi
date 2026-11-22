#!/usr/bin/env bash
# Tests for bin/preflight and bin/publish inside a space: which report the body gate reads, which
# branch a merged worker's `behind` verdict lets through, and which programs `delegate finish` runs.
#
# Why these exist: both programs resolved their state from the pre-space boss root, so in a space
# they looked for the report at $PI_BOSS_ROOT/reports/<slug>.md and refused one that sat at
# state/spaces/<slug>/reports/<slug>.md — "does not exist, so there is no report to publish" — and
# `finish` found them through PATH rather than the tree it lives in. #205 and #206 were published by
# hand because of it, which is exactly what this tooling is meant to remove. The merged branch is
# the other half: a branch origin/trunk already carries is finished, not behind, and failing it made
# a legitimately finished worker unfinishable.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT/bin/preflight"
PUBLISH="$ROOT/bin/publish"
DELEGATE="$ROOT/bin/delegate"
for f in "$PREFLIGHT" "$PUBLISH" "$DELEGATE"; do
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
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/bin"
PORTED_LOG="$WORK/ported.log"
LEGACY_LOG="$PI_LEGACY_BOSS_ROOT/log"
PATH_LOG="$WORK/stub.log"
export PORTED_LOG LEGACY_LOG PATH_LOG
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH

export GIT_AUTHOR_NAME="test"
export GIT_AUTHOR_EMAIL="test@example.invalid"
export GIT_COMMITTER_NAME="test"
export GIT_COMMITTER_EMAIL="test@example.invalid"
export GIT_CONFIG_NOSYSTEM=1

# The pre-space copies: finish must never reach these. They log, so a call is visible rather than
# silently harmless.
for prog in preflight publish; do
	cat >"$PI_LEGACY_BOSS_ROOT/bin/$prog" <<'STUB'
#!/usr/bin/env bash
printf 'legacy %s %s\n' "${0##*/}" "$*" >>"$LEGACY_LOG"
exit 0
STUB
	cat >"$WORK/stub/$prog" <<'STUB'
#!/usr/bin/env bash
printf 'path %s %s\n' "${0##*/}" "$*" >>"$PATH_LOG"
exit 0
STUB
done
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
printf '[]\n'
STUB
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
printf '{"terminals":[]}\n'
STUB
chmod +x "$WORK/stub/"* "$PI_LEGACY_BOSS_ROOT/bin/"*

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

# --- fixtures ---------------------------------------------------------------------------------

# A repository with: trunk (main), a branch origin/trunk already carries (w1, squash-merged), and a
# branch that collides with trunk (w2: both sides moved c.txt after w2's cut point).
ORIGIN="$WORK/origin.git"
PRJ="$WORK/proj"
git init -q --bare --initial-branch=main "$ORIGIN"
git init -q --initial-branch=main "$PRJ"
git -C "$PRJ" remote add origin "$ORIGIN"
printf 'a\n' >"$PRJ/a.txt"
printf 'c0\n' >"$PRJ/c.txt"
git -C "$PRJ" add -A
git -C "$PRJ" commit -qm 'start'
git -C "$PRJ" push -q -u origin main
git -C "$PRJ" checkout -q -b w1
printf 'b\n' >"$PRJ/b.txt"
git -C "$PRJ" add -A
git -C "$PRJ" commit -qm 'w1 work (#1)' -m 'Agent-Slug: w1'
git -C "$PRJ" push -q -u origin w1
git -C "$PRJ" checkout -q main
git -C "$PRJ" merge -q --squash w1
git -C "$PRJ" commit -qm 'w1 work (#1)'
git -C "$PRJ" push -q origin main
git -C "$PRJ" checkout -q -b w2
printf 'c-w2\n' >"$PRJ/c.txt"
git -C "$PRJ" add -A
git -C "$PRJ" commit -qm 'w2 moves c' -m 'Agent-Slug: w2'
git -C "$PRJ" push -q -u origin w2
git -C "$PRJ" checkout -q main
printf 'c-main\n' >"$PRJ/c.txt"
git -C "$PRJ" add -A
git -C "$PRJ" commit -qm 'main moves c'
git -C "$PRJ" push -q origin main
git -C "$PRJ" checkout -q w1

SPACE_DIR="$PI_SPACE_ROOT/state/spaces/sp"
mkdir -p "$SPACE_DIR/reports"
cat >"$SPACE_DIR/space.json" <<JSON
{"name": "sp", "kind": "project", "project": "$PRJ", "git": true}
JSON
# No `report` field: the space's own reports/ folder is what the fallback has to find.
cat >"$SPACE_DIR/delegations.json" <<JSON
{"w1": {"cwd": "$PRJ", "branch": "w1", "spec": "$SPACE_DIR/specs/w1.md"}}
JSON
REPORT="$SPACE_DIR/reports/w1.md"
write_report() {
	cat >"$1" <<'REPORT'
Mission: a worker in a space finishes without a hand-run publish

Review tier: High — two shell programs moved and finish now calls them by path.

Now possible: `delegate finish` publishes a space's report without a person pushing it.

## Evidence

Command: bin/preflight --slug w1 --space sp

```
preflight: 7/7 passed (0 cached, 7 ran) on w1 in 41s
```

## Thrown away

nothing
REPORT
}
write_report "$REPORT"

# ------------------------------------------- the body gate reads the space's report --
new_case 'a report under the space is the report the body gate reads'
run "$PREFLIGHT" --only body --slug w1 --space sp --cwd "$PRJ"
if [ "$RC" -eq 0 ]; then pass 'the body check passes'; else fail 'the body check failed' "$OUT"; fi
if has 'no pr-check target'; then pass 'the body was built (no body gate in this fixture, said by name)'; else fail 'the body was never built' "$OUT"; fi
case $OUT in
*"does not exist, so there is no report"*) fail 'it looked for a report somewhere else' "$OUT" ;;
*) pass 'it did not refuse the report it was given' ;;
esac

new_case 'a space with no report there still says so'
rm -f "$REPORT"
run "$PREFLIGHT" --only body --slug w1 --space sp --cwd "$PRJ"
if [ "$RC" -ne 0 ]; then pass 'the body check fails'; else fail 'the body check passed with no report' "$OUT"; fi
if has "$REPORT does not exist, so there is no report to publish"; then pass 'the refusal names the space report path'; else fail 'the refusal does not name the space report path' "$OUT"; fi
write_report "$REPORT"

# ------------------------------------------- the space, by --space and by project path --
new_case 'the space is resolved from --space and from the project path'
run "$PUBLISH" w1 --space sp --cwd "$PRJ" --body-out "$WORK/body-by-space.md"
if [ "$RC" -eq 0 ]; then pass '--space finds the report'; else fail '--space did not find the report' "$OUT"; fi
if [ -s "$WORK/body-by-space.md" ] && grep -q '^Mission: a worker in a space finishes' "$WORK/body-by-space.md"; then
	pass 'the body carries the report the space holds'
else
	fail 'the body does not carry the space report' "$(cat "$WORK/body-by-space.md" 2>/dev/null)"
fi
run "$PUBLISH" w1 --cwd "$PRJ" --body-out "$WORK/body-by-project.md"
if [ "$RC" -eq 0 ]; then pass 'the project path alone resolves the same space'; else fail 'the project path did not resolve the space' "$OUT"; fi

# A worker's worktree lies beside the project, not inside it, so the project path finds no space and
# the slug is the only thing that does. Without this a worker's own `bin/publish` looks in the
# pre-space layout and refuses the report it just wrote.
new_case 'a worktree outside the space resolves it by the worker it tracks'
git -C "$PRJ" worktree add -q "$WORK/wt" main
cat >"$SPACE_DIR/delegations.json" <<JSON
{"w1": {"cwd": "$WORK/wt", "branch": "w1", "spec": "$SPACE_DIR/specs/w1.md"}}
JSON
run "$PUBLISH" w1 --cwd "$WORK/wt" --body-out "$WORK/body-by-slug.md"
if [ "$RC" -eq 0 ]; then pass 'the slug alone finds the report'; else fail 'the slug did not resolve the space' "$OUT"; fi
if [ -s "$WORK/body-by-slug.md" ] && grep -q '^Mission: a worker in a space finishes' "$WORK/body-by-slug.md"; then
	pass 'the body is the report the space holds'
else
	fail 'the body does not carry the space report' "$(cat "$WORK/body-by-slug.md" 2>/dev/null)"
fi
cat >"$SPACE_DIR/delegations.json" <<JSON
{"w1": {"cwd": "$PRJ", "branch": "w1", "spec": "$SPACE_DIR/specs/w1.md"}}
JSON

new_case '--space that names no space is refused, not guessed'
run "$PREFLIGHT" --only behind --space nosuch --cwd "$PRJ"
if [ "$RC" -eq 2 ]; then pass 'preflight refuses it (exit 2)'; else fail "preflight exited $RC" "$OUT"; fi
if has 'no such space: nosuch — bin/space list'; then pass 'the refusal names bin/space list'; else fail 'the refusal does not say how to list spaces' "$OUT"; fi

# ------------------------------------------- a merged branch is not behind --
new_case 'a branch origin/trunk already carries passes behind'
run "$PREFLIGHT" --only behind --space sp --cwd "$PRJ" w1
if [ "$RC" -eq 0 ]; then pass 'behind passes'; else fail 'behind failed on a merged branch' "$OUT"; fi
if has 'already merged'; then pass 'the pass says it is merged'; else fail 'the pass does not say why' "$OUT"; fi

new_case 'a branch that collides with trunk still fails behind'
run "$PREFLIGHT" --only behind --space sp --cwd "$PRJ" w2
if [ "$RC" -ne 0 ]; then pass 'behind fails'; else fail 'behind passed on a colliding branch' "$OUT"; fi
if has 'c.txt'; then pass 'the failure names the colliding path'; else fail 'the failure does not name the path' "$OUT"; fi
if has 'git -C '"$PRJ"' rebase origin/main'; then pass 'the failure names the rebase'; else fail 'the failure does not name the rebase' "$OUT"; fi

# ------------------------------------------- finish runs the ported programs --
new_case 'finish runs the programs in its own tree, not the pre-space copies'
PORTED="$WORK/ported"
mkdir -p "$PORTED/bin"
cp "$DELEGATE" "$ROOT/bin/space-lib.sh" "$PORTED/bin/"
for prog in preflight publish; do
	cat >"$PORTED/bin/$prog" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >>"$PORTED_LOG"
[ "${0##*/}" = publish ] && exit 1
exit 0
STUB
done
chmod +x "$PORTED/bin/"*
: >"$PORTED_LOG"
: >"$PATH_LOG"
rm -f "$LEGACY_LOG"
run "$PORTED/bin/delegate" finish w1 --cwd "$PRJ"
if [ "$RC" -ne 0 ]; then pass 'finish stops at the refusing publish'; else fail 'finish exited 0 over a refusing publish' "$OUT"; fi
if has 'finish stopped at step 2 of 4 (publish)'; then pass 'the refusal names step 2'; else fail 'the refusal does not name the step' "$OUT"; fi
if grep -q '^preflight .*--slug w1 .*--space sp' "$PORTED_LOG"; then
	pass 'the gate in its own tree got the slug and the space'
else
	fail 'the ported preflight was not called with --space sp' "$(cat "$PORTED_LOG")"
fi
if grep -q '^publish .*--space sp' "$PORTED_LOG"; then
	pass 'the publisher in its own tree got the space'
else
	fail 'the ported publish was not called with --space sp' "$(cat "$PORTED_LOG")"
fi
if [ ! -s "$LEGACY_LOG" ]; then pass 'the pre-space copies were never run'; else fail 'finish ran a pre-space copy' "$(cat "$LEGACY_LOG")"; fi
if [ ! -s "$PATH_LOG" ]; then pass 'no copy on PATH was run'; else fail 'finish ran a copy from PATH' "$(cat "$PATH_LOG")"; fi

# ------------------------------------------- --keep-open stops after publish --
# The boss's landing loop needs the worker alive after the pull request exists: a red check is fixed
# by `delegate tell` into the worker's own terminal, and that needs a worker. --keep-open publishes
# and stops there — no wipe, no close, and no pretending the run finished.
new_case '--keep-open publishes and does not wipe or close'
KEEP="$WORK/keepopen"
mkdir -p "$KEEP/bin"
cp "$DELEGATE" "$ROOT/bin/space-lib.sh" "$KEEP/bin/"
cat >"$KEEP/bin/preflight" <<'STUB'
#!/usr/bin/env bash
printf 'preflight %s\n' "$*" >>"$PORTED_LOG"
printf 'preflight: 7/7 passed (0 cached, 7 ran)\n'
exit 0
STUB
cat >"$KEEP/bin/publish" <<'STUB'
#!/usr/bin/env bash
printf 'publish %s\n' "$*" >>"$PORTED_LOG"
printf 'published w1: #41 now at abc1234 (OPEN, MERGEABLE)\n'
printf 'https://example.invalid/pr/41\n'
exit 0
STUB
chmod +x "$KEEP/bin/"*
: >"$PORTED_LOG"
rm -f "$PI_SPACE_ROOT/state/decisions.jsonl"
KEEP_RECORD="$SPACE_DIR/delegations.json"
KEEP_BEFORE=$(cksum "$KEEP_RECORD")
run "$KEEP/bin/delegate" finish w1 --cwd "$PRJ" --keep-open
if [ "$RC" -eq 0 ]; then pass 'the kept-open finish exits 0'; else fail 'the kept-open finish failed' "$OUT"; fi
if has 'kept open: #41 at abc1234'; then
	pass 'it prints the pull request and the head sha `land` waits on'
else
	fail 'it printed no kept-open line naming the PR and sha' "$OUT"
fi
if [ "$(cksum "$KEEP_RECORD")" = "$KEEP_BEFORE" ] && grep -q '"w1"' "$KEEP_RECORD"; then
	pass 'the worker is still recorded, so it is still open'
else
	fail 'the kept-open finish closed the worker' "$(cat "$KEEP_RECORD")"
fi
if [ -f "$PI_SPACE_ROOT/state/decisions.jsonl" ] && grep -q '"command":"wipe"' "$PI_SPACE_ROOT/state/decisions.jsonl"; then
	fail 'the kept-open finish recorded a wipe'
else
	pass 'no wipe was recorded'
fi
if grep -q '^preflight ' "$PORTED_LOG" && grep -q '^publish ' "$PORTED_LOG"; then
	pass 'it did run the gate and the publisher'
else
	fail 'it skipped the gate or the publisher' "$(cat "$PORTED_LOG")"
fi

# ------------------------------------------- the CI gate: finish publishes only a green one --
# The gate `finish` runs is now `preflight --ci`, so a publish is refused when the pipeline's own
# jobs fail here — it printed `preflighted` for a branch GitHub failed, three times in one night.
# `<slot>` is the directory the stub programs live in, so a case can swap one out.
CIGATE() { # <dir> — delegate + space-lib from this tree, stub preflight and publish beside them
	mkdir -p "$1/bin"
	cp "$DELEGATE" "$ROOT/bin/space-lib.sh" "$1/bin/"
	cat >"$1/bin/preflight" <<'STUB'
#!/usr/bin/env bash
printf 'preflight %s\n' "$*" >>"$PORTED_LOG"
if [ "${CI_PF_RC:-0}" != 0 ]; then
	printf 'FAIL  ci (bin/ci, the pipeline jobs, run here)    2s  exit 1\n'
	printf '      ci: 11/12 runnable green, 0 skipped, 1 failed\n'
	printf '      ci: log: /tmp/ci/build.log\n'
	exit 1
fi
printf 'preflight: 1/1 passed (0 cached, 1 ran)\n'
exit 0
STUB
	cat >"$1/bin/publish" <<'STUB'
#!/usr/bin/env bash
printf 'publish %s\n' "$*" >>"$PORTED_LOG"
printf 'published w1: #41 now at abc1234 (OPEN, MERGEABLE)\n'
printf 'https://example.invalid/pr/41\n'
exit 0
STUB
	chmod +x "$1/bin/"*
}

new_case 'finish runs the gate with --ci, not with a hand-picked sample of the checks'
CI_DIR="$WORK/cigate"
CIGATE "$CI_DIR"
: >"$PORTED_LOG"
run "$CI_DIR/bin/delegate" finish w1 --cwd "$PRJ" --keep-open
if [ "$RC" -eq 0 ]; then pass 'the gated finish publishes'; else fail 'the gated finish failed' "$OUT"; fi
if grep -q '^preflight .*--ci' "$PORTED_LOG"; then
	pass 'the gate was run with --ci'
else
	fail 'the gate was run without --ci' "$(cat "$PORTED_LOG")"
fi
if grep -q '^publish ' "$PORTED_LOG"; then pass 'a green gate published'; else fail 'nothing was published'; fi

new_case 'finish refuses to publish when the CI stub is red, and names the tell as its last line'
: >"$PORTED_LOG"
CI_PF_RC=1 run "$CI_DIR/bin/delegate" finish w1 --cwd "$PRJ" --keep-open
if [ "$RC" -ne 0 ]; then pass 'the red gate stops the finish'; else fail 'finish exited 0 over a red pipeline' "$OUT"; fi
if has 'finish stopped at step 1 of 4 (preflight)'; then
	pass 'the refusal names step 1'
else
	fail 'the refusal does not name the step' "$OUT"
fi
if grep -q '^publish ' "$PORTED_LOG"; then fail 'it published over a red pipeline' "$(cat "$PORTED_LOG")"; else pass 'nothing was published'; fi
last_line=$(printf '%s\n' "$OUT" | tail -n 1)
case $last_line in
'fix in place: bin/delegate tell w1 '*ci*) pass "the last line is the tell command: $last_line" ;;
*) fail 'the last line is not the tell command' "last line: $last_line" ;;
esac

new_case '--skip ci "<reason>" publishes anyway and records the reason'
: >"$PORTED_LOG"
DECISIONS_FILE="$SPACE_DIR/state/decisions.jsonl"
rm -f "$DECISIONS_FILE"
run "$CI_DIR/bin/delegate" finish w1 --cwd "$PRJ" --keep-open --skip ci 'the CI runner is broken on this machine'
if [ "$RC" -eq 0 ]; then pass 'the bypassed finish publishes'; else fail 'the bypassed finish failed' "$OUT"; fi
if grep -q '^preflight ' "$PORTED_LOG"; then
	fail 'it ran the gate it was told to skip' "$(cat "$PORTED_LOG")"
else
	pass 'the gate was skipped, not run and ignored'
fi
if grep -q '^publish ' "$PORTED_LOG"; then pass 'it published'; else fail 'it did not publish'; fi
if [ -f "$DECISIONS_FILE" ] && grep -q '"command":"preflight"' "$DECISIONS_FILE" &&
	grep -q 'the CI runner is broken on this machine' "$DECISIONS_FILE"; then
	pass 'the reason is in state/decisions.jsonl, so the bypass is visible'
else
	fail 'the preflight skip and its reason were not recorded' "$(cat "$DECISIONS_FILE" 2>/dev/null)"
fi

# ------------------------------------------- a finish on a worker whose record is gone --
# `finish` could not tell "this worker is waiting to be published" from "this worker was published
# and closed last night": with the delegation record deleted, the space was never resolved, and the
# publish step ran off the report alone. One second run re-pushed #232, then died on a wipe with
# nothing to wipe, printed ~/.pi/reports/<slug>.md (a path no space ever wrote) and told a person a
# closed worker was "still open". The record is what a wipe and a close address, so a finish with no
# record is refused before the gate, before publish, and with the space's own paths in the message.
GONE_DIR="$WORK/gone"
mkdir -p "$GONE_DIR/bin"
cp "$DELEGATE" "$ROOT/bin/space-lib.sh" "$GONE_DIR/bin/"
PUBLISH_MARK="$WORK/publish-called"
PUBLISH_COUNT="$WORK/publish-count"
export PUBLISH_MARK PUBLISH_COUNT
cat >"$GONE_DIR/bin/preflight" <<'STUB'
#!/usr/bin/env bash
printf 'preflight %s\n' "$*" >>"$PORTED_LOG"
exit 0
STUB
cat >"$GONE_DIR/bin/publish" <<'STUB'
#!/usr/bin/env bash
printf 'publish %s\n' "$*" >>"$PORTED_LOG"
: >"$PUBLISH_MARK"
printf 'x' >>"$PUBLISH_COUNT"
printf 'published w1: #41 now at abc1234 (OPEN, MERGEABLE)\n'
printf 'https://example.invalid/pr/41\n'
exit 0
STUB
chmod +x "$GONE_DIR/bin/"*
W1_SHA=$(git -C "$PRJ" rev-parse w1)
# A report a finished worker leaves behind: Evidence with a gate run, the commit it stands for, and
# the wipe's five answers. Everything close asks for, so the first finish can reach 4/4.
write_finished_report() {
	cat >"$1" <<REPORT
Mission: a finish on a worker whose record is gone refuses instead of publishing again

Review tier: High

Now possible: \`delegate finish\` refuses a closed worker before it pushes anything.

Commit: $W1_SHA

## Evidence

Command: bin/preflight --ci --slug w1

\`\`\`
preflight: 7/7 passed (0 cached, 7 ran) on w1 in 41s
\`\`\`

## Thrown away

1. Deleted? nothing — the refusal is a check, no code became unnecessary.
2. Duplicated? space_with_report is the one place a space is found from a report.
3. Next feature? a finish that can be given the space by hand could land here in 30 minutes.
4. Learned? the record is what a wipe and a close address, so publish alone is not a finish.
5. Rewrite? nothing.
REPORT
}

new_case 'finish on a slug with no record refuses before anything is pushed'
write_finished_report "$REPORT"
printf '{}\n' >"$SPACE_DIR/delegations.json"
rm -f "$PUBLISH_MARK" "$PUBLISH_COUNT" "$PI_SPACE_ROOT/state/decisions.jsonl"
: >"$PORTED_LOG"
run "$GONE_DIR/bin/delegate" finish w1 --cwd "$PRJ"
if [ "$RC" -eq 1 ]; then pass 'it exits 1'; else fail "it exited $RC" "$OUT"; fi
refusal_line=$(printf '%s\n' "$OUT" | head -n 1)
expected_refusal='finish: refusing w1: it has no delegation record, so there is no worker to publish, wipe or close (it was already closed)'
if [ "$refusal_line" = "$expected_refusal" ]; then
	pass 'the first line is the one refusal line'
else
	fail 'the first line is not the refusal line' "got: $refusal_line"
fi
if [ ! -e "$PUBLISH_MARK" ]; then pass 'publish was never called'; else fail 'it published with no record'; fi
if grep -q '^publish ' "$PORTED_LOG"; then fail 'the publisher ran' "$(cat "$PORTED_LOG")"; else pass 'the publisher never ran'; fi
if grep -q '^preflight ' "$PORTED_LOG"; then fail 'the gate ran for a worker that cannot be published' "$(cat "$PORTED_LOG")"; else pass 'the gate did not run either'; fi
case $OUT in
*published* | *'now at'*) fail 'it printed a publish verdict' "$OUT" ;;
*) pass 'no pull-request-shaped output' ;;
esac
if has 'delegate list'; then pass 'it says where to see the workers that do exist'; else fail 'it does not point at delegate list' "$OUT"; fi

new_case 'the report path a refused finish prints is the space own'
if has "$SPACE_DIR/reports/w1.md"; then
	pass 'it names state/spaces/sp/reports/w1.md'
else
	fail 'it does not name the space report path' "$OUT"
fi
case $OUT in
*"$PI_SPACE_ROOT/reports/w1.md"*) fail 'it printed the pre-space reports/ folder' "$OUT" ;;
*"$HOME/.pi/reports/w1.md"*) fail 'it printed the boss root reports/ folder' "$OUT" ;;
*) pass 'no fallback path was printed' ;;
esac

new_case 'finish once, then finish again: the second refuses and publishes nothing'
cat >"$SPACE_DIR/delegations.json" <<JSON
{"w1": {"cwd": "$PRJ", "branch": "w1", "space": "sp-old", "spec": "$SPACE_DIR/specs/w1.md"}}
JSON
write_finished_report "$REPORT"
rm -f "$PUBLISH_MARK" "$PUBLISH_COUNT" "$PI_SPACE_ROOT/state/decisions.jsonl"
: >"$PORTED_LOG"
run "$GONE_DIR/bin/delegate" finish w1 --cwd "$PRJ"
if [ "$RC" -eq 0 ]; then pass 'the first finish publishes, wipes and closes'; else fail 'the first finish failed' "$OUT"; fi
if has 'preflighted, published, wiped, closed'; then pass 'the first finish reached 4/4'; else fail 'the first finish did not reach 4/4' "$OUT"; fi
if grep -q '"w1"' "$SPACE_DIR/delegations.json"; then fail 'the first finish left the record behind' "$(cat "$SPACE_DIR/delegations.json")"; else pass 'the record is gone, so the worker is closed'; fi
count_after_first=$(wc -c <"$PUBLISH_COUNT" 2>/dev/null || echo 0)
OUT=$OUT RC=$RC
run "$GONE_DIR/bin/delegate" finish w1 --cwd "$PRJ"
if [ "$RC" -eq 1 ]; then pass 'the second finish refuses (exit 1)'; else fail "the second finish exited $RC" "$OUT"; fi
if has 'it has no delegation record'; then pass 'it says the record is gone'; else fail 'it does not say why' "$OUT"; fi
if [ "$(wc -c <"$PUBLISH_COUNT" 2>/dev/null || echo 0)" = "$count_after_first" ]; then
	pass 'publish ran once across both runs, so nothing was pushed twice'
else
	fail 'the second run published again' "publishes: $count_after_first then $(wc -c <"$PUBLISH_COUNT" 2>/dev/null || echo 0)"
fi
if has 'the worker is still open'; then fail 'it claims a closed worker is still open' "$OUT"; else pass 'it does not claim the worker is still open'; fi

# ------------------------------------------- verdict --
printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
