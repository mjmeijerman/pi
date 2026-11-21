#!/usr/bin/env bash
# Tests for bin/space move — the project folder of a record, and nothing else.
#
# Why these exist: a record outlives the folder it was made in (a clone renamed, a checkout
# replaced, a workspace retired), and the alternative to moving it is forgetting the space and
# making a second one. A second space is the failure this pins: the guard would find a record
# whose project is gone, a live space it no longer recognises, and a person with two Bosses.
# So the move has to keep the record's identity (`id`, `boss`, `boss_argv`, the reports), refuse
# the two ways it can be a lie (no such folder, a folder another record already claims), and the
# guard has to adopt the moved record without a `space.new` — read off its own `--dry-run`.
#
# No network, no desktop app, nothing written outside $WORK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
GUARD="$ROOT/bin/guard"
for prog in "$SPACE" "$GUARD"; do
	[ -x "$prog" ] || {
		printf 'FATAL: %s is not executable\n' "$prog" >&2
		exit 1
	}
done

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub"
PATH="$WORK/stub:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export HERDR_SPACES="$WORK/spaces.json"

# A herdr-app that logs every call and answers `ls` from HERDR_SPACES; `space new` gets a space.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1" in
do) case "$2" in
	space.new) printf '{"space":"sp1","tab":"tb1","terminal":"t1"}\n' ;;
	*) printf '{}\n' ;;
	esac ;;
ls) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
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
run() {
	OUT=$("$@" 2>&1)
	RC=$?
}
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }
field() {
	node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(process.argv[2].split(".").reduce((a,k)=>a==null?a:a[k],r)??""))' \
		"$(record "$1")" "$2"
}

OLD="$WORK/old-project"
NEW="$WORK/new-project"
mkdir -p "$OLD" "$NEW"
run "$SPACE" new --name harness --project "$OLD" --kind harness
[ "$RC" -eq 0 ] || {
	printf 'FATAL: could not make the fixture space\n%s\n' "$OUT" >&2
	exit 1
}
BEFORE_ID=$(field harness id)
BEFORE_BOSS=$(field harness boss)
BEFORE_ARGV=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).boss_argv))' "$(record harness)")
BEFORE_CREATED=$(field harness created)
# A record the guard has passed over carries its `tabs` list (record_tabs_seed); `space new` writes
# the Boss tab name and argv and not the list, so the fixture writes it the way a pass would.
node -e '
	const fs=require("fs");
	const f=process.argv[1];
	const r=JSON.parse(fs.readFileSync(f,"utf8"));
	r.tabs=[{name:String(r.boss||"Boss"),folder:String(r.project||""),argv:r.boss_argv||[]}];
	fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n");
' "$(record harness)"
if [ -f "$PI_SPACE_ROOT/state/spaces/harness/specs/keep.md" ]; then :; fi
printf 'a spec\na report\n' >"$PI_SPACE_ROOT/state/spaces/harness/specs/keep.md"
printf 'a report\n' >"$PI_SPACE_ROOT/state/spaces/harness/reports/keep.md"

# ---------------------------------------------------------------- the move --
new_case 'moving a record to another folder'
run "$SPACE" move harness --project "$NEW"
if [ "$RC" -eq 0 ]; then pass 'the move succeeds'; else fail 'the move failed' "$OUT"; fi
if [ "$(field harness project)" = "$(cd -- "$NEW" && pwd -P)" ]; then pass 'project is the new folder'; else fail 'project was not rewritten' "$(field harness project)"; fi
if [ "$(field harness id)" = "$BEFORE_ID" ]; then pass 'id is kept'; else fail 'the id changed' "$(field harness id)"; fi
if [ "$(field harness boss)" = "$BEFORE_BOSS" ]; then pass 'boss is kept'; else fail 'the Boss name changed'; fi
if [ "$(field harness created)" = "$BEFORE_CREATED" ]; then pass 'created is kept'; else fail 'created was rewritten'; fi
AFTER_ARGV=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).boss_argv))' "$(record harness)")
if [ "$AFTER_ARGV" = "$BEFORE_ARGV" ]; then pass 'boss_argv is kept'; else fail "boss_argv changed: $BEFORE_ARGV -> $AFTER_ARGV"; fi
# A tab with a dead cwd is a tab the app cannot start, so the tabs in the old folder follow it.
if [ "$(field harness tabs.0.folder)" = "$(cd -- "$NEW" && pwd -P)" ]; then pass 'the Boss tab follows into the new folder'; else fail 'tabs[].folder still names the old folder' "$(field harness tabs.0.folder)"; fi
if [ -f "$PI_SPACE_ROOT/state/spaces/harness/reports/keep.md" ]; then pass 'the reports stay beside the record'; else fail 'a report was moved or lost'; fi
case $OUT in
*"space: harness -> $NEW"*) pass 'it prints space: <slug> -> <path>' ;;
*) fail 'the move does not print the new path' "$OUT" ;;
esac
case $OUT in
*"next: herdr-app do tab.new --name Boss --space $BEFORE_ID --folder $NEW"*) pass "the next command opens the Boss tab in the new folder" ;;
*) fail 'the next line is not the Boss tab in the new folder' "$OUT" ;;
esac
# The move never opens anything: the record is edited and the person (or the guard) opens tabs.
case $OUT in
*space.new*) fail 'the move called space.new' "$OUT" ;;
*) pass 'the move opened no space' ;;
esac

new_case '--json gives the record'
run "$SPACE" move harness --project "$NEW" --json
if [ "$RC" -eq 0 ]; then pass 'the move succeeds'; else fail 'the move failed' "$OUT"; fi
if printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);process.exit(j.name==="harness"&&j.project?0:1)})'; then
	pass 'the answer is the record itself'
else
	fail '--json did not print the record' "$OUT"
fi

# ------------------------------------------------------------- the refusals --
new_case 'a folder that is not there'
run "$SPACE" move harness --project "$WORK/no-such-folder"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'it was allowed'; fi
case $OUT in
*"no such folder"*) pass 'the refusal names the folder' ;;
*) fail 'the refusal does not name the folder' "$OUT" ;;
esac
if [ "$(field harness project)" = "$(cd -- "$NEW" && pwd -P)" ]; then pass 'the record is untouched'; else fail 'the refused move rewrote the record'; fi

new_case 'a path that is a file, not a folder'
printf 'x\n' >"$WORK/a-file"
run "$SPACE" move harness --project "$WORK/a-file"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a file was accepted as a project'; fi
case $OUT in
*"no such folder"*) pass 'the refusal says it is not a folder' ;;
*) fail 'the refusal does not say what is wrong' "$OUT" ;;
esac

new_case 'a folder another record already claims'
mkdir -p "$WORK/claimed"
run "$SPACE" new --name other --project "$WORK/claimed"
run "$SPACE" move harness --project "$WORK/claimed"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'two records were put on one folder'; fi
case $OUT in
*"already the project of space 'other'"*) pass 'the refusal names the record that holds it' ;;
*) fail 'the refusal does not name the other space' "$OUT" ;;
esac
if [ "$(field harness project)" = "$(cd -- "$NEW" && pwd -P)" ]; then pass 'the record is untouched'; else fail 'the refused move rewrote the record'; fi

new_case 'a space that does not exist'
run "$SPACE" move nosuch --project "$NEW"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'it was allowed'; fi
case $OUT in
*"no such space: nosuch"*) pass 'the refusal names the space' ;;
*) fail 'the refusal does not name the space' "$OUT" ;;
esac

# ------------------------------------------------- the guard adopts the move --
# herdr still holds the space under its old folder, the way a rename leaves it: the guard finds it
# by name, adopts it, and opens nothing. Read off `--dry-run`, because a test must not touch a tab.
new_case 'the guard adopts the moved record instead of making a second space'
cat >"$HERDR_SPACES" <<JSON
{"spaces":[{"name":"harness","id":"$BEFORE_ID","folder":"$OLD","tabs":[{"name":"Boss","id":"tb1","terminals":["t1"]}]}]}
JSON
run "$GUARD" --once --dry-run --space harness
if [ "$RC" -eq 0 ]; then pass 'the dry run exits 0'; else fail 'the dry run failed' "$OUT"; fi
case $OUT in
*"harness: dry-run: keeps herdr's space $BEFORE_ID with its Boss tab 'Boss' on $NEW, no space.new"*)
	pass 'it keeps the live space, on the new folder, and opens no space'
	;;
*) fail 'the dry run does not adopt the moved record' "$OUT" ;;
esac
case $OUT in
*"would keep space 'harness'"*) fail 'the guard would rebuild the space it already has' "$OUT" ;;
*) pass 'no rebuild: the space is not made twice' ;;
esac

new_case 'the guard does not clone a space already open on the new folder'
# The app renamed the space, so the name matches nothing: the folder is the only hint left, and a
# live space sitting on the moved folder is the space — not a reason for a second one.
cat >"$HERDR_SPACES" <<JSON
{"spaces":[{"name":"renamed","id":"spother","folder":"$NEW","tabs":[{"name":"Boss","id":"tb9"}]}]}
JSON
run "$GUARD" --once --dry-run --space harness
case $OUT in
*"keeps herdr's space spother"*"on $NEW, no space.new"*) pass 'it takes the space on the folder, and opens none' ;;
*) fail 'the dry run would open a second space on one folder' "$OUT" ;;
esac
case $OUT in
*"space.new --name"*) fail 'the dry run would call space.new' "$OUT" ;;
*) pass 'no space.new call anywhere in the plan' ;;
esac

printf '\n'
if [ "$FAIL_N" -eq 0 ]; then
	printf 'all %d checks passed\n' "$PASS_N"
	exit 0
fi
printf '%d of %d checks failed\n' "$FAIL_N" "$((PASS_N + FAIL_N))"
exit 1
