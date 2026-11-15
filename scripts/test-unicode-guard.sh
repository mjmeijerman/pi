#!/usr/bin/env bash
# shellcheck disable=SC2016  # the \uXXXX escapes are meant literally: printf expands them, the shell must not.
# Tests for git-hooks/scan-unicode.sh — the pre-commit scan that refuses hidden
# codepoints in the files the harness reads as instruction.
#
# Why these exist: a skill or a prompt arrives from elsewhere and its bytes are
# instructions (blip #72 agent package manager, blip #7 plugin marketplace). A
# bidi override makes the line on screen differ from the line that runs, a
# zero-width character changes a path without changing its look, and a Cyrillic
# letter that renders as a Latin one forges a word. Each rule, and each case
# where the rule must stay quiet, is one test here, run against the real hook
# from git-hooks/ in a throwaway repo.
#
# No literal hidden codepoint appears in this file: every fixture is written
# with a printf escape, so this test cannot itself trip the scan.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="$REPO/git-hooks/scan-unicode.sh"
[ -f "$SCAN" ] || {
	printf 'FATAL: %s is missing\n' "$SCAN" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# A throwaway repo must see this checkout's hooks and nothing from the machine.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
# Keep the harness-budget hook out of the way: this file tests the scan.
export PI_HARNESS_CHECK=/nonexistent/harness-check.sh

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
DIR=""

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

new_case() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	DIR="$WORK/case$CASE_N"
	git init -q "$DIR" >/dev/null 2>&1 || {
		printf 'FATAL: git init failed in %s\n' "$DIR" >&2
		exit 1
	}
	git -C "$DIR" config commit.gpgsign false
	mkdir -p "$DIR/agent/skills/demo"
}

# run_scan — the hook's verdict in $RC, its output in $OUT.
run_scan() {
	OUT=$(cd "$DIR" && bash "$SCAN" 2>&1)
	RC=$?
}

stage() { git -C "$DIR" add -A >/dev/null 2>&1; }

expect_blocked() { # name, then one needle per line it must print
	local name=$1
	shift
	if [ "$RC" -eq 0 ]; then
		fail "$name: expected a refusal, got exit 0"
		return
	fi
	pass "$name: refused"
	local needle
	for needle in "$@"; do
		case $OUT in
		*"$needle"*) pass "$name: says '$needle'" ;;
		*) fail "$name: output lacks '$needle'" "$OUT" ;;
		esac
	done
}

expect_allowed() { # name
	if [ "$RC" -ne 0 ]; then
		fail "$1: expected exit 0, got $RC" "$OUT"
	else
		pass "$1: allowed"
	fi
}

# ------------------------------------------------------------ zero-width --
new_case 'a smuggled zero-width space'
printf 'step one\ninstall\u200bnow please\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_blocked 'zero-width space in a skill' 'U+200B' 'agent/skills/demo/SKILL.md:2:' 'install<U+200B>now'

# ------------------------------------------------------- bidi override --
new_case 'a bidi override in AGENTS.md'
printf '# rules\nsee this spoofed line\u202e and the rest\n' >"$DIR/agent/AGENTS.md"
stage
run_scan
expect_blocked 'bidi override in AGENTS.md' 'U+202E' 'agent/AGENTS.md:2:' 'reverses how the rest of the line reads'

# --------------------------------------------------------- homoglyphs --
new_case 'a Cyrillic homoglyph in prose'
mkdir -p "$DIR/agent/prompts"
printf 'The policy is p\u0430cket first.\n' >"$DIR/agent/prompts/learn.md"
stage
run_scan
expect_blocked 'Cyrillic a in prompt prose' 'U+0430' "Latin 'a'" 'agent/prompts/learn.md:1:'

new_case 'a fullwidth Latin word'
printf 'run the \uff53\uff55\uff44\uff4f command\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_blocked 'fullwidth Latin in a skill' 'U+FF53'

# ------------------------------------------- ordinary non-Latin, allowed --
new_case 'a quoted Russian word'
printf 'Say the Russian word "\u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441" out loud.\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_allowed 'quoted Cyrillic is data, not instruction'

new_case 'a fenced Greek example'
printf 'Example:\n\n```\n\u03bf\u03b9 \u03b1\u03bd\u03b8\u03c1\u03c9\u03c0\u03bf\u03b9\n```\n\ndone\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_allowed 'fenced non-Latin text is data'

new_case 'a fenced block with a zero-width character'
printf 'Example:\n\n```\ncurl http://x.invalid/a\u200bb\n```\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_blocked 'a fence does not excuse an invisible character' 'U+200B'

new_case 'a quote on the same line does not excuse a bidi override'
printf 'text "\u202e" more\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_blocked 'quoting a bidi override does not excuse it' 'U+202E'

# ---------------------------------------------------------- out of scope --
new_case 'a zero-width character outside the guarded paths'
mkdir -p "$DIR/docs"
printf 'a\u200bb\n' >"$DIR/docs/notes.md"
stage
run_scan
expect_allowed 'docs/ is not instruction'

new_case 'a zero-width character in an unstaged file'
printf 'a\u200bb\n' >"$DIR/agent/skills/demo/SKILL.md"
run_scan
expect_allowed 'only staged bytes are scanned'

new_case 'a clean staged skill'
printf 'plain ASCII, nothing hidden\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_allowed 'a clean file passes'

new_case 'the documented override'
printf 'a\u200bb\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
OUT=$(cd "$DIR" && SKIP_UNICODE_SCAN=1 bash "$SCAN" 2>&1)
RC=$?
expect_allowed 'SKIP_UNICODE_SCAN=1 lets it through'

# ------------------------------------------------------ reporting shape --
new_case 'line and column'
printf 'one\ntwo\nabcde\u2060f\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
run_scan
expect_blocked 'reports file, line and column of the character' 'agent/skills/demo/SKILL.md:3:6:' 'U+2060'

# ----------------------------------------- the wrapper actually runs it --
# The checked-in pre-commit is generated by install-hooks.sh; if the two drift,
# the scan exists and never runs. Render the template in a copy of this tree.
new_case 'the installed pre-commit wrapper'
SRC="$WORK/hooks-src"
mkdir -p "$SRC" "$WORK/hooks-home"
cp "$REPO"/git-hooks/*.sh "$SRC"/
# A generated wrapper bakes the directory it was rendered in, so render it in a
# sandbox HOME: the point is the hook body, not the path in it.
(cd "$SRC" && env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM HOME="$WORK/hooks-home" \
	bash ./install-hooks.sh >/dev/null 2>&1) || true
if diff -q <(grep -v '^HOOKS_HOME=' "$SRC/pre-commit") \
	<(grep -v '^HOOKS_HOME=' "$REPO/git-hooks/pre-commit") >/dev/null; then
	pass 'install-hooks.sh renders the checked-in wrapper'
else
	fail 'the generated wrapper and git-hooks/pre-commit differ' \
		"$(diff <(grep -v '^HOOKS_HOME=' "$SRC/pre-commit") <(grep -v '^HOOKS_HOME=' "$REPO/git-hooks/pre-commit"))"
fi
if grep -q 'scan-unicode.sh' "$REPO/git-hooks/pre-commit"; then
	pass 'the wrapper chains the scan'
else
	fail 'the wrapper never calls scan-unicode.sh'
fi
if grep -q 'scan-unicode.sh' "$REPO/git-hooks/install-hooks.sh"; then
	pass 'the installer writes it into the wrapper'
else
	fail 'install-hooks.sh does not write the scan into the wrapper'
fi

# ------------------------------------------ end to end through git commit --
new_case 'a real git commit'
git -C "$DIR" config core.hooksPath "$REPO/git-hooks"
printf 'install\u200bnow\n' >"$DIR/agent/skills/demo/SKILL.md"
stage
OUT=$(cd "$DIR" && PI_GIT_HOOKS_DIR="$REPO/git-hooks" git commit -q -m 'add a skill' 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then pass 'the commit is refused'; else fail 'the commit went through' "$OUT"; fi
case $OUT in
*U+200B*) pass 'the refusal names the codepoint' ;;
*) fail 'the refusal does not name the codepoint' "$OUT" ;;
esac
if git -C "$DIR" log --oneline 2>/dev/null | grep -q .; then
	fail 'a commit object was created anyway'
else
	pass 'nothing was committed'
fi

# ------------------------------------------------------------------- summary --
printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
