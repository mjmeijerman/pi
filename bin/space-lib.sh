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
# the tree this file lives in. PI_LEGACY_BOSS_ROOT is the pre-space record, read and never written.

_space_lib_dir=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)
: "${SPACE_STATE:=${PI_SPACE_ROOT:-$(cd -- "$_space_lib_dir/.." && pwd)}/state}"
SPACES_DIR=$SPACE_STATE/spaces
SPACE_LEGACY_ROOT=${PI_LEGACY_BOSS_ROOT:-$HOME/big-boss-pi}
SPACE_RULES_TEMPLATE=${PI_SPACE_RULES_TEMPLATE:-$(cd -- "$_space_lib_dir/.." && pwd)/agent/space-rules.md}
SPACE_CEILING=8

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
# that rewrote it would lose what this version does not know about.
space_set_field() {
	node -e '
		const fs = require("fs");
		let j = {};
		try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
		j[process.argv[2]] = process.argv[3];
		fs.writeFileSync(process.argv[1], JSON.stringify(j, null, 2) + "\n");
	' "$(space_record "${1:-}")" "${2:-}" "${3:-}"
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
	command -v herdr-app >/dev/null 2>&1 || return 0
	id=$(herdr-app ls 2>/dev/null | HERDR_SPACE_NAME=$slug node -e '
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
# state/delegations.json parses the whole file as a single object.
space_merge_delegations() {
	SPACES_DIR=$SPACES_DIR SPACE_LEGACY_DELEGATIONS="$SPACE_LEGACY_ROOT/state/delegations.json" \
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
		fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
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
