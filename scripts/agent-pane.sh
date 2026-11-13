#!/usr/bin/env bash
# agent-pane.sh — spawn a pi worker in a real herdr pane.
#
# Why not `hc run`: terminals created by herdr-core without a pane cannot be
# tiled, so clicking one in the Herdr window only previews it (a modal). A pane
# created through herdr-app is a normal tile and can be closed when the work is
# done.
#
#   agent-pane.sh spawn <slug> <spec.md> [--direction right|down] [--cwd DIR]
#   agent-pane.sh close <slug|pane-id>
#   agent-pane.sh list
#
# State (slug → pane, terminal) lives in ~/.pi/scripts/.agent-panes.json.
set -euo pipefail

PI_BIN=${PI_BIN:-/home/mark/.local/share/pnpm/bin/pi}
STATE=${STATE:-$HOME/.pi/scripts/.agent-panes.json}
PROG=${0##*/}

die() { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"; }

state_read() { [ -f "$STATE" ] && cat "$STATE" || echo '{}'; }
state_write() { printf '%s\n' "$1" >"$STATE"; }

json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],j);console.log(v??"")' "$1"; }


# Resolve the pane and tab the caller lives in, so a worker always lands next to
# the agent that spawned it rather than next to whatever the person is looking at.
caller_context() {
	if [ -n "${HC_TERMINAL_ID:-}" ]; then
		herdr-app ls 2>/dev/null | node -e '
			let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
				const want=process.argv[1];
				const j=JSON.parse(d);
				for (const s of j.spaces) for (const t of s.tabs) for (const tm of t.terminals)
					if (tm.terminal===want) { console.log([tm.pane,t.id,t.terminals.length].join(" ")); return; }
			})' "$HC_TERMINAL_ID"
	fi
}

cmd_spawn() {
	mkdir -p "$(dirname "$STATE")"
	local slug=${1:?usage: spawn <slug> <spec.md>}; local spec=${2:?usage: spawn <slug> <spec.md>}
	local direction="" workdir=""
	shift 2
	while [ "$#" -gt 0 ]; do
		case $1 in
		--direction) direction=${2:?}; shift 2 ;;
		--cwd) workdir=${2:?}; shift 2 ;;
		*) die "unknown option $1" ;;
		esac
	done
	[ -f "$spec" ] || die "spec not found: $spec"
	need herdr-app; need hc
	local spawn_dir=${workdir:-$(cd "$(dirname "$spec")" && pwd)}
	# Remember what the person is looking at; spawning must not move them.
	local before
	before=$(herdr-app status 2>/dev/null || true)
	local person_tab person_pane
	person_tab=$(printf '%s' "$before" | json_get tab)
	person_pane=$(printf '%s' "$before" | json_get focused_pane)
	local argv
	argv=$(node -e 'process.stdout.write(JSON.stringify(["sh","-lc",process.argv[1]]))' \
		"cd $(printf '%q' "$spawn_dir") && exec $(printf '%q' "$PI_BIN") -a")

	# Place the worker next to this agent: split the caller's own pane. Past four
	# panes in the tab a split is unreadable, so open a named tab instead.
	local caller pane terminal out
	caller=$(caller_context || true)
	local caller_pane=${caller%% *}
	local rest=${caller#* }
	local caller_tab=${rest%% *}
	local pane_count=${rest##* }

	if [ -n "$caller_pane" ] && { [ -z "$pane_count" ] || [ "$pane_count" -lt 4 ]; }; then
		if [ -z "$direction" ]; then
			# First sibling goes right, later ones stack under the caller.
			if [ "${pane_count:-1}" -eq 1 ]; then direction=right; else direction=down; fi
		fi
		out=$(herdr-app do pane.split --pane "$caller_pane" --direction "$direction" --argv "$argv" 2>&1) \
			|| die "pane.split failed: $out"
	else
		[ -n "$caller_tab" ] || die "cannot find the calling pane (HC_TERMINAL_ID=${HC_TERMINAL_ID:-unset})"
		out=$(herdr-app do tab.new --name "$slug" --folder "$spawn_dir" --argv "$argv" \
			--task "Read $spec and do it" 2>&1) || die "tab.new failed: $out"
	fi

	pane=$(printf '%s' "$out" | json_get result.pane)
	[ -n "$pane" ] || pane=$(printf '%s' "$out" | json_get pane)
	[ -n "$pane" ] || pane=$(printf '%s' "$out" | json_get result.root_pane)
	terminal=$(printf '%s' "$out" | json_get result.terminal)
	[ -n "$terminal" ] || terminal=$(printf '%s' "$out" | json_get terminal)
	[ -n "$terminal" ] || terminal=$(printf '%s' "$out" | json_get result.root_terminal)
	[ -n "$pane" ] && [ -n "$terminal" ] || die "could not read pane/terminal from: $out"

	# Wait for pi's banner before sending; a send to a booting agent can be dropped.
	local i ready=0
	for i in $(seq 1 40); do
		if hc read "$terminal" 2>/dev/null | grep -q "escape interrupt\|/[Cc]ommands"; then ready=1; break; fi
		sleep 1
	done
	[ "$ready" = 1 ] || printf '%s: warning: banner not seen after 40s, sending anyway\n' "$PROG" >&2
	hc send "$terminal" "Read $spec and do it" >/dev/null || die "send failed for $terminal"

	# A worker belongs beside the agent that spawned it, never beside whatever
	# tab the person happens to have focused.
	if [ -n "$caller_tab" ]; then
		local placed
		placed=$(herdr-app ls 2>/dev/null | node -e '
			let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
				const want=process.argv[1];const j=JSON.parse(d);
				for (const s of j.spaces) for (const t of s.tabs) for (const tm of t.terminals)
					if (tm.terminal===want) { console.log(t.id+" "+tm.pane); return; }
			})' "$terminal" || true)
		if [ "${placed%% *}" != "$caller_tab" ]; then
			herdr-app do pane.close --pane "$pane" >/dev/null 2>&1 || true
			hc kill "$terminal" >/dev/null 2>&1 || true
			die "worker landed in the wrong tab (${placed%% *}); closed it instead of moving your view"
		fi
	fi
	# Put the person back where they were.
	[ -n "$person_tab" ] && herdr-app do tab.select --id "$person_tab" >/dev/null 2>&1 || true
	[ -n "$person_pane" ] && herdr-app do pane.focus --pane "$person_pane" >/dev/null 2>&1 || true

	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		j[process.argv[2]]={pane:process.argv[3],terminal:process.argv[4],spec:process.argv[5],ts:new Date().toISOString()};
		process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$slug" "$pane" "$terminal" "$spec")"

	printf '{"slug":"%s","pane":"%s","terminal":"%s","spec":"%s"}\n' "$slug" "$pane" "$terminal" "$spec"
}

cmd_close() {
	local target=${1:?usage: close <slug|pane-id>}
	local pane=$target terminal=""
	local known
	known=$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]];process.stdout.write(e?e.pane+" "+e.terminal:"");' "$STATE" "$target" 2>/dev/null || true)
	if [ -n "$known" ]; then pane=${known%% *}; terminal=${known##* }; fi

	herdr-app do pane.close --pane "$pane" >/dev/null 2>&1 || printf '%s: warning: pane.close failed for %s\n' "$PROG" "$pane" >&2
	[ -n "$terminal" ] && hc kill "$terminal" >/dev/null 2>&1 || true
	[ -n "$terminal" ] && hc rm "$terminal" >/dev/null 2>&1 || true
	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		delete j[process.argv[2]];process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$target")"
	printf '{"closed":"%s","pane":"%s"}\n' "$target" "$pane"
}

cmd_list() {
	herdr-app ls 2>/dev/null | node -e '
		let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
			const j=JSON.parse(d);
			for (const s of j.spaces) for (const t of s.tabs) for (const tm of t.terminals)
				console.log((tm.pane||"").slice(0,8), (tm.terminal||"").padEnd(5), (tm.app||"-").padEnd(6), tm.status||"-", t.name);
		})'
}

case ${1:-} in
spawn) shift; cmd_spawn "$@" ;;
close) shift; cmd_close "$@" ;;
list|ls) cmd_list ;;
*) die "usage: $PROG spawn|close|list ..." ;;
esac
