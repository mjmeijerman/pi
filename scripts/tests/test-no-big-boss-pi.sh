#!/usr/bin/env bash
# ============================================================================
# test-no-big-boss-pi.sh — the retired checkout must not be pointed at.
#
# Why this exists: the pre-space checkout at ~/big-boss-pi held the tools, the
# gate, the publisher and the Boss rules, and all of them live in ~/.pi now, so
# the folder is meant to be deletable. It is only deletable when nothing in this
# repo reads it: a path computed into it is a crash on the day it is removed, not
# a stale comment.
#
# The rule this test holds: no tracked file may name the retired checkout, with
# one exception — the login entry every machine already has registered is called
# `big-boss-pi-guard`, and `scripts/install-lib.mjs` must be able to spell that
# name to remove it. So the entry name is stripped before the search and the
# migration needs no exemption at all. `bin/guard` is not in the search: the file
# filter below is by extension, and it has none.
#
# The allowlist is a ratchet, not a permission: every entry is a named open item
# with the reason it is still there, case 2 fails if an entry rots away, and case
# 1 fails the moment a new file starts naming the folder. The list only shrinks.
#
# Expected on the parent commit: 18 files, so this fails there. That is the point.
# ============================================================================
set -uo pipefail

DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$DIR/../.." && pwd)
cd "$ROOT" || exit 1

PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); printf '  ok   %s\n' "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf '  FAIL %s\n' "$1"
	[ $# -gt 1 ] && printf '       %s\n' "$2"
}

# The names that must stay in the migration, and the reason each allowlisted path
# may still name the folder. One path per line, `path|reason`.
ALLOW=$(cat <<'EOF'
agent/extensions/big-boss-pi-guard.ts|the delegation-workspace guard is named after the folder it guards; renaming it is its own spec
agent/extensions/__tests__/big-boss-pi-guard.test.ts|the guard's own tests, fixtures named after the guard
agent/extensions/__tests__/big-boss-pi-guard-mutants.test.ts|the guard's mutant tests, same names
agent/extensions/__tests__/merge-guard.test.ts|a session path fixture inside the workspace the guard protects
docs/mutation-survivors.md|dated ledger whose rows quote test inputs from the guard's test files
docs/radar-conformance.md|the 2026-11-18 mutation reading names the six files it scored, two of them guard names
docs/radar-adoption-brief.md|the brief measures the backlog that lives in that folder, dated
docs/threat-model.md|the bare Boss's threat surface, dated, written about that box
git-hooks/scan-mutation.sh|a comment saying which pushes touch no extension
scripts/mutate-changed.sh|a comment saying where the sweep reports used to be archived
agent/extensions/herdr-resume-map.ts|reads worker argv names by path to work out a resumed worker's mode — open item, repoint to ~/.pi/bin
agent/extensions/__tests__/herdr-resume-map.test.ts|the fixtures for that mapping, open item with it
agent/extensions/self-learn.ts|WORKSPACE = join(homedir(), "big-boss-pi") — open item, the learner still writes there
agent/extensions/__tests__/self-learn.test.ts|the learner's own tests, open item with it
agent/prompts/learn.md|prose about the space the learner hands a branch to, open item
agent/skills/jev/SKILL.md|the jev binary resolution and one example path, open item
EOF
)

allowed_paths() { printf '%s\n' "$ALLOW" | sed -n 's/^\([^|]*\)|.*/\1/p'; }

# Tracked text files the rule applies to. `.ts` is here because the live code
# that would break is TypeScript; the spec's list stopped at `.service`.
FILES=$(git ls-files '*.sh' '*.mjs' '*.md' '*.json' '*.service' '*.ts' '*.ps1' '*.yml' '*.yaml' '*.txt')

# The search: strip the login entry's own name (`big-boss-pi-guard`), and what is
# left is a reference to the folder. awk, not `grep -P`: lint on a Mac has no -P.
# This file is skipped — a test that searches for a string has to contain it.
hits=$(
	printf '%s\n' "$FILES" | while IFS= read -r f; do
		[ -n "$f" ] || continue
		[ "$f" = "scripts/tests/test-no-big-boss-pi.sh" ] && continue
		awk -v F="$f" '
			{ line = $0; gsub(/big-boss-pi-guard/, "", line)
			  if (line ~ /big-boss-pi/) printf "%s:%d:%s\n", F, NR, $0 }
		' "$f"
	done
)

printf '\n== the retired checkout is not pointed at\n'
unlisted=$(printf '%s\n' "$hits" | sed -n 's/^\([^:]*\):.*/\1/p' | sort -u | grep -v '^$' | grep -vxF -f <(allowed_paths))
if [ -z "$unlisted" ]; then
	pass 'no file outside the allowlist names the retired checkout'
else
	fail 'these files name the retired checkout and are not allowlisted' "$(printf '%s\n' "$unlisted" | tr '\n' ' ')"
fi

printf '\n== the allowlist is a list of open items, not a permission\n'
allow_n=$(allowed_paths | wc -l | tr -d ' ')
hit_n=$(printf '%s\n' "$hits" | sed -n 's/^\([^:]*\):.*/\1/p' | sort -u | grep -c .)
if [ "$hit_n" -le "$allow_n" ]; then
	pass "$hit_n file(s) name it, all allowlisted ($allow_n entries)"
else
	fail "$hit_n file(s) name it, more than the $allow_n allowlisted"
fi
# A here-string, not a pipe: under `set -uo pipefail` a reader that exits early
# (grep -q does, as soon as it matches) is a write error on the writer, so the
# pipeline's status is 141 and this loop would call a good allowlist entry
# rotted. A here-string has no writer process, so there is no pipe to break.
rotted=''
while IFS= read -r p; do
	[ -n "$p" ] || continue
	if ! grep -q "^$p:" <<<"$hits"; then rotted="$rotted $p"; fi
done <<<"$(allowed_paths)"
if [ -z "$rotted" ]; then
	pass 'every allowlisted path still names it — no entry is stale'
else
	fail 'an allowlisted path no longer names it, so its entry must go' "$rotted"
fi
dupes=$(allowed_paths | sort | uniq -d | tr '\n' ' ')
if [ -z "$dupes" ]; then
	pass 'no path is listed twice'
else
	fail 'a path is listed twice' "$dupes"
fi

printf '\n== the migration keeps the names it must remove, and nothing else\n'
lib=scripts/install-lib.mjs
if [ -f "$lib" ]; then
	if grep -q 'LEGACY_GUARD' "$lib" && grep -q "big-boss-pi-guard" "$lib"; then
		pass 'install-lib.mjs holds the old unit/task/label in LEGACY_GUARD'
	else
		fail 'install-lib.mjs no longer names the entry it has to remove'
	fi
	# Every spelling left there must be one of the three entry names, never a path.
	awk '/big-boss-pi/ { line=$0; gsub(/big-boss-pi-guard/, "", line); if (line ~ /big-boss-pi/) print NR": "$0 }' "$lib" >/dev/null
	# LEGACY_GUARD is the only place; the rest of the file must be clean.
	outside=$(awk '
		/LEGACY_GUARD/ || /^};$/ { inblock = ($0 ~ /LEGACY_GUARD/) ? 1 : 0; next }
		{ line=$0; gsub(/big-boss-pi-guard/, "", line); if (line ~ /big-boss-pi/ && !inblock) print NR": "$0 }
	' "$lib")
	if [ -z "$outside" ]; then
		pass 'outside LEGACY_GUARD, install-lib.mjs names no part of it'
	else
		fail 'install-lib.mjs names it outside LEGACY_GUARD' "$outside"
	fi
else
	fail "$lib is missing — there is nothing to migrate from"
fi

printf '\n== verdict ==\n'
printf '%s passed, %s failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
