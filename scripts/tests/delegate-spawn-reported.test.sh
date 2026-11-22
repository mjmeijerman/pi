#!/usr/bin/env bash
# Tests that `delegate spawn` refuses while a worker in the space has reported and nobody published
# it — the mechanical half of "the boss cannot forget an unfinished worker".
#
# Why these exist. Twice in one session the boss read `delegate status` as `reported`, stopped, and
# left a branch unpublished until a person noticed. The rule was in AGENTS.md and in context and was
# skipped anyway. The other half is `agent/extensions/open-work.ts`, which puts the sentence in the
# prompt; this is the refusal that makes the same sentence unavoidable at the next spawn.
#
# No network, no herdr, no pi: the stubs are the shape scripts/tests/test-delegations-lock.sh builds.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE=${PI_REPORTED_DELEGATE:-$ROOT/bin/delegate}
SPACE=${PI_REPORTED_SPACE:-$ROOT/bin/space}
for tool in "$DELEGATE" "$SPACE"; do
	[ -x "$tool" ] || {
		printf 'FATAL: %s is not executable\n' "$tool" >&2
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
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/state"
export DELEGATE_POLL_SECONDS=0
export PATH="$WORK/stub:$PI_SPACE_ROOT/bin:/usr/local/bin:/usr/bin:/bin"

cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"do space.new") printf '{"space":"sp1","tab":"tb1","pane":"p1","terminal":"t1"}\n' ;;
"do tab.new") printf '{"space":"sp1","tab":"tb2","pane":"p2","terminal":"t2"}\n' ;;
"do tab.close") printf '{}\n' ;;
"ls "*) printf '{"spaces":[]}\n' ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
ls) printf '{"terminals":[{"id":"t-boss","state":"idle"}]}\n' ;;
read) printf 'escape interrupt\n' ;;
send) exit 0 ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
printf '[]\n'
STUB
cat >"$PI_SPACE_ROOT/bin/jev" <<'STUB'
#!/usr/bin/env bash
case "$1" in
plan) printf '{"mode":"bare","route":"remote","thinking":"medium","reason":"stub jev","answered":{"mode":"bare","route":"remote","thinking":"medium"}}\n' ;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-bare"
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

PRJ="$WORK/proj"
mkdir -p "$PRJ"
printf 'x\n' >"$PRJ/a.txt"
"$SPACE" new --name reports --project "$PRJ" >/dev/null 2>&1
SD="$PI_SPACE_ROOT/state/spaces/reports"
REC="$SD/delegations.json"
REPORT="$SD/reports/w1.md"
mkdir -p "$SD/reports" "$SD/state"

# A worker that wrote its report and nothing else happened: the word `delegate list` already prints
# for it is `reported` (report_written, no toldAt, so nothing newer than the file).
write_record() {
	printf '{"w1":{"slug":"w1","kind":"tab","space":"sp1","spaceName":"reports","tab":"tb1","pane":"p1","terminal":"t1","cwd":"%s","mode":"bare","thinking":"low","spec":"%s/specs/w1.md","report":"%s","branch":"trunk"}}\n' \
		"$PRJ" "$SD" "$REPORT" >"$REC"
}

new_case 'spawn refuses while a report is written and unpublished'
write_record
printf '# Report — w1\n\nMission: a finished worker nobody published\n\n## Evidence\n\nCommand: `true`\n\nOutput (last 20 lines):\n\n```\nnothing\n```\n' >"$REPORT"
run "$DELEGATE" status w1
if [ "$OUT" = reported ]; then pass 'status says reported' ; else fail "status said $OUT, so this is not the state the refusal guards" ; fi
run "$DELEGATE" spawn w2 --cwd "$PRJ" "write one line in b.txt"
if [ "$RC" -ne 0 ]; then pass "the spawn exits $RC, not 0"; else fail 'a spawn beside an unpublished report was allowed'; fi
EXPECT="worker w1: reported, report at $REPORT — next: bin/delegate finish w1"
case $OUT in
*"$EXPECT"*) pass 'it prints the same sentence the prompt line carries' ;;
*) fail 'the prompt sentence is not in the refusal' "$OUT" ;;
esac
case $OUT in
*"$ROOT/bin/delegate finish w1"* | *"/delegate finish w1"*)
	pass 'it names the command that clears it'
	;;
*) fail 'the clearing command is not named' "$OUT" ;;
esac
SLUGS=$(node -e 'try{process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).sort().join(","))}catch{process.stdout.write("unparseable")}' "$REC")
if [ "$SLUGS" = w1 ]; then
	pass 'no worker was recorded for the refused spawn'
else
	fail "the record changed: $SLUGS" "$(cat "$REC")"
fi

new_case 'the same spawn is allowed once the report is published and the worker closed'
# `delegate finish` deletes the delegation entry in its last step (cmd_close), and the report and the
# spec stay behind. Deleting the entry is that step; the report file is untouched on purpose, so the
# case proves the gate reads the record and not the leftover file.
printf '{}\n' >"$REC"
run "$DELEGATE" spawn w2 --cwd "$PRJ" "write one line in b.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn exits 0'; else fail 'the spawn still failed' "$OUT"; fi
case $OUT in
*"reported, report at"*) fail 'the refusal survived the published report' "$OUT" ;;
*) pass 'no reported-worker refusal' ;;
esac

printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
