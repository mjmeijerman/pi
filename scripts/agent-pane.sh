#!/usr/bin/env bash
# agent-pane.sh — spawn a pi worker without moving the person's view.
#
# Why hidden: herdr shows every new pane and tab immediately, so spawning a
# worker used to pull the person off the tab they were reading. `hc run --bg`
# with no herdr.* labels keeps the worker's terminal out of the window: the
# window does not change at all, not even focus. Look at a worker on purpose
# with `show` (borrows the current pane in place), put the screen back with
# `hide`.
#
#   agent-pane.sh spawn <slug> <spec.md> [--cwd DIR]
#   agent-pane.sh show <slug|terminal>
#   agent-pane.sh hide <slug|terminal>
#   agent-pane.sh close <slug|terminal> [--pane]
#   agent-pane.sh list
#
# State (slug → terminal, borrowed pane) lives in ~/.pi/scripts/.agent-panes.json.
set -euo pipefail

PI_BIN=${PI_BIN:-/home/mark/.local/share/pnpm/bin/pi}
STATE=${STATE:-$HOME/.pi/scripts/.agent-panes.json}
PROG=${0##*/}

die() { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"; }

state_read() { [ -f "$STATE" ] && cat "$STATE" || echo '{}'; }
state_write() { printf '%s\n' "$1" >"$STATE"; }

json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],j);console.log(v??"")' "$1"; }

# Slug or terminal ID → "terminal borrowed" from state. A bare terminal ID
# (t7-style) is passed through with no state lookup.
resolve() {
	local want=$1
	if printf '%s' "$want" | grep -qx 't[0-9a-z]\+'; then
		printf '%s ' "$want"
		return 0
	fi
	node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]];
		if(!e){console.error("unknown slug: "+process.argv[2]);process.exit(1);}
		process.stdout.write((e.terminal||"")+" "+(e.borrowed||""));' "$STATE" "$want"
}

cmd_spawn() {
	mkdir -p "$(dirname "$STATE")"
	local slug=${1:?usage: spawn <slug> <spec.md>}; local spec=${2:?usage: spawn <slug> <spec.md>}
	local workdir=""
	shift 2
	while [ "$#" -gt 0 ]; do
		case $1 in
		--cwd) workdir=${2:?}; shift 2 ;;
		*) die "unknown option $1" ;;
		esac
	done
	[ -f "$spec" ] || die "spec not found: $spec"
	need hc
	local spawn_dir
	spawn_dir=${workdir:-$(cd "$(dirname "$spec")" && pwd)}
	# hc names are 1-32 of a-z 0-9 - _ ; keep the slug usable as both.
	local name
	name=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | cut -c1-32)

	# Hidden on purpose: no herdr.space / herdr.tab label, so the window shows
	# nothing and focus cannot move. --outlive-parent keeps the worker alive
	# when this agent's turn ends.
	local out terminal
	out=$(hc run --bg --json --name "$name" --cwd "$spawn_dir" --no-notify --outlive-parent -- "$PI_BIN" -a 2>&1) \
		|| die "hc run failed: $out"
	terminal=$(printf '%s' "$out" | json_get address)
	[ -n "$terminal" ] || die "could not read terminal from: $out"

	# Wait for pi's banner before sending; a send to a booting agent can be dropped.
	local i ready=0
	for i in $(seq 1 40); do
		if hc read "$terminal" 2>/dev/null | grep -q "escape interrupt\|/[Cc]ommands"; then ready=1; break; fi
		sleep 1
	done
	[ "$ready" = 1 ] || printf '%s: warning: banner not seen after 40s, sending anyway\n' "$PROG" >&2
	hc send "$terminal" "Read $spec and do it" >/dev/null || die "send failed for $terminal"

	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		j[process.argv[2]]={terminal:process.argv[3],spec:process.argv[4],ts:new Date().toISOString()};
		process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$slug" "$terminal" "$spec")"

	printf '{"slug":"%s","terminal":"%s","spec":"%s","hidden":true}\n' "$slug" "$terminal" "$spec"
}

# Borrow the focused pane for a look: the pane's own terminal stays alive and
# comes back with `hide`. Focus itself does not move.
cmd_show() {
	local target=${1:?usage: show <slug|terminal>}
	local resolved terminal borrowed
	resolved=$(resolve "$target") || die "show: no entry for '$target' (try: agent-pane.sh list)"
	terminal=${resolved%% *}; borrowed=${resolved#* }
	[ -n "$terminal" ] || die "no terminal for $target"
	need herdr-app
	local focused
	focused=$(herdr-app status 2>/dev/null | json_get focused_pane)
	[ -n "$focused" ] || die "no focused pane (is the Herdr window open?)"
	herdr-app do terminal.show --terminal "$terminal" --pane "$focused" >/dev/null 2>&1 \
		|| die "terminal.show failed for $terminal"
	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]]||{terminal:process.argv[3]};
		e.borrowed=process.argv[4];
		j[process.argv[2]]=e;
		process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$target" "$terminal" "$focused")"
	printf '{"shown":"%s","terminal":"%s","pane":"%s"}\n' "$target" "$terminal" "$focused"
}

cmd_hide() {
	local target=${1:?usage: hide <slug|terminal>}
	local resolved borrowed
	resolved=$(resolve "$target") || die "hide: no entry for '$target' (try: agent-pane.sh list)"
	borrowed=${resolved#* }
	[ -n "$borrowed" ] || die "nothing borrowed for $target (its pane was never swapped)"
	need herdr-app
	herdr-app do terminal.show --pane "$borrowed" >/dev/null 2>&1 || die "terminal.show --pane failed for $borrowed"
	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		if(j[process.argv[2]])delete j[process.argv[2]].borrowed;
		process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$target")"
	printf '{"hidden":"%s","pane":"%s"}\n' "$target" "$borrowed"
}

cmd_close() {
	local target=${1:?usage: close <slug|terminal> [--pane]}
	local want_pane=0
	shift
	while [ "$#" -gt 0 ]; do
		case $1 in
		--pane) want_pane=1; shift ;;
		*) die "unknown option $1" ;;
		esac
	done
	local resolved terminal pane=""
	resolved=$(resolve "$target" 2>/dev/null || true)
	terminal=${resolved%% *}
	if [ -z "$terminal" ]; then terminal=$target; fi

	# Legacy entries from the pane-based spawns carry a pane; close it if asked
	# or if it is still around.
	pane=$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]]||{};process.stdout.write(e.pane||"");' "$STATE" "$target" 2>/dev/null || true)

	# If the worker is on screen in a borrowed pane, put the pane back first.
	local borrowed
	borrowed=${resolved#* }
	if [ -n "$borrowed" ]; then herdr-app do terminal.show --pane "$borrowed" >/dev/null 2>&1 || true; fi
	if [ "$want_pane" = 1 ] && [ -n "$pane" ]; then herdr-app do pane.close --pane "$pane" >/dev/null 2>&1 || true; fi
	[ -n "$terminal" ] && hc kill "$terminal" >/dev/null 2>&1 || true
	[ -n "$terminal" ] && hc rm "$terminal" >/dev/null 2>&1 || true
	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		delete j[process.argv[2]];process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$target")"
	printf '{"closed":"%s","terminal":"%s"}\n' "$target" "$terminal"
}

cmd_list() {
	node -e '
		const {execFileSync}=require("child_process");
		const fs=require("fs");
		let st={};try{st=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const byTerm={};for(const [slug,e] of Object.entries(st))if(e.terminal)byTerm[e.terminal]=slug;
		let j={};
		try{j=JSON.parse(execFileSync("hc",["ls","--json"],{encoding:"utf8"}))}catch{}
		for(const t of j.terminals||[]){
			const slug=byTerm[t.address];
			console.log((slug?slug:"-").padEnd(18), (t.address||"").padEnd(5), (t.status||"-").padEnd(8), slug?(st[slug].borrowed?"on screen":"hidden"):t.where||"");
		}' "$STATE"
}

case ${1:-} in
spawn) shift; cmd_spawn "$@" ;;
show) shift; cmd_show "$@" ;;
hide) shift; cmd_hide "$@" ;;
close) shift; cmd_close "$@" ;;
list|ls) cmd_list ;;
*) die "usage: $PROG spawn|show|hide|close|list ..." ;;
esac
