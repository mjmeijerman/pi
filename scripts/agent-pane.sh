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
# Two kinds of worker, and the difference is on purpose:
#
#   spawn SLUG SPEC                 hidden: no space, no herdr label, focus cannot move.
#                                   This is the delegation path (learn-publish.sh): the
#                                   person asked for that work, they do not want the view
#                                   taken away from them.
#   spawn SLUG SPEC --visible       its own space and tab in the agents pane, which the
#                                   person can find in `list`, watch with `show` and end
#                                   with `close`. The self-learn learner uses this: an
#                                   agent nobody can see is an agent nobody can stop.
#
# A visible spawn does not keep the view either. `space.new` always shows the new
# space, so spawn notes the space and tab that were selected before it, and selects
# them again by id the moment the ids are back — the same pair bin/delegate uses.
# The worker is in the agents pane where it belongs; the person is still reading
# what they were reading. `--no-restore` keeps the old behaviour, for watching a
# worker appear. Nothing is hidden either way: `list` shows the space either way.
#
#   agent-pane.sh spawn <slug> <spec.md> [--cwd DIR] [--visible] [--sandbox] [--no-restore] [--env K=V]...
#
# `--sandbox` runs the pi inside through scripts/pisandbox (no ssh keys, no cloud creds,
# network on) with the working directory readable and writable. The host creates the
# space, the sandbox runs the work — the same split bin/delegate uses, where the space
# is made by the unsandboxed host and bin/pi-sandboxed runs the worker. A sandboxed
# process cannot make a space (herdr-app lives outside every sandbox mount), so the
# creation half must stay here, on the host.
#
#   agent-pane.sh show <slug|terminal>
#   agent-pane.sh hide <slug|terminal>
#   agent-pane.sh close <slug|terminal> [--pane]
#   agent-pane.sh list
#
# State (slug → terminal, space, borrowed pane) lives in ~/.pi/scripts/.agent-panes.json.
set -euo pipefail

PI_BIN=${PI_BIN:-/home/mark/.local/share/pnpm/bin/pi}
PISANDBOX=${PISANDBOX:-$HOME/.pi/scripts/pisandbox}
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

# The space and tab the person is looking at, as "SPACE TAB". Empty when the window
# cannot be read (no window, herdr-app error): a view that cannot be read must not
# stop a spawn, it must only lose the restore.
screen_state() {
	local out space tab
	out=$(herdr-app status 2>/dev/null) || return 0
	space=$(printf '%s' "$out" | json_get space)
	tab=$(printf '%s' "$out" | json_get tab)
	[ -n "$space" ] && [ -n "$tab" ] || return 0
	printf '%s %s' "$space" "$tab"
}

# restore_focus <space> <tab> — select that space, then that tab, by id. Ids, never
# names: a name is not what the person was looking at. Returns non-zero instead of
# dying, so the caller can warn and let the spawn stand.
restore_focus() {
	herdr-app do space.select --id "$1" >/dev/null 2>&1 || return 1
	herdr-app do tab.select --id "$2" >/dev/null 2>&1 || return 1
	return 0
}

# The command line the new space or terminal runs: cd, then any --env pairs, then the
# runner. Built here rather than by the caller so a sandboxed worker cannot be started
# unsandboxed by a caller that forgot the wrapper, and so the env a learner needs
# (PI_SELF_LEARN=1 and friends) survives into a process that does not inherit it —
# herdr starts the space from the app's environment, not from this shell's.
runner_line() {
	local dir=$1 sandboxed=$2 line e
	line="cd $(printf '%q' "$dir")"
	for e in "${envs[@]+${envs[@]}}"; do
		line="$line; export $(printf '%q' "$e")"
	done
	if [ "$sandboxed" = 1 ]; then
		line="$line; exec $(printf '%q' "$PISANDBOX") --rw $(printf '%q' "$dir") -- $(printf '%q' "$PI_BIN") -a"
	else
		line="$line; exec $(printf '%q' "$PI_BIN") -a"
	fi
	printf '%s' "$line"
}

cmd_spawn() {
	mkdir -p "$(dirname "$STATE")"
	local slug=${1:?usage: spawn <slug> <spec.md>}; local spec=${2:?usage: spawn <slug> <spec.md>}
	local workdir="" visible=0 sandboxed=0 restore=1
	envs=()
	shift 2
	while [ "$#" -gt 0 ]; do
		case $1 in
		--cwd) workdir=${2:?}; shift 2 ;;
		--visible) visible=1; shift ;;
		--sandbox) sandboxed=1; shift ;;
		--no-restore) restore=0; shift ;;
		--env) envs+=("${2:?--env needs KEY=VAL}"); shift 2 ;;
		*) die "unknown option $1" ;;
		esac
	done
	[ -f "$spec" ] || die "spec not found: $spec"
	need hc
	# herdr-app is the host's own app, and it is the one thing a sandbox does not mount.
	# Requiring it on both paths is what turns "a worker started somewhere inside a
	# sandbox and nobody noticed" into a line the caller has to read: a process that
	# cannot see herdr-app is not on the host, so the space it thinks it made belongs
	# to a herdr of its own.
	need herdr-app
	if [ "$sandboxed" = 1 ] && [ ! -x "$PISANDBOX" ]; then die "$PISANDBOX not found — cannot start a sandboxed worker"; fi
	local spawn_dir
	spawn_dir=${workdir:-$(cd "$(dirname "$spec")" && pwd)}
	# hc names are 1-32 of a-z 0-9 - _ ; keep the slug usable as both.
	local name
	name=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | cut -c1-32)

	local out terminal="" space=""
	if [ "$visible" = 1 ]; then
		# Visible on purpose: a real space and tab, so the person finds the worker in the
		# agents pane, can watch it and can end it. space.new has no hidden mode, so this
		# is the path that cannot lie about existing.
		local argv
		argv=$(node -e 'process.stdout.write(JSON.stringify(["sh","-lc",process.argv[1]]))' \
			"$(runner_line "$spawn_dir" "$sandboxed")")
		# space.new has no hidden mode: the new space is shown, which takes the person
		# off the space and tab they were reading. Note both ids now, explicitly.
		local before=""
		[ "$restore" = 1 ] && before=$(screen_state)
		out=$(herdr-app do space.new --name "$name" --folder "$spawn_dir" --tab "$name" \
			--argv "$argv" --task "Read $spec and do it" 2>&1) \
			|| die "space.new failed for $name: $out"
		space=$(printf '%s' "$out" | json_get space)
		[ -n "$space" ] || space=$(printf '%s' "$out" | json_get result.space)
		terminal=$(printf '%s' "$out" | json_get terminal)
		[ -n "$terminal" ] || terminal=$(printf '%s' "$out" | json_get result.terminal)
		[ -n "$space" ] || die "space.new made no space: $out"
		# Put the view back before anything slow happens: the banner wait and the send.
		# One warning line per failure, never a refusal: a started worker is not thrown
		# away over a view, and the worker stays visible in the agents pane either way.
		if [ "$restore" = 1 ]; then
			if [ -z "$before" ]; then
				printf '%s: warning: could not read the space on screen before the spawn, so focus stayed on space %s\n' "$PROG" "$space" >&2
			elif ! restore_focus "${before%% *}" "${before##* }"; then
				printf '%s: warning: could not restore focus to space %s, so focus stayed on space %s\n' "$PROG" "${before%% *}" "$space" >&2
			fi
		fi
	else
		# Hidden on purpose: no herdr.space / herdr.tab label, so the window shows
		# nothing and focus cannot move. --outlive-parent keeps the worker alive
		# when this agent's turn ends.
		out=$(hc run --bg --json --name "$name" --cwd "$spawn_dir" --no-notify --outlive-parent \
			-- sh -lc "$(runner_line "$spawn_dir" "$sandboxed")" 2>&1) \
			|| die "hc run failed: $out"
		terminal=$(printf '%s' "$out" | json_get address)
	fi
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
		j[process.argv[2]]={terminal:process.argv[3],space:process.argv[4]||null,spec:process.argv[5],
			hidden:process.argv[6]!=="1",sandboxed:process.argv[7]==="1",ts:new Date().toISOString()};
		process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$slug" "$terminal" "$space" "$spec" "$visible" "$sandboxed")"

	# One JSON line, read by callers as the proof a worker exists: the terminal and the
	# space are named, and `hidden` says which of the two paths made it.
	if [ "$visible" = 1 ]; then
		printf '{"slug":"%s","terminal":"%s","space":"%s","spec":"%s","hidden":false,"sandboxed":%s}\n' \
			"$slug" "$terminal" "$space" "$spec" "$([ "$sandboxed" = 1 ] && echo true || echo false)"
	else
		printf '{"slug":"%s","terminal":"%s","spec":"%s","hidden":true,"sandboxed":%s}\n' \
			"$slug" "$terminal" "$spec" "$([ "$sandboxed" = 1 ] && echo true || echo false)"
	fi
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
	local borrowed space
	borrowed=${resolved#* }
	if [ -n "$borrowed" ]; then herdr-app do terminal.show --pane "$borrowed" >/dev/null 2>&1 || true; fi
	if [ "$want_pane" = 1 ] && [ -n "$pane" ]; then herdr-app do pane.close --pane "$pane" >/dev/null 2>&1 || true; fi
	# A visible worker owns a space; close that too, or the pane keeps an empty one.
	# Best effort and never fatal: a close that half-works must not fail a caller's
	# last step, and a sandboxed learner cannot reach herdr-app at all.
	space=$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]]||{};process.stdout.write(e.space||"");' "$STATE" "$target" 2>/dev/null || true)
	if [ -n "$space" ] && command -v herdr-app >/dev/null 2>&1; then
		herdr-app do space.close --id "$space" --confirmed true >/dev/null 2>&1 || true
	fi
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
		// The last column says where the worker is, and every worker is findable: a young
		// one with its own space is named by that space, one borrowed into a pane says so,
		// and only the old `hc run --bg` path is "hidden" — which is what that word meant.
		const where=(slug)=>{
			if(!slug)return null;
			const e=st[slug];
			if(e.borrowed)return "on screen";
			if(e.space)return "space "+e.space;
			return "hidden";
		};
		for(const t of j.terminals||[]){
			const slug=byTerm[t.address];
			const w=where(slug);
			console.log((slug?slug:"-").padEnd(18), (t.address||"").padEnd(5), (t.status||"-").padEnd(8), w===null?(t.where||""):w);
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
