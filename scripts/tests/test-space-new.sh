#!/usr/bin/env bash
# Tests for bin/space new — the one command that makes a durable space, and the project rules it
# writes into the project's AGENTS.md.
#
# Why these exist: a space is the thing that makes "one worker per space" and "merged before the
# next" true, and the rules block in the project is how a later boss learns that. Both are one
# command's output, so both are checked here against a throwaway state root and a stub herdr-app:
# no network, no real herdr, nothing written outside $WORK.
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
# The state root is the space root: bin/space reads $PI_SPACE_ROOT/state, delegate reads the same
# when PI_BOSS_ROOT points there, so a fixture is one directory and not two.
export PI_BOSS_ROOT="$PI_SPACE_ROOT"
export HERDR_LOG="$WORK/herdr.log"
export HERDR_COUNT="$WORK/herdr.count"

# A herdr-app that answers the two shapes space needs and nothing else, logging every call.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1" in
do)
	case "$2" in
	space.new)
		n=$(($(cat "$HERDR_COUNT" 2>/dev/null || echo 0) + 1))
		printf '%s' "$n" >"$HERDR_COUNT"
		printf '{"space":"sp%s","tab":"tb%s","pane":"p%s","terminal":"t%s"}\n' "$n" "$n" "$n" "$n"
		;;
	*) printf '{}\n' ;;
	esac
	;;
ls)
	if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi
	;;
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
gitproject() {
	project "$1"
	git -C "$1" init -q
	git -C "$1" -c core.hooksPath=/dev/null -c user.email=t@e -c user.name=t \
		commit -q --allow-empty -m init
}
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }

# --------------------------------------------------- a plain folder, no git --
P="$WORK/proj"
project "$P"
run "$SPACE" new --name demo --project "$P"
if [ "$RC" -eq 0 ]; then pass 'a folder makes a space'; else fail 'space new failed' "$OUT"; fi
if [ -f "$(record demo)" ]; then pass 'the record is at state/spaces/demo/space.json'; else fail 'no record written'; fi
if grep -q '"git": false' "$(record demo)"; then pass 'git is false without a .git'; else fail 'git was not recorded false'; fi
if grep -q '"project": "'"$P"'"' "$(record demo)"; then pass 'the project path is recorded'; else fail 'project path missing'; fi
# The herdr space id is recorded because `tab.new` needs it: a worker is a tab inside this space.
if grep -q '"id": "sp1"' "$(record demo)"; then pass "herdr's space id is recorded"; else fail 'the record has no herdr id' "$(cat "$(record demo)")"; fi
if [ -f "$P/AGENTS.md" ]; then pass 'AGENTS.md is created in the project'; else fail 'AGENTS.md was not created'; fi
if [ "$(grep -c 'pi-space:begin' "$P/AGENTS.md")" = 1 ]; then pass 'exactly one rules block'; else fail 'the rules block is not exactly one'; fi
if grep -q 'This space is demo' "$P/AGENTS.md"; then pass 'the block names the space'; else fail 'the block does not name the space'; fi
if grep -qF "$P" "$P/AGENTS.md"; then pass 'the block names the project'; else fail 'the block does not name the project'; fi
if [ "$(wc -l <"$P/AGENTS.md")" -lt 40 ]; then pass 'the rules stay under 40 lines'; else fail 'the rules block is 40 lines or more'; fi
case $OUT in
*"bin/delegate spawn"*) pass 'the next line names delegate spawn' ;;
*) fail 'the next line does not name delegate spawn' "$OUT" ;;
esac
run "$SPACE" list
case $OUT in
*demo*no-git*) pass 'list shows the space as no-git' ;;
*) fail 'list does not show no-git' "$OUT" ;;
esac

new_case 'a second space under the same name'
BEFORE=$(grep '"created"' "$(record demo)")
run "$SPACE" new --name demo --project "$P"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'the duplicate was allowed'; fi
case $OUT in
*"already exists for $P"*) pass 'the refusal names the project already using the name' ;;
*) fail 'the refusal does not name the existing project' "$OUT" ;;
esac
if [ "$(grep '"created"' "$(record demo)")" = "$BEFORE" ]; then pass 'the existing record is untouched'; else fail 'the existing record was rewritten'; fi

new_case 'no --project and no --clone'
run "$SPACE" new --name lonely
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'it was allowed'; fi
case $OUT in
*--project*--clone*) pass 'the refusal names both ways to give a project' ;;
*) fail 'the refusal does not name --project and --clone' "$OUT" ;;
esac

new_case 'a project that does not exist'
run "$SPACE" new --name ghost --project "$WORK/nope"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a missing project was accepted'; fi
if [ -e "$(record ghost)" ]; then fail 'a record was written anyway'; else pass 'no record was written'; fi

new_case 'a project that is not writable'
if [ "$(id -u)" = 0 ]; then
	pass 'skipped (running as root: every folder is writable)'
else
	RO="$WORK/readonly"
	project "$RO"
	chmod 0555 "$RO"
	run "$SPACE" new --name locked --project "$RO"
	chmod 0755 "$RO"
	if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'an unwritable project was accepted'; fi
	case $OUT in
	*"not writable"*) pass 'the refusal says it is not writable' ;;
	*) fail 'the refusal does not say why' "$OUT" ;;
	esac
fi

# ------------------------------------------------------------------- git --
new_case 'a git project'
G="$WORK/gitproj"
gitproject "$G"
git -C "$G" remote add origin git@github.com:me/gitproj.git
run "$SPACE" new --name gitdemo --project "$G"
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'space new failed' "$OUT"; fi
if grep -q '"git": true' "$(record gitdemo)"; then pass 'git is recorded true'; else fail 'git was not recorded true'; fi
if grep -q 'git@github.com:me/gitproj.git' "$(record gitdemo)"; then pass 'the remote is recorded'; else fail 'the remote is missing'; fi
run "$SPACE" list
case $OUT in
*gitdemo*git*) pass 'list shows it as git' ;;
*) fail 'list does not show it as git' "$OUT" ;;
esac
if grep -qi 'one worker at a time' "$G/AGENTS.md"; then pass 'the rules say one worker at a time'; else fail 'the rules do not say one worker at a time'; fi
if grep -qF -- "--cwd $G" "$G/AGENTS.md"; then pass 'the rules name the spawn command for this project'; else fail 'the rules do not name the spawn command'; fi

new_case '--no-git on a git project'
run "$SPACE" new --name nogit --project "$G" --no-git
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'space new failed' "$OUT"; fi
if grep -q '"git": false' "$(record nogit)"; then pass 'git is false anyway'; else fail '--no-git did not win'; fi

# --------------------------------------------------- the rules block is edited in place --
new_case 'a project that already has an AGENTS.md'
E="$WORK/existing"
project "$E"
printf '# House rules\n\nkeep me\n' >"$E/AGENTS.md"
run "$SPACE" new --name existing --project "$E"
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'space new failed' "$OUT"; fi
if head -n 3 "$E/AGENTS.md" | grep -q 'keep me'; then pass 'the existing content survives, first'; else fail 'the existing content moved or went missing'; fi
if grep -q 'pi-space:begin' "$E/AGENTS.md"; then pass 'the block is appended'; else fail 'the block is missing'; fi

new_case 'the block is replaced, never duplicated'
BEFORE_N=$(grep -c 'pi-space:begin' "$E/AGENTS.md")
(
	# shellcheck source=/dev/null
	. "$ROOT/bin/space-lib.sh"
	space_rules_write second-name "$E"
	space_rules_write third-name "$E"
)
AFTER_N=$(grep -c 'pi-space:begin' "$E/AGENTS.md")
if [ "$BEFORE_N" = 1 ] && [ "$AFTER_N" = 1 ]; then pass 'still exactly one block'; else fail "blocks: $BEFORE_N then $AFTER_N"; fi
if grep -q 'This space is third-name' "$E/AGENTS.md"; then pass 'the block carries the newest name'; else fail 'the block was not replaced'; fi
if head -n 3 "$E/AGENTS.md" | grep -q 'keep me'; then pass 'the surrounding content still survives'; else fail 'the surrounding content was damaged'; fi
if grep -q 'second-name' "$E/AGENTS.md"; then fail 'the old block is still in the file'; else pass 'the old block is gone'; fi

# ------------------------------------------------------------------ clone --
new_case '--clone from a local repository'
SRC="$WORK/origin"
gitproject "$SRC"
git clone -q --bare "$SRC" "$WORK/origin.git"
run "$SPACE" new --name cloned --clone "$WORK/origin.git"
if [ "$RC" -eq 0 ]; then pass 'the clone becomes the project'; else fail 'space new --clone failed' "$OUT"; fi
if [ -d "$HOME/projects/cloned/.git" ]; then pass 'it is cloned into ~/projects/<slug>'; else fail 'no clone at ~/projects/cloned'; fi
if grep -q '"git": true' "$(record cloned)"; then pass 'it is recorded as git'; else fail 'the clone is not recorded as git'; fi

new_case '--clone into a folder that already has something in it'
mkdir -p "$HOME/projects/taken"
printf 'mine\n' >"$HOME/projects/taken/keep.txt"
run "$SPACE" new --name taken --clone "$WORK/origin.git"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'an occupied clone target was accepted'; fi
case $OUT in
*"exists and is not empty"*) pass 'the refusal names the folder' ;;
*) fail 'the refusal does not name the folder' "$OUT" ;;
esac
if [ -f "$HOME/projects/taken/keep.txt" ]; then pass 'nothing in it was touched'; else fail 'the existing folder was deleted'; fi

# ------------------------------------------------------------- show, forget --
new_case 'show and forget'
run "$SPACE" show demo
case $OUT in
*"project: $P"*"git: false"*) pass 'show prints the record' ;;
*) fail 'show does not print project and git' "$OUT" ;;
esac
run "$SPACE" forget demo
if [ "$RC" -eq 0 ]; then pass 'forget succeeds'; else fail 'forget failed' "$OUT"; fi
if [ -e "$(record demo)" ]; then fail 'the record survived forget'; else pass 'the record is gone'; fi
run "$SPACE" list
if printf '%s\n' "$OUT" | grep -q '^demo '; then
	fail 'forget left the space in the list' "$OUT"
else
	pass 'forget drops it from the list'
fi
if grep -q 'space.close' "$HERDR_LOG"; then fail 'forget closed the herdr space'; else pass 'forget leaves the herdr space open'; fi
if [ -d "$P" ] && [ -f "$P/AGENTS.md" ]; then pass 'the folder and its rules stay'; else fail 'forget touched the project'; fi

new_case 'forget a space that is not there'
run "$SPACE" forget never-was
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'forget invented a success'; fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
