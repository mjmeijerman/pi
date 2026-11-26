#!/usr/bin/env bash
# Tests that a worker mode which cannot run on this host is said out loud instead of becoming a
# dead tab: the mode check before `tab.new`, the one-line fallback and its decision row, the
# restart reading the recorded mode back, and the warning when a start is not witnessed.
#
# Why these exist. On native Windows `bin/pi-sandboxed:35` refuses and exits, and `delegate spawn`
# picked exactly that mode from jev's conservative default, opened the tab anyway and printed a
# success JSON for a worker that never ran (state/spaces/harness/reports/spawn-check.md). The tab
# printed the refusal, dropped to a PowerShell prompt and the follow-up `hc send` landed there. Two
# halves: a mode the host cannot run is refused or replaced by `bare` before a tab exists, and a
# start nobody witnessed prints the terminal's own last line.
#
# The pure half is host-independent: `shell_mode_ok` is asked both ways by stubbing `shell_is_win`,
# which is the one predicate it reads. The end-to-end half needs the host it describes — native
# Windows, where `sandboxed` and `no-net` are unavailable — and says so instead of pretending on
# Linux. No network, no herdr, no pi: the stubs are the shape
# scripts/tests/delegate-spawn-reported.test.sh builds.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELEGATE=${PI_MODE_DELEGATE:-$ROOT/bin/delegate}
SPACE=${PI_MODE_SPACE:-$ROOT/bin/space}
RESOLVE="$ROOT/bin/shell-resolve.sh"
for f in "$DELEGATE" "$SPACE" "$RESOLVE"; do
	[ -e "$f" ] || {
		printf 'FATAL: %s is missing\n' "$f" >&2
		exit 1
	}
done

# Native Windows is the host this file is about. `shell_is_win` answers with OSTYPE, so ask it
# rather than spelling the shell test a second time.
case ${OSTYPE:-} in msys* | cygwin* | win32) IS_WIN=1 ;; *) IS_WIN=0 ;; esac
[ -n "${MSYSTEM:-}" ] && IS_WIN=1

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/state"
export DELEGATE_POLL_SECONDS=0
export PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"

# The waits are not what is under test: a stub `sleep` keeps the 40-second start watch and the
# poll loop from costing the suite a minute each.
printf '#!/bin/sh\nexit 0\n' >"$WORK/stub/sleep"

# Every tab.new the delegate opens is appended here, so "no tab was opened" and "which runner the
# restart used" are facts about a file and not about prose.
: >"$WORK/tabs.log"
cat >"$WORK/stub/herdr-app" <<STUB
#!/usr/bin/env bash
case "\$1 \$2" in
"do space.new") printf '{"space":"sp1","tab":"tb1","pane":"p1","terminal":"t1"}\n' ;;
"do tab.new")
	printf '%s\n' "\$*" >>"$WORK/tabs.log"
	printf '{"space":"sp1","tab":"tb2","pane":"p2","terminal":"t2"}\n'
	;;
"do tab.close") printf '{}\n' ;;
"ls "*) printf '{"spaces":[]}\n' ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/hc" <<STUB
#!/usr/bin/env bash
case "\$1" in
ls) printf '{"terminals":[{"id":"t-boss","state":"idle"}]}\n' ;;
# STUB_HC_READ is the tab's screen: unset means pi came up (the banner the spawn waits for).
read) if [ -n "\${STUB_HC_READ:-}" ]; then printf '%s\n' "\$STUB_HC_READ"; else printf 'escape interrupt\n'; fi ;;
send) exit 0 ;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nprintf "[]\\n"\n' >"$WORK/stub/gh"
# jev answers the mode the case is about; the route and the effort stay out of the way.
cat >"$PI_SPACE_ROOT/bin/jev" <<'STUB'
#!/usr/bin/env bash
case "$1" in
plan)
	m=${STUB_JEV_MODE:-bare}
	printf '{"mode":"%s","route":"remote","thinking":"medium","reason":"stub jev","answered":{"mode":"%s","route":"remote","thinking":"medium"}}\n' "$m" "$m"
	;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-bare"
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-sandboxed"
printf '#!/usr/bin/env bash\nexit 0\n' >"$PI_SPACE_ROOT/bin/pi-nonet"
chmod +x "$WORK/stub/"* "$PI_SPACE_ROOT/bin/"*

PASS_N=0
FAIL_N=0
SKIP_N=0
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
skip() { SKIP_N=$((SKIP_N + 1)); printf 'skip %s: %s\n' "$CASE" "$1"; }
run() { OUT=$("$@" 2>&1); RC=$?; }

PRJ="$WORK/proj"
mkdir -p "$PRJ"
printf 'x\n' >"$PRJ/a.txt"
"$SPACE" new --name modes --project "$PRJ" >/dev/null 2>&1
SD="$PI_SPACE_ROOT/state/spaces/modes"
REC="$SD/delegations.json"
mkdir -p "$SD/reports" "$SD/state"
: >"$REC"

# probe_modes <win 0|1> — `shell_mode_ok` asked for every mode with shell_is_win stubbed to 0
# (it is Windows) or 1 (it is not). One line per mode: `<mode> <exit status>`.
probe_modes() {
	bash -c '
		. "$1"
		w=$2
		shell_is_win() { return "$w"; }
		for m in bare sandboxed no-net nope; do
			shell_mode_ok "$m"
			printf "%s %s\n" "$m" "$?"
		done' _ "$RESOLVE" "$1"
}

new_case 'the helper answers per host'
EXPECT_WIN='bare 0
sandboxed 1
no-net 1
nope 2'
EXPECT_NIX='bare 0
sandboxed 0
no-net 0
nope 2'
GOT=$(probe_modes 0)
if [ "$GOT" = "$EXPECT_WIN" ]; then
	pass 'on native Windows: bare available, sandboxed and no-net not, an unknown mode is not an answer'
else
	fail 'the Windows answers are wrong' "$GOT"
fi
GOT=$(probe_modes 1)
if [ "$GOT" = "$EXPECT_NIX" ]; then
	pass 'on Linux, macOS and WSL: all three modes available'
else
	fail 'the non-Windows answers are wrong' "$GOT"
fi

new_case 'an explicit mode the host cannot run is refused before any tab is opened'
if [ "$IS_WIN" = 1 ]; then
	: >"$WORK/tabs.log"
	STUB_JEV_MODE=sandboxed run env STUB_JEV_MODE=sandboxed "$DELEGATE" spawn w-sbx --cwd "$PRJ" --mode sandboxed "write one line in b.txt"
	if [ "$RC" -ne 0 ]; then pass "the spawn exits $RC, not 0"; else fail 'a mode the host cannot run was accepted'; fi
	case $OUT in
	*"cannot run on this host"*) pass 'the refusal says why' ;;
	*) fail 'the refusal does not say why' "$OUT" ;;
	esac
	case $OUT in
	*"--mode bare"*) pass 'it names the flag that works here' ;;
	*) fail 'the flag that works is not named' "$OUT" ;;
	esac
	if [ -s "$WORK/tabs.log" ]; then
		fail 'a tab was opened for a mode that cannot run' "$(cat "$WORK/tabs.log")"
	else
		pass 'no tab was opened, so there is nothing to clean up'
	fi
	SLUGS=$(node -e 'try{process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).join(","))}catch{}' "$REC")
	if [ -z "$SLUGS" ]; then pass 'no worker was recorded for the refused spawn'; else fail "the record changed: $SLUGS"; fi
else
	skip 'this host has a sandbox; the refusal is Windows-only and the pure case above pins the rule'
fi

new_case "a mode that came from jev falls back to bare with one line and a decision row"
if [ "$IS_WIN" = 1 ]; then
	: >"$WORK/tabs.log"
	: >"$SD/state/decisions.jsonl"
	STUB_JEV_MODE=sandboxed run env STUB_JEV_MODE=sandboxed "$DELEGATE" spawn w-fall --cwd "$PRJ" "write one line in b.txt"
	if [ "$RC" -eq 0 ]; then pass 'the spawn starts a worker instead of a dead tab'; else fail "the spawn failed: $OUT"; fi
	NOTES=$(printf '%s\n' "$OUT" | grep -c 'note: mode sandboxed cannot run on this host')
	if [ "$NOTES" = 1 ]; then
		pass 'exactly one line says why bare is used'
	else
		fail "expected one fallback line, saw $NOTES" "$OUT"
	fi
	case $OUT in
	*'"mode":"bare"'*) pass 'the JSON says the mode that actually runs' ;;
	*) fail 'the JSON still reports the mode that cannot run' "$OUT" ;;
	esac
	case $OUT in
	*'using mode=bare.'*) pass 'the line names the mode that is used instead' ;;
	*) fail 'the fallback line does not say what is used' "$OUT" ;;
	esac
	ROW=$(node -e '
		const fs=require("fs");
		const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
		const m=lines.filter((l)=>l.command==="mode").pop();
		process.stdout.write(m?JSON.stringify(m):"");' "$SD/state/decisions.jsonl")
	case $ROW in
	*'"decision":"bare"'*) pass 'the mode decision row records bare' ;;
	*) fail 'the decision row does not record the fallback' "${ROW:-no mode row}" ;;
	esac
	case $ROW in
	*'"jev":"sandboxed"'*) pass "the row keeps jev's own answer beside it" ;;
	*) fail "jev's answer is not on the row" "${ROW:-no mode row}" ;;
	esac
	printf '{}\n' >"$REC"
else
	skip 'this host has a sandbox, so jev'"'"'s sandboxed answer runs and nothing falls back'
fi

new_case 'a start nobody witnessed prints the terminal'"'"'s own last line'
: >"$WORK/tabs.log"
STUB_HC_READ='pi-sandboxed: no sandbox on native Windows; run pi under WSL2' \
	run env STUB_HC_READ='pi-sandboxed: no sandbox on native Windows; run pi under WSL2' \
	"$DELEGATE" spawn w-dead --cwd "$PRJ" "write one line in b.txt"
if [ "$RC" -eq 0 ]; then
	pass 'the spawn still exits 0: the tab exists and the wait can still watch it'
else
	fail "the spawn exited $RC; the report has to say why if that changes" "$OUT"
fi
case $OUT in
*"warning: w-dead did not start in terminal t2"*) pass 'the warning names the worker and its terminal' ;;
*) fail 'the warning does not name the terminal' "$OUT" ;;
esac
case $OUT in
*"no sandbox on native Windows"*) pass "the terminal's own last line is in the spawn output" ;;
*) fail 'the reason the tab died is not in the output' "$OUT" ;;
esac
printf '{}\n' >"$REC"

new_case 'a restart reads the recorded mode back and starts bare'
if [ "$IS_WIN" = 1 ]; then
	: >"$WORK/tabs.log"
	printf '{"w-r":{"slug":"w-r","kind":"tab","space":"sp1","spaceName":"modes","tab":"tb1","pane":"p1","terminal":"t1","cwd":"%s","mode":"sandboxed","thinking":"low","spec":"%s/specs/w-r.md","report":"%s/reports/w-r.md"}}\n' \
		"$PRJ" "$SD" "$SD" >"$REC"
	mkdir -p "$SD/specs"
	printf '# Worker w-r\n\nA spec left behind by a spawn that predates the host check.\n' >"$SD/specs/w-r.md"
	run timeout 120 "$DELEGATE" wait w-r --forever
	if printf '%s\n' "$OUT" | grep -q 'note: mode sandboxed cannot run on this host'; then
		pass 'the restart prints the same line the spawn prints'
	else
		fail 'the restart said nothing about the mode' "$OUT"
	fi
	if grep -q 'pi-bare' "$WORK/tabs.log"; then
		pass 'the restarted tab runs pi-bare, not the mode that refuses'
	else
		fail 'the restarted tab does not run pi-bare' "$(cat "$WORK/tabs.log")"
	fi
else
	skip 'this host can run sandboxed, so there is no mode to read back and replace'
fi

printf '\n%s passed, %s failed, %s skipped\n' "$PASS_N" "$FAIL_N" "$SKIP_N"
[ "$FAIL_N" -eq 0 ]
