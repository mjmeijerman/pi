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

# -------------------------------------------- the questions a bare `space new` asks --
# Feed stdin with a pipe: `where` takes a folder or a URL, and the git question is only asked for a
# folder with no `.git`. The reading taken is said on stderr, in one line, so a misread URL is seen.
new_case 'a bare space new asks, and n records git: false'
H="$WORK/gitless"
project "$H"
: >"$HERDR_LOG"
OUT=$(printf 'asked\n%s\nn\n' "$H" | "$SPACE" new 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'a bare space new failed' "$OUT"; fi
if [ -f "$(record asked)" ]; then pass 'the record is written'; else fail 'no record was written' "$OUT"; fi
if grep -q '"git": false' "$(record asked)" 2>/dev/null; then pass "the fourth answer 'n' records git: false"; else fail "the 'n' did not reach the git question" "$(cat "$(record asked)" 2>/dev/null)"; fi
if grep -q '"project": "'"$H"'"' "$(record asked)" 2>/dev/null; then pass 'the folder was taken as given'; else fail 'the folder is not the one answered' "$(cat "$(record asked)" 2>/dev/null)"; fi
case $OUT in
*"space: folder $H"*) pass 'the reading taken (a folder) is said in one line' ;;
*) fail 'it does not say it read a folder' "$OUT" ;;
esac
if script --version 2>/dev/null | grep -q util-linux; then
	# Only a terminal shows the prompts; the behaviour above is the same either way.
	printf 'gibprompt\n%s\nn\n' "$H" | script -qec "$SPACE new" /dev/null >"$WORK/gib.out" 2>&1
	case $(cat "$WORK/gib.out") in
	*"is it a git project?"*) pass 'the git question is asked, on a terminal' ;;
	*) fail 'the git question is not asked' "$(cat "$WORK/gib.out")" ;;
	esac
	if grep -q '"git": false' "$(record gibprompt)" 2>/dev/null; then pass 'and its answer is recorded'; else fail 'the terminal answer was not recorded' "$(cat "$WORK/gib.out")"; fi
else
	pass 'skipped the prompt text (no util-linux script(1) here)'
fi

new_case 'a bare space new answering y on a folder that is not a repository'
H2="$WORK/gitless2"
project "$H2"
OUT=$(printf 'asked-y\n%s\ny\n' "$H2" | "$SPACE" new 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the run succeeds'; else fail 'the run failed' "$OUT"; fi
# `y` says "it is a git project", and the folder is none: there is no remote to record either way,
# so the honest record is the same one `n` gives, and the report says so rather than pretending.
if grep -q '"git": false' "$(record asked-y)" 2>/dev/null; then pass 'git is false anyway: nothing to pull from'; else fail 'y recorded something else' "$(cat "$(record asked-y)" 2>/dev/null)"; fi

new_case 'a bare space new whose folder answer is a URL'
SRC2="$WORK/origin2"
gitproject "$SRC2"
git clone -q --bare "$SRC2" "$WORK/origin2.git"
OUT=$(printf 'urlspace\nfile://%s\nn\n' "$WORK/origin2.git" | "$SPACE" new 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then pass 'the space is made'; else fail 'the URL answer was not cloned' "$OUT"; fi
if [ -d "$HOME/projects/urlspace/.git" ]; then pass 'it is cloned into ~/projects/<name>'; else fail 'no clone at ~/projects/urlspace' "$OUT"; fi
case $OUT in
*"space: cloning file://$WORK/origin2.git"*) pass 'the reading taken (a clone) is said in one line' ;;
*) fail 'it does not say it read a URL' "$OUT" ;;
esac
if grep -q '"git": true' "$(record urlspace)" 2>/dev/null; then pass 'no git question is asked: the trailing n is not taken as an answer' ; else fail 'the clone was recorded as no-git' "$(cat "$(record urlspace)" 2>/dev/null)"; fi

new_case 'a bare space new whose answer is a URL beside --no-git'
: >"$HERDR_LOG"
OUT=$(printf 'nope-clone\nfile://%s\n' "$WORK/origin2.git" | "$SPACE" new --no-git 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail '--no-git with a clone was accepted' "$OUT"; fi
case $OUT in
*"--clone and --no-git answer the same question"*) pass 'the refusal names both answers' ;;
*) fail 'the refusal does not name the conflict' "$OUT" ;;
esac
if [ -e "$(record nope-clone)" ]; then fail 'a record was written'; else pass 'no record was written'; fi
if [ -e "$HOME/projects/nope-clone" ]; then fail 'a clone was made'; else pass 'nothing was cloned'; fi
if [ -z "$(cat "$HERDR_LOG")" ]; then pass 'the app was never called'; else fail 'a tab was opened' "$(cat "$HERDR_LOG")"; fi

new_case 'space new <name> asks nothing at all'
S="$WORK/silent"
project "$S"
cd "$S" || exit 1
OUT=$("$SPACE" new silent </dev/null 2>&1)
RC=$?
cd "$WORK" || exit 1
if [ "$RC" -eq 0 ]; then pass 'it is created from the name alone'; else fail 'the positional path asked a question' "$OUT"; fi
if grep -q '"project": "'"$S"'"' "$(record silent)" 2>/dev/null; then pass 'the project is the folder it ran in'; else fail 'the project is not $PWD' "$(cat "$(record silent)" 2>/dev/null)"; fi

new_case 'a folder answer that does not exist, answered n'
: >"$HERDR_LOG"
OUT=$(printf 'gone\n%s\nn\n' "$WORK/nothere" | "$SPACE" new 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then pass 'it exits 1'; else fail 'a refused folder was created' "$OUT"; fi
if [ -e "$(record gone)" ]; then fail 'the record was written'; else pass 'no record was written'; fi
if [ -e "$WORK/nothere" ]; then fail 'the folder was created anyway'; else pass 'the folder was not created'; fi
if [ -z "$(cat "$HERDR_LOG")" ]; then pass 'the app was never called'; else fail 'a tab was opened' "$(cat "$HERDR_LOG")"; fi

# ------------------------------------------------------------- show, forget --
new_case 'show and forget'
run "$SPACE" show demo
case $OUT in
*"project: $P"*"git: false"*) pass 'show prints the record' ;;
*) fail 'show does not print project and git' "$OUT" ;;
esac
# `forget` asks on a terminal and takes `--yes` from a script; nothing here can answer a question.
run "$SPACE" forget demo --yes
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
run "$SPACE" forget never-was --yes
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'forget invented a success'; fi

new_case 'forget asks for the name, and a wrong answer keeps the record'
K="$WORK/kept"
project "$K"
run "$SPACE" new --name kept --project "$K"
if script --version 2>/dev/null | grep -q util-linux; then
	# script(1) is the terminal this case needs: the question only exists when a person can answer it.
	printf 'y\n' | script -qec "$SPACE forget kept" /dev/null >"$WORK/tty.out" 2>&1
	TTY_RC=$?
	if [ -f "$(record kept)" ]; then pass "a 'y' no longer drops it"; else fail "a 'y' dropped the record" "$(cat "$WORK/tty.out")"; fi
	if [ "$TTY_RC" -eq 1 ]; then pass 'it exits 1'; else fail "a 'y' exited $TTY_RC, and 0 means dropped" "$(cat "$WORK/tty.out")"; fi
	case $(cat "$WORK/tty.out") in
	*"kept — nothing was dropped"*) pass 'it says the space was kept' ;;
	*) fail 'it does not say the space was kept' "$(cat "$WORK/tty.out")" ;;
	esac
	case $(cat "$WORK/tty.out") in
	*"dropped: its record"*"kept:    reports/"*) pass 'the question says what goes and what stays' ;;
	*) fail 'the question does not say what goes and what stays' "$(cat "$WORK/tty.out")" ;;
	esac
else
	pass 'skipped the prompt itself (no util-linux script(1) here)'
fi

new_case 'forget drops it when the name is typed back'
if script --version 2>/dev/null | grep -q util-linux; then
	printf 'kept\n' | script -qec "$SPACE forget kept" /dev/null >"$WORK/tty2.out" 2>&1
	TTY_RC=$?
	if [ "$TTY_RC" -eq 0 ]; then pass 'it exits 0'; else fail "the typed name exited $TTY_RC" "$(cat "$WORK/tty2.out")"; fi
	if [ -e "$(record kept)" ]; then fail 'the typed name did not drop the record'; else pass 'the typed name drops the record'; fi
	case $(cat "$WORK/tty2.out") in
	*"forgot kept"*) pass 'it says what it dropped' ;;
	*) fail 'it does not say what it dropped' "$(cat "$WORK/tty2.out")" ;;
	esac
else
	pass 'skipped the prompt itself (no util-linux script(1) here)'
fi

new_case 'forget --yes answers up front and is never silent'
D="$WORK/dropped"
project "$D"
run "$SPACE" new --name dropped --project "$D"
SYSERR=$("$SPACE" forget dropped --yes 2>&1 >/dev/null)
RC=$?
STDOUT=$("$SPACE" list 2>/dev/null)
if [ "$RC" -eq 0 ] && [ ! -e "$(record dropped)" ]; then pass 'the record is dropped'; else fail 'forget --yes did not drop it' "$SYSERR"; fi
case $SYSERR in
*"dropped: its record"*"kept:    reports/"*) pass 'the explanation goes to stderr, so the destructive path is never silent' ;;
*) fail 'the explanation is missing from stderr' "$SYSERR" ;;
esac
if [ -f "$D/a.txt" ]; then pass 'the folder and its work stay'; else fail 'the folder was touched'; fi

# ------------------------------------------------------------ tab forget --
# `tabs[]` is the whole mechanism: `bin/guard` rebuilds a space that is gone from every entry in it,
# so the verb that makes a closed tab stay closed is the one that removes the entry. The record is
tab_names() {
	node -e 'const j=require(process.argv[1]);process.stdout.write((Array.isArray(j.tabs)?j.tabs:[]).map(t=>t.name).join(","))' "$(record "$1")"
}
set_tabs() { # <slug> <tabs-json>
	TABS="$2" node -e '
		const fs = require("fs");
		const file = process.argv[1];
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		j.tabs = JSON.parse(process.env.TABS);
		fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
	' "$(record "$1")"
}
TT="$WORK/tabspace"
project "$TT"
run "$SPACE" new --name tabspace --project "$TT"
set_tabs tabspace "[{\"name\":\"Boss\",\"folder\":\"$TT\",\"argv\":[]},{\"name\":\"Extra\",\"folder\":\"$TT\",\"argv\":[\"sh\",\"-lc\",\"date\"]}]"

new_case 'tab list names the recorded tabs'
run "$SPACE" tab list tabspace
if [ "$RC" -eq 0 ]; then pass 'it succeeds'; else fail 'tab list failed' "$OUT"; fi
if [ "$OUT" = "Boss
Extra" ]; then pass 'both entries are named, in record order'; else fail 'the list is not the two tabs' "$OUT"; fi
run "$SPACE" tab list tabspace --json
if [ "$OUT" = '{"space":"tabspace","tabs":["Boss","Extra"]}' ]; then pass '--json is the same answer for a script'; else fail '--json prints something else' "$OUT"; fi

new_case 'tab forget removes the one entry and keeps the Boss'
: >"$HERDR_LOG"
run "$SPACE" tab forget tabspace Extra
if [ "$RC" -eq 0 ]; then pass 'it succeeds'; else fail 'tab forget failed' "$OUT"; fi
if [ "$(tab_names tabspace)" = "Boss" ]; then pass 'only Extra is gone'; else fail 'the tab list is not just Boss' "$(cat "$(record tabspace)")"; fi
if grep -q '"project": "'"$TT"'"' "$(record tabspace)"; then pass 'the rest of the record is untouched'; else fail 'the record lost its fields' "$(cat "$(record tabspace)")"; fi
case $OUT in
*"tab Extra forgotten"*) pass 'it names the entry it removed' ;;
*) fail 'it does not name the entry' "$OUT" ;;
esac
case $OUT in
*"guard will no longer re-create it"*"still recorded: Boss"*) pass 'it says the guard stops rebuilding it, and what is left' ;;
*) fail 'it does not say what will not come back' "$OUT" ;;
esac
if [ -s "$HERDR_LOG" ]; then fail 'the verb talked to herdr-app' "$(cat "$HERDR_LOG")"; else pass 'it edits the record and never talks to herdr'; fi

new_case 'tab forget refuses the Boss tab and changes nothing'
BEFORE=$(cat "$(record tabspace)")
run "$SPACE" tab forget tabspace Boss
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'the Boss entry was removed' "$OUT"; fi
case $OUT in
*"bin/space forget tabspace"*) pass 'the refusal names the way to drop the whole space' ;;
*) fail 'the refusal names no way out' "$OUT" ;;
esac
if [ "$(cat "$(record tabspace)")" = "$BEFORE" ]; then pass 'the record is unchanged'; else fail 'the refused verb rewrote the record'; fi

new_case 'tab forget refuses a name no entry matches, naming the entries there are'
run "$SPACE" tab forget tabspace Nope
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a missing name was a success' "$OUT"; fi
case $OUT in
*"no tab called 'Nope'"*Boss*) pass 'the refusal names the entries that do exist' ;;
*) fail 'the refusal does not name the entries' "$OUT" ;;
esac

new_case 'tab forget refuses a tab a tracked worker still uses'
set_tabs tabspace "[{\"name\":\"Boss\",\"folder\":\"$TT\",\"argv\":[]},{\"name\":\"logs\",\"folder\":\"$TT\",\"argv\":[],\"id\":\"tb-worker\"}]"
node -e '
	const fs=require("fs");
	fs.writeFileSync(process.argv[1], JSON.stringify({w7:{slug:"w7",kind:"tab",space:"s1",spaceName:"tabspace",tab:"tb-worker"}},null,2)+"\n")' "$PI_SPACE_ROOT/state/spaces/tabspace/delegations.json"
run "$SPACE" tab forget tabspace logs
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a working tab was unrecorded' "$OUT"; fi
case $OUT in
*"bin/delegate close w7"*) pass 'the refusal names the worker and the command that closes it' ;;
*) fail 'the refusal names no way to close the worker' "$OUT" ;;
esac
if [ "$(tab_names tabspace)" = "Boss,logs" ]; then pass 'the record is unchanged'; else fail 'the refused verb removed the entry' "$(cat "$(record tabspace)")"; fi

new_case 'the Boss argv is the .cmd in the bin directory when there is one'
# Windows starts a program, not a shebang: the install writes `<bin dir>/pi-bare.cmd`
# and Herdr cannot start the extensionless script the record used to carry. The
# file only exists there on Windows, so its presence is the whole test.
PC="$WORK/projcmd"
project "$PC"
run "$SPACE" new --name posixboss --project "$PC"
if grep -qF "\"$ROOT/bin/pi-bare\"" "$(record posixboss)"; then pass 'without a .cmd the bare script is recorded'; else fail 'the default Boss argv is not the script beside bin/' "$(cat "$(record posixboss)")"; fi
mkdir -p "$HOME/.local/bin"
printf '@echo off\r\n' >"$HOME/.local/bin/pi-bare.cmd"
run "$SPACE" new --name winboss --project "$PC"
if [ "$RC" -eq 0 ]; then pass 'the space is made with a .cmd present'; else fail 'space new failed with a .cmd present' "$OUT"; fi
if grep -qF "\"$HOME/.local/bin/pi-bare.cmd\"" "$(record winboss)"; then pass 'the .cmd is recorded as the Boss argv'; else fail 'the record does not name the .cmd' "$(cat "$(record winboss)")"; fi
rm -f "$HOME/.local/bin/pi-bare.cmd"

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
