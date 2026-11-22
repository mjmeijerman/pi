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
#   the tree    the content of the working tree: `git add -A -- ./` into a throwaway index
#               (`GIT_INDEX_FILE`) and `git write-tree`. One cheap call, and the key is the bytes
#               the gates will read — an unstaged edit is a different tree, and two worktrees or
#               two clones of the same content are the same tree, so one verdict answers both.
#               HEAD is not in the key on purpose: a commit that changes nothing is not new work.
#   the name    the suite or test, as the command that ran it: `script:scripts/tests/x.test.sh`,
#               so both gates name the same script the same way and there is one entry for it
#   the gates   sha256 over bin/preflight, bin/receipts.sh, bin/ci, scripts/ci-local.sh and
#               scripts/ci-offline.sh, so a changed gate never reuses another gate's verdict, in
#               either direction. Reuse is therefore symmetric: what ci-offline wrote, preflight
#               reads, and what preflight wrote, ci-offline reads.
#
# The content hash is the tracked content plus the untracked-and-not-ignored files, exactly what
# `git status` would call the working tree: `.gitignore`d paths (`state/`, `.env`, a worktree) are
# outside it, so a job whose verdict reads one of those is never answered by a content-keyed
# receipt — `bin/ci` marks those rows `no-cache` instead.
#
# The tree is only a tree when it is this one: `git rev-parse --show-toplevel` walks upward, so a
# directory that merely sits inside some other checkout (a test fixture, a scratch dir under $HOME)
# would otherwise be keyed by that enclosing repo — whose dirty state the run itself changes. A
# toplevel that is not $root and not inside it is not this tree's root, and the tree is then keyed
# by its own path instead of content nobody here wrote.
#
# Where the ledger lives is two tiers. A caller that sets PI_RECEIPT_SHARED (bin/ci inside a space)
# puts every receipt in that shared directory, keyed by content, so every worktree of one space
# answers from one ledger. A caller that pins PI_RECEIPT_DIR — bin/preflight exports it to every
# suite it runs, so a gate that runs inside another writes where its parent reads — writes there.
# Otherwise the receipts are at <checkout>/state/preflight, which is the original per-tree store.
# `state/` is generated and gitignored, so writing a receipt cannot dirty the tree hash it was
# keyed by.
#
# PI_RECEIPT_NOCACHE (any value) disables both tiers: nothing is read and nothing is written. That
# is `bin/ci --no-cache`, and it is the only honest answer for a job that would read a file the
# content hash cannot see.
#
# PI_PREFLIGHT_CACHE_TTL (seconds, or Ns/Nm/Nh; default 6h, 0 disables) expires a receipt, and an
# expired receipt is no receipt at all: the work runs again. A cached FAIL is still a FAIL — it is
# read, printed with the transcript that failed, and it blocks.

_receipt_sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# receipt_init <checkout> — where this gate sits (for the gate hashes) and where its receipts go.
receipt_init() {
	local root=$1 top
	root=$(cd -- "$root" 2>/dev/null && pwd) || return 1
	RECEIPT_HOME=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.." && pwd)
	top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)
	case $top in
	"$root" | "$root"/*) RECEIPT_GIT=1 ;;
	*) top="" ; RECEIPT_GIT=0 ;;
	esac
	RECEIPT_TREE_ROOT=${top:-$root}
	# Two tiers, one active: a shared directory when the caller named one (bin/ci in a space),
	# else the caller's pinned directory, else this tree's own. RECEIPT_TIER_NAME is what the
	# caller prints as "which ledger answered".
	if [ -n "${PI_RECEIPT_SHARED:-}" ]; then
		RECEIPT_DIR=$PI_RECEIPT_SHARED
		RECEIPT_TIER_NAME=shared
	else
		RECEIPT_DIR=${PI_RECEIPT_DIR:-$RECEIPT_TREE_ROOT/state/preflight}
		RECEIPT_TIER_NAME=tree
	fi
	export PI_RECEIPT_DIR=$RECEIPT_DIR
	RECEIPT_TREE=""
	RECEIPT_GATE=""
	RECEIPT_RC=""
	RECEIPT_TIER=""
	RECEIPT_MS=0
	RECEIPT_TS=0
	RECEIPT_AGE=0
	return 0
}

# receipt_tree — the content hash, read once per process: `git add -A -- ./` into a throwaway index
# and `git write-tree`, so the key is the bytes the gate will read. An unstaged edit is a different
# tree, and two worktrees of the same content are the same tree. HEAD is deliberately absent: a
# rebase or a commit that changes nothing is not new work, and the file content already says so.
receipt_tree() {
	local idx tree head st
	[ -n "$RECEIPT_TREE" ] && {
		printf '%s' "$RECEIPT_TREE"
		return 0
	}
	if [ "${RECEIPT_GIT:-0}" = 0 ]; then
		# No checkout of its own: the tree is the directory, so two scratch dirs never share a
		# receipt and nothing an enclosing repo does can change this key.
		RECEIPT_TREE=$(_receipt_sha "no-git"$'\n'"$RECEIPT_TREE_ROOT")
		printf '%s' "$RECEIPT_TREE"
		return 0
	fi
	idx=$(mktemp "${TMPDIR:-/tmp}/pi-receipt-index.XXXXXX" 2>/dev/null || true)
	if [ -n "$idx" ]; then
		rm -f -- "$idx"
		if GIT_INDEX_FILE=$idx git -C "$RECEIPT_TREE_ROOT" add -A -- ./ >/dev/null 2>&1 &&
			tree=$(GIT_INDEX_FILE=$idx git -C "$RECEIPT_TREE_ROOT" write-tree 2>/dev/null) &&
			[ -n "$tree" ]; then
			rm -f -- "$idx"
			RECEIPT_TREE=$tree
			printf '%s' "$RECEIPT_TREE"
			return 0
		fi
		rm -f -- "$idx"
	fi
	# An index this cannot write (a read-only tree, an odd git) still has a key, and a worse one:
	# HEAD plus the dirty list, which at least invalidates on any edit.
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
	for f in bin/preflight bin/receipts.sh bin/ci scripts/ci-local.sh scripts/ci-offline.sh; do
		out="$out$(_receipt_sha "$(sha256sum "$RECEIPT_HOME/$f" 2>/dev/null | cut -d' ' -f1)")-"
	done
	RECEIPT_GATE=$(_receipt_sha "receipts-2"$'\n'"$out")
	printf '%s' "$RECEIPT_GATE"
}

receipt_key() { # <name>
	_receipt_sha "receipts-2"$'\n'"$(receipt_tree)"$'\n'"$(receipt_gate)"$'\n'"$1"
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
#
# Plain text, read with what a POSIX box already has: metadata lines, a `---output---` marker, then
# the transcript verbatim. It used to be JSON parsed by `node`, which made the ledger depend on node
# being on PATH — CI's node is not in /usr/bin, so the receipt was never found and every suite ran
# twice. The ledger is read on the way into a run, so it may not need a runtime to be read.
receipt_read() {
	local key file line rc="" ts="" ms=""
	key=$(receipt_key "$1") || return 1
	file=$RECEIPT_DIR/$key.receipt
	[ -f "$file" ] || return 1
	while IFS= read -r line; do
		case $line in
		'exit: '*) rc=${line#exit: } ;;
		'ts: '*) ts=${line#ts: } ;;
		'elapsed_ms: '*) ms=${line#elapsed_ms: } ;;
		'---output---') break ;;
		esac
	done <"$file"
	case $rc in '' | *[!0-9]*) return 1 ;; esac
	case $ts in '' | *[!0-9]*) return 1 ;; esac
	case $ms in '' | *[!0-9]*) ms=0 ;; esac
	# Everything after the marker is the transcript, byte for byte.
	awk 'seen { print } !seen && $0 == "---output---" { seen = 1 }' "$file" >"$2" || return 1
	printf '%s %s %s' "$rc" "$ms" "$ts"
}

# receipt_write <name> <exit> <elapsed_ms> <transcript-file> — record a verdict that was reached.
receipt_write() {
	local key tmp now
	[ -z "${PI_RECEIPT_NOCACHE:-}" ] || return 0
	key=$(receipt_key "$1") || return 0
	[ -f "$4" ] || return 0
	mkdir -p "$RECEIPT_DIR" 2>/dev/null || return 0
	tmp=$RECEIPT_DIR/.$key.$$.tmp
	now=$(date +%s)
	{
		printf 'check: %s\nexit: %s\nelapsed_ms: %s\nts: %s\nat: %s\ntree: %s\ngate: %s\n---output---\n' \
			"$1" "$2" "$3" "$now" "$(receipt_stamp "$now")" "$(receipt_tree)" "$(receipt_gate)"
		cat -- "$4"
	} >"$tmp" 2>/dev/null && mv -f -- "$tmp" "$RECEIPT_DIR/$key.receipt" 2>/dev/null ||
		rm -f -- "$tmp"
	return 0
}

# receipt_lookup <name> <transcript-file> — 0 when a fresh receipt answered it, and then
# RECEIPT_RC/RECEIPT_MS/RECEIPT_TS/RECEIPT_AGE hold the verdict that was reached before. A caller
# that must ignore the ledger for a run exports PI_RECEIPT_FRESH=1 instead.
receipt_lookup() {
	local ttl stamp
	RECEIPT_RC=""
	RECEIPT_TIER=""
	RECEIPT_MS=0
	RECEIPT_TS=0
	RECEIPT_AGE=0
	# --no-cache and --fresh both mean "do not trust what is on disk", and this is the one place
	# that decides it for every reader.
	[ -z "${PI_RECEIPT_NOCACHE:-}" ] || return 1
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
	RECEIPT_TIER=${RECEIPT_TIER_NAME:-tree}
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
	for f in "$RECEIPT_DIR"/*.receipt; do
		[ -f "$f" ] || continue
		grep -qxF "tree: $tree" "$f" 2>/dev/null && rm -f -- "$f"
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
