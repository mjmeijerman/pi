#!/usr/bin/env bash
# Tests for bin/space policy — the one number a space may raise.
#
# Why these exist: "merged before the next" was one hard rule for every space, and a space that
# wants several pull requests open at once (a repo other people work in, a prototyping repo) had
# no way to say so. It says it in its own record now, in `max_open_prs`, and this is the only
# command that reads and writes that field. Absent must read as 1 — every record written before
# the field existed was made under that rule — and a bad value must be refused rather than
# guessed at, because the field is the gate that stops a second worker beside the first.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
[ -x "$SPACE" ] || {
	printf 'FATAL: %s is not executable\n' "$SPACE" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub"
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export PI_BOSS_ROOT="$PI_SPACE_ROOT"
export HERDR_LOG="$WORK/herdr.log"

cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"sp1","tab":"tb1","pane":"p1","terminal":"t1"}\n' ;;
"ls "*) printf '{"spaces":[]}\n' ;;
*) printf '{}\n' ;;
esac
STUB
chmod +x "$WORK/stub/herdr-app"

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

project() { mkdir -p "$1"; printf 'x\n' >"$1/a.txt"; }
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }
# The record minus the field under test: what the write must leave exactly as it was.
rest() {
	node -e '
		const fs = require("fs");
		const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		delete j[process.argv[2]];
		process.stdout.write(JSON.stringify(j, null, 2));' "$1" "${2:-max_open_prs}"
}

P="$WORK/proj"
project "$P"
run "$SPACE" new --name demo --project "$P"
if [ "$RC" -eq 0 ]; then pass 'the fixture space is made'; else fail 'space new failed' "$OUT"; fi
Q="$WORK/other"
project "$Q"
run "$SPACE" new --name other --project "$Q"
if [ "$RC" -eq 0 ]; then pass 'the second fixture space is made'; else fail 'space new failed' "$OUT"; fi

# ------------------------------------------------------- absent reads as 1 --
new_case 'a record with no max_open_prs'
run "$SPACE" policy demo
if [ "$RC" -eq 0 ]; then pass 'policy succeeds'; else fail 'policy failed' "$OUT"; fi
case $OUT in
*"max_open_prs: 1 (default)"*) pass 'an absent field reads 1 (default)' ;;
*) fail 'an absent field does not read 1 (default)' "$OUT" ;;
esac
if grep -q 'max_open_prs' "$(record demo)"; then fail 'reading wrote the field'; else pass 'reading wrote nothing'; fi

new_case 'show prints the effective limit beside the other fields'
run "$SPACE" show demo
case $OUT in
*"max_open_prs: 1 (default)"*) pass 'show says 1 (default)' ;;
*) fail 'show does not print the limit' "$OUT" ;;
esac

new_case 'policy --json says so too'
run "$SPACE" policy demo --json
if printf '%s' "$OUT" | grep -q '"max_open_prs":1' && printf '%s' "$OUT" | grep -q '"default":true'; then
	pass '--json prints the effective value and that it defaulted'
else
	fail '--json does not print the effective value' "$OUT"
fi

# ----------------------------------------------------------- writing one field --
new_case '--max-open-prs 3'
BEFORE=$(rest "$(record demo)")
OTHER_BEFORE=$(cat "$(record other)")
run "$SPACE" policy demo --max-open-prs 3
if [ "$RC" -eq 0 ]; then pass 'the write succeeds'; else fail 'the write failed' "$OUT"; fi
if grep -q '"max_open_prs": 3' "$(record demo)"; then pass 'the field is 3'; else fail 'the field is not 3' "$(cat "$(record demo)")"; fi
if [ "$(rest "$(record demo)")" = "$BEFORE" ]; then pass 'every other field is untouched'; else fail 'another field changed' "$BEFORE" "$(rest "$(record demo)")"; fi
if [ "$(cat "$(record other)")" = "$OTHER_BEFORE" ]; then pass "the other space's record is untouched"; else fail 'a second record was rewritten'; fi
if compgen -G "$PI_SPACE_ROOT/state/spaces/demo/.space.json.tmp.*" >/dev/null; then
	fail 'a temp file was left beside the record'
else
	pass 'the write leaves no temp file behind'
fi
run "$SPACE" policy demo
case $OUT in
*"max_open_prs: 3"*) pass 'reading it back says 3, not (default)' ;;
*) fail 'reading it back does not say 3' "$OUT" ;;
esac
if printf '%s' "$OUT" | grep -q 'default'; then fail 'a set value still reads as default'; else pass 'a set value is not called a default'; fi

new_case 'unbounded round-trips'
run "$SPACE" policy demo --max-open-prs unbounded
if [ "$RC" -eq 0 ]; then pass 'unbounded is accepted'; else fail 'unbounded was refused' "$OUT"; fi
run "$SPACE" policy demo
case $OUT in
*"max_open_prs: unbounded"*) pass 'it reads back as unbounded' ;;
*) fail 'it does not read back as unbounded' "$OUT" ;;
esac
run "$SPACE" policy demo --json
if printf '%s' "$OUT" | grep -q '"max_open_prs":"unbounded"'; then pass '--json carries unbounded as a string'; else fail '--json does not carry unbounded' "$OUT"; fi
if grep -q '"max_open_prs": "unbounded"' "$(record demo)"; then pass 'the record holds the word'; else fail 'the record does not hold unbounded' "$(cat "$(record demo)")"; fi
run "$SPACE" policy demo --max-open-prs 2
if grep -q '"max_open_prs": 2' "$(record demo)"; then pass 'a number can follow unbounded'; else fail 'the number did not replace unbounded'; fi

# ------------------------------------------------------------- bad values --
new_case 'values the field cannot mean'
BEFORE=$(cat "$(record demo)")
for bad in 0 -1 1.5 yes; do
	run "$SPACE" policy demo --max-open-prs "$bad"
	if [ "$RC" -ne 0 ]; then pass "'$bad' is refused"; else fail "'$bad' was written"; fi
	case $OUT in
	*"integer of 1 or more"*"unbounded"*) pass "'$bad' names both accepted forms" ;;
	*) fail "'$bad' does not name the accepted forms" "$OUT" ;;
	esac
done
if [ "$(cat "$(record demo)")" = "$BEFORE" ]; then pass 'the record is unchanged after every refusal'; else fail 'a refusal wrote something'; fi

new_case 'policy on a space that is not there'
run "$SPACE" policy never-was
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'policy invented a space'; fi

new_case 'policy with no space name'
run "$SPACE" policy
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'it printed something anyway' "$OUT"; fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
