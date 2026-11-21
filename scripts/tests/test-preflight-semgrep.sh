#!/usr/bin/env bash
# Tests for bin/preflight's semgrep check — every config CI would run, or a named FAIL.
#
# Why these exist: pf_semgrep_configs took the FIRST --config in a workflow and dropped the rest,
# so `.github/workflows/test.yml`'s `${SEMGREP_RULES}/bash` — the only config that carries shell
# rules — never reached semgrep here. PR #209 went green in this tree and red in CI on
# unquoted-variable-expansion-in-command. The cases below pin the two rules that make that
# impossible: all three configs are handed over, in file order; and a `$VAR` config that cannot be
# resolved FAILS by name instead of narrowing the scan.
#
# The check is a shell function in bin/preflight, so the test sources the real file (it dispatches
# only when executed) and drives pf_check_semgrep directly: no git repository, no network, no real
# semgrep. `semgrep` and `curl` are stubs on PATH, and PATH is otherwise the runner's — the same
# empties the scrub check uses.
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
mkdir -p "$WORK/stub" "$WORK/home" "$WORK/cache" "$WORK/rules/bash" "$WORK/repo/.github/workflows"

printf 'rules: []\n' >"$WORK/rules/bash/rules.yaml"
printf 'echo hi\n' >"$WORK/repo/changed.sh"

# A semgrep that only records its argv, and a curl that always fails: the resolution path has to
# work without either of them reaching the network.
cat >"$WORK/stub/semgrep" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$SEMGREP_ARGV"
exit "${SEMGREP_STUB_RC:-0}"
STUB
printf '#!/usr/bin/env bash\nprintf "curl stub: no network in this test\\n" >&2\nexit 7\n' >"$WORK/stub/curl"
chmod +x "$WORK/stub/semgrep" "$WORK/stub/curl"

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
RC=0
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
	ARGV="$WORK/argv$CASE_N"
	rm -f "$ARGV"
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

# run_check [VAR=value ...] — the check, with the repo above as the checkout being gated.
run_check() {
	OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		PI_SEMGREP_CACHE="$WORK/cache" SEMGREP_ARGV="$ARGV" "$@" \
		bash -c '. "$1" >/dev/null 2>&1 || true
			PF_CWD=$2 PF_CODE=(changed.sh) PF_SLUG= PF_BRANCH=
			pf_check_semgrep
			exit $?' _ "$PREFLIGHT" "$WORK/repo" 2>&1)
	RC=$?
}

# configs_in_argv — the value after every --config the stub was handed, in order.
configs_in_argv() {
	[ -f "$ARGV" ] || return 0
	awk '/^--config$/{getline; print}' "$ARGV" | tr '\n' ' '
}

# ---------------------------------------------------------------------------
case_start "every --config a workflow passes is handed to semgrep, in file order"
cat >"$WORK/repo/.github/workflows/test.yml" <<'YML'
jobs:
  scan:
    env:
      SEMGREP_RULES_SHA: a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2
    steps:
      - run: |
          semgrep scan \
            --config p/default \
            --config p/typescript \
            --config "${SEMGREP_RULES}/bash" \
            --metrics=off ./*.sh
  other:
    steps:
      - run: semgrep --config=p/ci .
YML
run_check SEMGREP_RULES="$WORK/rules"
expect_rc "the check passes" 0
got=$(configs_in_argv)
case $got in
*"p/default p/typescript $WORK/rules/bash"*) pass "p/default, p/typescript and the shell ruleset all arrived, in file order" ;;
*) fail "p/default, p/typescript and the shell ruleset all arrived, in file order" "argv configs: $got" ;;
esac
case $got in
*"p/ci"*) pass "the --config=X spelling in a second workflow is picked up too, not dropped" ;;
*) fail "the --config=X spelling in a second workflow is picked up too, not dropped" "argv configs: $got" ;;
esac
out_has "semgrep: 1 changed file(s) clean" "the pass names what was scanned"


# ---------------------------------------------------------------------------
case_start "a \$VAR config the workflow pins by commit is resolved from the pinned SHA"
rm -rf "$WORK/cache"/*
mkdir -p "$WORK/cache/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/bash"
printf 'rules: []\n' >"$WORK/cache/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/bash/rules.yaml"
run_check
expect_rc "an unset \$VAR falls back to the cache the SHA names" 0
got=$(configs_in_argv)
case $got in
*"$WORK/cache/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/bash"*) pass "the cached ruleset is what semgrep was handed" ;;
*) fail "the cached ruleset is what semgrep was handed" "argv configs: $got" ;;
esac

# ---------------------------------------------------------------------------
case_start "no cache and no network is a FAIL that names the config"
rm -rf "$WORK/cache"/*
run_check
expect_rc "the unresolvable config is refused" nonzero
out_has 'config: ${SEMGREP_RULES}/bash — ' "the refusal names the config, not the file that happened to be first"
out_has 'a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2' "the refusal names the SHA it could not fetch"
if [ -f "$ARGV" ]; then
	fail "semgrep was not run at all" "argv exists: $(configs_in_argv)"
else
	pass "semgrep was not run at all: a narrower scan is not attempted"
fi

# ---------------------------------------------------------------------------
case_start "a config with no route at all is named, never dropped"
cat >"$WORK/repo/.github/workflows/unpinned.yml" <<'YML'
steps:
  - run: semgrep --config "$SOME_RULESET/packs" .
YML
run_check SEMGREP_RULES="$WORK/rules"
expect_rc "the unpinned variable is refused" nonzero
out_has 'config: $SOME_RULESET/packs — ' "the refusal names it"
out_has 'SOME_RULESET_SHA' "the refusal says what would resolve it"

# ---------------------------------------------------------------------------
case_start "a finding makes the check fail: the gate cannot be talked into passing"
rm -f "$WORK/repo/.github/workflows/unpinned.yml"
run_check SEMGREP_RULES="$WORK/rules" SEMGREP_STUB_RC=1
expect_rc "a non-zero semgrep is a failed check" nonzero

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
