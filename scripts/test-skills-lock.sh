#!/usr/bin/env bash
# Tests for the skill pin: `scripts/harness-check.sh --write-skills-lock` writes
# agent/skills.lock, `--verify-skills-lock` reads it back and refuses a mismatch.
#
# Why these exist: a skill arrives from elsewhere and nothing pinned it, so a
# changed byte in a SKILL.md was invisible to every check (blip #72 agent package
# manager, blip #7 plugin marketplace). Each rule the lock promises is one case
# here, run against the real harness-check.sh in a throwaway root — a fixture
# copy of the script would drift away from the script that ships.
#
# Every case is offline and self-contained: temp roots under one mktemp -d, git
# config neutralised, no network.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT_DIR/scripts/harness-check.sh"
[ -f "$CHECK" ] || {
	printf 'FATAL: %s is missing\n' "$CHECK" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
ROOT=""

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

# A fresh harness-shaped root: two skills, one of them with a referenced file.
new_root() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	ROOT="$WORK/case$CASE_N"
	mkdir -p "$ROOT/agent/skills/demo/references" "$ROOT/agent/skills/other"
	cat >"$ROOT/agent/skills/demo/SKILL.md" <<'EOF'
---
name: demo
description: a skill that loads references/rules.md before acting.
---
Read references/rules.md, then apply clubs.tsv.
EOF
	printf 'rules v1\n' >"$ROOT/agent/skills/demo/references/rules.md"
	printf 'club\tcity\n' >"$ROOT/agent/skills/demo/clubs.tsv"
	# A stray token that resolves to no file must not become an entry.
	printf 'See https://example.invalid/WORK/repo for the source.\n' >>"$ROOT/agent/skills/demo/SKILL.md"
	printf 'plain skill\n' >"$ROOT/agent/skills/other/SKILL.md"
}

write_lock() { bash "$CHECK" --root "$ROOT" --write-skills-lock; }
verify_lock() { bash "$CHECK" --root "$ROOT" --verify-skills-lock; }
lock_file() { printf '%s/agent/skills.lock' "$ROOT"; }

# ---------------------------------------------------------------- no lock yet --
new_root 'a root with no lock'
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'fails when agent/skills.lock is missing'; else fail 'expected a failing verify, got exit 0' "$out"; fi
case $out in
*--write-skills-lock*) pass 'names the exact regenerate command' ;;
*) fail 'the message does not name the regenerate command' "$out" ;;
esac

# ------------------------------------------------------------------ writes it --
new_root 'writing the lock'
out=$(write_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'write exits 0'; else fail 'write failed' "$out"; fi
if [ -f "$(lock_file)" ]; then pass 'agent/skills.lock exists'; else fail 'no agent/skills.lock was written'; fi
for rel in agent/skills/demo/SKILL.md agent/skills/demo/references/rules.md \
	agent/skills/demo/clubs.tsv agent/skills/other/SKILL.md; do
	if awk -F'\t' -v p="$rel" '$3==p{found=1} END{exit found?0:1}' "$(lock_file)"; then
		pass "locks $rel"
	else
		fail "no entry for $rel" "$(cat "$(lock_file)")"
	fi
done
if grep -q 'WORK/repo' "$(lock_file)"; then
	fail 'a token that names no file became an entry' "$(cat "$(lock_file)")"
else
	pass 'a token that resolves to nothing is not locked'
fi
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'a freshly written lock verifies'; else fail 'fresh lock does not verify' "$out"; fi

# ------------------------------------------------------------ tampered skill --
new_root 'a tampered skill'
write_lock >/dev/null
printf 'rules v1, plus an instruction nobody reviewed\n' >>"$ROOT/agent/skills/demo/SKILL.md"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'a changed SKILL.md fails the check'; else fail 'a tampered skill passed' "$out"; fi
case $out in
*agent/skills/demo/SKILL.md*) pass 'the FAIL names the tampered file' ;;
*) fail 'the FAIL does not name the file' "$out" ;;
esac
case $out in
*--write-skills-lock*) pass 'the FAIL carries the exact regenerate command' ;;
*) fail 'the FAIL has no regenerate command' "$out" ;;
esac
write_lock >/dev/null
out=$(verify_lock 2>&1) || fail 'regenerating after a reviewed change does not verify' "$out"
pass 'regenerating clears it'

# -------------------------------------------------------- a file with no entry --
new_root 'a skill file with no entry'
write_lock >/dev/null
mkdir -p "$ROOT/agent/skills/unlocked"
printf 'a skill nobody pinned\n' >"$ROOT/agent/skills/unlocked/SKILL.md"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'fails'; else fail 'an unpinned skill file passed' "$out"; fi
case $out in
*agent/skills/unlocked/SKILL.md*) pass 'names the unpinned file' ;;
*) fail 'does not name the unpinned file' "$out" ;;
esac

# --------------------------------------------------------- a deleted skill file --
new_root 'a locked file that is gone'
write_lock >/dev/null
rm -f "$ROOT/agent/skills/demo/references/rules.md"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'fails'; else fail 'a lock entry outlived its file and passed' "$out"; fi
case $out in
*'locked file is gone'*) pass 'says the locked file is gone' ;;
*) fail 'does not say the file is gone' "$out" ;;
esac

# ------------------------------------------------------------- a flipped hash --
new_root 'a hand-edited lock'
write_lock >/dev/null
awk -F'\t' -v OFS='\t' '
  /^#/ { print; next }
  !done { $1 = (substr($1, 1, 1) == "a" ? "b" : "a") substr($1, 2); done = 1 }
  { print }
' "$(lock_file)" >"$WORK/flipped"
mv "$WORK/flipped" "$(lock_file)"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'a hand-edited sha256 fails'; else fail 'a hand-edited hash passed' "$out"; fi

# -------------------------------------------------------- the commit column --
new_root 'the commit column'
git init -q "$ROOT" >/dev/null 2>&1
git -C "$ROOT" add -A >/dev/null 2>&1
git -C "$ROOT" -c commit.gpgsign=false commit -q -m 'add skills' >/dev/null 2>&1
write_lock >/dev/null
first=$(git -C "$ROOT" log -1 --format=%H -- agent/skills/demo/SKILL.md | cut -c1-12)
locked=$(awk -F'\t' '$3=="agent/skills/demo/SKILL.md"{print $2}' "$(lock_file)")
if [ -n "$first" ] && [ "$locked" = "$first" ]; then
	pass "records the commit that last touched the file ($first)"
else
	fail 'the commit column does not match git' "lock: ${locked:-none}" "git:  ${first:-none}"
fi
printf 'edited\n' >>"$ROOT/agent/skills/demo/SKILL.md"
git -C "$ROOT" add -A >/dev/null 2>&1
git -C "$ROOT" -c commit.gpgsign=false commit -q -m 'edit skill' >/dev/null 2>&1
write_lock >/dev/null
second=$(git -C "$ROOT" log -1 --format=%H -- agent/skills/demo/SKILL.md | cut -c1-12)
locked=$(awk -F'\t' '$3=="agent/skills/demo/SKILL.md"{print $2}' "$(lock_file)")
if [ "$locked" = "$second" ] && [ "$second" != "$first" ]; then
	pass 'a new commit for the file moves the column with it'
else
	fail 'the column did not follow the new commit' "first: $first" "second: $second" "lock: $locked"
fi

# ------------------------------------------------------- outside a git repo --
new_root 'a root that is not a git repo'
write_lock >/dev/null
locked=$(awk -F'\t' '$3=="agent/skills/other/SKILL.md"{print $2}' "$(lock_file)")
if [ "$locked" = '-' ]; then
	pass 'records - instead of inventing a commit'
else
	fail 'expected - outside git' "got: ${locked:-none}"
fi

# ----------------------------------------------------- no skills, no failure --
CASE_N=$((CASE_N + 1))
CASE='a root with no agent/skills'
ROOT="$WORK/case$CASE_N"
mkdir -p "$ROOT/docs"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
	pass 'a root that is not a harness checkout is not a failure'
else
	fail 'a root without agent/skills failed the lock check' "$out"
fi

# ------------------------------------------------------------------- summary --
printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
