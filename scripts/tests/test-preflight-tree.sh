#!/usr/bin/env bash
# Tests for the tree a file-reading check reads — bin/preflight's pf_read_tree/pf_read_path.
#
# Why these exist: the branch moved the reads from $PF_CWD to the branch's own tree and, where a file
# was not there, `continue`d past it. A gate pointed at a tree that holds none of the changed files
# then read nothing, printed `no changed code file`, and passed — the red that shipped on #229, where
# scripts/tests/test-preflight-semgrep.sh went 3 passed / 11 failed. Three rules are pinned here: a
# slug whose branch lives in a worktree reads the worktree; a file the read tree lacks is read from
# $PF_CWD instead of dropped; and a file in neither tree is a FAIL naming the file and both trees,
# with semgrep never run at all — a narrower scan is never a pass.
#
# bin/preflight dispatches only when executed, so these source it and drive the functions directly.
# No network: `semgrep` is a stub that records the directory it ran in and its argv, then exits 0.
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

PREFLIGHT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../bin" && pwd)/preflight"
[ -f "$PREFLIGHT" ] || {
	printf 'FATAL: %s is missing\n' "$PREFLIGHT" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/stub" "$WORK/home" "$WORK/cache" "$WORK/repo"

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
RC=0
RAN_IN_FILE=""
ARGV=""

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
	RAN_IN_FILE="$WORK/ran$CASE_N"
	ARGV="$WORK/argv$CASE_N"
	rm -f "$RAN_IN_FILE" "$ARGV"
}

# A semgrep that records the directory it was run in and its argv, then passes.
cat >"$WORK/stub/semgrep" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$PWD" >"$SEMGREP_RAN_IN"
printf '%s\n' "$@" >"$SEMGREP_ARGV"
exit "${SEMGREP_STUB_RC:-0}"
STUB
chmod +x "$WORK/stub/semgrep"

# A real repository with a real worktree: pf_read_tree reads `git worktree list --porcelain`, so a
# fixture that is not a checkout would test nothing.
git -C "$WORK/repo" init -q -b trunk
git -C "$WORK/repo" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m one
git -C "$WORK/repo" worktree add -q -b feat "$WORK/wt"
# On trunk only, and after the branch was cut: a file the read tree genuinely does not hold.
printf 'echo trunk\n' >"$WORK/repo/onlyrepo.sh"
git -C "$WORK/repo" add onlyrepo.sh
git -C "$WORK/repo" -c user.email=t@example.invalid -c user.name=t commit -q -m two
printf 'echo feat\n' >"$WORK/wt/changed.sh"

out_has() {
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
		pass "$2"
	else
		fail "$2" "missing: $1" "$OUT"
	fi
}

ran_in() {
	cat "$RAN_IN_FILE" 2>/dev/null
}

# read_tree <cwd> <branch> <slug> — pf_read_tree's answer.
read_tree() {
	OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		bash -c '. "$1" >/dev/null 2>&1 || true; PF_CWD=$2; pf_read_tree "$2" "$3" "$4"' \
		_ "$PREFLIGHT" "$1" "$2" "$3" 2>&1)
	RC=$?
}

# run_semgrep <read-tree> <code...> — pf_check_semgrep over $WORK/repo as the checkout.
run_semgrep() {
	local read=$1
	shift
	OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		PI_SEMGREP_CACHE="$WORK/cache" SEMGREP_RAN_IN="$RAN_IN_FILE" SEMGREP_ARGV="$ARGV" \
		bash -c '. "$1" >/dev/null 2>&1 || true
			PF_CWD=$2 PF_READ=$3 PF_SLUG=s1 PF_BRANCH=feat PF_CODE=("${@:4}")
			pf_check_semgrep
			exit $?' _ "$PREFLIGHT" "$WORK/repo" "$read" "$@" 2>&1)
	RC=$?
}

# ---------------------------------------------------------------------------
case_start "a slug whose branch lives in a worktree reads the worktree"
read_tree "$WORK/repo" feat s1
[ "$OUT" = "$WORK/wt" ] && pass "pf_read_tree prints the worktree's path ($WORK/wt)" ||
	fail "pf_read_tree prints the worktree's path" "got: ${OUT:-<nothing>}" "expected: $WORK/wt"

case_start "a slug whose branch no checkout holds reads the caller's checkout"
read_tree "$WORK/repo" no-such-branch s2
[ "$OUT" = "$WORK/repo" ] && pass "pf_read_tree prints --cwd" ||
	fail "pf_read_tree prints --cwd" "got: ${OUT:-<nothing>}" "expected: $WORK/repo"

case_start "a changed file the read tree holds is scanned there"
run_semgrep "$WORK/wt" changed.sh
[ "$RC" -eq 0 ] && pass "the check passes" || fail "the check passes" "exit $RC" "$OUT"
out_has "tree: $WORK/wt" "the tree line names the worktree"
out_has "semgrep: 1 changed file(s) clean" "the pass names what was scanned"
[ "$(ran_in)" = "$WORK/wt" ] && pass "semgrep ran in the worktree" ||
	fail "semgrep ran in the worktree" "ran in: $(ran_in)"

case_start "a changed file the read tree lacks is read from the checkout, not dropped"
run_semgrep "$WORK/wt" onlyrepo.sh
[ "$RC" -eq 0 ] && pass "the check passes" || fail "the check passes" "exit $RC" "$OUT"
out_has "tree: $WORK/repo" "the tree line names the checkout the file was found in"
out_has "semgrep: 1 changed file(s) clean" "a file outside the read tree is scanned, not skipped"
[ "$(ran_in)" = "$WORK/repo" ] && pass "semgrep ran in the checkout" ||
	fail "semgrep ran in the checkout" "ran in: $(ran_in)"

case_start "a changed file in neither tree is a FAIL naming the file and both trees"
run_semgrep "$WORK/wt" gone.sh
[ "$RC" -ne 0 ] && pass "a file in neither tree refuses" || fail "a file in neither tree refuses" "exit 0, expected a refusal" "$OUT"
out_has "gone.sh" "the FAIL names the file"
out_has "$WORK/wt" "the FAIL names the read tree"
out_has "$WORK/repo" "the FAIL names the checkout"
out_has "FAIL, not a skip" "the FAIL says a narrower read is not a skip"
if [ -f "$ARGV" ]; then
	fail "semgrep was not run at all" "argv exists"
else
	pass "semgrep was not run at all: the narrowed scan is not attempted"
fi

case_start "a changed-file list the read tree holds whole is scanned whole"
printf 'echo both\n' >"$WORK/wt/both.sh"
run_semgrep "$WORK/wt" changed.sh both.sh
[ "$RC" -eq 0 ] && pass "the check passes when both files are in the read tree" || fail "the check passes when both files are in the read tree" "exit $RC" "$OUT"
out_has "semgrep: 2 changed file(s) clean" "both changed files were scanned"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
