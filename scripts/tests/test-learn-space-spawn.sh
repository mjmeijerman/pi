#!/usr/bin/env bash
# Tests for `agent-pane.sh spawn … --space SLUG` — the learner's launch.
#
# A learner used to be a space of its own (`space.new`), and it is now a tab in the space
# whose project compacted. That is one distinction and it is entirely visible in the argv
# the stub host records, so it is checked here rather than argued in a comment:
#
#   1. `--space` calls `tab.new` with that space's id, and `space.new` is never called:
#      a learner that made a space would be a second desk, not a tab at the first one;
#   2. its `close` closes that tab and never the space: a finished worker must not take
#      the person's desk with it;
#   3. `--space` naming a space no record has is refused in words, not opened somewhere.
#
# Every case runs the real script against a stub `herdr-app` and `hc`, with the record in a
# scratch `PI_SPACE_ROOT`. No network, no real herdr, no space on this machine touched.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/agent-pane.sh"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export STATE="$WORK/panes.json"
export HERDR_LOG="$WORK/herdr.log"
export PISANDBOX="$WORK/pisandbox"
mkdir -p "$HOME" "$WORK/stub" "$PI_SPACE_ROOT/state/spaces/pi" "$WORK/proj"
PATH="$WORK/stub:$PATH"
export PATH

failures=0
ok() { printf 'ok   %s\n' "$1"; }
no() {
	printf 'FAIL %s\n' "$1" >&2
	[ -n "${2:-}" ] && printf '     %s\n' "$2" >&2
	failures=$((failures + 1))
}

# herdr-app records every call and answers like the real one: ids for a new tab, nothing
# for a close. `space.new` answers too — so a call to it would be recorded, and found.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do tab.new") printf '{"space":"s1","tab":"tb9","pane":"p9","terminal":"t9"}\n' ;;
"do space.new") printf '{"space":"s-boss","tab":"tb-boss","terminal":"t-boss"}\n' ;;
"do tab.close" | "do space.close") printf '{}\n' ;;
"ls "*) printf '{"spaces":[{"id":"s1","name":"pi"}]}\n' ;;
*) printf '{}\n' ;;
esac
STUB
cat >"$WORK/stub/hc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
read) printf 'escape interrupt  /Commands\n' ;;
send) exit 0 ;;
*) printf '{}\n' ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$PISANDBOX"
chmod +x "$WORK/stub/"* "$PISANDBOX"

# The space record `bin/space new --kind harness --project ~/pi` writes, with the id filled
# in. A project space is the same file with another `kind`.
cat >"$PI_SPACE_ROOT/state/spaces/pi/space.json" <<JSON
{"name":"pi","id":"s1","kind":"harness","project":"$WORK/proj","git":true}
JSON
printf '# learn\n' >"$WORK/spec.md"

# --------------------------------------------------- a learner is a tab, not a space ---
out=$(bash "$SCRIPT" spawn learn-1200 "$WORK/spec.md" --cwd "$WORK/proj" --space pi --sandbox 2>"$WORK/err.log")
status=$?
log=$(cat "$HERDR_LOG" 2>/dev/null || true)
if [ "$status" != 0 ]; then
	no "spawn --space exits 0" "exit $status: $(cat "$WORK/err.log")"
else
	ok "spawn --space exits 0"
fi
if printf '%s' "$log" | grep -q '^do tab.new '; then
	ok "it opens a tab"
else
	no "it opens a tab" "herdr-app was asked: ${log:-nothing}"
fi
if printf '%s' "$log" | grep -q -- '--space s1'; then
	ok "the tab is opened in the space's herdr id"
else
	no "the tab is opened in the space's herdr id" "asked: ${log:-nothing}"
fi
if printf '%s' "$log" | grep -q 'space\.new'; then
	no "space.new is never called for a learner" "asked: $log"
else
	ok "space.new is never called for a learner"
fi
if printf '%s' "$log" | grep -q -- '--focus false'; then
	ok "the tab is added without taking the view"
else
	no "the tab is added without taking the view" "asked: ${log:-nothing}"
fi
case $out in
*'"tab":"tb9"'*'"space":"pi"'*) ok "the report names the tab and the space" ;;
*) no "the report names the tab and the space" "stdout: ${out:-nothing}" ;;
esac
if printf '%s' "$log" | grep -q 'pisandbox'; then
	ok "the pi inside it runs sandboxed"
else
	no "the pi inside it runs sandboxed" "argv sent to tab.new: ${log:-nothing}"
fi

# ------------------------------------------------ close takes the tab, not the desk ---
: >"$HERDR_LOG"
out=$(bash "$SCRIPT" close learn-1200 2>"$WORK/err.log")
status=$?
log=$(cat "$HERDR_LOG" 2>/dev/null || true)
if [ "$status" = 0 ]; then
	ok "close exits 0"
else
	no "close exits 0" "exit $status: $(cat "$WORK/err.log")"
fi
if printf '%s' "$log" | grep -q '^do tab.close --id tb9'; then
	ok "close closes the tab"
else
	no "close closes the tab" "asked: ${log:-nothing}"
fi
if printf '%s' "$log" | grep -q 'space\.close'; then
	no "close never closes the space it was a tab in" "asked: $log"
else
	ok "close never closes the space it was a tab in"
fi

# ------------------------------------------------------------- an unknown space -----
out=$(bash "$SCRIPT" spawn learn-1201 "$WORK/spec.md" --cwd "$WORK/proj" --space nosuch 2>&1)
status=$?
if [ "$status" != 0 ] && printf '%s' "$out" | grep -q 'no such space: nosuch'; then
	ok "--space naming no record is refused, naming it"
else
	no "--space naming no record is refused, naming it" "exit $status: $out"
fi

printf '\n%s\n' "$([ "$failures" = 0 ] && echo "test-learn-space-spawn: every case passed" || echo "test-learn-space-spawn: $failures failed")"
[ "$failures" = 0 ]
