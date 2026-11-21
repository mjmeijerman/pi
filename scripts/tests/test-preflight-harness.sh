#!/usr/bin/env bash
# Tests for bin/preflight's harness-check, the check that runs `scripts/harness-check.sh` — the same
# script the harness-check job runs — before a branch is published.
#
# Why these exist: ten branches came back red on that job between 2026-11-20 and 2026-11-21 (one of
# them on four `test-regex-literal` FAILs in a single test file), and every one of those verdicts was
# reachable in this checkout in 8.4 seconds. Nothing ran it here: `make audit` runs it by hand, the
# pre-commit hook runs only `--quick`, and `bin/preflight` did not run it at all. So the rule was
# checked after the push and only after it.
#
# The cases below pin the four things that make the check worth having, and each of them is a way a
# gate reads green while the job it stands in for reads red:
#   - the verdict is the script's exit code, never a summary parsed out of its text (both directions:
#     "0 failed" that exits 1 must FAIL, `FAIL` lines that exit 0 must pass);
#   - the script runs in the branch's checkout, not the caller's;
#   - a run that hits its cap is a FAIL, because an undecided rule is not a pass;
#   - a checkout with no scripts/harness-check.sh is a named skip, not a silent pass.
#
# The check is a shell function in bin/preflight, so this sources the real file (it dispatches only
# when executed) and drives pf_check_harness and pf_applies directly: no git repository, no network,
# no real harness-check.sh. PATH is the runner's plus a stub directory.
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
mkdir -p "$WORK/stub" "$WORK/home" "$WORK/repo/scripts"

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
case_start() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
}

expect_rc() { # <why> <0|nonzero>
	case $2 in
	0) [ "$RC" -eq 0 ] && pass "$1" || fail "$1" "exit $RC" "$OUT" ;;
	*) [ "$RC" -ne 0 ] && pass "$1" || fail "$1" "exit 0, expected a refusal" "$OUT" ;;
	esac
}
out_has() {
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
		pass "$2"
	else
		fail "$2" "missing: $1" "$OUT"
	fi
}
out_lacks() {
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
		fail "$2" "unexpected: $1" "$OUT"
	else
		pass "$2"
	fi
}

# check_script — the stub harness-check.sh in the fixture checkout. $1 is its body, which decides
# both what it prints and what it exits with.
check_script() {
	printf '#!/usr/bin/env bash\n%s\n' "$1" >"$WORK/repo/scripts/harness-check.sh"
	chmod +x "$WORK/repo/scripts/harness-check.sh"
}

# run_check — pf_check_harness against the fixture, in the runner's environment plus the stub path.
# CAP overrides the wall-clock cap. The log directory is made inside the inner shell: `bin/preflight`
# sets PREFLIGHT_TMP empty at source time and installs a trap that removes it on exit, so a shared
# fixture directory is gone after the first case.
CAP=""
run_check() {
	OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		PREFLIGHT_HARNESS_CAP="${CAP:-300}" \
		bash -c '. "$1" >/dev/null 2>&1 || true
			PREFLIGHT_TMP=$(mktemp -d "${TMPDIR:-/tmp}/pftest.XXXXXX")
			PF_CWD=$2 PF_CHANGED=(a.md) PF_SLUG= PF_BRANCH=
			pf_check_harness
			exit $?' _ "$PREFLIGHT" "$WORK/repo" 2>&1)
	RC=$?
}

# applies <changed...> — pf_applies harness in the fixture, as an exit code.
applies() {
	local out
	out=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		bash -c '. "$1" >/dev/null 2>&1 || true
			PF_CWD=$2
			shift 2
			PF_CHANGED=("$@")
			pf_applies harness' _ "$PREFLIGHT" "$WORK/repo" "$@" 2>&1)
	printf '%s' "$?"
}

# ---------------------------------------------------------------------------
case_start "a green run passes and says what it found"
check_script 'printf "PASS docs-budget             AGENTS.md  ok\\n"
printf "97 passed, 0 warn, 0 failed\\n"
exit 0'
run_check
expect_rc "the check passes" 0
out_has "97 passed, 0 warn, 0 failed" "the pass line carries the run's own summary"

# ---------------------------------------------------------------------------
case_start "a red run FAILs and names the rules that failed"
check_script 'printf "FAIL test-regex-literal       scripts/tests/x.test.mjs:127     RegExp( built from a value\\n"
printf "FAIL radar-blip-valid         git-hooks/scan-mutation.sh          cites blip #159, which is not in docs/radar-blips.tsv\\n"
printf "93 passed, 7 warn, 2 failed\\n"
exit 1'
run_check
expect_rc "the check refuses" nonzero
out_has "exited 1 — 2 FAIL line(s)" "the refusal counts the FAIL lines it read"
out_has "test-regex-literal" "the refusal quotes the FAIL line a reader can act on"
out_has "cites blip #159" "and the second one"
out_has "scripts/harness-baseline.txt" "the refusal says where a violation that predates the branch belongs"

# ---------------------------------------------------------------------------
case_start "the exit code decides, not the summary text: 0 failed that exits 1 still FAILs"
check_script 'printf "93 passed, 0 warn, 0 failed\\n"
exit 1'
run_check
expect_rc "a run that exits nonzero refuses the branch however its last line reads" nonzero
out_has "exited 1" "the refusal names the exit code it read"

# ---------------------------------------------------------------------------
case_start "the exit code decides, not the text: FAIL lines that exit 0 pass"
check_script 'printf "FAIL stale-baseline          scripts/harness-baseline.txt  an entry no longer fails\\n"
exit 0'
run_check
expect_rc "a run that exits 0 is a pass, and the text is not re-judged here" 0
out_lacks "exited 1" "no refusal is invented out of a printed line"

# ---------------------------------------------------------------------------
case_start "it runs the checkout's own script, in that checkout"
check_script 'if [ "$(pwd)" != "'"$WORK"'/repo" ]; then
	printf "FAIL wrong-cwd                 .  ran in %s\\n" "$(pwd)"
	exit 4
fi
printf "97 passed, 0 warn, 0 failed\\n"
exit 0'
run_check
expect_rc "the pass stands, so the script ran in the branch's checkout" 0
out_has "97 passed, 0 warn, 0 failed" "and its summary is the pass line"

# ---------------------------------------------------------------------------
case_start "a capped run is a FAIL, never a pass"
check_script 'printf "PASS docs-budget             AGENTS.md  ok\\n"
sleep 5
printf "97 passed, 0 warn, 0 failed\\n"
exit 0'
CAP=1
run_check
CAP=""
expect_rc "the run that hits its cap refuses" nonzero
out_has "hit its 1s cap" "the refusal names the cap, so nobody reads it as a survivor or as green"
out_has "undecided rule is not a pass" "and says why a cap cannot pass"

# ---------------------------------------------------------------------------
case_start "a checkout with no harness-check.sh is a named skip, not a pass"
rm -f "$WORK/repo/scripts/harness-check.sh"
run_check
expect_rc "pf_check_harness refuses by name" nonzero
out_has "no scripts/harness-check.sh" "the line names the missing file"
skip_out=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" bash -c '
	. "$1" >/dev/null 2>&1 || true
	PF_CWD=$2 PF_CHANGED=(a.md)
	pf_skip_reason harness' _ "$PREFLIGHT" "$WORK/repo" 2>&1)
if printf '%s\n' "$skip_out" | grep -Fq "a project checkout has no harness to check"; then
	pass "the skip line says a project checkout has nothing to check"
else
	fail "the skip line says a project checkout has nothing to check" "$skip_out"
fi

# ---------------------------------------------------------------------------
case_start "it applies only where there is something to read"
check_script 'exit 0'
[ "$(applies a.md)" = 0 ] && pass "a changed file and the script: it applies" ||
	fail "a changed file and the script: it applies" "pf_applies said no"
[ "$(applies)" = 1 ] && pass "no changed file: it does not apply" ||
	fail "no changed file: it does not apply" "pf_applies said yes"
rm -f "$WORK/repo/scripts/harness-check.sh"
[ "$(applies a.md)" = 1 ] && pass "a checkout with no script: it does not apply" ||
	fail "a checkout with no script: it does not apply" "pf_applies said yes"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
