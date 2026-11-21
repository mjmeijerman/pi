#!/usr/bin/env bash
# Tests for `bin/delegate status <slug>` — one word, from the tool, and the same word `delegate list`
# prints. No polling, no prose.
#
# Why these exist: a boss answered "is the worker done?" by grepping its report for a field, with
# `grep -qE "Commit: [0-9a-f]{7}"`. The report was written and said `` Commit: `e8d8358` `` — with a
# backtick — so the grep found nothing and the boss reported "working" for twelve minutes after
# `bin/delegate list` already said `reported`. The prose was fine; the poll was wrong. So the cases
# below are the answer read from the record and from the report's required fields, and the trap
# itself is asserted on disk: the same file the boss grepped, where that grep still finds nothing.
#
#   1. a record with no report is `working`;
#   2. a report with backticked fields and a filled `## Evidence` is `reported` — and the trap grep
#      finds nothing on it;
#   3. a report whose `Mission:` is still the skeleton placeholder is `working`, not `reported`;
#   4. a closed worker (entry gone, report kept) is `closed`;
#   5. a slug nothing names is `unknown`, exit 1;
#   6. `status` and `list` say the same word for every fixture;
#   7. `--json` carries the slug, the word and the report path.
#
# No network, no desktop app, nothing written outside $WORK. Set PI_STATUS_DELEGATE to another
# `bin/delegate` (trunk's) to run the same cases against older code, which is how the report shows a
# case failing before the fix.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE=${PI_STATUS_DELEGATE:-$ROOT/bin/delegate}
[ -x "$DELEGATE" ] || {
	printf 'FATAL: %s is not executable\n' "$DELEGATE" >&2
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
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
mkdir -p "$HOME" "$PI_SPACE_ROOT/state/spaces/demo/specs" "$PI_SPACE_ROOT/state/spaces/demo/reports" \
	"$WORK/legacy" "$WORK/stub-down" "$WORK/stub-seen"

# herdr's terminal list decides `gone`, and these cases are about the record: `hc` that answers
# nothing, and `hc` that never lists this worker's terminal, are the two stubs. No hc at all is a
# third answer, and every case here names the one it wants.
printf '#!/usr/bin/env bash\nexit 1\n' >"$WORK/stub-down/hc"
cat >"$WORK/stub-seen/hc" <<'STUB'
#!/usr/bin/env bash
printf '{"terminals":[{"id":"t-other","state":"idle"}]}\n'
STUB
chmod +x "$WORK/stub-down/hc" "$WORK/stub-seen/hc"

SD="$PI_SPACE_ROOT/state/spaces/demo"
SPEC="$SD/specs/w1.md"
REPORT="$SD/reports/w1.md"
printf '# Worker w1\n\nMission: test fixture\n' >"$SPEC"

write_record() {
	cat >"$SD/delegations.json" <<JSON
{"w1":{"slug":"w1","kind":"tab","space":"sp1","spaceName":"demo","tab":"tb1","terminal":"t1","cwd":"$WORK","mode":"sandboxed","thinking":"low","spec":"$SPEC","report":"$REPORT"}}
JSON
}

# The report that fooled the boss: every field wrapped in backticks, Evidence filled, and the commit
# on a `Commit: \`sha\`` line — which `^Commit: [0-9a-f]` does not match.
cat >"$WORK/backticked.md" <<'REPORT'
# Report — w1

Mission: the person can stop waiting, because `bin/delegate status w1` says one word

Review tier: Low

Test change: none: no test file changed

Now possible: run `bin/delegate status w1` and act on the word.

## Evidence

Command: `bash scripts/ci-offline.sh`

Output (last 20 lines):

```
== ci-offline: 1 suite(s), 0 failed
```

Commit: `e8d8358`
REPORT

# The same five fields, and `Mission:` left as the placeholder spawn writes: an unfinished report.
cat >"$WORK/skeleton-mission.md" <<'REPORT'
# Report — w1

Mission: <fill in: who is better off and what shows it, in one line>

Review tier: Low

Test change: none: no test file changed

## Evidence

Command: `bash scripts/ci-offline.sh`

Output (last 20 lines):

```
== ci-offline: 1 suite(s), 0 failed
```

Commit: `e8d8358`
REPORT

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
export PATH="$WORK/stub-down:$PATH"

# ------------------------------------------------ 1. a record with no report --
new_case 'a record with no report'
write_record
rm -f "$REPORT"
run "$DELEGATE" status w1
if [ "$RC" -eq 0 ]; then pass 'it exits 0'; else fail "it exited $RC" "$OUT"; fi
if [ "$OUT" = working ]; then pass 'it says working'; else fail "it said '$OUT', not 'working'"; fi

# ------------------------------------- 2. the backticked report that fooled the boss --
new_case 'a report whose fields are wrapped in backticks'
write_record
cp "$WORK/backticked.md" "$REPORT"
if grep -qE '^Commit: [0-9a-f]{7}' "$REPORT"; then
	fail 'the trap is not on disk: the old grep finds a commit line'
else
	pass 'the trap: grep -qE "^Commit: [0-9a-f]{7}" finds nothing (this is what fooled the boss)'
fi
if grep -q '^Commit: `e8d8358`$' "$REPORT"; then
	pass 'the report does say the commit, inside a backtick span'
else
	fail 'the fixture lost its backticked Commit line'
fi
run "$DELEGATE" status w1
if [ "$RC" -eq 0 ]; then pass 'it exits 0'; else fail "it exited $RC" "$OUT"; fi
if [ "$OUT" = reported ]; then pass 'it says reported, from the report and not from its prose'; else fail "it said '$OUT', not 'reported'"; fi

# --------------------------------------------- 3. a report missing its Mission --
new_case 'a report whose Mission: is still the placeholder'
write_record
cp "$WORK/skeleton-mission.md" "$REPORT"
run "$DELEGATE" status w1
if [ "$OUT" = working ]; then pass 'it says working, not reported'; else fail "it said '$OUT', not 'working'"; fi
run "$DELEGATE" list
case $OUT in
*w1*working*) pass 'delegate list calls it working too' ;;
*) fail 'delegate list does not call it working' "$OUT" ;;
esac

# ------------------------------------------------------ 4. a closed worker --
new_case 'a closed worker'
write_record
cp "$WORK/backticked.md" "$REPORT"
printf '{}\n' >"$SD/delegations.json"
run "$DELEGATE" status w1
if [ "$RC" -eq 0 ]; then pass 'it exits 0'; else fail "it exited $RC" "$OUT"; fi
if [ "$OUT" = closed ]; then pass 'it says closed, from the report the close kept'; else fail "it said '$OUT', not 'closed'"; fi
run "$DELEGATE" list
case $OUT in
*w1*) fail 'delegate list still shows a closed worker' "$OUT" ;;
*) pass 'delegate list has no row for it, which is what closed means' ;;
esac

# ------------------------------------------------------ 5. a slug nothing names --
new_case 'a slug nothing names'
run "$DELEGATE" status no-such-worker
if [ "$RC" -eq 1 ]; then pass 'it exits 1'; else fail "it exited $RC"; fi
if [ "$OUT" = unknown ]; then pass 'it says unknown'; else fail "it said '$OUT', not 'unknown'"; fi

# ------------------------------------------------- 6. status and list agree --
new_case 'status and list agree'
agree=0
disagree=""
check_agree() { # <fixture-name> <expected-word>
	local want=$1 word row
	run "$DELEGATE" status w1
	word=$OUT
	run "$DELEGATE" list
	row=$(printf '%s\n' "$OUT" | awk '$1=="w1"{print $5}')
	if [ "$word" = "$want" ] && [ "$row" = "$word" ]; then
		agree=$((agree + 1))
	else
		disagree="$disagree$want: status='$word' list='$row'"$'\n'
	fi
}
# working (no report)
write_record
rm -f "$REPORT"
check_agree working
# reported
cp "$WORK/backticked.md" "$REPORT"
check_agree reported
# working again (placeholder Mission)
cp "$WORK/skeleton-mission.md" "$REPORT"
check_agree working
if [ "$agree" -eq 3 ]; then
	pass 'the same word for working, reported and working-again fixtures'
else
	fail "$agree of 3 agreed with delegate list" "$disagree"
fi

# ------------------------------------------- still the same word from herdr's side --
new_case 'a terminal herdr no longer lists'
write_record
rm -f "$REPORT"
PATH="$WORK/stub-seen:$PATH" run "$DELEGATE" status w1
if [ "$OUT" = gone ]; then
	pass 'it says gone, the word delegate list already uses for a terminal that died before the report'
else
	fail "it said '$OUT', not 'gone'" "$OUT"
fi
PATH="$WORK/stub-seen:$PATH" run "$DELEGATE" list
case $OUT in
*w1*gone*) pass 'delegate list says gone too' ;;
*) fail 'delegate list disagrees about a gone worker' "$OUT" ;;
esac

# ---------------------------------------------------------------- 7. --json --
new_case '--json'
write_record
cp "$WORK/backticked.md" "$REPORT"
run "$DELEGATE" status w1 --json
if [ "$RC" -eq 0 ]; then pass 'it exits 0'; else fail "it exited $RC" "$OUT"; fi
if printf '%s' "$OUT" | grep -qF "\"status\":\"reported\""; then pass 'it carries the word'; else fail 'it does not carry the word' "$OUT"; fi
if printf '%s' "$OUT" | grep -qF "\"slug\":\"w1\""; then pass 'it carries the slug'; else fail 'it does not carry the slug' "$OUT"; fi
if printf '%s' "$OUT" | grep -qF "\"report\":\"$REPORT\""; then pass 'it carries the report path'; else fail 'it does not carry the report path' "$OUT"; fi
run "$DELEGATE" status no-such-worker --json
if [ "$RC" -eq 1 ]; then pass 'it exits 1 for an unknown slug'; else fail "it exited $RC"; fi
if printf '%s' "$OUT" | grep -qF '"status":"unknown"'; then pass 'it says unknown'; else fail "it did not say unknown" "$OUT"; fi
if printf '%s' "$OUT" | grep -qF '"report":""'; then pass 'the report path is empty for a slug with no report'; else fail 'it names a report that does not exist' "$OUT"; fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
