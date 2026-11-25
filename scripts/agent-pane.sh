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
#   spawn SLUG SPEC --space SLUG    a tab in that space, added last and never focused: the
#                                   worker sits beside the work it is about, and the person
#                                   stays on the tab they were reading. self-learn uses
#                                   this — a learner is a tab in the space whose project
#                                   compacted, never a space of its own.
#   spawn SLUG SPEC --visible       its own space and tab (legacy: `bin/space new` is how a
#                                   space is made now), which the person can find in `list`,
#                                   watch with `show` and end with `close`.
#
# `--sandbox` runs the pi inside through scripts/pisandbox (no ssh keys, no cloud creds,
# network on) with the working directory readable and writable. The host creates the
# space, the sandbox runs the work — the same split bin/delegate uses, where the space
# is made by the unsandboxed host and bin/pi-sandboxed runs the worker. A sandboxed
# process cannot make a tab (herdr-app lives outside every sandbox mount), so the
# creation half must stay here, on the host.
#
#   agent-pane.sh spawn <slug> <spec.md> [--cwd DIR] [--space SLUG] [--visible] [--sandbox] [--env K=V]...
#   agent-pane.sh show <slug|terminal>
#   agent-pane.sh hide <slug|terminal>
#   agent-pane.sh close <slug|terminal> [--pane]
#                                   exit 0: the space and the entry are gone.
#                                   exit 1: the worker is stopped but its space is still
#                                   open (no herdr-app here, or space.close failed); the
#                                   entry is kept so `list` shows it and a host-side close
#                                   can finish the job.
#   agent-pane.sh list
#
# State (slug → terminal, space, borrowed pane) lives in ~/.pi/scripts/.agent-panes.json.
set -euo pipefail

PI_BIN=${PI_BIN:-$HOME/.local/share/pnpm/bin/pi}
PISANDBOX=${PISANDBOX:-$HOME/.pi/scripts/pisandbox}
STATE=${STATE:-$HOME/.pi/scripts/.agent-panes.json}
PROG=${0##*/}

# The space record: `--space <slug>` resolves that space's herdr id from
# `state/spaces/<slug>/space.json` — the same file `bin/delegate` reads, so a tab opened here and
# a tab opened there cannot disagree about which space it is. Sourced lazily, and only when
# `--space` is used: the hidden and own-space paths do not read space records, and a machine
# without them can still start a worker.
space_lib() {
	local dir
	dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")/../bin" 2>/dev/null && pwd) || return 1
	[ -r "$dir/space-lib.sh" ] || return 1
	# shellcheck source=/dev/null
	. "$dir/space-lib.sh"
}

die() { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"; }

# The argv a tab is started with: `bin/worker-argv.sh` is the one spelling, shared with
# `bin/delegate`, so a tab opened here and a worker started there cannot disagree about the
# first word. It matters on Windows, where herdr types that argv into PowerShell and `sh` is
# not a name it knows. Sourced lazily like space_lib: the hidden path never builds one.
worker_lib() {
	local dir
	dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")/../bin" 2>/dev/null && pwd) || return 1
	[ -r "$dir/worker-argv.sh" ] || return 1
	# shellcheck source=/dev/null
	. "$dir/worker-argv.sh"
}

# tab_argv <command line> — the JSON array tab.new and space.new take, or a die naming the
# fix: a tab given an argv whose first word cannot be run starts nothing, silently.
tab_argv() {
	local argv
	worker_lib || die "bin/worker-argv.sh is not beside this script — it builds the argv a tab is started with"
	argv=$(worker_tab_argv "$1") || die "no argv for the tab: the line above names the bash it could not find"
	printf '%s' "$argv"
}

state_read() { [ -f "$STATE" ] && cat "$STATE" || echo '{}'; }
state_write() { printf '%s\n' "$1" >"$STATE"; }

json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],j);console.log(v??"")' "$1"; }

# The space and tab the person is looking at, as "space tab", or empty when the
# window cannot be read (no window, herdr-app error). Never dies: a view that
# cannot be read must not stop a spawn.
screen_state() {
	local out space tab
	out=$(herdr-app status 2>/dev/null) || return 0
	space=$(printf '%s' "$out" | json_get space)
	tab=$(printf '%s' "$out" | json_get tab)
	[ -n "$space" ] && [ -n "$tab" ] || return 0
	printf '%s %s' "$space" "$tab"
}

# restore_focus "space tab" — select that space, then that tab, explicitly by the
# ids read before the spawn. Returns non-zero instead of dying: the caller warns
# and the spawn stands.
restore_focus() {
	local pair=$1 space tab
	space=${pair%% *}; tab=${pair#* }
	[ -n "$space" ] && [ -n "$tab" ] || return 1
	herdr-app do space.select --id "$space" >/dev/null 2>&1 || return 1
	herdr-app do tab.select --id "$tab" >/dev/null 2>&1 || return 1
	return 0
}

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

# The command line the new space or terminal runs: cd, then any --env pairs, then the
# runner. Built here rather than by the caller so a sandboxed worker cannot be started
# unsandboxed by a caller that forgot the wrapper, and so the env a learner needs
# (PI_SELF_LEARN=1 and friends) survives into a process that does not inherit it —
# herdr starts the space from the app's environment, not from this shell's.
runner_line() {
	local dir=$1 sandboxed=$2 line e
	line="cd $(printf '%q' "$dir")"
	# herdr starts the space from the app's own environment, whose PATH has no pi
	# directory: `pi-sandbox.sh` then dies with "pi is not on PATH" before pi ever
	# runs, and the space stays behind as an empty tab. The binary's directory goes
	# on the front of PATH here, so the sandbox resolves the same absolute binary
	# from inside the sandboxed path it builds. One line, and both the visible space
	# and the hidden worker (same function) start from an environment that has no pi.
	line="$line; export PATH=$(printf '%q' "$(dirname "$PI_BIN")"):\$PATH"
	for e in "${envs[@]+${envs[@]}}"; do
		line="$line; export $(printf '%q' "$e")"
	done
	if [ "$sandboxed" = 1 ]; then
		# Nothing after `--` but pi's own arguments: pi-sandbox.sh resolves the binary
		# from PATH and runs it with the rest of the line, so handing it the absolute
		# path as well started `pi /home/…/pi -a` — a binary path as the first message.
		line="$line; exec $(printf '%q' "$PISANDBOX") --rw $(printf '%q' "$dir") -- -a"
	else
		line="$line; exec $(printf '%q' "$PI_BIN") -a"
	fi
	printf '%s' "$line"
}

cmd_spawn() {
	mkdir -p "$(dirname "$STATE")"
	local slug=${1:?usage: spawn <slug> <spec.md>}; local spec=${2:?usage: spawn <slug> <spec.md>}
	local workdir="" visible=0 sandboxed=0 space_slug=""
	envs=()
	shift 2
	while [ "$#" -gt 0 ]; do
		case $1 in
		--cwd) workdir=${2:?}; shift 2 ;;
		--space) space_slug=${2:?--space needs a space name}; shift 2 ;;
		--visible) visible=1; shift ;;
		--sandbox) sandboxed=1; shift ;;
		--env) envs+=("${2:?--env needs KEY=VAL}"); shift 2 ;;
		*) die "unknown option $1" ;;
		esac
	done
	[ -z "$space_slug" ] || space_lib || die "--space needs bin/space-lib.sh, and it is not beside this script"
	[ -z "$space_slug" ] || space_valid_slug "$space_slug" || die "--space takes a space name: '$space_slug'"
	[ -z "$space_slug" ] || [ "$visible" = 0 ] || die "--space and --visible answer the same question: a tab in that space, or a space of its own"
	[ -z "$space_slug" ] || [ -f "$(space_record "$space_slug")" ] || die "no such space: $space_slug — bin/space list"
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

	local out terminal="" space="" tab=""
	if [ -n "$space_slug" ]; then
		# A tab in the space that asked for it. `tab.new` takes the space's herdr id, which a
		# record written before that field existed gets from `space_id_ensure` (one read of
		# `herdr-app ls`, written back once). `--focus false` adds the tab last and keeps the
		# shown space and its selected tab, so nobody loses their place.
		local argv space_id
		space_id=$(space_id_ensure "$space_slug")
		[ -n "$space_id" ] || die "space $space_slug has no herdr id — is it open? bin/space show $space_slug"
		argv=$(tab_argv "$(runner_line "$spawn_dir" "$sandboxed")")
		out=$(herdr-app do tab.new --name "$name" --space "$space_id" --folder "$spawn_dir" \
			--argv "$argv" --task "Read $spec and do it" --focus false 2>&1) \
			|| die "tab.new failed for $name in space $space_slug ($space_id): $out"
		tab=$(printf '%s' "$out" | json_get tab)
		space=$space_id
		terminal=$(printf '%s' "$out" | json_get terminal)
		[ -n "$terminal" ] || terminal=$(printf '%s' "$out" | json_get result.terminal)
		[ -n "$terminal" ] || die "tab.new made no terminal in space $space_slug: $out"
	elif [ "$visible" = 1 ]; then
		# Visible on purpose: a real space and tab, so the person finds the worker in the
		# agents pane, can watch it and can end it. space.new has no hidden mode, so this
		# is the path that cannot lie about existing.
		local argv before=""
		argv=$(tab_argv "$(runner_line "$spawn_dir" "$sandboxed")")
		# space.new shows the new space, which takes the person off what they were
		# reading. Note both ids first, explicitly, and put them back after — the same
		# pair bin/delegate uses. Nobody should lose their place to a learner.
		before=$(screen_state)
		out=$(herdr-app do space.new --name "$name" --folder "$spawn_dir" --tab "$name" \
			--argv "$argv" --task "Read $spec and do it" 2>&1) \
			|| die "space.new failed for $name: $out"
		space=$(printf '%s' "$out" | json_get space)
		[ -n "$space" ] || space=$(printf '%s' "$out" | json_get result.space)
		terminal=$(printf '%s' "$out" | json_get terminal)
		[ -n "$terminal" ] || terminal=$(printf '%s' "$out" | json_get result.terminal)
		[ -n "$space" ] || die "space.new made no space: $out"
		# Restore before the banner wait: that wait is up to 40 s, and the person must not
		# spend it looking at the learner's space.
		case "$before" in
		"") printf '%s: warning: could not read the space on screen before the spawn, so focus stayed on space %s\n' \
			"$PROG" "${space:-?}" >&2 ;;
		*) restore_focus "$before" || printf '%s: warning: could not restore focus to the space you were on, so focus stayed on space %s\n' \
			"$PROG" "${space:-?}" >&2 ;;
		esac
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
	# A space whose pi never starts is not a worker: it is closed and reported here,
	# because the alternative is an empty tab the person has to find and end by hand.
	local i ready=0 seen="" why tries pause
	tries=${PI_PANE_BANNER_TRIES:-40}
	pause=${PI_PANE_BANNER_PAUSE:-1}
	for i in $(seq 1 "$tries"); do
		seen=$(hc read "$terminal" 2>&1 || true)
		if printf '%s' "$seen" | grep -q "escape interrupt\|/[Cc]ommands"; then ready=1; break; fi
		[ "$pause" = 0 ] || sleep "$pause"
	done
	if [ "$ready" != 1 ]; then
		why=$(printf '%s\n' "$seen" | grep -m1 -i 'error' || true)
		[ -n "$why" ] || why=$(printf '%s\n' "$seen" | grep -m1 -v '^[[:space:]]*$' || true)
		[ -n "$why" ] || why="no output from $terminal"
		why=$(printf '%s' "$why" | cut -c1-300)
		if [ -n "$tab" ]; then
			# A tab, never the space: closing the space here would take the person's own desk
			# down with the worker that finished.
			command -v herdr-app >/dev/null 2>&1 && herdr-app do tab.close --id "$tab" --confirmed true >/dev/null 2>&1 || true
		elif [ -n "$space" ] && command -v herdr-app >/dev/null 2>&1; then
			# Best effort: a space that will not close must not hide the reason pi failed.
			herdr-app do space.close --id "$space" --confirmed true >/dev/null 2>&1 || true
		fi
		hc kill "$terminal" >/dev/null 2>&1 || true
		hc rm "$terminal" >/dev/null 2>&1 || true
		die "pi did not start in $terminal: $why"
	fi
	hc send "$terminal" "Read $spec and do it" >/dev/null || die "send failed for $terminal"

	state_write "$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		j[process.argv[2]]={terminal:process.argv[3],space:process.argv[4]||null,tab:process.argv[8]||null,
			spaceSlug:process.argv[9]||null,spec:process.argv[5],
			hidden:process.argv[6]!=="1",sandboxed:process.argv[7]==="1",ts:new Date().toISOString()};
		process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$slug" "$terminal" "$space" "$spec" "$visible" "$sandboxed" "$tab" "$space_slug")"

	# One JSON line, read by callers as the proof a worker exists: the terminal and the
	# space are named, and `hidden` says which of the paths made it.
	if [ -n "$space_slug" ]; then
		printf '{"slug":"%s","terminal":"%s","tab":"%s","space":"%s","spec":"%s","hidden":false,"sandboxed":%s}\n' \
			"$slug" "$terminal" "$tab" "$space_slug" "$spec" "$([ "$sandboxed" = 1 ] && echo true || echo false)"
	elif [ "$visible" = 1 ]; then
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
	local borrowed space tab
	borrowed=${resolved#* }
	if [ -n "$borrowed" ]; then herdr-app do terminal.show --pane "$borrowed" >/dev/null 2>&1 || true; fi
	if [ "$want_pane" = 1 ] && [ -n "$pane" ]; then herdr-app do pane.close --pane "$pane" >/dev/null 2>&1 || true; fi
	# A visible worker owns a space; close that too, or the pane keeps an empty one.
	#
	# A close that reports success without closing the space is how a space outlives the
	# only record of it: on 2026-11-18 the person said "I see 2 learn-1200 spaces still
	# open" while `.agent-panes.json` held no entry for either. The old code deleted the
	# entry whatever `space.close` did (the call was `>/dev/null 2>&1 || true`), so a
	# learner whose herdr-app could not reach the host core left an orphan tab and no
	# trace. Keep the entry until the space is really gone, and say which space is left.
	space=$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]]||{};process.stdout.write(e.space||"");' "$STATE" "$target" 2>/dev/null || true)
	tab=$(node -e '
		const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
		const e=j[process.argv[2]]||{};process.stdout.write(e.tab||"");' "$STATE" "$target" 2>/dev/null || true)
	local space_closed=1 space_note="" close_out=""
	if [ -n "$tab" ]; then
		# A tab-kind worker closes its tab and never the space: the space is the person's,
		# and a finished worker must not take the desk it was working on with it.
		if ! command -v herdr-app >/dev/null 2>&1; then
			space_closed=0
			space_note="tab $tab is still open: herdr-app is not in PATH here, so close it on the host with '$PROG close $target'"
		elif close_out=$(herdr-app do tab.close --id "$tab" --confirmed true 2>&1); then
			:
		elif printf '%s' "$close_out" | grep -Fq "no tab" && printf '%s' "$close_out" | grep -Fq "$tab"; then
			: # already gone: the same answer space.close gives for a space that is not there
		else
			space_closed=0
			space_note="tab $tab is still open: tab.close said '$close_out'"
		fi
	elif [ -n "$space" ]; then
		if ! command -v herdr-app >/dev/null 2>&1; then
			space_closed=0
			space_note="space $space is still open: herdr-app is not in PATH here, so close it on the host with '$PROG close $target'"
		elif close_out=$(herdr-app do space.close --id "$space" --confirmed true 2>&1); then
			:
		elif printf '%s' "$close_out" | grep -Fq "no space" && printf '%s' "$close_out" | grep -Fq "$space"; then
			: # already gone: herdr answered `{"error":"no space \"s9\""}`, and a close
			# that half-worked yesterday is a finished close today, not a retry forever
		else
			space_closed=0
			space_note="space $space is still open: space.close said '$close_out'"
		fi
	fi
	[ -n "$terminal" ] && hc kill "$terminal" >/dev/null 2>&1 || true
	[ -n "$terminal" ] && hc rm "$terminal" >/dev/null 2>&1 || true
	if [ "$space_closed" = 1 ]; then
		state_write "$(node -e '
			const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
			delete j[process.argv[2]];process.stdout.write(JSON.stringify(j,null,2));' "$STATE" "$target")"
		printf '{"closed":"%s","terminal":"%s","space":"%s","space_closed":true}\n' "$target" "$terminal" "$space"
		return 0
	fi
	# The entry stays, so `list` still names the space and a host-side close can finish it.
	printf '{"closed":"%s","terminal":"%s","space":"%s","space_closed":false}\n' "$target" "$terminal" "$space"
	printf '%s: %s\n' "$PROG" "$space_note" >&2
	return 1
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
