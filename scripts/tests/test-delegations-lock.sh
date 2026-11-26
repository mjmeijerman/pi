#!/usr/bin/env bash
# Tests for bin/records-lib.sh and the one lock it puts around delegations.json.
#
# Why these exist: state/spaces/<slug>/delegations.json is written by `delegate spawn`,
# `delegate close` and the tab bookkeeping, and each did read → modify → writeFileSync with no
# lock. Two writers running together dropped each other's entry — a live worker lost its record 16
# minutes after spawn and `delegate finish` refused it — and a reader could see a half-written file,
# which reads as "no records at all". So the loss is reproduced here first, with no lock, and only
# then shown fixed: a test that asserts a lock it never saw fail proves nothing.
#
# Radar basis: #29 harness quality evaluation — the measurement is case 1's count of survivors and
# case 2's count of partial reads, taken before the assertion, not asserted from memory.
#
# Cases:
#   1. the loss, with no lock: eight writers, fewer than eight entries survive (count quoted);
#   2. the fix: the same eight through records_lock/records_write, all eight present, and a reader
#      loop alongside never once sees a file that does not parse (failures counted, expect 0);
#   3. a stale lock: a 40 s old lock directory is broken by records_lock, with one warning line,
#      and the write then succeeds;
#   4. the same eight again with flock hidden from PATH, so the mkdir path is what runs;
#   5. two real `bin/delegate` invocations, started together against a stub space: the spawn's new
#      entry and the close's deletion both land, so neither erases the other.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/bin/records-lib.sh"
DELEGATE="$ROOT/bin/delegate"
SPACE="$ROOT/bin/space"
for f in "$LIB" "$DELEGATE" "$SPACE"; do
	[ -f "$f" ] || {
		printf 'FATAL: %s does not exist\n' "$f" >&2
		exit 1
	}
done
# shellcheck source=../../bin/records-lib.sh disable=SC1090
. "$LIB"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

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

# entries <file> — how many entries the record holds, or "unparseable".
entries() {
	node -e 'try{process.stdout.write(String(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).length))}catch{process.stdout.write("unparseable")}' "${1:?}"
}

# A record with one entry, so "fewer than eight survive" has something to lose and a lock that
# drops the seed entry is visible.
seed_record() { printf '{"seed":{"slug":"seed"}}\n' >"$1"; }

# The writers are separate scripts, not shell functions: eight copies of one function sharing a
# shell would not be eight processes, and the whole point is eight processes racing.
#
# The window each one holds open is the same in both: read, 50 ms of "work", write back.
WRITER_BODY='
const fs = require("fs");
const { execSync } = require("child_process");
let j = {};
try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
execSync("sleep 0.05");
j[process.argv[2]] = { slug: process.argv[2] };
fs.writeFileSync(process.argv[1], JSON.stringify(j, null, 2) + "\n");
'
cat >"$WORK/writer-plain.sh" <<STUB
#!/usr/bin/env bash
# the shape the harness had before the lock: read, modify, writeFileSync
node -e '$WRITER_BODY' "\$1" "\$2"
STUB
cat >"$WORK/writer-locked.sh" <<STUB
#!/usr/bin/env bash
# the same writer through the library: one lock around the read-modify-write
. "$LIB"
records_mutate "\$1" '
const fs = require("fs");
const { execSync } = require("child_process");
let j = {};
try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
execSync("sleep 0.05");
j[process.argv[2]] = { slug: process.argv[2] };
process.stdout.write(JSON.stringify(j, null, 2) + "\n");
' "\$2"
STUB
chmod +x "$WORK/writer-plain.sh" "$WORK/writer-locked.sh"

eight_writers() {
	local writer=$1 file=$2 i
	for i in 1 2 3 4 5 6 7 8; do
		"$writer" "$file" "w$i" &
	done
	wait
}

# --- 1. the loss, reproduced with no lock ------------------------------------------------------
new_case 'the loss, with no lock'
FILE="$WORK/nolock.json"
seed_record "$FILE"
eight_writers "$WORK/writer-plain.sh" "$FILE"
COUNT=$(entries "$FILE")
printf '     entries that survived: %s of 8\n' "$COUNT"
if [ "$COUNT" = unparseable ]; then
	fail 'the unchecked writers left a file that does not parse'
elif [ "$COUNT" -lt 8 ]; then
	pass "the loss is real: only $COUNT of 8 entries survived"
else
	fail 'the control kept all 8 entries, so this case proves nothing' "$(cat "$FILE")"
fi

# --- 2. the fix, with a reader alongside -------------------------------------------------------
new_case 'the fix: eight locked writers, a reader that never sees a partial file'
FILE="$WORK/locked.json"
seed_record "$FILE"
READS_LOG="$WORK/reads.log"
: >"$READS_LOG"
(
	# Bounded and throttled: the point is ".never a partial file", not volume, and an unbounded
	# loop would write a log big enough to hide the rest of this suite's output.
	for _ in $(seq 1 400); do
		[ -e "$WORK/stop-reader" ] && break
		if node -e 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}' "$FILE"; then
			printf 'ok\n' >>"$READS_LOG"
		else
			printf 'bad\n' >>"$READS_LOG"
		fi
		sleep 0.01
	done
) &
READER=$!
eight_writers "$WORK/writer-locked.sh" "$FILE"
: >"$WORK/stop-reader"
wait "$READER" 2>/dev/null
READS=$(wc -l <"$READS_LOG" | tr -d ' ')
READ_FAILS=$(grep -c '^bad$' "$READS_LOG" 2>/dev/null || true)
READ_FAILS=${READ_FAILS:-0}
COUNT=$(entries "$FILE")
if [ "$COUNT" = 9 ]; then
	pass 'all eight entries survive beside the seed: 9 of 9'
else
	fail "expected 9 entries, found $COUNT" "$(cat "$FILE")"
fi
printf '     reads: %s, failures: %s\n' "${READS:-0}" "$READ_FAILS"
if [ "$READ_FAILS" -eq 0 ] && [ "${READS:-0}" -gt 0 ]; then
	pass "no reader saw a partial file in $READS reads"
else
	fail "a reader saw $READ_FAILS partial reads in ${READS:-0}" "$(sed -n '1,5p' "$READS_LOG")"
fi
# Nothing is still held: taking the lock again is immediate rather than the 30 s refusal.
START=$(date +%s)
if records_lock "$FILE" && records_unlock "$FILE" && [ "$(($(date +%s) - START))" -lt 5 ]; then
	pass 'nothing was left locked'
else
	fail 'the lock was still held after the writers finished'
fi

# Hiding flock is a PATH shim, not an uninstall: one directory of symlinks to everything on PATH
# except flock. That is what macOS and git-bash look like to the library, and the two cases below
# are the mkdir path — a stale lock, and eight writers — with no flock to fall back on.
SHIM="$WORK/nofock"
mkdir -p "$SHIM"
while IFS= read -r d; do
	[ -d "$d" ] || continue
	for p in "$d"/*; do
		b=${p##*/}
		[ "$b" = flock ] && continue
		[ -e "$SHIM/$b" ] || ln -sfn "$p" "$SHIM/$b"
	done
done <<<"$(printf '%s' "$PATH" | tr ':' '\n')"
if PATH="$SHIM" bash -c 'command -v flock' >/dev/null 2>&1; then
	fail 'flock is still on the shim PATH, so the mkdir path was not exercised'
fi

# --- 3. a stale lock is broken ----------------------------------------------------------------
new_case 'a stale lock directory is broken, once, with a warning'
FILE="$WORK/stale.json"
seed_record "$FILE"
mkdir "$FILE.lock.d"
node -e 'const fs=require("fs");const t=new Date(Date.now()-40000);fs.utimesSync(process.argv[1],t,t)' "$FILE.lock.d"
BEFORE=$(entries "$FILE")
OUT=$(PATH="$SHIM" "$WORK/writer-locked.sh" "$FILE" w-stale 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the writer got through'; else fail 'the writer was refused by the stale lock' "$OUT"; fi
case $OUT in
*"breaking the stale lock $FILE.lock.d (4"*"old) on $FILE"*)
	pass 'one warning names the lock directory, its age and the file'
	;;
*) fail 'the warning does not name the lock, the age and the file' "$OUT" ;;
esac
if [ "$(printf '%s\n' "$OUT" | grep -c 'breaking the stale lock')" = 1 ]; then
	pass 'exactly one warning line'
else
	fail 'the warning was printed more than once' "$OUT"
fi
if [ -e "$FILE.lock.d" ]; then fail 'the stale lock directory was left behind'; else pass 'the lock directory is gone'; fi
AFTER=$(entries "$FILE")
if [ "$AFTER" = "$((BEFORE + 1))" ]; then pass 'the write landed after the break'; else fail "expected $((BEFORE + 1)) entries, found $AFTER" "$(cat "$FILE")"; fi

# --- 4. the same eight with flock hidden from PATH: the mkdir path ---------------------------
new_case 'the mkdir path: flock hidden from PATH'
FILE="$WORK/mkdir.json"
seed_record "$FILE"
# The writers' own exit status is kept, and their stderr with it. The only silent way this case
# loses a write is a writer that died — measured on CI 2026-11-26 (harness-check job 140154780368):
# eight writers, seven entries, and not one other line red to say why. A loss has to name which
# writer failed and what it said, instead of counting to seven and stopping there.
WPIDS=()
for i in 1 2 3 4 5 6 7 8; do
	PATH="$SHIM" "$WORK/writer-locked.sh" "$FILE" "w$i" 2>"$WORK/mkdir.w$i.err" &
	WPIDS+=("$!")
done
WRITER_RCS=""
WRITER_BAD=0
for p in "${WPIDS[@]}"; do
	if wait "$p"; then WRITER_RCS="$WRITER_RCS 0"; else WRITER_RCS="$WRITER_RCS $?"; WRITER_BAD=$((WRITER_BAD + 1)); fi
done
COUNT=$(entries "$FILE")
if [ "$COUNT" = 9 ]; then
	pass 'the mkdir path keeps all eight writes: 9 of 9'
else
	MISSING=$(node -e '
		let j = {};
		try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
		const gone = [];
		for (let i = 1; i <= 8; i++) if (!j["w" + i]) gone.push("w" + i);
		process.stdout.write(gone.join(" ") || "none of the eight is missing");' "$FILE")
	fail "expected 9 entries through the mkdir path, found $COUNT" \
		"missing entries: $MISSING" \
		"writer exit codes:$WRITER_RCS" \
		"$(cat "$WORK"/mkdir.w*.err 2>/dev/null)"
fi
if [ "$WRITER_BAD" -eq 0 ]; then
	pass 'all eight writers exited 0, so no write was dropped on the way in'
else
	fail "$WRITER_BAD of 8 writers exited non-zero, so the count above may be theirs to explain" \
		"$(cat "$WORK"/mkdir.w*.err 2>/dev/null)"
fi
if [ -e "$FILE.lock.d" ]; then fail 'the mkdir lock was left behind'; else pass 'the mkdir lock was removed'; fi

# --- 5. two real delegate invocations against one stub space ---------------------------------
# The stubs are the shape scripts/tests/test-space-delegate.sh already builds: herdr-app hands out
# tab ids and lists nothing, hc says the banner is on screen, jev answers one plan. No herdr, no pi,
# no network — and the record is the real one bin/delegate writes.
new_case 'a real spawn and a real close, started together, both land'
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/state"
export HERDR_LOG="$WORK/herdr.log"
export DELEGATE_POLL_SECONDS=0
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
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

PRJ="$WORK/proj"
mkdir -p "$PRJ"
printf 'x\n' >"$PRJ/a.txt"
"$SPACE" new --name sp --project "$PRJ" >/dev/null 2>&1
REC="$PI_SPACE_ROOT/state/spaces/sp/delegations.json"
printf '{"old":{"slug":"old","kind":"tab","tab":"tb-old","pane":"p-old","terminal":"t-old","cwd":"%s","mode":"bare"}}\n' "$PRJ" >"$REC"

# `close` refuses a worker with no wipe step recorded, and the step is one line in
# state/decisions.jsonl. Written here as that line rather than through `delegate wipe`, which
# resolves the worker from the legacy record and not from a space: this case is about the lock on
# the delegation record, not about the wipe gate.
mkdir -p "$PI_SPACE_ROOT/state/spaces/sp/state"
printf '{"command":"wipe","task":"old","decision":"skipped","reason":"the fixture worker threw nothing away","overridden":false,"slug":"old"}\n' \
	>>"$PI_SPACE_ROOT/state/spaces/sp/state/decisions.jsonl"

"$DELEGATE" spawn new --cwd "$PRJ" "write one line in a.txt" >"$WORK/spawn.log" 2>&1 &
SPAWN_PID=$!
"$DELEGATE" close old >"$WORK/close.log" 2>&1 &
CLOSE_PID=$!
wait "$SPAWN_PID"
SPAWN_RC=$?
wait "$CLOSE_PID"
CLOSE_RC=$?
if [ "$SPAWN_RC" -eq 0 ]; then pass 'the spawn exits 0'; else fail 'the spawn failed' "$(cat "$WORK/spawn.log")"; fi
if [ "$CLOSE_RC" -eq 0 ]; then pass "the close exits 0"; else fail 'the close failed' "$(cat "$WORK/close.log")"; fi
SLUGS=$(node -e 'try{process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).sort().join(","))}catch{process.stdout.write("unparseable")}' "$REC")
if [ "$SLUGS" = new ]; then
	pass 'the record holds the spawned worker and the closed one is gone'
else
	fail "expected the record to hold 'new' only, found: $SLUGS" "$(cat "$REC")"
fi

printf '\n%s\n' "$([ "$FAIL_N" -eq 0 ] && echo "test-delegations-lock: $PASS_N passed, 0 failed" || echo "test-delegations-lock: $PASS_N passed, $FAIL_N failed")"
[ "$FAIL_N" -eq 0 ]
