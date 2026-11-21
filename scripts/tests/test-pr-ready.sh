#!/usr/bin/env bash
# Tests for bin/pr-ready — the one answer to "is this pull request green".
#
# Why these exist: `gh pr checks | grep -c pending` matches the word "pending" and nothing else, so
# IN_PROGRESS, QUEUED and a rollup that has not registered its workflows yet all read as zero
# pending. That is how a PR was called green three minutes before it went red. Every rule in this
# file is one the prose could not answer, run against a `gh` stub on PATH that returns JSON
# fixtures: the real gh is never called, so this test needs no network and no repository.
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../bin" && pwd)"
PR_READY="$BIN/pr-ready"
[ -f "$PR_READY" ] || {
	printf 'FATAL: %s is missing\n' "$PR_READY" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/stub" "$WORK/home" "$WORK/nogh"

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

expect_rc() { # <why> <0|nonzero>
	case $2 in
	0) [ "$RC" -eq 0 ] && pass "$1" || fail "$1" "exit $RC" "$OUT" ;;
	*) [ "$RC" -ne 0 ] && pass "$1" || fail "$1" "exit 0, expected a refusal" "$OUT" ;;
	esac
}
out_has() { # <why> <text>
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
		pass "$2"
	else
		fail "$2" "missing: $1" "$OUT"
	fi
}

# A gh stub: `gh pr view <n> --json ...` prints $GH_FIXTURE. A numbered sibling ($GH_FIXTURE.1,
# .2, ...) is used when it exists, so --wait can be given one fixture per poll.
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
[ "$1" = pr ] && [ "$2" = view ] || {
	printf 'gh stub: unexpected argv: %s\n' "$*" >&2
	exit 64
}
n=$(( $(cat "$GH_COUNT" 2>/dev/null || printf 0) + 1 ))
printf '%s\n' "$n" >"$GH_COUNT"
f=$GH_FIXTURE
[ -f "$f.$n" ] && f=$f.$n
cat "$f"
STUB
chmod +x "$WORK/stub/gh"

# write_rollup <file> <head> <spec>... — one statusCheckRollup.
#   run:<status>:<conclusion|empty for null>   a CheckRun (status and conclusion, like gh)
#   ctx:<state>                                a StatusContext (state only, like gh)
write_rollup() {
	local file=$1 head=$2 items="" spec i=0
	local -a list=()
	shift 2
	# "$*" joins on a space and this splits on one, so a caller may hand the specs
	# over as one quoted line ("$(repeat_spec ...)") instead of unquoted words.
	IFS=' ' read -r -a list <<<"$*"
	for spec in "${list[@]}"; do
		i=$((i + 1))
		case $spec in
		run:*)
			local rest=${spec#run:}
			local status=${rest%%:*}
			local conclusion=${rest#*:}
			if [ -z "$conclusion" ]; then conclusion=null; else conclusion="\"$conclusion\""; fi
			items="$items${items:+,}{\"__typename\":\"CheckRun\",\"name\":\"c$i\",\"status\":\"$status\",\"conclusion\":$conclusion}"
			;;
		ctx:*) items="$items${items:+,}{\"__typename\":\"StatusContext\",\"context\":\"s$i\",\"state\":\"${spec#ctx:}\"}" ;;
		esac
	done
	printf '{"headRefOid":"%s","statusCheckRollup":[%s]}\n' "$head" "$items" >"$file"
}

# repeat_spec <spec> <count> — the same spec on one line, for the quoted call form.
repeat_spec() {
	local spec=$1 n=$2 out="" i=0
	while [ "$i" -lt "$n" ]; do
		out="$out$spec "
		i=$((i + 1))
	done
	printf '%s' "$out"
}

# all_success <file> <head> [count] — a rollup every rule says yes to.
all_success() {
	local file=$1 head=$2 n=${3:-12} i specs=()
	for ((i = 0; i < n; i++)); do specs+=("run:COMPLETED:SUCCESS"); done
	write_rollup "$file" "$head" "${specs[@]}"
}

FULL=0123456789abcdef0123456789abcdef01234567
SHORT=0123456

run_pr_ready() { # <fixture> [args...]
	local fixture=$1
	shift
	OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
		GH_FIXTURE="$fixture" GH_COUNT="$WORK/count" \
		bash "$PR_READY" "$@" 2>&1)
	RC=$?
	rm -f "$WORK/count"
}

# ---------------------------------------------------------------------------
case_start "an empty rollup is not a green one"
printf '{"headRefOid":"%s","statusCheckRollup":[]}\n' "$FULL" >"$WORK/empty.json"
run_pr_ready "$WORK/empty.json" 209 --sha "$FULL"
expect_rc "the empty rollup is refused" nonzero
out_has "no checks" "the refusal says there are no checks"
out_has "pending 0" "the status line still carries the numbers"

# ---------------------------------------------------------------------------
case_start "a check still running is not a green one"
write_rollup "$WORK/inprogress.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" "run:IN_PROGRESS:"
run_pr_ready "$WORK/inprogress.json" 209 --sha "$FULL"
expect_rc "IN_PROGRESS is refused" nonzero
out_has "pending 1" "the status line counts it as pending"
out_has "not ready" "the refusal is printed"

# ---------------------------------------------------------------------------
case_start "a check with no conclusion at all is not a green one"
write_rollup "$WORK/noconclusion.json" "$FULL" run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED: run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS run:COMPLETED:SUCCESS
run_pr_ready "$WORK/noconclusion.json" 209 --sha "$FULL"
expect_rc "an empty conclusion is refused" nonzero
out_has "pending 1" "an empty conclusion reads as pending"

# ---------------------------------------------------------------------------
case_start "a queued check is not a green one"
write_rollup "$WORK/queued.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:QUEUED:
run_pr_ready "$WORK/queued.json" 209 --sha "$FULL"
expect_rc "QUEUED is refused" nonzero
out_has "pending 1" "QUEUED reads as pending"

# ---------------------------------------------------------------------------
case_start "a failed check is not a green one"
write_rollup "$WORK/failure.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:FAILURE
run_pr_ready "$WORK/failure.json" 209 --sha "$FULL"
expect_rc "FAILURE is refused" nonzero
out_has "fail 1" "the status line counts the failure"
out_has "FAILED" "the refusal says a check failed"

# ---------------------------------------------------------------------------
case_start "all green on the asked-about commit is the only pass"
all_success "$WORK/green.json" "$FULL"
run_pr_ready "$WORK/green.json" 209 --sha "$FULL"
expect_rc "twelve successes on the full sha pass" 0
out_has "checks 12, pending 0, fail 0" "the status line is the whole verdict"

# ---------------------------------------------------------------------------
case_start "green on another commit is not green on this one"
run_pr_ready "$WORK/green.json" 209 --sha deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
expect_rc "a different head is refused" nonzero
out_has "head is" "the refusal names the head"

# ---------------------------------------------------------------------------
case_start "--sha matches short or full"
run_pr_ready "$WORK/green.json" 209 --sha "$SHORT"
expect_rc "a short sha matching the head passes" 0
run_pr_ready "$WORK/green.json" 209 --sha "$FULL"
expect_rc "the full sha passes too" 0
run_pr_ready "$WORK/green.json" 209
expect_rc "no --sha puts no constraint on the head" 0

# ---------------------------------------------------------------------------
case_start "the rollup must hold at least --min-checks"
all_success "$WORK/three.json" "$FULL" 3
run_pr_ready "$WORK/three.json" 209 --sha "$FULL"
expect_rc "three checks are refused by the default 12" nonzero
out_has "min-checks is 12" "the refusal names the floor"
run_pr_ready "$WORK/three.json" 209 --sha "$FULL" --min-checks 3
expect_rc "--min-checks 3 accepts them" 0

# ---------------------------------------------------------------------------
case_start "a status context is read by its state, not by its absent conclusion"
write_rollup "$WORK/contexts.json" "$FULL" "$(repeat_spec ctx:SUCCESS 11)" ctx:SUCCESS
run_pr_ready "$WORK/contexts.json" 209 --sha "$FULL"
expect_rc "twelve SUCCESS status contexts pass" 0
write_rollup "$WORK/context-pending.json" "$FULL" "$(repeat_spec ctx:SUCCESS 11)" ctx:PENDING
run_pr_ready "$WORK/context-pending.json" 209 --sha "$FULL"
expect_rc "a PENDING status context is refused" nonzero

# ---------------------------------------------------------------------------
case_start "--wait polls until the rollup is green"
write_rollup "$WORK/wait.json.1" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:IN_PROGRESS:
all_success "$WORK/wait.json.2" "$FULL"
run_pr_ready "$WORK/wait.json" 209 --sha "$FULL" --wait --interval 1 --max 10
expect_rc "the second poll is green, so --wait exits 0" 0
out_has "pending 0, fail 0" "the verdict printed is the green one"

# ---------------------------------------------------------------------------
case_start "--wait that never goes green gives up and fails"
write_rollup "$WORK/wait-never.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:IN_PROGRESS:
run_pr_ready "$WORK/wait-never.json" 209 --sha "$FULL" --wait --interval 1 --max 2
expect_rc "a wait that runs out is not a pass" nonzero
out_has "gave up" "the refusal says the wait ran out"

# ---------------------------------------------------------------------------
case_start "gh missing is a FAIL, never a pass"
OUT=$(env -i PATH="$WORK/nogh:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
	PR_READY_GH="$WORK/no-such-gh" bash "$PR_READY" 209 --sha "$FULL" 2>&1)
RC=$?
expect_rc "no gh, no green" nonzero
out_has "gh is not installed" "the refusal names the missing tool"

# ---------------------------------------------------------------------------
case_start "a failed check stops the wait"
# A gate that keeps polling after a failure never ends and never helps: --wait must return on the
# first failed run, not after --max.
write_rollup "$WORK/wait-fail.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:IN_PROGRESS
write_rollup "$WORK/wait-fail-2.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:FAILURE
start=$(date +%s)
OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
	GH_FIXTURE="$WORK/wait-fail-2.json" GH_COUNT="$WORK/count" \
	bash "$PR_READY" 209 --sha "$FULL" --wait --interval 5 --max 60 2>&1)
RC=$?
rm -f "$WORK/count"
end=$(date +%s)
expect_rc "a failure ends the wait" nonzero
out_has "waiting cannot turn a failure green" "it says why it stopped"
elapsed=$((end - start))
if [ "$elapsed" -lt 5 ]; then pass "it stopped before the next interval ($elapsed s)"
else fail "it waited $elapsed s with a failure on the board"; fi

# ---------------------------------------------------------------------------
case_start "a PR gh cannot read is a FAIL, never a pass"
OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
	GH_FIXTURE="$WORK/does-not-exist.json" bash "$PR_READY" 209 2>&1)
RC=$?
expect_rc "an unreadable PR is refused" nonzero
out_has "not ready" "the refusal says it is not ready"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n' "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
