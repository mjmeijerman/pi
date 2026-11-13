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
# State (slug → pane, terminal) lives in ~/.pi/tools/.agent-panes.json.
set -euo pipefail

PI_BIN=${PI_BIN:-/home/mark/.local/share/pnpm/bin/pi}
STATE=${STATE:-$HOME/.pi/tools/.agent-panes.json}
PROG=${0##*/}

die() { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"; }

state_read() { [ -f "$STATE" ] && cat "$STATE" || echo '{}'; }
state_write() { printf '%s\n' "$1" >"$STATE"; }

json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],j);console.log(v??"")' "$1"; }

cmd_spawn() {
	mkdir -p "$(dirname "$STATE")"
	local slug=${1:?usage: spawn <slug> <spec.md>}; local spec=${2:?usage: spawn <slug> <spec.md>}
	local direction=right workdir=""
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

	local out
	out=$(herdr-app do pane.split --direction "$direction" \
		--argv "$(node -e 'process.stdout.write(JSON.stringify(["sh","-lc",process.argv[1]]))' \
			"cd $(printf '%q' "$spawn_dir") && exec $(printf '%q' "$PI_BIN") -a")" 2>&1) || die "pane.split failed: $out"
	local pane terminal
	pane=$(printf '%s' "$out" | json_get result.pane)
	terminal=$(printf '%s' "$out" | json_get result.terminal)
	[ -n "$pane" ] || pane=$(printf '%s' "$out" | json_get pane)
	[ -n "$terminal" ] || terminal=$(printf '%s' "$out" | json_get terminal)
	[ -n "$pane" ] && [ -n "$terminal" ] || die "could not read pane/terminal from: $out"

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
