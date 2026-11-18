#!/usr/bin/env bash
# One file owns the node major: mise.toml.
#
# Why this runs instead of grepping: the claim under test is "the number
# setup.sh prints comes from mise.toml", and a grep for the string "24" can be
# satisfied by a comment while the `die` still prints a hardcoded 24. So every
# case here copies a throwaway tree, edits mise.toml, and runs the real
# preflight block of setup.sh with a fake `node` on PATH — then reads the number
# out of the message that was actually printed. The preflight is lines 1..the
# `fi` that closes the node check: everything before the first prompt, nothing
# that touches the host.
#
# The literal fallback is a case of its own: a tree with no mise.toml must print
# byte-for-byte what it printed before the pin existed, because a clone that
# predates (or rejected) the file must not change its advice.
#
# Cheap on purpose: no network, no model, no mise, temp dirs under one
# mktemp -d. Run it by hand, or through `make scripts-test`, which globs
# scripts/tests/*.test.sh.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$ROOT_DIR/setup.sh"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
ERR=""
STATUS=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

# ------------------------------------------------ where the preflight ends ----

END_LINE=$(awk '/^have node \|\| die/ {seen = 1; next} seen && /^fi$/ {print NR; exit}' "$SETUP")
if [ -z "${END_LINE:-}" ]; then
	printf 'FAIL: no node preflight block (`have node || die` ... `fi`) in %s\n' "$SETUP" >&2
	exit 1
fi

# ---------------------------------------------------------------- fixtures ----

# tree <name>: a throwaway repo root the preflight accepts.
tree() {
	local dir="$WORK/$1"
	mkdir -p "$dir/agent" "$dir/bin" "$dir/only"
	: >"$dir/install.sh"
	# The preflight only: everything setup.sh does before it prompts. Written by
	# line range so the message text is the real one, never a copy.
	sed -n "1,${END_LINE}p" "$SETUP" >"$dir/preflight.sh"
	printf '\nexit 0\n' >>"$dir/preflight.sh"
	for c in sed head uname git dirname tr; do
		ln -sf "$(command -v "$c")" "$dir/only/$c"
	done
	printf '%s\n' "$dir"
}

# node_ok <tree> <major>: a `node` that reports the given major, as setup.sh asks
# for it (`node -v` and `node -p process.versions.node`).
node_ok() {
	local dir=$1 major=$2
	cat >"$dir/bin/node" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
-v|--version) echo "v$major.1.0" ;;
-p) echo "$major" ;;
*) exit 1 ;;
esac
EOF
	chmod +x "$dir/bin/node"
}

# run_preflight <tree> <with-node|without-node>: run the real block, print
# nothing, leave $STATUS, $OUT, $ERR.
run_preflight() {
	local dir=$1 mode=$2 path
	if [ "$mode" = with-node ]; then path="$dir/bin:/usr/bin:/bin"; else path="$dir/only"; fi
	ERR="$WORK/stderr"
	env PATH="$path" /bin/bash "$dir/preflight.sh" >"$WORK/stdout" 2>"$ERR"
	STATUS=$?
	OUT=$(cat "$WORK/stdout" "$ERR")
}

expect_in() {
	local needle=$1 what=$2
	case "$OUT" in
	*"$needle"*) pass "$what" ;;
	*) fail "$what" "expected: $needle" "printed : $(printf '%s' "$OUT" | tr '\n' '|')" ;;
	esac
}

expect_status() {
	local want=$1
	if [ "$STATUS" = "$want" ]; then
		pass "exit $want"
	else
		fail "exit $want" "got: $STATUS" "printed: $(printf '%s' "$OUT" | tr '\n' '|')"
	fi
}

write_pin() { printf '%s\n' "$2" >"$1/mise.toml"; }

# ------------------------------------------------------------ the pin, live ----

CASE_N=$((CASE_N + 1))
CASE="pin 24, node 22"
T=$(tree "pin24")
write_pin "$T" '[tools]
node = "24"
npm = "11"'
node_ok "$T" 22
run_preflight "$T" with-node
expect_in "node v22.1.0 is older than 24" "warn names the pinned major"
expect_status 0

CASE_N=$((CASE_N + 1))
CASE="pin 26, node 22"
T=$(tree "pin26")
write_pin "$T" '[tools]
node = "26"'
node_ok "$T" 22
run_preflight "$T" with-node
expect_in "node v22.1.0 is older than 26" "warn follows mise.toml, not the old literal"
case "$OUT" in
*"older than 24"*) fail "warn still says 24" "printed: $(printf '%s' "$OUT" | tr '\n' '|')" ;;
*) pass "no stale 24 in the warn" ;;
esac

CASE_N=$((CASE_N + 1))
CASE="pin 26, no node"
T=$(tree "pin26-nonode")
write_pin "$T" '[tools]
node = "26"'
run_preflight "$T" without-node
expect_in "node is not installed (pi needs Node 26 or newer)" "die follows mise.toml"
expect_status 1

CASE_N=$((CASE_N + 1))
CASE="pin 24, node 26"
T=$(tree "pin24-new")
write_pin "$T" '[tools]
node = "24"'
node_ok "$T" 26
run_preflight "$T" with-node
expect_status 0
case "$OUT" in
*"older than"*) fail "no warn when node is new enough" "printed: $(printf '%s' "$OUT" | tr '\n' '|')" ;;
*) pass "silent when node is new enough" ;;
esac

CASE_N=$((CASE_N + 1))
CASE="pin 25 only (no npm line)"
T=$(tree "pin25")
write_pin "$T" '[tools]
# no npm entry: a one-tool mise.toml still pins node
node = "25.1.0"'
node_ok "$T" 22
run_preflight "$T" with-node
expect_in "older than 25" "major taken from a point release"

# ------------------------------------------------------------ the fallback ----

CASE_N=$((CASE_N + 1))
CASE="no mise.toml, no node"
T=$(tree "nomise-nonode")
run_preflight "$T" without-node
expect_in "node is not installed (pi needs Node 24 or newer)" "fallback die text unchanged"
expect_status 1

CASE_N=$((CASE_N + 1))
CASE="no mise.toml, node 22"
T=$(tree "nomise-pin")
node_ok "$T" 22
run_preflight "$T" with-node
expect_in "node v22.1.0 is older than 24; pi 1.5.x expects 24 or 26" "fallback warn text unchanged"

CASE_N=$((CASE_N + 1))
CASE="unparseable mise.toml"
T=$(tree "garbage")
write_pin "$T" '[tools]
node = "twenty-four"'
node_ok "$T" 22
run_preflight "$T" with-node
expect_in "older than 24" "non-numeric pin falls back to 24"

CASE_N=$((CASE_N + 1))
CASE="unreadable mise.toml"
T=$(tree "unreadable")
write_pin "$T" '[tools]
node = "26"'
chmod 000 "$T/mise.toml"
if [ "$(id -u)" = 0 ]; then
	pass "skipped: root reads a 000 file, so the case proves nothing"
else
	node_ok "$T" 22
	run_preflight "$T" with-node
	expect_in "older than 24" "unreadable pin falls back to 24"
fi
chmod 644 "$T/mise.toml"

# ------------------------------------------------------------------- verdict --

printf '\n%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
