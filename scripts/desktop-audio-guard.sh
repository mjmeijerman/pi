#!/usr/bin/env bash
# desktop-audio-guard — put back the ALSA sink nodes WirePlumber gave up on.
#
# Radar Vol. 35 blip 20 (stateful guardrails, Trial): the guard asserts one
# invariant on the host — the audio stack has the sink nodes the user's
# configuration names — and repairs it with a bounded retry, logging every
# decision. The problem it fixes: at login two PipeWire stacks can overlap (the
# desktop-manager greeter's and the user session's) and the user session's ALSA
# opens return EBUSY:
#
#   pipewire[1886]: spa.alsa: 'hdmi:1,1': playback open failed: Device or resource busy
#   wireplumber[1888]: s-monitors: Failed to create
#     alsa_output.pci-0000_01_00.1.hdmi-stereo-extra1:
#     Object activation aborted: PipeWire proxy destroyed
#
# WirePlumber aborts that node and never retries, so the sink is gone for the
# whole session. When the sink that lost is the configured default — it was on
# this machine (default.configured.audio.sink = ...hdmi-stereo-extra1) — GNOME's
# output list is missing an entry and the default is silently something else.
# Measured on this machine 2026-11-17: 4 of the last 5 boots carried the EBUSY
# signature (see the report); the guard drives that to a repaired session.
#
# Two tiers, both bounded, because the two failures need different answers:
#   1. no ALSA sink node at all → restart WirePlumber, at most twice, backoff
#      between; still nothing → exit 1 so `systemctl --user status` shows it.
#   2. sinks exist but the configured default's node does not → restart
#      WirePlumber once per boot (marker file), then leave it alone: a device
#      that was unplugged or a monitor switched off must not be fought forever.
#
# Why a user unit: the failure is in the user session's PipeWire and the repair
# is `systemctl --user restart wireplumber`. Nothing here needs root.
#
# Why no `pactl`: pulseaudio-utils is not installed on this machine (`pactl`
# absent). The probes are pw-dump, then pw-cli, then wpctl — all from the
# pipewire package that is already a hard dependency of the stack being guarded.
#
# Why the guard never calls `wpctl set-default`: the default sink is the user's
# choice. WirePlumber restores the configured default itself once the missing
# node exists again, so the guard only ever restores nodes, never picks one.
set -uo pipefail

# Probes and actions, overridable so a test can point the guard at a fake stack
# without touching the live one.
DUMP_CMD="${AUDIO_GUARD_PW_DUMP:-pw-dump}"
CLI_CMD="${AUDIO_GUARD_PW_CLI:-pw-cli}"
STATUS_CMD="${AUDIO_GUARD_WPCTL:-wpctl}"
RESTART_CMD="${AUDIO_GUARD_RESTART:-systemctl --user restart wireplumber}"
CARDS_DIR="${AUDIO_GUARD_CARDS_DIR:-/proc/asound}"
STATE_DIR="${AUDIO_GUARD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/desktop-audio-guard}"
BOOT_ID="${AUDIO_GUARD_BOOT_ID:-$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)}"
WP_STATE_FILE="${AUDIO_GUARD_WP_STATE:-$HOME/.local/state/wireplumber/default-nodes}"

# Budgets. The unit's TimeoutStartSec is larger than the worst case here:
# ready 45 + (recheck 20 + backoff 2) + (recheck 20 + backoff 5) = 92 s.
READY_WAIT="${AUDIO_GUARD_READY_WAIT:-45}"
RECHECK_WAIT="${AUDIO_GUARD_RECHECK_WAIT:-20}"
MAX_RESTARTS="${AUDIO_GUARD_MAX_RESTARTS:-2}"
BACKOFF="${AUDIO_GUARD_BACKOFF:-2}"

log() { printf 'desktop-audio-guard: %s\n' "$*"; }

# Node names of the ALSA sinks that exist right now; empty output means the
# invariant is broken.
#
# `node.name` is a node property. The metadata the daemon stores is
# `"key": "default.audio.sink", "value": { "name": ... }`, which a grep for
# `node.name` does not match — so a sink that is remembered but was never
# created is not mistaken for one that exists.
alsa_sinks() {
	if command -v "$DUMP_CMD" >/dev/null 2>&1; then
		timeout 10 "$DUMP_CMD" 2>/dev/null |
			grep -o '"node\.name": "alsa_output\.[^"]*"' |
			sed 's/.*"\(alsa_output\.\)/\1/; s/"$//' | sort -u
	elif command -v "$CLI_CMD" >/dev/null 2>&1; then
		timeout 10 "$CLI_CMD" ls Node 2>/dev/null |
			grep -o 'node\.name = "alsa_output\.[^"]*"' |
			sed 's/.*"\(alsa_output\.\)/\1/; s/"$//' | sort -u
	fi
}

# The sink node the user's configuration asks for. WirePlumber keeps it in the
# daemon metadata; the state file is the fallback for an older daemon.
configured_default() {
	local name
	# The metadata entry may be one line or wrapped, so read the key line plus a
	# few after it rather than assuming the name sits on the same line.
	name=$(timeout 10 "$DUMP_CMD" 2>/dev/null |
		awk '/"key": "default\.configured\.audio\.sink"/{seen=1; n=0}
			seen{print; n++; if (n >= 4) exit}' |
		grep -o '"name": "[^"]*"' | head -1 |
		sed 's/.*"name": "//; s/"$//')
	if [ -z "$name" ]; then
		name=$(sed -n 's/^default\.configured\.audio\.sink=//p' \
			"$WP_STATE_FILE" 2>/dev/null | head -1)
	fi
	printf '%s' "$name"
}

has_hardware() {
	# No card directory: no audio hardware, nothing to guard — a no-op, not a
	# failed unit.
	for _card in "$CARDS_DIR"/card[0-9]*; do
		[ -e "$_card" ] && return 0
	done
	return 1
}

stack_answers() {
	command -v "$STATUS_CMD" >/dev/null 2>&1 || return 1
	timeout 3 "$STATUS_CMD" status >/dev/null 2>&1
}

restart_stack() {
	# Word splitting is the point: RESTART_CMD is a command line, not a path.
	# shellcheck disable=SC2086
	$RESTART_CMD >/dev/null 2>&1
}

# wait_for <seconds> [node-name] — resolves as soon as one ALSA sink exists, or
# as soon as that particular node exists.
wait_for() {
	local deadline=$((SECONDS + $1)) names
	while :; do
		names=$(alsa_sinks)
		if [ -n "$names" ]; then
			if [ -z "${2:-}" ]; then
				return 0
			fi
			if printf '%s\n' "$names" | grep -qxF -- "$2"; then
				return 0
			fi
		fi
		[ "$SECONDS" -ge "$deadline" ] && return 1
		sleep 1
	done
}

report_sinks() {
	log "$1: $(printf '%s\n' "$2" | wc -l) ALSA sink(s) back"
}

main() {
	if ! has_hardware; then
		log "no audio hardware under $CARDS_DIR — nothing to guard"
		return 0
	fi

	# The login oneshot is ordered after graphical-session.target, but the
	# session bus and pipewire itself can still be a second away. Waiting here is
	# what keeps the guard from "repairing" a stack that has not started yet.
	local deadline=$((SECONDS + READY_WAIT))
	until stack_answers; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			log "pipewire did not answer within ${READY_WAIT}s — leaving the stack alone"
			return 0
		fi
		sleep 1
	done

	local sinks wanted
	sinks=$(alsa_sinks)
	wanted=$(configured_default)

	if [ -n "$sinks" ]; then
		log "ok: $(printf '%s\n' "$sinks" | wc -l) ALSA sink(s) present"
		case "$wanted" in
		alsa_output.*) ;;
		*)
			log "no configured default sink of the form alsa_output.* — nothing to compare"
			return 0
			;;
		esac
		if printf '%s\n' "$sinks" | grep -qxF -- "$wanted"; then
			log "ok: configured default $wanted has a node — no action"
			return 0
		fi
		# Tier 2: the node the configuration names is missing while other sinks
		# work. One repair per boot: if the device is unplugged or the monitor is
		# switched off, restarting the stack again will not help and would fight
		# the user every timer tick.
		local marker="$STATE_DIR/default-repair.$BOOT_ID"
		if [ -e "$marker" ]; then
			log "configured default $wanted has no node; already repaired once this boot — leaving it (device unplugged or output switched off?)"
			return 0
		fi
		if mkdir -p "$STATE_DIR" 2>/dev/null; then
			rm -f "$STATE_DIR"/default-repair.* 2>/dev/null
			: >"$marker" 2>/dev/null
		fi
		log "configured default $wanted has no node — restarting wireplumber once"
		if ! restart_stack; then
			log "restart command failed: ${RESTART_CMD}"
		fi
		if wait_for "$RECHECK_WAIT" "$wanted"; then
			sinks=$(alsa_sinks)
			report_sinks "fixed the configured default" "$sinks"
		else
			log "configured default $wanted still has no node after one restart — other sinks work, leaving it"
		fi
		return 0
	fi

	# Tier 1: no real sink at all. This is the EBUSY loss with nothing to fall
	# back to. Restart WirePlumber, which rebuilds the nodes from the devices
	# that are there now, at most MAX_RESTARTS times with a short backoff.
	local attempt=0
	while [ "$attempt" -lt "$MAX_RESTARTS" ]; do
		attempt=$((attempt + 1))
		log "no ALSA sink node — restarting wireplumber (attempt ${attempt}/${MAX_RESTARTS})"
		if ! restart_stack; then
			log "restart command failed: ${RESTART_CMD}"
		fi
		if wait_for "$RECHECK_WAIT"; then
			sinks=$(alsa_sinks)
			report_sinks "fixed on attempt ${attempt}" "$sinks"
			return 0
		fi
		if [ "$attempt" -lt "$MAX_RESTARTS" ]; then
			sleep "$BACKOFF"
			BACKOFF=$((BACKOFF + 3))
		fi
	done

	log "still no ALSA sink after ${MAX_RESTARTS} restart(s) — no output is available; check 'wpctl status' and 'journalctl --user -b -u pipewire'"
	return 1
}

main "$@"
exit $?
