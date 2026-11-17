#!/usr/bin/env bash
# Tests for scripts/desktop-audio-guard.sh — the user unit that puts the ALSA
# sink nodes back when WirePlumber lost the login EBUSY race and gave up.
#
# Why these exist: the guard is silent on a healthy machine by design, so the
# only place its decisions can be seen is a fake stack. Every case runs the real
# script with the probes pointed at throwaway commands in a temp dir, which is
# also the proof that the guard never touches the live PipeWire: the restart it
# "runs" is a counter in $WORK.
#
# Run it directly, or through `make scripts-test`.
#
# shellcheck disable=SC2015
# `A && pass || fail` is the goal: both helpers swallow their status, so the
# right-hand side cannot run after a passing case. Written as if/then/else in
# every line it would triple the length of the file for no reading gain.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop-audio-guard.sh"
[ -f "$SCRIPT" ] || {
	printf 'FATAL: %s is missing\n' "$SCRIPT" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf 'FAIL %s: %s\n' "$CASE" "$1"; }

case_start() {
	CASE="$1"
	CASE_N=$((CASE_N + 1))
	OUT=""
	STATUS=0
	# Fresh fixture per case: the fake stack lives beside its own counters.
	FIX="$WORK/case$CASE_N"
	mkdir -p "$FIX/cards" "$FIX/state"
	RESTARTS="$FIX/restarts"
	: >"$RESTARTS"
}

# A machine that has a sound card. Cases that need one call this; the no-audio
# case leaves $FIX/cards empty on purpose.
make_hardware() {
	mkdir -p "$FIX/cards/card0"
	printf 'ID: 0123456789abcdef\n' >"$FIX/cards/card0/id"
}

# A pw-dump that prints whatever is in $FIX/dump.json — the fixture decides
# which nodes and which metadata exist.
make_probes() {
	cat >"$FIX/pw-dump" <<EOF
#!/usr/bin/env bash
cat "$FIX/dump.json" 2>/dev/null
EOF
	cat >"$FIX/pw-cli" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
	cat >"$FIX/wpctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
	chmod +x "$FIX/pw-dump" "$FIX/pw-cli" "$FIX/wpctl"
	# The restart only counts, and may swap in a different dump: $FIX/after.json
	# is applied when the case wrote one (the "restart fixed it" case).
	cat >"$FIX/restart" <<EOF
#!/usr/bin/env bash
printf 'restart\n' >>"$RESTARTS"
[ -f "$FIX/after.json" ] && cp "$FIX/after.json" "$FIX/dump.json"
exit 0
EOF
	chmod +x "$FIX/restart"
}

run_guard() {
	OUT="$(
		AUDIO_GUARD_PW_DUMP="$FIX/pw-dump" \
			AUDIO_GUARD_PW_CLI="$FIX/pw-cli" \
			AUDIO_GUARD_WPCTL="$FIX/wpctl" \
			AUDIO_GUARD_RESTART="$FIX/restart" \
			AUDIO_GUARD_CARDS_DIR="$FIX/cards" \
			AUDIO_GUARD_WP_STATE="$FIX/wp-default-nodes" \
			AUDIO_GUARD_STATE_DIR="$FIX/state" \
			AUDIO_GUARD_BOOT_ID=testboot \
			AUDIO_GUARD_READY_WAIT="${READY_WAIT:-1}" \
			AUDIO_GUARD_RECHECK_WAIT=1 \
			AUDIO_GUARD_BACKOFF=0 \
			AUDIO_GUARD_MAX_RESTARTS="${MAX_RESTARTS:-2}" \
			bash "$SCRIPT" 2>&1
	)"
	STATUS=$?
}

restart_count() { grep -c '^restart$' "$RESTARTS" 2>/dev/null || true; }

HDMI="alsa_output.pci-0000_01_00.1.hdmi-stereo-extra1"
USB="alsa_output.usb-Generic_USB_Audio-00.HiFi__Speaker__sink"

# $1 = sink node names to present (comma separated, may be empty),
# $2 = the node the configuration names as default (may be empty).
write_dump() {
	local nodes="$1" want="$2" first=1
	{
		printf '[\n'
		local IFS=,
		for node in $nodes; do
			[ -z "$node" ] && continue
			[ $first -eq 0 ] && printf ',\n'
			first=0
			printf '  { "id": 66, "type": "PipeWire:Interface:Node",\n    "info": { "props": {\n      "media.class": "Audio/Sink",\n      "node.name": "%s" } } }' "$node"
		done
		if [ -n "$want" ]; then
			[ $first -eq 0 ] && printf ',\n'
			first=0
			printf '  { "id": 900, "type": "PipeWire:Interface:Metadata",\n    "metadata": [\n      { "subject": 0, "key": "default.configured.audio.sink", "type": "Spa:String:JSON", "value": { "name": "%s" } }\n    ] }' "$want"
		fi
		printf '\n]\n'
	} >"$FIX/dump.json"
	unset IFS
}

# --- 1. no audio hardware: a machine without cards is left alone --------------
case_start "no audio hardware"
make_probes
: >"$FIX/dump.json"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"desktop-audio-guard: no audio hardware"*) pass "logs the no-op reason" ;;
*) fail "did not log the no-op reason: $OUT" ;;
esac
[ "$(restart_count)" = "0" ] && pass "never restarts the stack" || fail "restarted the stack"

# --- 2. pipewire never answers: no action, no failed unit ---------------------
case_start "pipewire does not answer"
make_hardware
make_probes
: >"$FIX/dump.json"
cat >"$FIX/wpctl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FIX/wpctl"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"pipewire did not answer"*) pass "logs the give-up line" ;;
*) fail "did not log the give-up line: $OUT" ;;
esac
[ "$(restart_count)" = "0" ] && pass "never restarts a stack that is not up" || fail "restarted the stack"

# --- 3. healthy stack: says ok and exits 0 without restarting -----------------
case_start "the configured default has a node"
make_hardware
make_probes
write_dump "$USB,$HDMI" "$HDMI"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"ok: 2 ALSA sink(s) present"*) pass "counts the sinks" ;;
*) fail "did not report the sinks: $OUT" ;;
esac
case "$OUT" in
*"ok: configured default $HDMI has a node — no action"*) pass "confirms the configured default" ;;
*) fail "did not confirm the configured default: $OUT" ;;
esac
[ "$(restart_count)" = "0" ] && pass "leaves the stack and the default alone" || fail "restarted a healthy stack"

# --- 4. no sink at all, restart brings one back: one attempt, exit 0 ----------
case_start "restart repairs an empty stack"
make_hardware
make_probes
: >"$FIX/dump.json"
write_dump "$USB,$HDMI" "$HDMI"
cp "$FIX/dump.json" "$FIX/after.json"
: >"$FIX/dump.json"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"restarting wireplumber (attempt 1/2)"*) pass "logs the attempt" ;;
*) fail "did not log the attempt: $OUT" ;;
esac
case "$OUT" in
*"fixed on attempt 1: 2 ALSA sink(s) back"*) pass "logs the fix" ;;
*) fail "did not log the fix: $OUT" ;;
esac
[ "$(restart_count)" = "1" ] && pass "restarted exactly once" || fail "restarted $(restart_count) times"

# --- 5. restart never helps: bounded at two attempts, exits 1 -----------------
case_start "restart cannot repair it"
make_hardware
make_probes
: >"$FIX/dump.json"
run_guard
[ "$STATUS" -eq 1 ] && pass "exits 1 so the unit is visibly failed" || fail "exits $STATUS, wanted 1"
[ "$(restart_count)" = "2" ] && pass "stopped after two attempts" || fail "restarted $(restart_count) times, wanted 2"
case "$OUT" in
*"still no ALSA sink after 2 restart(s)"*) pass "logs the give-up line" ;;
*) fail "did not log the give-up line: $OUT" ;;
esac

# --- 6. a remembered-but-absent sink is not a sink ----------------------------
# The daemon keeps `default.audio.sink` in its metadata even when the node was
# never created. A grep for node.name must not read that as a live sink, or the
# guard would no-op exactly in the case it exists for.
case_start "metadata names a sink that is not there"
make_hardware
make_probes
write_dump "" "$HDMI"
MAX_RESTARTS=1 run_guard
[ "$STATUS" -eq 1 ] && pass "treats it as missing" || fail "exits $STATUS, wanted 1"
[ "$(restart_count)" = "1" ] && pass "restarts for the absent node" || fail "did not restart"

# --- 7. other sinks work but the configured default's node is gone ------------
# This is the boot the user complained about: the list is short by the device
# they picked. One repair, bounded, and the default is never reassigned.
case_start "configured default node is missing, other sinks work"
make_hardware
make_probes
write_dump "$USB" "$HDMI"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"configured default $HDMI has no node — restarting wireplumber once"*) pass "logs the single repair" ;;
*) fail "did not log the single repair: $OUT" ;;
esac
[ "$(restart_count)" = "1" ] && pass "restarted exactly once" || fail "restarted $(restart_count) times"
case "$OUT" in
*"still has no node after one restart — other sinks work, leaving it"*) pass "leaves an unplugged device alone" ;;
*) fail "did not leave it alone: $OUT" ;;
esac
[ -e "$FIX/state/default-repair.testboot" ] && pass "remembers the repair for this boot" || fail "wrote no repair marker"

# --- 8. the same broken default in the same boot is not repaired twice --------
case_start "already repaired this boot"
make_hardware
make_probes
write_dump "$USB" "$HDMI"
: >"$FIX/state/default-repair.testboot"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
[ "$(restart_count)" = "0" ] && pass "does not restart again" || fail "restarted $(restart_count) times"
case "$OUT" in
*"already repaired once this boot — leaving it"*) pass "logs why it stopped" ;;
*) fail "did not log why it stopped: $OUT" ;;
esac

# --- 9. a machine with no configured default is not "broken" ------------------
case_start "no configured default"
make_hardware
make_probes
write_dump "$USB" ""
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
[ "$(restart_count)" = "0" ] && pass "does not restart" || fail "restarted $(restart_count) times"
case "$OUT" in
*"no configured default sink"*) pass "says there is nothing to compare" ;;
*) fail "did not say why: $OUT" ;;
esac

# --- 10. an older daemon without the metadata still has the state file --------
# WirePlumber writes default.configured.audio.sink into
# ~/.local/state/wireplumber/default-nodes as well. If the dump carries no
# metadata, the guard must still know which node the user's configuration names.
case_start "configured default comes from the state file"
make_hardware
make_probes
write_dump "$USB" ""
printf 'default.configured.audio.sink=%s\n' "$HDMI" >"$FIX/wp-default-nodes"
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"configured default $HDMI has no node"*) pass "read the state file" ;;
*) fail "did not read the state file: $OUT" ;;
esac
[ "$(restart_count)" = "1" ] && pass "repaired once" || fail "restarted $(restart_count) times"

# --- 11. the metadata entry wrapped over lines is still read -----------------
# pw-dump prints one metadata entry per line today, but a wrapped entry must not
# silently fall through to a stale state file and name the wrong node.
case_start "wrapped metadata names the missing default"
make_hardware
make_probes
cat >"$FIX/dump.json" <<EOF
[
  { "id": 90, "type": "PipeWire:Interface:Node",
    "info": { "props": {
      "media.class": "Audio/Sink",
      "node.name": "$USB" } } },
  { "id": 900, "type": "PipeWire:Interface:Metadata",
    "metadata": [
      { "subject": 0, "key": "default.configured.audio.sink", "type": "Spa:String:JSON",
        "value": { "name": "$HDMI" } }
    ] }
]
EOF
run_guard
[ "$STATUS" -eq 0 ] && pass "exits 0" || fail "exits $STATUS, wanted 0"
case "$OUT" in
*"configured default $HDMI has no node"*) pass "read the wrapped entry" ;;
*) fail "did not read the wrapped entry: $OUT" ;;
esac

printf '\n%s case(s), %s ok, %s failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
