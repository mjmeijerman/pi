#!/usr/bin/env bash
# Tests for git-hooks/add-provenance.sh — the commit-msg hook that appends the
# `Agent-Slug` and `Spec` trailers at commit time.
#
# Why these exist: `delegate close` refuses a commit without an Agent-Slug
# trailer, and that refusal arrives after the branch is merged, when amending
# means rewriting trunk. Every rule the hook promises is one case here, run
# against the real hook from git-hooks/ in a throwaway repo: a fixture copy of
# the hook would drift away from the hook that ships.
#
# Run it directly, or through `npm test` in agent/ (package.json runs this file
# after `node --test`, the same way it picks up scripts/tests/*.test.mjs).
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../git-hooks" && pwd)"
HOOK="$HOOKS/add-provenance.sh"
[ -x "$HOOK" ] || {
	printf 'FATAL: %s is missing or not executable\n' "$HOOK" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# A throwaway repo must see this checkout's hooks and nothing from the machine:
# the global hooksPath, the global template dir and any user config would let a
# passing case prove the wrong hook.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export PI_GIT_HOOKS_DIR="$HOOKS"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-01-01T00:00:00 +0000'

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
REPO=""

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

case_start() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	REPO="$WORK/case$CASE_N"
	git init -q "$REPO" >/dev/null 2>&1 || {
		printf 'FATAL: git init failed in %s\n' "$REPO" >&2
		exit 1
	}
	git -C "$REPO" config core.hooksPath "$HOOKS"
	git -C "$REPO" config commit.gpgsign false
}

# commit_msg — the message git stored, exactly as git stores it.
commit_msg() { git -C "$REPO" log -1 --format=%B; }

# run_hook <msg-file> [env assignments...] — the hook on its own, for the cases
# where the point is what it does to a file rather than what git does next.
run_hook() {
	local file=$1
	shift
	env -u AGENT_SLUG -u PI_AGENT_SLUG "$@" "$HOOK" "$file"
}

expect_eq() { # label expected actual
	if [ "$2" = "$3" ]; then
		pass "$1"
	else
		fail "$1" "want: $(printf '%s' "$2" | sed -n l)" "got:  $(printf '%s' "$3" | sed -n l)"
	fi
}

expect_status() { # label expected actual output
	if [ "$2" = "$3" ]; then
		pass "$1"
	else
		fail "$1" "want exit $2, got $3" "output: $4"
	fi
}

# ---------------------------------------------------------------------------
case_start "no slug in the environment: a human commit is untouched"
msg="$WORK/human"
printf 'feat(x): a human wrote this\n\nThe body a human wrote.\n' >"$msg"
printf 'a\n' >"$REPO/a"
git -C "$REPO" add -A >/dev/null
# Cleared on the way in, not by the runner: a worker or delegate shell exports a
# slug, and this case is about what the hook does when nobody claims one.
if env -u AGENT_SLUG -u PI_AGENT_SLUG git -C "$REPO" commit -q -F "$msg" >"$WORK/out" 2>"$WORK/err"; then
	expect_eq "message is byte-identical" \
		"$(printf 'feat(x): a human wrote this\n\nThe body a human wrote.')" "$(commit_msg)"
	if commit_msg | grep -q '^Agent-Slug:'; then
		fail "no Agent-Slug trailer was added" "$(commit_msg)"
	else
		pass "no Agent-Slug trailer was added"
	fi
else
	fail "the commit succeeded" "$(cat "$WORK/out" "$WORK/err")"
fi

# The same message through the hook directly: not one byte may move.
cp "$msg" "$WORK/untouched"
cp "$msg" "$WORK/untouched.expected"
run_hook "$WORK/untouched" >"$WORK/out" 2>"$WORK/err"
status=$?
expect_status "hook exits 0" 0 "$status" "$(cat "$WORK/out" "$WORK/err")"
if cmp -s "$WORK/untouched" "$WORK/untouched.expected"; then
	pass "the message file is not rewritten"
else
	fail "the message file is not rewritten" "$(cat "$WORK/untouched")"
fi
expect_eq "the hook prints nothing" "" "$(cat "$WORK/out" "$WORK/err")"

# ---------------------------------------------------------------------------
case_start "slug set: both trailers, last, after the author's own trailer"
msg="$WORK/worker"
printf 'feat(y): worker commit\n\nSigned-off-by: Someone <someone@example.com>\n\n\n' >"$msg"
printf 'b\n' >"$REPO/b"
git -C "$REPO" add -A >/dev/null
if AGENT_SLUG=some-worker git -C "$REPO" commit -q -F "$msg" >"$WORK/out" 2>"$WORK/err"; then
	pass "the commit succeeded"
	expect_eq "the trailers join the author's trailer block, at the very end" \
		"$(printf 'feat(y): worker commit\n\nSigned-off-by: Someone <someone@example.com>\nAgent-Slug: some-worker\nSpec: specs/some-worker.md')" \
		"$(commit_msg)"
	expect_eq "git reports the trailers" "some-worker" \
		"$(git -C "$REPO" log -1 --format='%(trailers:key=Agent-Slug,valueonly)' | tr -d '[:space:]')"
	expect_eq "the hook itself is silent on success" "" "$(cat "$WORK/out" "$WORK/err")"
else
	fail "the commit succeeded" "$(cat "$WORK/out" "$WORK/err")"
fi

# ---------------------------------------------------------------------------
case_start "trailers already there: never duplicated, never rewritten"
msg="$WORK/handwritten"
printf 'fix(z): hand-written trailers\n\nAgent-Slug: other-worker\nSpec: specs/other.md\n' >"$msg"
printf 'c\n' >"$REPO/c"
git -C "$REPO" add -A >/dev/null
if AGENT_SLUG=some-worker git -C "$REPO" commit -q -F "$msg" >"$WORK/out" 2>"$WORK/err"; then
	expect_eq "one Agent-Slug line" "1" "$(commit_msg | grep -c '^Agent-Slug:')"
	expect_eq "the author's value is kept" "other-worker" \
		"$(commit_msg | sed -n 's/^Agent-Slug:[[:space:]]*//p')"
	expect_eq "one Spec line" "1" "$(commit_msg | grep -c '^Spec:')"
	expect_eq "the message is otherwise unchanged" \
		"$(printf 'fix(z): hand-written trailers\n\nAgent-Slug: other-worker\nSpec: specs/other.md')" \
		"$(commit_msg)"
else
	fail "the commit succeeded" "$(cat "$WORK/out" "$WORK/err")"
fi

# A body that does not end in a trailer gets the blank line a trailer block needs.
printf 'Subject line\n\nSome prose, and a trailing blank line.\n\n' >"$WORK/prose"
run_hook "$WORK/prose" AGENT_SLUG=some-worker >/dev/null 2>&1
expect_eq "a blank line separates the body from the trailers" \
	"$(printf 'Subject line\n\nSome prose, and a trailing blank line.\n\nAgent-Slug: some-worker\nSpec: specs/some-worker.md')" \
	"$(cat "$WORK/prose")"

# A second pass over the same file, the way an amend re-runs the hook.
printf 'chore: amend me\n' >"$WORK/twice"
run_hook "$WORK/twice" AGENT_SLUG=some-worker >/dev/null 2>&1
run_hook "$WORK/twice" AGENT_SLUG=some-worker >/dev/null 2>&1
expect_eq "re-running the hook adds nothing" \
	"$(printf 'chore: amend me\n\nAgent-Slug: some-worker\nSpec: specs/some-worker.md')" \
	"$(cat "$WORK/twice")"

# A missing Spec is added on its own, without duplicating the Agent-Slug.
printf 'chore: half stamped\n\nAgent-Slug: other-worker\n' >"$WORK/half"
run_hook "$WORK/half" AGENT_SLUG=some-worker >/dev/null 2>&1
expect_eq "the missing Spec is added, the Agent-Slug is not" \
	"$(printf 'chore: half stamped\n\nAgent-Slug: other-worker\nSpec: specs/some-worker.md')" \
	"$(cat "$WORK/half")"

# ---------------------------------------------------------------------------
case_start "a message with no trailing newline stays valid"
msg="$WORK/nonewline"
printf 'fix: no trailing newline' >"$msg"
printf 'd\n' >"$REPO/d"
git -C "$REPO" add -A >/dev/null
if AGENT_SLUG=some-worker git -C "$REPO" commit -q -F "$msg" >"$WORK/out" 2>"$WORK/err"; then
	expect_eq "the subject survives and the trailers are appended" \
		"$(printf 'fix: no trailing newline\n\nAgent-Slug: some-worker\nSpec: specs/some-worker.md')" \
		"$(commit_msg)"
else
	fail "the commit succeeded" "$(cat "$WORK/out" "$WORK/err")"
fi

# ---------------------------------------------------------------------------
case_start "a merge commit stays valid and still reads as a merge"
printf 'one\n' >"$REPO/base"
git -C "$REPO" add -A >/dev/null
git -C "$REPO" commit -q -m base >/dev/null 2>&1
main_branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
git -C "$REPO" branch -q side
git -C "$REPO" checkout -q side >/dev/null 2>&1
printf 'two\n' >"$REPO/side"
git -C "$REPO" add -A >/dev/null
git -C "$REPO" commit -q -m 'side work' >/dev/null 2>&1
git -C "$REPO" checkout -q "$main_branch" >/dev/null 2>&1
if AGENT_SLUG=some-worker git -C "$REPO" merge -q --no-ff --no-edit side >"$WORK/out" 2>"$WORK/err"; then
	pass "the merge succeeded"
	expect_eq "the first line is still the merge line" "1" \
		"$(commit_msg | head -1 | grep -c "^Merge branch 'side'")"
	expect_eq "the trailers are the last two non-blank lines" \
		"$(printf 'Agent-Slug: some-worker\nSpec: specs/some-worker.md')" \
		"$(commit_msg | grep -v '^$' | tail -2)"
else
	fail "the merge succeeded" "$(cat "$WORK/out" "$WORK/err")"
fi

# ---------------------------------------------------------------------------
case_start "a comment-only message is left alone, so git still refuses it"
msg="$WORK/comment-only"
printf '# a comment, and nothing else\n#\n' >"$msg"
cp "$msg" "$WORK/comment-only.expected"
printf 'e\n' >"$REPO/e"
git -C "$REPO" add -A >/dev/null
# --cleanup=strip is what makes this the comment-only case: with -F alone git
# keeps comment lines, so the message is not empty and nothing is being tested.
if AGENT_SLUG=some-worker git -C "$REPO" commit -q --cleanup=strip -F "$msg" >"$WORK/out" 2>"$WORK/err"; then
	fail "git still refuses an empty message" "$(commit_msg)"
else
	pass "git still refuses an empty message"
	if grep -q 'empty commit message' "$WORK/err"; then
		pass "the refusal is git's own, not the hook's"
	else
		fail "the refusal is git's own, not the hook's" "$(cat "$WORK/err")"
	fi
fi
printf '# a comment, and nothing else\n#\n' >"$WORK/comment-only-file"
run_hook "$WORK/comment-only-file" AGENT_SLUG=some-worker >/dev/null 2>&1
if cmp -s "$WORK/comment-only-file" "$WORK/comment-only.expected"; then
	pass "the hook does not seed a comment-only message with a trailer"
else
	fail "the hook does not seed a comment-only message with a trailer" "$(cat "$WORK/comment-only-file")"
fi

# ---------------------------------------------------------------------------
case_start "--no-verify still bypasses the hook"
msg="$WORK/bypass"
printf 'chore: bypass\n' >"$msg"
printf 'f\n' >"$REPO/f"
git -C "$REPO" add -A >/dev/null
if AGENT_SLUG=some-worker git -C "$REPO" commit -q --no-verify -F "$msg" >/dev/null 2>&1; then
	expect_eq "no trailers were added" "chore: bypass" "$(commit_msg)"
else
	fail "the commit succeeded"
fi

# ---------------------------------------------------------------------------
case_start "a slug that is not a slug is refused, loudly"
printf 'feat: bad slug\n' >"$WORK/bad-slug"
out=$(run_hook "$WORK/bad-slug" AGENT_SLUG='Not A Slug' 2>&1)
status=$?
expect_status "the hook exits non-zero" 1 "$status" "$out"
if printf '%s' "$out" | grep -q 'is not a worker slug'; then
	pass "the message names the value that is wrong"
else
	fail "the message names the value that is wrong" "$out"
fi
expect_eq "the message file is untouched" "feat: bad slug" "$(cat "$WORK/bad-slug")"

# ---------------------------------------------------------------------------
case_start "no message file: the hook says what is missing"
out=$(env -u PI_AGENT_SLUG AGENT_SLUG=some-worker "$HOOK" 2>&1)
status=$?
expect_status "the hook exits non-zero" 1 "$status" "$out"
if printf '%s' "$out" | grep -q 'no commit message file to stamp'; then
	pass "the message says what is missing"
else
	fail "the message says what is missing" "$out"
fi

# ---------------------------------------------------------------------------
case_start "PI_AGENT_SLUG is accepted as well as AGENT_SLUG"
printf 'feat: prefixed\n' >"$WORK/prefixed"
run_hook "$WORK/prefixed" PI_AGENT_SLUG=some-worker >/dev/null 2>&1
expect_eq "the prefixed variable activates the hook too" \
	"$(printf 'feat: prefixed\n\nAgent-Slug: some-worker\nSpec: specs/some-worker.md')" \
	"$(cat "$WORK/prefixed")"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
