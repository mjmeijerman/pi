#!/usr/bin/env bash
# receipts.sh — one ledger for every gate that proves a tree: a verdict reached once is reused by
# the gate that needs it next, and never re-run just because another command asked.
#
#   . "$root/bin/receipts.sh"
#   receipt_init "$root"          # the checkout this gate sits in; sets the ledger's location
#   receipt_lookup "<name>" out   # 0 = answered from a receipt, RC/MS/TS/AGE filled in
#   receipt_write "<name>" <rc> <ms> <transcript-file>
#
# Why it exists: `bin/preflight`'s `suites` check runs this repo's test suites, and
# `scripts/ci-offline.sh` then ran 22 of the same test scripts again (79s, 41s of it user CPU).
# Both exist because GitHub Actions cannot start a job here, so a publish that asks for both paid
# for both. The ledger is the one place a test script's answer is kept, so the second ask is a
# file read.
#
# A receipt is never a pass by staleness, so its key is the whole input of the verdict it holds:
#
#   the tree    `git rev-parse HEAD` plus `git status --porcelain`, so an unstaged edit — a tree
#               no receipt was ever written on — invalidates every receipt at once
#   the name    the suite or test, as the command that ran it: `script:scripts/tests/x.test.sh`,
#               so both gates name the same script the same way and there is one entry for it
#   the gates   sha256 over bin/preflight, bin/receipts.sh, scripts/ci-local.sh and
#               scripts/ci-offline.sh, so a changed gate never reuses another gate's verdict, in
#               either direction. Reuse is therefore symmetric: what ci-offline wrote, preflight
#               reads, and what preflight wrote, ci-offline reads.
#
# The ledger lives at $PI_RECEIPT_DIR when a caller pinned one — bin/preflight exports it to every
# suite it runs, so a gate that runs inside another writes where its parent reads — and otherwise
# at <checkout>/state/preflight. `state/` is generated and gitignored, so writing a receipt cannot
# dirty the tree hash it was keyed by.
#
# PI_PREFLIGHT_CACHE_TTL (seconds, or Ns/Nm/Nh; default 6h, 0 disables) expires a receipt, and an
# expired receipt is no receipt at all: the work runs again. A cached FAIL is still a FAIL — it is
# read, printed with the transcript that failed, and it blocks.

_receipt_sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# receipt_init <checkout> — where this gate sits (for the gate hashes) and where its receipts go.
receipt_init() {
	local root=$1
	root=$(cd -- "$root" 2>/dev/null && pwd) || return 1
	RECEIPT_HOME=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.." && pwd)
	RECEIPT_TREE_ROOT=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$root")
	RECEIPT_DIR=${PI_RECEIPT_DIR:-$RECEIPT_TREE_ROOT/state/preflight}
	export PI_RECEIPT_DIR=$RECEIPT_DIR
	RECEIPT_TREE=""
	RECEIPT_GATE=""
	RECEIPT_RC=""
	RECEIPT_MS=0
	RECEIPT_TS=0
	RECEIPT_AGE=0
	return 0
}

# receipt_tree — the tree hash, read once per process: HEAD and the working tree, so a dirty tree
# is its own tree and a receipt written on a clean one cannot answer for it.
receipt_tree() {
	local head st
	[ -n "$RECEIPT_TREE" ] && {
		printf '%s' "$RECEIPT_TREE"
		return 0
	}
	head=$(git -C "$RECEIPT_TREE_ROOT" rev-parse HEAD 2>/dev/null || printf 'no-head')
	st=$(git -C "$RECEIPT_TREE_ROOT" status --porcelain 2>/dev/null | LC_ALL=C sort)
	RECEIPT_TREE=$(_receipt_sha "$head"$'\n'"$st")
	printf '%s' "$RECEIPT_TREE"
}

# receipt_gate — the gates' own bytes, read once. A receipt is only reused by the same gates that
# produced it; the ledger code is one of them, because a change in how a verdict is keyed or read
# changes what a receipt means.
receipt_gate() {
	local f out=""
	[ -n "$RECEIPT_GATE" ] && {
		printf '%s' "$RECEIPT_GATE"
		return 0
	}
	for f in bin/preflight bin/receipts.sh scripts/ci-local.sh scripts/ci-offline.sh; do
		out="$out$(_receipt_sha "$(sha256sum "$RECEIPT_HOME/$f" 2>/dev/null | cut -d' ' -f1)")-"
	done
	RECEIPT_GATE=$(_receipt_sha "receipts-1"$'\n'"$out")
	printf '%s' "$RECEIPT_GATE"
}

receipt_key() { # <name>
	_receipt_sha "receipts-1"$'\n'"$(receipt_tree)"$'\n'"$(receipt_gate)"$'\n'"$1"
}

# PI_PREFLIGHT_CACHE_TTL: seconds, or Ns/Nm/Nh. Default six hours; 0 disables the ledger.
receipt_ttl_seconds() {
	local v=${PI_PREFLIGHT_CACHE_TTL:-6h} n unit=1
	case $v in *[!0-9smhSMH]*) printf '21600'; return 0 ;; esac
	case $v in
	*[hH]) n=${v%[hH]} unit=3600 ;;
	*[mM]) n=${v%[mM]} unit=60 ;;
	*[sS]) n=${v%[sS]} ;;
	*) n=$v ;;
	esac
	case $n in '' | *[!0-9]*) n=21600 unit=1 ;; esac
	printf '%s' "$((n * unit))"
}

receipt_age_human() { # <seconds> — "8s", "4m", "3h", "2d"
	local s=$1
	if [ "$s" -lt 90 ]; then printf '%ss' "$s"
	elif [ "$s" -lt 5400 ]; then printf '%sm' "$((s / 60))"
	elif [ "$s" -lt 172800 ]; then printf '%sh' "$((s / 3600))"
	else printf '%sd' "$((s / 86400))"; fi
}

receipt_stamp() { # <epoch> — the ISO second the verdict was reached
	date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'ts %s' "$1"
}

# receipt_read <name> <transcript-file> — prints "exit elapsed_ms ts" and writes the stored
# transcript to <transcript-file>; nonzero when there is no receipt for this key. Age is never
# judged here: freshness is the caller's decision, and receipt_lookup is where it is made.
receipt_read() {
	local key file
	command -v node >/dev/null 2>&1 || return 1
	key=$(receipt_key "$1") || return 1
	file=$RECEIPT_DIR/$key.json
	[ -f "$file" ] || return 1
	node -e '
		const fs = require("fs");
		const [path, into] = process.argv.slice(1);
		let j;
		try { j = JSON.parse(fs.readFileSync(path, "utf8")); } catch { process.exit(1); }
		if (typeof j.exit !== "number" || typeof j.ts !== "number") process.exit(1);
		fs.writeFileSync(into, String(j.output == null ? "" : j.output));
		process.stdout.write(`${j.exit} ${j.elapsed_ms || 0} ${j.ts}`);' "$file" "$2"
}

# receipt_write <name> <exit> <elapsed_ms> <transcript-file> — record a verdict that was reached.
receipt_write() {
	local key tmp
	key=$(receipt_key "$1") || return 0
	[ -f "$4" ] || return 0
	mkdir -p "$RECEIPT_DIR" 2>/dev/null || return 0
	tmp=$RECEIPT_DIR/.$key.$$.tmp
	node -e '
		const fs = require("fs");
		const [dest, tmp, check, rc, ms, out, tree, gate] = process.argv.slice(1);
		const rec = {
			check,
			exit: Number(rc),
			elapsed_ms: Number(ms),
			ts: Math.floor(Date.now() / 1000),
			at: new Date().toISOString(),
			tree: tree,
			gate: gate,
			output: fs.readFileSync(out, "utf8"),
		};
		fs.writeFileSync(tmp, JSON.stringify(rec, null, 1) + "\n");
		fs.renameSync(tmp, dest);' "$RECEIPT_DIR/$key.json" "$tmp" "$1" "$2" "$3" "$4" \
		"$(receipt_tree)" "$(receipt_gate)" 2>/dev/null || rm -f "$tmp"
	return 0
}

# receipt_lookup <name> <transcript-file> — 0 when a fresh receipt answered it, and then
# RECEIPT_RC/RECEIPT_MS/RECEIPT_TS/RECEIPT_AGE hold the verdict that was reached before. A caller
# that must ignore the ledger for a run exports PI_RECEIPT_FRESH=1 instead.
receipt_lookup() {
	local ttl stamp
	RECEIPT_RC=""
	RECEIPT_MS=0
	RECEIPT_TS=0
	RECEIPT_AGE=0
	[ -z "${PI_RECEIPT_FRESH:-}" ] || return 1
	ttl=$(receipt_ttl_seconds)
	[ "$ttl" -gt 0 ] || return 1
	stamp=$(receipt_read "$1" "$2") || return 1
	read -r RECEIPT_RC RECEIPT_MS RECEIPT_TS <<<"$stamp"
	case $RECEIPT_RC in '' | *[!0-9]*) return 1 ;; esac
	RECEIPT_AGE=$(($(date +%s) - RECEIPT_TS))
	# A receipt from the future is a clock that moved: treat it as no receipt at all.
	[ "$RECEIPT_AGE" -ge 0 ] || return 1
	[ "$RECEIPT_AGE" -le "$ttl" ] || return 1
	return 0
}

# receipt_forget — --fresh means this tree's memory is not trusted, so it is not left behind for
# the other gate to read either: a run that bypasses the ledger and a run that trusts it must
# agree. Only this tree's receipts go — another checkout, and a suite's own throwaway repo, keep
# theirs, so a nested --fresh cannot empty the ledger of the run that started it.
receipt_forget() {
	local f tree
	[ -d "${RECEIPT_DIR:-}" ] || return 0
	tree=$(receipt_tree)
	for f in "$RECEIPT_DIR"/*.json; do
		[ -f "$f" ] || continue
		grep -qF "\"tree\": \"$tree\"" "$f" 2>/dev/null && rm -f -- "$f"
	done
	return 0
}

# receipt_unit_name <command line> — the name a suite is keyed by, the same string from either
# gate: `bash scripts/tests/x.test.sh` and `bash scripts/ci-local.sh --only offline` are paths in
# this tree, so they are named by path (`script:…`); a bare tool invocation is named as itself.
receipt_unit_name() {
	local cmd=$1 first rest
	cmd=${cmd#"${cmd%%[![:space:]]*}"}
	cmd=${cmd%"${cmd##*[![:space:]]}"}
	case $cmd in bash\ *) cmd=${cmd#bash } ;; esac
	first=${cmd%% *}
	if [ "$first" = "$cmd" ]; then rest=""; else rest=${cmd#* }; fi
	first=${first#./}
	if [ -n "$first" ] && [ -f "$RECEIPT_TREE_ROOT/$first" ]; then
		printf 'script:%s%s' "$first" "${rest:+ $rest}"
	else
		printf 'unit:%s' "$cmd"
	fi
}
