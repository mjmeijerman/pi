#!/usr/bin/env bash
# space-lib.sh — the space record, and the rules that read it.
#
# A *space* is one project, durable: it outlives the terminals in it. Its record lives at
# state/spaces/<slug>/space.json and its workers' specs, reports and delegation record live
# beside it in the same folder, so forgetting a space is one directory and not a hunt.
#
# This file is sourced by bin/space (which writes the record) and bin/delegate (which reads the
# record from where it was run). Sourcing defines functions and variables only.
#
# PI_SPACE_ROOT points the whole record somewhere else (a test, a second machine). It defaults to
# the harness home this block decides. PI_LEGACY_BOSS_ROOT, when a caller sets it, names the
# pre-space record: read and never written.

# Where the harness is — and so where `state/` and `agent/space-rules.md` are. Three answers, in
# this order, and nothing guessed:
#   1. PI_HOME, when the caller set it. Copy mode writes it into the entries it copies
#      (scripts/install-lib.mjs `stampPiHome`), because a copy on PATH has no symlink to follow
#      back to its checkout: it resolved to `%USERPROFILE%\.local`, whose `state/` holds nothing,
#      while `%USERPROFILE%\.pi\state` held the harness space (#260).
#   2. the checkout this file or its caller belongs to: `readlink -f` follows the symlink a POSIX
#      install makes, and the directory above `bin/` counts only when it really holds this file
#      and the rules template beside it. A copy's parent holds neither, so a copy is never taken
#      for a checkout.
#   3. this library's own parent, when the first two are absent. The last resort, and `bin/space
#      list` names the directory it read rather than printing an empty list as if the machine had
#      no spaces at all.
_space_lib_dir=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)
_space_lib_parent=$(cd -- "$_space_lib_dir/.." && pwd)
_space_is_checkout() { [ -f "$1/bin/space-lib.sh" ] && [ -f "$1/agent/space-rules.md" ]; }
if [ -n "${PI_HOME:-}" ]; then
	_space_home=$PI_HOME
	_space_home_from=PI_HOME
elif _space_is_checkout "$_space_lib_parent"; then
	_space_home=$_space_lib_parent
	_space_home_from=checkout
else
	_space_home=$_space_lib_parent
	_space_home_from=parent
fi
: "${SPACE_STATE:=${PI_SPACE_ROOT:-$_space_home}/state}"
SPACES_DIR=$SPACE_STATE/spaces
# The pre-space checkout is retired: its name must not be a default anywhere, or a deleted
# folder stays alive as a fallback path. PI_LEGACY_BOSS_ROOT still names one for a caller that
# keeps records made before the move, and an empty value is the ordinary case.
SPACE_LEGACY_ROOT=${PI_LEGACY_BOSS_ROOT:-}
SPACE_RULES_TEMPLATE=${PI_SPACE_RULES_TEMPLATE:-$_space_home/agent/space-rules.md}
SPACE_CEILING=8

# herdr_app_path — the `herdr-app` this tree talks to, or nothing when there is none.
#
# One decision, the same one `bin/guard` makes (`tool_path`): the override first, then PATH.
# PI_GUARD_HERDR_APP is the guard's own variable, read here too, so one environment points
# every tool in this tree at one app.
#
# Why an override at all: `space new` opens a REAL space in the app of whoever runs it, and a test
# that hands its child a throwaway HOME still finds the app on the user's PATH — the record it
# writes dies with the temp folder, the space stays behind, owned by nothing, and the person's
# focus moves mid-run. With the override a stub answers instead, and the real app is unreachable
# rather than merely outrun. No override and nothing on PATH is an empty answer, never a guess:
# the callers refuse in words that say what to do.
#
# A vendor install folder is deliberately NOT a fallback here. The guard needs one because the
# logon task runs with no useful PATH; `space new` runs from a person's shell or from the
# installer, which has just found `herdr-app` on PATH itself — and a silent fall through to
# `%LOCALAPPDATA%` is exactly the reach a test cannot switch off.
herdr_app_path() {
	if [ -n "${PI_GUARD_HERDR_APP:-}" ] && [ -x "${PI_GUARD_HERDR_APP}" ]; then
		printf '%s' "$PI_GUARD_HERDR_APP"
		return 0
	fi
	command -v herdr-app 2>/dev/null || return 0
}

space_valid_slug() {
	case ${1:-} in [a-z0-9]*) ;; *) return 1 ;; esac
	printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]{0,30}$'
}

space_dir() { printf '%s/%s' "$SPACES_DIR" "$1"; }
space_record() { printf '%s/%s/space.json' "$SPACES_DIR" "$1"; }
space_delegations() { printf '%s/%s/delegations.json' "$SPACES_DIR" "$1"; }
space_specs() { printf '%s/%s/specs' "$SPACES_DIR" "$1"; }
space_reports() { printf '%s/%s/reports' "$SPACES_DIR" "$1"; }
space_exists() { [ -f "$(space_record "${1:-}")" ]; }

# space_slugs — every durable space, one per line, newest record last.
space_slugs() {
	[ -d "$SPACES_DIR" ] || return 0
	local d
	for d in "$SPACES_DIR"/*/; do
		[ -f "${d}space.json" ] || continue
		d=${d%/}
		printf '%s\n' "${d##*/}"
	done
}

# space_field <slug> <field> — a recorded value, empty when the record or the field is missing.
space_field() {
	node -e '
		const fs = require("fs");
		let j = {};
		try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
		const v = process.argv[2].split(".").reduce((a, k) => (a == null ? a : a[k]), j);
		if (v !== undefined && v !== null && v !== "" && typeof v !== "object") process.stdout.write(String(v));
	' "$(space_record "${1:-}")" "${2:-}"
}

# space_set_field <slug> <field> <value> — write one field into a record and leave every other
# field as it was. The record is the whole document (`bin/space show` prints it), so a migration
# that rewrote it would lose what this version does not know about. Written to a temp file beside
# it and renamed, so a reader at the same moment sees the old record or the new one, never half
# of either. A numeric value is written as a number, never as a string: the field types are read
# back by `space_max_open_prs`, and "3" and 3 must not become two answers.
space_set_field() {
	SPACE_FILE=$(space_record "${1:-}") SPACE_KEY=${2:-} SPACE_VALUE=${3:-} node -e '
		const fs = require("fs"), path = require("path");
		const file = process.env.SPACE_FILE;
		let j = {};
		try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(1); }
		const raw = process.env.SPACE_VALUE;
		j[process.env.SPACE_KEY] = /^[0-9]+$/.test(raw) ? Number(raw) : raw;
		const tmp = path.join(path.dirname(file), ".space.json.tmp." + process.pid);
		fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
		fs.renameSync(tmp, file);
	'
}

# space_tabs <slug> — the record's tab names, one per line, in the order the record holds them.
# Nothing is printed for a record with no `tabs` (a space `bin/space new` just made: the guard
# seeds the Boss entry on its first pass), so a caller can read silence as "no entry recorded".
space_tabs() {
	SPACE_FILE=$(space_record "${1:-}") node -e '
		const fs = require("fs");
		let j = {};
		try { j = JSON.parse(fs.readFileSync(process.env.SPACE_FILE, "utf8")); } catch { process.exit(0); }
		for (const t of Array.isArray(j.tabs) ? j.tabs : [])
			if (t && typeof t === "object" && t.name) process.stdout.write(String(t.name) + "\n");
	'
}

# space_remove_tab <slug> <name> — drop the entry called <name> from the record's `tabs` list and
# leave every other field as it was, through the same temp-file-plus-rename write as
# `space_set_field`: a reader at the same moment sees the old record or the new one, never half of
# either. Every entry with that name goes, not the first one — a duplicate left behind would be the
# one the guard rebuilds the tab from. Exit 0 and print the names that are left; 3 when no entry
# matches (the record is untouched); 1 when the record cannot be read or written.
space_remove_tab() {
	SPACE_FILE=$(space_record "${1:-}") TAB_NAME=${2:-} node -e '
		const fs = require("fs"), path = require("path");
		const file = process.env.SPACE_FILE;
		let j = {};
		try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(1); }
		const tabs = Array.isArray(j.tabs) ? j.tabs : [];
		const keep = tabs.filter((t) => !(t && typeof t === "object" && String(t.name || "") === process.env.TAB_NAME));
		if (keep.length === tabs.length) process.exit(3);
		j.tabs = keep;
		const tmp = path.join(path.dirname(file), ".space.json.tmp." + process.pid);
		fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
		fs.renameSync(tmp, file);
		process.stdout.write(keep.map((t) => String((t && t.name) || "")).filter(Boolean).join("\n"));
	'
}

# space_max_open_prs <slug> — how many of this space's pull requests may be open at once, as the
# record says it: a positive integer, or `unbounded`. Absent reads as `1`, which is the rule every
# record written before the field existed was made under; a record hand-edited to something that is
# neither is read the same way, because a typo must not quietly raise the gate it was meant to set.
space_max_open_prs() {
	local v
	v=$(space_field "${1:-}" max_open_prs)
	case $v in
	unbounded) printf 'unbounded' ;;
	*)
		if printf '%s' "$v" | grep -Eq '^[1-9][0-9]*$'; then
			printf '%s' "$v"
		else
			printf '1'
		fi
		;;
	esac
}

# space_kind <slug> — what learning in this space may change: `harness` or `project`.
#
# The space decides the kind and the session that compacted never does, so this is read from the
# record and nowhere else — not from the folder the project happens to sit in, and not from a
# flag a caller could pass. A record written before the field existed is a `project` space.
space_kind() {
	case $(space_field "${1:-}" kind) in
	harness) printf 'harness' ;;
	*) printf 'project' ;;
	esac
}

# space_id_ensure <slug> — herdr's id for a space, from its record.
#
# A record written before this field existed holds the name only, and the name is the person's
# to rename, so the id is read back from `herdr-app ls` once and written into the record (a lazy
# migration: one field, the rest of the record untouched). Prints the id, or nothing when neither
# the record nor herdr can name the space — the caller refuses in words that say what to do.
space_id_ensure() {
	local slug=${1:-} id
	id=$(space_field "$slug" id)
	if [ -n "$id" ]; then
		printf '%s' "$id"
		return 0
	fi
	local app
	app=$(herdr_app_path)
	[ -n "$app" ] || return 0
	id=$("$app" ls 2>/dev/null | HERDR_SPACE_NAME=$slug node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			let j = {};
			try { j = JSON.parse(d); } catch { return; }
			for (const s of (Array.isArray(j.spaces) ? j.spaces : []))
				if (s && s.name === process.env.HERDR_SPACE_NAME && s.id) { process.stdout.write(String(s.id)); return; }
		});
	') || id=""
	[ -n "$id" ] || return 0
	space_set_field "$slug" id "$id" || return 0
	printf '%s' "$id"
}

# space_resolve <dir> — the slug of the space whose project contains <dir>, longest path first.
# A folder no space claims prints nothing: that is the refusal delegate turns into the command
# that creates one. Two spaces on the same folder cannot both be right, so the longer project
# path wins, and equal paths fall back to the slug order.
space_resolve() {
	SPACES_DIR=$SPACES_DIR node -e '
		const fs = require("fs"), path = require("path");
		let cwd;
		try { cwd = fs.realpathSync(process.argv[1]); } catch { process.exit(0); }
		let names = [];
		try { names = fs.readdirSync(process.env.SPACES_DIR); } catch { process.exit(0); }
		let best = null;
		for (const name of names.sort()) {
			let j = {};
			try { j = JSON.parse(fs.readFileSync(path.join(process.env.SPACES_DIR, name, "space.json"), "utf8")); } catch { continue; }
			let proj;
			try { proj = fs.realpathSync(String(j.project || "")); } catch { continue; }
			if (cwd !== proj && !cwd.startsWith(proj.endsWith("/") ? proj : proj + "/")) continue;
			if (!best || proj.length > best.len) best = { name, len: proj.length };
		}
		if (best) process.stdout.write(best.name);
	' "${1:-.}"
}

# space_pick <explicit|empty> <dir> [slug] — the slug of the space a command runs in, in the one
# rule bin/delegate uses: the space --space named, else the space whose project is the longest one
# containing <dir>, else — when the folder is in no space — the space whose record tracks worker
# <slug> (space_of_slug, the answer `delegate finish` trusts for that slug). The last one is what
# makes a worker's own `bin/preflight --slug <slug>` in its worktree find the report: a worktree
# lives outside the space's project. Prints nothing and returns 0 when none of the three names a
# space, so a caller can keep the pre-space layout; a --space that names no space prints why on
# stderr and returns 2, and the caller refuses in its own words rather than guessing.
space_pick() {
	local explicit=${1:-} dir=${2:-.} worker=${3:-} slug
	if [ -n "$explicit" ]; then
		space_valid_slug "$explicit" || {
			printf -- "--space takes a space name: '%s'\n" "$explicit" >&2
			return 2
		}
		if ! space_exists "$explicit"; then
			printf 'no such space: %s — bin/space list\n' "$explicit" >&2
			return 2
		fi
		printf '%s' "$explicit"
		return 0
	fi
	slug=$(space_resolve "$dir")
	if [ -n "$slug" ]; then
		printf '%s' "$slug"
		return 0
	fi
	[ -z "$worker" ] || space_of_slug "$worker"
	return 0
}

# space_of_slug <slug> — the space that tracks worker <slug>, from this machine's record.
space_of_slug() {
	local s
	for s in $(space_slugs); do
		[ -f "$(space_delegations "$s")" ] || continue
		if node -e '
			const fs = require("fs");
			let j = {};
			try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
			process.exit(j[process.argv[2]] ? 0 : 1);' "$(space_delegations "$s")" "${1:-}"; then
			printf '%s' "$s"
			return 0
		fi
	done
	return 0
}

# space_merge_delegations <outfile> — every space's workers as one object, each entry carrying
# `space`, plus the legacy record when one exists and no space's own record mentions that slug
# (read once, for one release; never written back). One document, because every reader of
# state/delegations.json parses the whole file as a single object. Written to a temp file and
# renamed, so a reader running at the same moment sees the old document or the new one, never a
# half of either.
space_merge_delegations() {
	SPACES_DIR=$SPACES_DIR SPACE_LEGACY_DELEGATIONS="${SPACE_LEGACY_ROOT:+$SPACE_LEGACY_ROOT/state/delegations.json}" \
		node -e '
		const fs = require("fs"), path = require("path");
		const out = {};
		let names = [];
		try { names = fs.readdirSync(process.env.SPACES_DIR); } catch {}
		for (const name of names.sort()) {
			let j = {};
			try { j = JSON.parse(fs.readFileSync(path.join(process.env.SPACES_DIR, name, "delegations.json"), "utf8")); } catch { continue; }
			for (const k of Object.keys(j)) out[k] = Object.assign({}, j[k] || {}, { spaceName: name });
		}
		let legacy = {};
		try { legacy = JSON.parse(fs.readFileSync(process.env.SPACE_LEGACY_DELEGATIONS, "utf8")); } catch {}
		for (const k of Object.keys(legacy)) if (!out[k]) out[k] = Object.assign({}, legacy[k] || {}, { legacy: true });
		const tmp = process.argv[1] + ".tmp." + process.pid;
		fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
		fs.renameSync(tmp, process.argv[1]);
	' "${1:?space_merge_delegations needs an output file}"
}

# space_rules_block <slug> <project> — the rules a space writes into the project's AGENTS.md,
# generated from agent/space-rules.md. Two markers, so a second run replaces its own block and a
# file that already has one never grows a second copy.
space_rules_block() {
	local slug=$1 project=$2 tpl
	tpl=${SPACE_RULES_TEMPLATE:-}
	[ -n "$tpl" ] && [ -f "$tpl" ] || return 1
	printf '<!-- pi-space:begin -->\n'
	sed -e "s|{{SPACE}}|$slug|g" -e "s|{{PROJECT}}|$project|g" "$tpl"
	printf '<!-- pi-space:end -->\n'
}

# space_rules_write <slug> <project> — write or replace the block in <project>/AGENTS.md.
# Replace-only: the file's other content is untouched, and the block appears exactly once.
space_rules_write() {
	local slug=$1 project=$2 file block tmp
	file=$project/AGENTS.md
	block=$(space_rules_block "$slug" "$project") || return 1
	if [ ! -f "$file" ]; then
		printf '%s\n' "$block" >"$file"
		return 0
	fi
	tmp=$(mktemp)
	BLOCK=$block node -e '
		const fs = require("fs");
		const [file, tmp] = process.argv.slice(1);
		const block = process.env.BLOCK;
		const text = fs.readFileSync(file, "utf8");
		const begin = "<!-- pi-space:begin -->", end = "<!-- pi-space:end -->";
		const b = text.indexOf(begin), e = text.indexOf(end);
		let out;
		if (b >= 0 && e > b) {
			// Replace the first block in place; drop any later copy.
			let head = text.slice(0, b), tail = text.slice(e + end.length);
			tail = tail.split(begin).map((part, i) => {
				if (i === 0) return part;
				const cut = part.indexOf(end);
				return cut < 0 ? "" : part.slice(cut + end.length);
			}).join("");
			out = head + block + "\n" + tail.replace(/^\n+/, "\n");
		} else {
			out = text.replace(/\s*$/, "\n\n") + block + "\n";
		}
		fs.writeFileSync(tmp, out);
	' "$file" "$tmp"
	mv "$tmp" "$file"
}

# space_writable <dir> — a project this person can actually work in.
space_writable() {
	local dir=$1 probe
	[ -d "$dir" ] && [ -w "$dir" ] || return 1
	probe=$(mktemp -p "$dir" .pi-space-probe.XXXXXX 2>/dev/null) || return 1
	rm -f "$probe"
	return 0
}
