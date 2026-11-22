#!/usr/bin/env bash
# Tests for the space dimension of bin/delegate — which space a command runs in, where the spec,
# the report and the record land, and what the list says.
#
# Why these exist: a space is durable only if the tool agrees on which one it is looking at. The
# resolution rule (--space, else the longest project path that contains the cwd), the refusal in a
# folder no space claims, per-space records, and reading the old record without writing it are all
# one decision, and a wrong answer files a worker's report in another project's space.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPACE="$ROOT/bin/space"
DELEGATE="$ROOT/bin/delegate"
for f in "$SPACE" "$DELEGATE"; do
	[ -x "$f" ] || {
		printf 'FATAL: %s is not executable\n' "$f" >&2
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
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export DELEGATE_POLL_SECONDS=0

# herdr-app: space.new and tab.new hand out ids, everything else is quiet.
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
# hc: no terminals listed, and a read that says the banner is already on screen.
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
# No worker terminals are listed, so every recorded worker whose report is still a skeleton reads
# as gone: these cases are about resolution, not about a live worker holding a space.
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
# jev, the runner and the programs delegate reaches for live in $PI_BOSS_ROOT/bin, which is where a
# real install puts them: one stub each, answering the one shape the caller reads.
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
record() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/space.json"; }
delegations() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1/delegations.json"; }

OUTER="$WORK/outer"
INNER="$OUTER/sub"
OTHER="$WORK/other"
mkdir -p "$INNER" "$OTHER"
printf 'x\n' >"$OUTER/a.txt"
printf 'x\n' >"$OTHER/a.txt"
"$SPACE" new --name outer --project "$OUTER" >/dev/null
"$SPACE" new --name inner --project "$INNER" >/dev/null
"$SPACE" new --name other --project "$OTHER" >/dev/null

# ------------------------------------------- a folder no space claims is refused --
new_case 'spawning in a folder no space claims'
STRAY="$WORK/stray"
mkdir -p "$STRAY"
run "$DELEGATE" spawn lost --cwd "$STRAY" "do a thing"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'the spawn went ahead' "$OUT"; fi
case $OUT in
*"no space claims $STRAY"*) pass 'the refusal names the folder' ;;
*) fail 'the refusal does not name the folder' "$OUT" ;;
esac
case $OUT in
*"space new --name <slug> --project $STRAY"*) pass 'the refusal names the command that makes one' ;;
*) fail 'the refusal does not name bin/space new' "$OUT" ;;
esac
if compgen -G "$PI_SPACE_ROOT/state/spaces/*/delegations.json" >/dev/null; then
	fail 'a record was written for a refused spawn'
else
	pass 'nothing was recorded'
fi

# --------------------------------------------- resolution by project path --
new_case 'spawn resolves its space from --cwd'
run "$DELEGATE" spawn w1 --cwd "$OTHER" "write one line in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
if [ -f "$(delegations other)" ]; then pass 'the record lands in the space that claims the folder'; else fail 'no record in space other' "$OUT"; fi
if [ "$(wc -c <"$(delegations other)")" -gt 2 ]; then pass 'the record is not empty'; else fail 'the record is empty'; fi
case $OUT in
*"$PI_SPACE_ROOT/state/spaces/other/reports/w1.md"*) pass 'the report path is inside that space' ;;
*) fail 'the report path is not inside the resolved space' "$OUT" ;;
esac

new_case 'the longest project path wins'
run "$DELEGATE" spawn w2 --cwd "$INNER" "write two lines in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
case $OUT in
*"state/spaces/inner/reports/w2.md"*) pass 'the inner space claims its own subfolder' ;;
*) fail 'the outer space won a folder the inner one owns' "$OUT" ;;
esac

new_case 'the resolver, called directly'
RESOLVED=$(
	# shellcheck source=/dev/null
	. "$ROOT/bin/space-lib.sh"
	printf '%s|%s|%s' "$(space_resolve "$INNER")" "$(space_resolve "$OUTER")" "$(space_resolve "$WORK")"
)
if [ "$RESOLVED" = "inner|outer|" ]; then
	pass 'inner, then outer, then nothing'
else
	fail "resolved '$RESOLVED'"
fi

# --------------------------------------------------------- --space on its own --
new_case '--space names the space for a folder no space claims'
run "$DELEGATE" spawn w3 --space other --cwd "$STRAY" "write three lines in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
case $OUT in
*"state/spaces/other/reports/w3.md"*) pass 'the record went to the space --space named' ;;
*) fail '--space was ignored' "$OUT" ;;
esac

new_case '--space with a name that is not a space'
run "$DELEGATE" spawn w4 --space nowhere --cwd "$OUTER" "write four lines"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'an unknown space was accepted' "$OUT"; fi
case $OUT in
*"no such space: nowhere"*) pass 'the refusal names the space' ;;
*) fail 'the refusal does not name the space' "$OUT" ;;
esac

# ------------------------------------------------------------------- the list --
new_case 'list shows the space, and --space filters'
run "$DELEGATE" list
if printf '%s\n' "$OUT" | grep -q '^w1 .*other'; then pass 'each row carries its space'; else fail 'the space column is missing or wrong' "$OUT"; fi
run "$DELEGATE" list --space inner
if printf '%s\n' "$OUT" | grep -q '^w2 '; then pass 'the filter keeps the space it names'; else fail 'the filter dropped the space it names' "$OUT"; fi
if printf '%s\n' "$OUT" | grep -q '^w1 '; then fail 'the filter let another space through' "$OUT"; else pass 'the filter drops other spaces'; fi
run "$DELEGATE" list --space nowhere
if [ "$RC" -ne 0 ]; then pass 'an unknown space is refused'; else fail 'an unknown space listed something' "$OUT"; fi

# ------------------------------------------------ the old record, read not written --
new_case 'the legacy record is read, never written'
LEGACY="$PI_LEGACY_BOSS_ROOT/state/delegations.json"
cat >"$LEGACY" <<JSON
{"oldworker":{"space":"sp-old","terminal":"t-old","cwd":"$OTHER","mode":"bare","thinking":"high","report":"$PI_LEGACY_BOSS_ROOT/reports/oldworker.md"}}
JSON
BEFORE_SUM=$(cksum "$LEGACY")
run "$DELEGATE" list
if printf '%s\n' "$OUT" | grep -q '^oldworker '; then pass 'a worker from the old record is listed'; else fail 'the old record is not read' "$OUT"; fi
run "$DELEGATE" spawn w5 --space other --cwd "$OTHER" "write five lines in a.txt"
AFTER_SUM=$(cksum "$LEGACY")
if [ "$BEFORE_SUM" = "$AFTER_SUM" ]; then pass 'the old record is untouched by a new spawn'; else fail 'the old record was written'; fi
if [ -f "$(delegations other)" ] && grep -q '"w5"' "$(delegations other)"; then pass 'the new worker is in the space record'; else fail 'the new worker was not recorded in its space'; fi

# ------------------------------------------------------------ a duplicate slug --
new_case 'a slug already used in another space'
run "$DELEGATE" spawn w1 --space inner --cwd "$INNER" "write one line in a.txt"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'the same slug was reused in another space' "$OUT"; fi
case $OUT in
*"already exists in space 'other'"*) pass 'the refusal names the space that holds it' ;;
*) fail 'the refusal does not name the space' "$OUT" ;;
esac

# ------------------------------------------------------------------- what --space does not cover --
new_case 'wait and close find the worker without --space'
run "$DELEGATE" wait w1 --timeout 1
case $OUT in
*"no such"*) fail 'wait could not find the worker' "$OUT" ;;
*) pass 'wait reads the worker record by slug' ;;
esac

# ------------------------------- a brief a person wrote at specs/<slug>.md is never overwritten --
# The path a person writes their brief at is the obvious one, and spawn used to write its generated
# wrapper there, one second after the brief landed: the worker booted on "Read this spec and do it"
# pointing at itself. Three workers were spent on that stub in one night. The wrapper is now
# specs/<slug>.spawn.md, a hand-written specs/<slug>.md is the task verbatim, and the record names it.
BRIEF_PROJ="$WORK/briefprj"
mkdir -p "$BRIEF_PROJ"
printf 'x\n' >"$BRIEF_PROJ/a.txt"
"$SPACE" new --name brief --project "$BRIEF_PROJ" >/dev/null
BRIEF_SPEC="$PI_SPACE_ROOT/state/spaces/brief/specs/wb.md"
BRIEF_WRAPPER="$PI_SPACE_ROOT/state/spaces/brief/specs/wb.spawn.md"
mkdir -p "$(dirname "$BRIEF_SPEC")"
printf '# a brief a person wrote\n\nDo the thing in a.txt, and nothing else.\n' >"$BRIEF_SPEC"
BRIEF_SUM=$(cksum "$BRIEF_SPEC")

new_case 'a hand-written spec survives spawn byte-identical'
run "$DELEGATE" spawn wb --cwd "$BRIEF_PROJ" "write one line in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
if [ "$(cksum "$BRIEF_SPEC")" = "$BRIEF_SUM" ]; then
	pass 'the brief is byte-identical after spawn'
else
	fail 'spawn rewrote the brief' "$(cat "$BRIEF_SPEC")"
fi
if [ -f "$BRIEF_WRAPPER" ]; then pass 'the wrapper is specs/<slug>.spawn.md'; else fail 'no wrapper at specs/<slug>.spawn.md'; fi
if grep -qxF "Read \`$BRIEF_SPEC\` and do it." "$BRIEF_WRAPPER"; then
	pass 'the wrapper points at the brief instead of copying it'
else
	fail 'the wrapper does not point at the brief' "$(sed -n '/^## Task/,/^## Rules/p' "$BRIEF_WRAPPER")"
fi
if grep -qF 'The line that summoned this worker was: write one line in a.txt' "$BRIEF_WRAPPER"; then
	pass 'the summoning line is kept as context, and labelled as such'
else
	fail 'the summoning line was dropped' "$(sed -n '/^## Task/,/^## Rules/p' "$BRIEF_WRAPPER")"
fi
if grep -qF "\"spec\": \"$BRIEF_SPEC\"" "$(delegations brief)"; then
	pass "the record's spec names the hand-written file"
else
	fail "the record does not name the brief as the spec" "$(cat "$(delegations brief)")"
fi

new_case 'with no hand-written spec the wrapper carries the task'
NOPRJ="$WORK/nobriefprj"
mkdir -p "$NOPRJ"
printf 'x\n' >"$NOPRJ/a.txt"
"$SPACE" new --name nobrief --project "$NOPRJ" >/dev/null
NOPR_WRAPPER="$PI_SPACE_ROOT/state/spaces/nobrief/specs/wc.spawn.md"
run "$DELEGATE" spawn wc --cwd "$NOPRJ" "write two lines in a.txt"
if [ "$RC" -eq 0 ]; then pass 'the spawn succeeds'; else fail 'the spawn failed' "$OUT"; fi
if [ -f "$NOPR_WRAPPER" ] && grep -qF 'write two lines in a.txt' "$NOPR_WRAPPER"; then
	pass 'the wrapper carries the task text'
else
	fail 'the wrapper does not carry the task' "$(cat "$NOPR_WRAPPER" 2>/dev/null)"
fi
if grep -qF "\"spec\": \"$NOPR_WRAPPER\"" "$(delegations nobrief)"; then
	pass 'the record names the wrapper it wrote'
else
	fail 'the record does not name the wrapper' "$(cat "$(delegations nobrief)")"
fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
