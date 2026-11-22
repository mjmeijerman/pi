#!/usr/bin/env bash
# Tests for bin/prose-review — one pull request's prose review, run by hand.
#
# Why these exist: the prose review used to be reachable only from a GitHub runner, so the three
# things a person actually does with it — read the request, read the answers, and be told there is
# no key — were untested here. Each case drives the real wrapper against a stub root: a stub
# `prose-review.mjs` and a stub `gh` on PATH, so no network, no model and no repository is needed.
# Each case is red with no bin/prose-review at all (trunk).
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../bin" && pwd)"
PROSE_BIN="${PROSE_BIN:-$BIN/prose-review}"
[ -f "$PROSE_BIN" ] || {
	printf 'FATAL: %s is missing\n' "$PROSE_BIN" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
RC=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}
case_start() { CASE_N=$((CASE_N + 1)); CASE=$1; }

out_has() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then pass "$2"; else fail "$2" "missing: $1" "$OUT"; fi
}
out_lacks() { # <text> <why>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then fail "$2" "unexpectedly present: $1" "$OUT"; else pass "$2"; fi
}
expect_rc() { # <0|nonzero|N> <why>
	case $1 in
	0) [ "$RC" -eq 0 ] && pass "$2" || fail "$2" "exit $RC" "$OUT" ;;
	nonzero) [ "$RC" -ne 0 ] && pass "$2" || fail "$2" "exit 0, expected a failure" "$OUT" ;;
	*) [ "$RC" = "$1" ] && pass "$2" || fail "$2" "exit $RC, expected $1" "$OUT" ;;
	esac
}

run_prose() { # [args...] — the wrapper, with the stub gh on PATH
	OUT=$("$PROSE_BIN" "$@" 2>"$WORK/stderr")
	RC=$?
}

# A stub root: the review script answers whatever mode it was asked for, and `gh` serves one prose
# diff. Anything else `gh` is asked to do is recorded, so "posts nothing" is a file that is absent.
prose_root() { # <dir>
	mkdir -p "$1/.github/scripts" "$1/ghbin"
	cat >"$1/.github/scripts/prose-review.mjs" <<'STUB'
const args = process.argv.slice(2);
if (args.includes("--dry-run")) {
	process.stdout.write(`${JSON.stringify({ model: "stub-model", messages: ["five questions"] }, null, 2)}\n`);
	process.exit(0);
}
process.stdout.write(
	"<!-- prose-review -->\n**prose-review** — five questions about the instruction prose in this diff (`stub-model`).\n\n" +
		"1. **contradiction** — agent/AGENTS.md:12 says wait forever, agent/AGENTS.md:20 says sleep.\n" +
		"2. **missing command** — no finding\n" +
		"3. **uncheckable rule** — no finding\n" +
		"4. **duplicated rule** — no finding\n" +
		"5. **older sentence now false** — no finding\n",
);
STUB
	cat >"$1/ghbin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\\n' "\$*" >>"$WORK/gh.calls"
case "\$1 \$2" in
"pr diff")
	printf '%s\\n' \\
		'diff --git a/agent/AGENTS.md b/agent/AGENTS.md' \\
		'--- a/agent/AGENTS.md' \\
		'+++ b/agent/AGENTS.md' \\
		'@@ -1,2 +1,2 @@' \\
		'-old sentence' \\
		'+new sentence' \\
		'diff --git a/README.md b/README.md' \\
		'--- a/README.md' \\
		'+++ b/README.md' \\
		'@@ -1,2 +1,2 @@' \\
		'-old line' \\
		'+new line'
	;;
*) printf 'gh stub: unhandled %s\\n' "\$*" >&2; exit 1 ;;
esac
STUB
	chmod +x "$1/ghbin/gh"
}

REAL_PATH=$PATH
STUB_ROOT=$WORK/root
prose_root "$STUB_ROOT"
export PATH="$STUB_ROOT/ghbin:$PATH"

# --- no key: one line, exit 2, and no review is invented ----------------------------------------
case_start "no key"
unset PROSE_REVIEW_API_KEY
run_prose 7 --root "$STUB_ROOT"
expect_rc 2 "a missing key exits 2"
line_count=$(printf '%s\n' "$OUT" | grep -c . || true)
if [ "$line_count" = 1 ]; then
	pass "it says so in one line"
else
	fail "it printed $line_count lines, not one" "$OUT"
fi
out_has "PROSE_REVIEW_API_KEY is unset" "the line names the missing key"
out_lacks "no finding" "a review that did not run reports no findings"

# --- --dry-run: the request is printed, and nothing is posted ------------------------------------
case_start "dry run"
# A saved diff, so "touches no network" is a claim a stub gh can check: it is never called at all.
cat >"$WORK/one.diff" <<'DIFF'
diff --git a/agent/AGENTS.md b/agent/AGENTS.md
--- a/agent/AGENTS.md
+++ b/agent/AGENTS.md
@@ -1,2 +1,2 @@
-old sentence
+new sentence
DIFF
: >"$WORK/gh.calls"
run_prose 7 --root "$STUB_ROOT" --dry-run --diff "$WORK/one.diff"
expect_rc 0 "--dry-run exits 0 without a key"
out_has '"model": "stub-model"' "the request itself is printed"
if [ -s "$WORK/gh.calls" ]; then
	fail "--dry-run with --diff touched gh" "$(cat "$WORK/gh.calls")"
else
	pass "--dry-run with --diff touches no network and posts nothing"
fi

# --- a review that answers: the five answers, printed -------------------------------------------
case_start "answers"
: >"$WORK/gh.calls"
export PROSE_REVIEW_API_KEY=dummy-key-for-a-stub
run_prose 7 --root "$STUB_ROOT"
expect_rc 0 "a review that answers exits 0"
out_has "<!-- prose-review -->" "the marker is in what it prints"
out_has "1. **contradiction**" "the first answer is printed"
out_has "5. **older sentence now false**" "the fifth answer is printed"
if grep -Eq '^(api|repo)' "$WORK/gh.calls"; then
	fail "a plain run posted the comment" "$(cat "$WORK/gh.calls")"
else
	pass "a plain run posts nothing (--post was not given)"
fi

export PATH=$REAL_PATH

printf '\n%s: %d case(s), %d passed, %d failed\n' "test-prose-review-cli" "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
