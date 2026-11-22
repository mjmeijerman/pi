#!/usr/bin/env bash
# Tests for the three things that made creating a space the hardest command in the harness:
#
#   1. `space new <slug>` — the name is the argument, and the folder is the one you are standing in;
#      `space new` with nothing after it asks three questions with defaults, and with nothing to
#      read it prints the usage and exits 1, so a script is never left waiting on a prompt;
#   2. `space list` says whether the app has each space open (`live <id>` / `not in herdr-app`),
#      and lists every record even when `herdr-app` is missing, with one line saying so;
#   3. `space forget <slug>` asks before it drops a record, and `--yes` is the answer a script gives.
#
# No network, no desktop app, nothing written outside $WORK. Set SPACE_UX_BIN to another `bin/`
# (trunk's `space` and `space-lib.sh`) to run the same cases against older code, which is how the
# report shows a case failing before the change.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BINDIR=${SPACE_UX_BIN:-$ROOT/bin}
SPACE="$BINDIR/space"
[ -x "$SPACE" ] || {
	printf 'FATAL: %s is not executable\n' "$SPACE" >&2
	exit 1
}
[ -f "$BINDIR/space-lib.sh" ] || {
	printf 'FATAL: %s is missing — bin/space sources it\n' "$BINDIR/space-lib.sh" >&2
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
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub"
export HERDR_LOG="$WORK/herdr.log"
export HERDR_SPACES="$WORK/spaces.json"
: >"$HERDR_LOG"

# A herdr-app that writes down every call. `ls` answers whatever the case put in $HERDR_SPACES, so
# one case can say "the app has demo" and the next can say "the app has never heard of it".
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"sp-new","tab":"tb-new","pane":"p-new","terminal":"t-new"}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
chmod +x "$WORK/stub/herdr-app"
PATH="$WORK/stub:$PATH"
export PATH
# The same PATH with no stub in it: the case where the app is simply not installed.
PATH_NOSTUB=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$WORK/stub" | paste -sd: -)

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
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }
tabs_opened() { grep -c '^do space.new' "$HERDR_LOG" 2>/dev/null || true; }

# The one project folder these cases stand in, so "the folder you are in" is a fact and not $HOME.
PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"
cd "$PROJ" || exit 1

# ------------------------------------------------- a name, and the folder you are in --
new_case 'space new <slug> takes the folder you are in'
run "$SPACE" new demo
if [ "$RC" -eq 0 ]; then pass 'it is created'; else fail 'space new demo failed' "$OUT"; fi
if [ -f "$(record demo)" ]; then pass 'the record is written'; else fail 'no record was written' "$OUT"; fi
if grep -q '"project": "'"$PROJ"'"' "$(record demo)"; then pass 'the project is the folder it ran in'; else fail 'the project is not $PWD' "$(cat "$(record demo)")"; fi
if grep -q '"kind": "project"' "$(record demo)"; then pass 'a bare name is a project space'; else fail 'the kind is not project'; fi
if grep -qF "do space.new --name demo --folder $PROJ" "$HERDR_LOG"; then pass 'one tab is opened, for that folder'; else fail 'the app was not asked for this space' "$(cat "$HERDR_LOG")"; fi
case $OUT in
"space: demo on $PROJ"*) pass 'one line says what it made' ;;
*) fail 'the printed line is not "space: <slug> on <path>"' "$OUT" ;;
esac

# ------------------------------------------------------- no arguments, no terminal --
new_case 'space new with no arguments and nothing to read'
: >"$HERDR_LOG"
BEFORE_N=$(tabs_opened)
OUT=$("$SPACE" new </dev/null 2>&1)
RC_BARE=$?
if [ "$RC_BARE" -ne 0 ]; then pass 'it exits 1'; else fail 'a script was waited on instead of refused' "$OUT"; fi
case $OUT in
*"usage: bin/space new"*) pass 'it prints the usage' ;;
*) fail 'the usage text is missing' "$OUT" ;;
esac
if [ -f "$(record proj)" ]; then fail 'a record was written anyway'; else pass 'no record was written'; fi
if [ "$(tabs_opened)" = "$BEFORE_N" ]; then pass 'no tab was opened'; else fail 'the app was asked for a space' "$(cat "$HERDR_LOG")"; fi

new_case 'space new with answers piped in'
mkdir -p "$WORK/fed"
cd "$WORK/fed" || exit 1
: >"$HERDR_LOG"
OUT=$(printf 'fed\n\n\n' | "$SPACE" new 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the space is created'; else fail 'the piped answers were not taken' "$OUT"; fi
if grep -q '"project": "'"$WORK/fed"'"' "$(record fed)"; then pass 'the empty folder answer means $PWD'; else fail 'the project is not the folder it ran in' "$(cat "$(record fed)" 2>/dev/null)"; fi
if grep -qF "do space.new --name fed --folder $WORK/fed" "$HERDR_LOG"; then pass 'the tab is opened for that folder'; else fail 'the app was not asked' "$(cat "$HERDR_LOG")"; fi

new_case 'the answer "n" creates nothing'
# The folder is named and is not there, so `create it?` is the question the third answer answers;
# the assertions below are the ones they always were.
cd "$WORK" || exit 1
: >"$HERDR_LOG"
OUT=$(printf 'nope\n%s/nope\nn\n' "$WORK" | "$SPACE" new 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then pass 'it exits 1'; else fail 'a refused space was created' "$OUT"; fi
if [ -e "$(record nope)" ]; then fail 'the record was written'; else pass 'no record was written'; fi
if [ -z "$(cat "$HERDR_LOG")" ]; then pass 'the app was never called'; else fail 'a tab was opened' "$(cat "$HERDR_LOG")"; fi

# ------------------------------------------------------- --here and "." are $PWD --
cd "$PROJ" || exit 1
new_case '--here and . both mean the folder you are in'
: >"$HERDR_LOG"
run "$SPACE" new here-demo --here
if [ "$RC" -eq 0 ]; then pass '--here is accepted'; else fail '--here was refused' "$OUT"; fi
if grep -q '"project": "'"$PROJ"'"' "$(record here-demo)" 2>/dev/null; then pass '--here records $PWD'; else fail '--here did not record $PWD'; fi
run "$SPACE" new dot-demo --project .
if [ "$RC" -eq 0 ]; then pass '--project . is accepted'; else fail '--project . was refused' "$OUT"; fi
if grep -q '"project": "'"$PROJ"'"' "$(record dot-demo)" 2>/dev/null; then pass '--project . records $PWD'; else fail '--project . did not record $PWD'; fi
run "$SPACE" new bare-dot .
if [ "$RC" -eq 0 ]; then pass 'a bare . as the second word is accepted'; else fail 'a bare . was refused' "$OUT"; fi
if grep -q '"project": "'"$PROJ"'"' "$(record bare-dot)" 2>/dev/null; then pass 'a bare . records $PWD'; else fail 'a bare . did not record $PWD'; fi

# ---------------------------------------------------------------- list says live --
new_case 'list says whether the app has the space open'
printf '{"spaces":[{"name":"demo","id":"sp-live-1"}]}\n' >"$HERDR_SPACES"
run "$SPACE" list
if [ "$RC" -eq 0 ]; then pass 'list runs'; else fail 'list failed' "$OUT"; fi
case $OUT in
*"demo"*"live sp-live-1"*) pass 'a space the app reports reads live and its id' ;;
*) fail 'no live column for demo' "$OUT" ;;
esac
case $OUT in
*"here-demo"*"not in herdr-app"*) pass 'a space the app does not report says so' ;;
*) fail 'no "not in herdr-app" for here-demo' "$OUT" ;;
esac
if printf '%s\n' "$OUT" | grep -q '^here-demo '; then pass 'it still lists the space it cannot see'; else fail 'the closed space fell out of the list' "$OUT"; fi

new_case 'list --json keeps the record shape and adds live'
run "$SPACE" list --json
if [ "$RC" -eq 0 ]; then pass 'list --json runs'; else fail 'list --json failed' "$OUT"; fi
JSON_NAME=$(printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const r=a.find(x=>x.name==="demo");process.stdout.write(r?String(r.live)+" "+String(r.live_id)+" "+String(r.project):"none")})')
if [ "$JSON_NAME" = "true sp-live-1 $PROJ" ]; then pass 'the record carries live, live_id and its own fields'; else fail "the json row was '$JSON_NAME'"; fi

new_case 'list without herdr-app still lists every record'
: >"$HERDR_SPACES"
OUT=$(PATH="$PATH_NOSTUB" "$SPACE" list 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'list runs with no app on PATH'; else fail 'list failed without the app' "$OUT"; fi
case $OUT in
*"herdr-app: unavailable"*) pass 'it says the app is unavailable, once' ;;
*) fail 'it does not say herdr-app is unavailable' "$OUT" ;;
esac
if printf '%s\n' "$OUT" | grep -q '^demo ' && printf '%s\n' "$OUT" | grep -q '^here-demo '; then
	pass 'every record is still listed'
else
	fail 'records went missing with the app' "$OUT"
fi
if [ "$(printf '%s\n' "$OUT" | grep -c 'herdr-app: unavailable')" = 1 ]; then pass 'said once, not per row'; else fail 'the unavailable line repeats' "$OUT"; fi

# -------------------------------------------------------------------- forget asks --
new_case 'forget asks, and n drops nothing'
if script --version 2>/dev/null | grep -q util-linux; then
	# script(1) is the terminal this case needs: the question only exists when a person can answer it.
	printf 'n\n' | script -qec "$SPACE forget demo" /dev/null >"$WORK/tty.out" 2>&1
	TTY_RC=$?
	if [ -f "$(record demo)" ]; then pass 'the record survives an n'; else fail 'n dropped the record' "$(cat "$WORK/tty.out")"; fi
	if [ "$TTY_RC" -ne 0 ]; then pass 'it exits 1'; else fail 'n was read as yes' "$(cat "$WORK/tty.out")"; fi
	case $(cat "$WORK/tty.out") in
	*"drop its record"*) pass 'the question says what it drops' ;;
	*) fail 'the question is missing' "$(cat "$WORK/tty.out")" ;;
	esac
else
	pass 'skipped the prompt itself (no util-linux script(1) here)'
fi

new_case 'forget with no answer and no --yes is refused'
OUT=$("$SPACE" forget demo </dev/null 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then pass 'it exits 1'; else fail 'a script forgot a space silently' "$OUT"; fi
case $OUT in
*--yes*) pass 'the refusal names --yes' ;;
*) fail 'the refusal does not name --yes' "$OUT" ;;
esac
if [ -f "$(record demo)" ]; then pass 'the record is still there'; else fail 'the record went anyway'; fi

new_case 'forget --yes drops the record and leaves the folder'
OUT=$("$SPACE" forget demo --yes 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'it succeeds'; else fail 'forget --yes failed' "$OUT"; fi
if [ -e "$(record demo)" ]; then fail 'the record survived --yes'; else pass 'the record is gone'; fi
if [ -d "$PROJ" ] && [ -f "$PROJ/a.txt" ]; then pass 'the folder and its work stay'; else fail 'the folder was touched'; fi
case $OUT in
*"forgot demo"*) pass 'it says what it dropped' ;;
*) fail 'it does not say what it dropped' "$OUT" ;;
esac
if grep -q 'space.close' "$HERDR_LOG"; then fail 'forget closed the app space'; else pass 'the app space is left open'; fi
run "$SPACE" list
if printf '%s\n' "$OUT" | grep -q '^demo '; then fail 'forget left it in the list' "$OUT"; else pass 'it is gone from the list'; fi

# ----------------------------------------------------------------- the refusals stay --
new_case 'a name another record holds is still refused'
: >"$HERDR_LOG"
run "$SPACE" new here-demo
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'the duplicate was allowed' "$OUT"; fi
case $OUT in
*"already exists for $PROJ"*) pass 'the refusal names the folder already using it' ;;
*) fail 'the refusal does not name the other folder' "$OUT" ;;
esac
if [ -z "$(cat "$HERDR_LOG")" ]; then pass 'no tab was opened'; else fail 'a tab was opened' "$(cat "$HERDR_LOG")"; fi

new_case 'a sandboxed Boss is still refused'
run "$SPACE" new sandboss --argv '["pi-sandboxed"]'
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a sandboxed Boss was accepted' "$OUT"; fi
case $OUT in
*"the Boss is bare"*) pass 'the refusal says the Boss is bare' ;;
*) fail 'the refusal does not say the Boss is bare' "$OUT" ;;
esac
if [ -e "$(record sandboss)" ]; then fail 'a record was written'; else pass 'no record was written'; fi

new_case 'a name given with --name and no folder is still refused'
run "$SPACE" new --name lonely
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'it was allowed' "$OUT"; fi
case $OUT in
*--project*--clone*) pass 'the refusal names both ways to give a project' ;;
*) fail 'the refusal does not name --project and --clone' "$OUT" ;;
esac

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
