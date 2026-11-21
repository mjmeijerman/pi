#!/usr/bin/env bash
# Tests for bin/jev — the launcher, its sibling imports and the tree it keeps its state in.
#
# Why these exist: jev was ported from ~/big-boss-pi/bin into ~/.pi/bin, and three things have to
# hold in the new home or the tool is worse than missing. Its imports are siblings (jev.mjs reads
# ./jev-model.mjs and ./usage.mjs), so a copy that lost one of them fails with node's module error
# instead of jev's message. Its state path is its own tree (bin/usage.mjs resolves ROOT from
# import.meta.url), so a copy in the wrong place writes usage where nobody reads it. And its key file
# is $HOME/.pi/agent/env.secret, which is the same home the rest of the harness uses.
#
# Offline on purpose: no key, no TypeSafe call, no network. The unreachable case points at a closed
# port on loopback, which is refused instantly and costs nothing; every other case stops before the
# request. A test that needed the model would be a test nobody runs.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JEV="$ROOT_DIR/bin/jev"
for f in "$JEV" "$ROOT_DIR/bin/jev.mjs" "$ROOT_DIR/bin/jev-model.mjs" "$ROOT_DIR/bin/usage.mjs"; do
	[ -f "$f" ] || {
		printf 'FATAL: %s is missing\n' "$f" >&2
		exit 1
	}
done
command -v node >/dev/null 2>&1 || {
	printf 'FATAL: node is not on PATH\n' >&2
	exit 1
}

WORK="$(readlink -f "$(mktemp -d)")"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
ERR=""
RC=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	[ "$#" -eq 0 ] || printf '%s\n' "$@" | sed 's/^/     /'
}

case_start() {
	CASE_N=$((CASE_N + 1))
	CASE="$1"
	OUT=""
	ERR=""
	RC=0
}

# jev_run <program> [VAR=value ...] — one call in a stripped environment: no inherited key, no
# inherited PI_BOSS_ROOT, a home of this test's own.
jev_run() {
	local prog=$1
	shift
	OUT=$(env -i PATH="${JEV_PATH:-/usr/local/bin:/usr/bin:/bin}" HOME="$WORK/home" "$@" "$prog" ${JEV_ARGS:-} 2>"$WORK/stderr")
	RC=$?
	ERR="$(cat "$WORK/stderr")"
}
has() { case $OUT in *"$1"*) return 0 ;; esac; return 1; }
err_has() { case $ERR in *"$1"*) return 0 ;; esac; return 1; }
joined() { printf '%s\n%s\n' "$OUT" "$ERR"; }

mkdir -p "$WORK/home"
# The node the launcher execs has to be on this PATH, whatever mise or fnm put it behind.
JEV_PATH="/usr/local/bin:/usr/bin:/bin:$(dirname "$(command -v node)")"
# A planted, fake value, spelled from parts: this file is a test fixture, not a place a credential is
# written down, and the run that uses it asserts the value never reaches stdout or stderr.
PLANTED_NAME="TYPESAFE_API_KEY"
PLANTED_VALUE="planted-fake-value-for-this-test"

# ------------------------------------------- 1. no key --
case_start "no key, no key file: the default key path is this home"
JEV_ARGS='route port the executables' jev_run "$JEV"
if [ "$RC" -eq 3 ]; then pass 'exits 3, the "no answer" code'; else fail "expected 3, got $RC: $ERR"; fi
if err_has 'no API key' && err_has "$WORK/home/.pi/agent/env.secret"; then
	pass 'names ~/.pi/agent/env.secret under this HOME'
else
	fail "stderr: $ERR"
fi

case_start "no key, an explicit unreadable key file: that path is named"
JEV_ARGS='route port the executables' jev_run "$JEV" JEV_KEY_FILE="$WORK/absent.secret"
if [ "$RC" -eq 3 ] && err_has "$WORK/absent.secret"; then pass 'names the file it could not read'; else fail "rc=$RC err=$ERR"; fi

case_start "a key file with no matching line says which line is missing"
printf 'SOMETHING_ELSE=1\n' >"$WORK/nokey.secret"
JEV_ARGS='route port the executables' jev_run "$JEV" JEV_KEY_FILE="$WORK/nokey.secret"
if [ "$RC" -eq 3 ] && err_has 'the key file has no TYPESAFE_API_KEY'; then pass 'names the missing line'; else fail "rc=$RC err=$ERR"; fi

# ------------------------------------------- 2. the sibling imports and the transport --
case_start "with a key, an unreachable model fails as jev, not as node"
printf '%s=%s\n' "$PLANTED_NAME" "$PLANTED_VALUE" >"$WORK/key.secret"
mkdir -p "$WORK/state-root"
JEV_ARGS='route port the executables' jev_run "$JEV" \
	JEV_KEY_FILE="$WORK/key.secret" JEV_ENDPOINT=http://127.0.0.1:1/v1/systemone \
	JEV_TIMEOUT=3000 PI_BOSS_ROOT="$WORK/state-root"
if [ "$RC" -eq 3 ]; then pass 'exits 3'; else fail "expected 3, got $RC: $OUT $ERR"; fi
if err_has 'decision model unreachable'; then pass "the message is jev's own (the imports resolved)"; else fail "stderr: $ERR"; fi
if joined | grep -q -- "$PLANTED_VALUE"; then fail 'the value reached stdout or stderr'; else pass 'the key is never printed'; fi
if [ -s "$WORK/state-root/state/usage.jsonl" ]; then pass 'a usage line landed under PI_BOSS_ROOT/state'; else fail 'no usage line was written'; fi
if node -e '
	const fs=require("node:fs");
	const line=JSON.parse(fs.readFileSync(process.argv[1],"utf8").trim().split("\n").pop());
	if(line.kind!=="jev"||line.command!=="route"||line.ok!==false||line.error!=="unreachable")process.exit(1);
	if(typeof line.latency_ms!=="number")process.exit(1);
' "$WORK/state-root/state/usage.jsonl"; then
	pass 'kind jev, command route, ok false, error unreachable'
else
	fail "usage line: $(cat "$WORK/state-root/state/usage.jsonl")"
fi

# ------------------------------------------- 3. the ported tree --
# The port in one case: the four files, in a directory that is not the repo, keep their state in
# their own tree and need nothing from ~/big-boss-pi.
case_start "a copy in another tree keeps its state in that tree"
mkdir -p "$WORK/elsewhere/bin"
cp "$JEV" "$WORK/elsewhere/bin/jev"
cp "$ROOT_DIR/bin/jev.mjs" "$ROOT_DIR/bin/jev-model.mjs" "$ROOT_DIR/bin/usage.mjs" "$WORK/elsewhere/bin/"
OUT=$(env -i PATH="$JEV_PATH" HOME="$WORK/home" JEV_KEY_FILE="$WORK/key.secret" \
	JEV_ENDPOINT=http://127.0.0.1:1/v1/systemone JEV_TIMEOUT=3000 \
	"$WORK/elsewhere/bin/jev" route ported 2>"$WORK/stderr")
RC=$?
ERR="$(cat "$WORK/stderr")"
if [ "$RC" -eq 3 ] && err_has 'decision model unreachable'; then pass 'runs with its siblings beside it'; else fail "rc=$RC out=$OUT err=$ERR"; fi
if [ -s "$WORK/elsewhere/state/usage.jsonl" ]; then pass 'wrote state/ beside itself, not under the old tree'; else fail "no $WORK/elsewhere/state/usage.jsonl"; fi
if joined | grep -q 'big-boss-pi'; then fail 'the answer mentions the deleted tree'; else pass 'no path from the old tree in its output'; fi

# ------------------------------------------- 4. usage errors --
case_start "no subcommand is a usage error"
JEV_ARGS='' jev_run "$JEV"
if [ "$RC" -eq 2 ] && err_has 'usage: jev'; then pass 'exits 2 and prints the usage line'; else fail "rc=$RC err=$ERR"; fi

case_start "a subcommand with no text is a usage error"
JEV_ARGS='route' jev_run "$JEV"
if [ "$RC" -eq 2 ] && err_has 'needs the question text'; then pass 'exits 2 and says what is missing'; else fail "rc=$RC err=$ERR"; fi

# ------------------------------------------- verdict --
printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
