#!/usr/bin/env bash
# Tests for bin/pr-ready — the one answer to "is this pull request green".
#
# Why these exist: `gh pr checks | grep -c pending` matches the word "pending" and nothing else, so
# IN_PROGRESS, QUEUED and a rollup that has not registered its workflows yet all read as zero
# pending. That is how a PR was called green three minutes before it went red. Every rule in this
# file is one the prose could not answer, run against a `gh` stub on PATH that returns JSON
# fixtures: the real gh is never called, so this test needs no network and no repository.
#
# PR_READY=<path> points the suite at another pr-ready, which is how a new rule is proved red on an
# older one: PR_READY=/tmp/trunk-pr-ready bash scripts/tests/test-pr-ready.sh
#
# Run it directly, or through scripts/ci-offline.sh, which globs scripts/tests/test-*.sh.
set -uo pipefail

BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../bin" && pwd)"
PR_READY="${PR_READY:-$BIN/pr-ready}"
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
out_lacks() { # <why> <text> — a line that must NOT be there (a name, or a repeat)
	if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
		fail "$2" "unexpectedly present: $1" "$OUT"
	else
		pass "$2"
	fi
}
out_has_once() { # <why> <text> — exactly one line, so a per-poll announcement cannot repeat
	local n
	n=$(printf '%s\n' "$OUT" | grep -Fc -- "$1")
	if [ "$n" -eq 1 ]; then
		pass "$2"
	else
		fail "$2" "seen $n time(s), expected 1: $1" "$OUT"
	fi
}

# A gh stub: `gh pr view <n> --json ...` prints the rollup fixture, or the comments fixture when the
# --json list asks for comments. A numbered sibling ($GH_FIXTURE.1, .2, ...) is used when it exists,
# so --wait can be given one fixture per poll.
cat >"$WORK/stub/gh" <<'STUB'
#!/usr/bin/env bash
[ "$1" = pr ] && [ "$2" = view ] || {
	printf 'gh stub: unexpected argv: %s\n' "$*" >&2

exit 64
}
f=$GH_FIXTURE
for arg in "$@"; do
	case $arg in
	*comments*) f=$GH_COMMENTS ;;
	*statusCheckRollup*) f=$GH_FIXTURE ;;
	esac
done
n=$(( $(cat "$GH_COUNT" 2>/dev/null || printf 0) + 1 ))
printf '%s\n' "$n" >"$GH_COUNT"
[ -f "$f.$n" ] && f=$f.$n
cat "$f"
STUB
chmod +x "$WORK/stub/gh"

# write_comments <file> [body]... — the PR's comments, one comment per body, as gh returns them.
write_comments() {
	local file=$1 first=1 body
	shift
	printf '{"comments":[' >"$file"
	for body in "$@"; do
		[ "$first" = 1 ] || printf ',' >>"$file"
		first=0
		printf '{"body":%s}' "$(printf '%s' "$body" | jq -Rs .)" >>"$file"
	done
	printf ']}\n' >>"$file"
}

# write_thread <file> <login> <createdAt> <body> ... — the same comments with the two fields a reply
# is judged by: who wrote it and when. gh returns both; a comment without them cannot be told from
# the review it answers.
write_thread() {
	local file=$1 first=1
	shift
	printf '{"comments":[' >"$file"
	while [ "$#" -ge 3 ]; do
		[ "$first" = 1 ] || printf ',' >>"$file"
		first=0
		printf '{"author":{"login":%s},"createdAt":%s,"body":%s}' \
			"$(printf '%s' "$1" | jq -Rs .)" "$(printf '%s' "$2" | jq -Rs .)" "$(printf '%s' "$3" | jq -Rs .)" >>"$file"
		shift 3
	done
	printf ']}\n' >>"$file"
}

# A prose-review comment as .github/scripts/prose-review.mjs writes it: the marker, then one numbered
# line per question, a citation or the literal words "no finding".
prose_comment() { # <answer1> ... <answer5>
	local -a q=(contradiction "missing command" "uncheckable rule" "duplicated rule" "older sentence now false")
	local i=1 out="<!-- prose-review -->"
	out=$out$'\n**prose-review** — five questions about the instruction prose in this diff (`stub`).\n'
	for a in "$@"; do
		out=$out$'\n'"$i. **${q[$((i - 1))]}** — $a"
		i=$((i + 1))
	done
	printf '%s' "$out"
}

# write_rollup <file> <head> <spec>... — one statusCheckRollup.
#   run:<status>:<conclusion|empty for null>   a CheckRun (status and conclusion, like gh)
#   ctx:<state>                                a StatusContext (state only, like gh)
write_rollup() {
	local file=$1 head=$2 items="" spec i=0
	local -a list=()
	shift 2
	# "$*" joins on a space and read -a splits on the shell's default IFS, which is
	# whitespace, so a caller may hand the specs over as one quoted line
	# ("$(repeat_spec ...)") instead of unquoted words. No IFS assignment: the default
	# already splits on that space, and semgrep refuses a line that sets it.
	read -r -a list <<<"$*"
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
		GH_FIXTURE="$fixture" GH_COMMENTS="${COMMENTS_FIXTURE:-$WORK/comments-none.json}" \
		GH_COUNT="$WORK/count" \
		bash "$PR_READY" "$@" 2>&1)
	RC=$?
	rm -f "$WORK/count"
}

# The default: a pull request whose instructions nobody had to read, so nobody wrote a review.
write_comments "$WORK/comments-none.json"

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
case_start "one failure does not end the wait: the rest of the rollup does"
# Measured: a check failed three seconds in while fourteen were still QUEUED and the old --wait
# exited at once, so nobody learned whether the other fourteen passed. A failure says waiting cannot
# turn *that* check green; the verdict is the whole rollup, so --wait keeps polling until every
# check has a conclusion and then judges once.
write_rollup "$WORK/late-fail.json.1" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:FAILURE run:IN_PROGRESS:
write_rollup "$WORK/late-fail.json.2" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:FAILURE run:COMPLETED:FAILURE
start=$(date +%s)
run_pr_ready "$WORK/late-fail.json" 209 --sha "$FULL" --wait --interval 2 --max 30
end=$(date +%s)
elapsed=$((end - start))
expect_rc "a rollup with a concluded failure is not green" nonzero
out_has "check c12 failed; still waiting for 1" "the first failure is announced as it appears, with what is still running"
out_has "check c13 failed; still waiting for 0" "the second failure is announced when its check concludes"
out_has_once "check c12 failed" "the announcement for c12 appears once, not once per poll"
out_has "checks 13, pending 0, fail 2, finished" "the last line carries the whole completed rollup"
if [ "$elapsed" -ge 2 ]; then pass "it kept polling after the first failure ($elapsed s, not the instant exit)"
else fail "it exited after $elapsed s, before the second poll could look"; fi

# ---------------------------------------------------------------------------
case_start "--fail-fast is the impatient mode: the first failure, and only it"
start=$(date +%s)
run_pr_ready "$WORK/late-fail.json" 209 --sha "$FULL" --wait --fail-fast --interval 5 --max 60
end=$(date +%s)
expect_rc "--fail-fast refuses on the first failure" nonzero
out_has "check c12 failed" "it names the check that failed"
out_lacks "c13" "it names nothing about the checks still running"
elapsed=$((end - start))
if [ "$elapsed" -lt 5 ]; then pass "it stopped before the next interval ($elapsed s)"
else fail "it waited $elapsed s with a failure on the board"; fi

# ---------------------------------------------------------------------------
case_start "a rollup that has not registered yet waits instead of refusing"
printf '{"headRefOid":"%s","statusCheckRollup":[]}\n' "$FULL" >"$WORK/unregistered.json.1"
all_success "$WORK/unregistered.json.2" "$FULL"
run_pr_ready "$WORK/unregistered.json" 209 --sha "$FULL" --wait --interval 1 --max 15
expect_rc "the rollup appears on the next poll, so --wait passes" 0
out_has "no check has registered yet" "the empty rollup is named as unregistered, not as no checks"
out_has "checks 12, pending 0, fail 0, finished" "the pass carries the finished rollup"

# ---------------------------------------------------------------------------
case_start "--fail-fast stops at the first failure"
# A gate that keeps polling after a failure never ends and never helps: --fail-fast must return on
# the first failed run, not after --max. The default --wait does the opposite (the case above).
write_rollup "$WORK/wait-fail.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:IN_PROGRESS
write_rollup "$WORK/wait-fail-2.json" "$FULL" "$(repeat_spec run:COMPLETED:SUCCESS 11)" run:COMPLETED:FAILURE
start=$(date +%s)
OUT=$(env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
	GH_FIXTURE="$WORK/wait-fail-2.json" GH_COUNT="$WORK/count" \
	bash "$PR_READY" 209 --sha "$FULL" --wait --fail-fast --interval 5 --max 60 2>&1)
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
# The prose review. `prose-review` posts one comment on a PR that touches an instruction file, and
# that comment is green in CI whether it holds five findings or five "no finding" lines: the check
# says the review ran, never that there is nothing left to do. A finding is a change to the diff, so
# a PR carrying one is not ready to hand over.
case_start "a prose-review finding is not a green one"
all_success "$WORK/prose-green.json" "$FULL"
write_comments "$WORK/prose-found.json" \
	"$(prose_comment "agent/AGENTS.md:16 makes --wait required, and agent/AGENTS.md:17 requires delegate wait" "no finding" "no finding" "agent/AGENTS.md:16 repeats 'not news'" "no finding")"
COMMENTS_FIXTURE=$WORK/prose-found.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "five green checks and a finding is refused" nonzero
out_has "checks 12, pending 0, fail 0" "the status line keeps its shape"
out_has "prose review: 2 finding(s) open — contradiction" "the verdict counts the findings and names the first"
out_has "open: contradiction — agent/AGENTS.md:16 makes --wait required" "the first finding is quoted in the review's own words"
out_has "open: duplicated rule — agent/AGENTS.md:16 repeats" "every finding is named, not only the first"
out_lacks "missing command —" "a question answered 'no finding' is not printed as a finding"

# ---------------------------------------------------------------------------
case_start "five 'no finding' answers leave the PR ready"
write_comments "$WORK/prose-clean.json" "$(prose_comment "no finding" "no finding" "no finding" "No finding." "no finding")"
COMMENTS_FIXTURE=$WORK/prose-clean.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "a review with nothing to answer passes" 0
out_lacks "not ready" "the pass says nothing about the review"
out_has "prose review: clean (5 checks)" "the pass counts the questions the review answered"

# ---------------------------------------------------------------------------
case_start "no prose-review comment is nothing to answer"
write_comments "$WORK/comments-chatter.json" "looks good to me" "1. **contradiction** — a finding in a comment that is not the review"
COMMENTS_FIXTURE=$WORK/comments-chatter.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "an ordinary PR with no review comment passes" 0
out_has "prose review: none yet" "the pass says there was no review to answer"

# ---------------------------------------------------------------------------
case_start "the marker is what makes a comment the review"
write_comments "$WORK/prose-unmarked.json" \
	"1. **contradiction** — agent/AGENTS.md:16 contradicts itself, and this comment is not the review"
COMMENTS_FIXTURE=$WORK/prose-unmarked.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "a person quoting a finding is not a review" 0

# ---------------------------------------------------------------------------
case_start "a review this cannot read is not a pass"
write_comments "$WORK/prose-garbled.json" "$(printf '<!-- prose-review -->\n**prose-review** — five questions (stub).\n\nI could not answer these.')"
COMMENTS_FIXTURE=$WORK/prose-garbled.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "a marked comment with no numbered answer line is refused" nonzero
out_has "answered nothing this gate can read" "the refusal says the review was unreadable, not clean"

# ---------------------------------------------------------------------------
case_start "comments gh cannot read are a FAIL, never a pass"
printf 'not json at all\n' >"$WORK/comments-broken.json"
COMMENTS_FIXTURE=$WORK/comments-broken.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "an unreadable comments payload is refused" nonzero
out_has "did not parse" "the refusal names the parse failure"

# ---------------------------------------------------------------------------
case_start "--wait does not wait for a finding"
# A finding is answered by a commit. Polling cannot write one, so a wait that kept polling would
# burn --max minutes and end in the same refusal; it stops at once and names the finding.
COMMENTS_FIXTURE=$WORK/prose-found.json
start=$(date +%s)
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL" --wait --interval 5 --max 60
COMMENTS_FIXTURE=""
end=$(date +%s)
expect_rc "a green rollup with a finding is not a pass" nonzero
out_has "checks 12, pending 0, fail 0, finished" "the rollup is reported as finished, not as still running"
out_has "waiting does not write one" "it says why waiting cannot help"
elapsed=$((end - start))
if [ "$elapsed" -lt 5 ]; then pass "it stopped before the next interval ($elapsed s)"
else fail "it waited $elapsed s on a finding no poll can answer"; fi


# ---------------------------------------------------------------------------
# A finding a person can answer. AGENTS.md states the rule as "answer every finding in the diff or in
# a reply", and the review comment is posted by a workflow, so a reply is the only way a person can
# answer one. Measured on trunk: `bin/pr-ready 229 --sha d5ce1e4` refused with "the prose review has
# 2 answer(s) to write into the diff" while a comment answering both findings sat on the PR two
# minutes later — the gate took the first marked comment and only that one, and refused on any
# finding at all, so a PR whose review found something could never be handed over.
T1=2026-01-01T00:00:00Z
T2=2026-01-01T00:10:00Z
T3=2026-01-01T00:20:00Z

case_start "a finding a person answered in a later reply is answered"
write_thread "$WORK/thread-answered.json" \
	github-actions "$T1" "$(prose_comment "agent/AGENTS.md:16 makes --wait required" "no finding" "no finding" "no finding" "no finding")" \
	octocat "$T2" "Finding 1: fixed in cff5699, --wait is optional again."
COMMENTS_FIXTURE=$WORK/thread-answered.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "a reply naming the finding is a pass" 0
out_has "prose review: 1 finding(s) answered by octocat" "the verdict names who answered it"

# ---------------------------------------------------------------------------
case_start "a reply that names nothing answers nothing"
write_thread "$WORK/thread-thanks.json" \
	github-actions "$T1" "$(prose_comment "agent/AGENTS.md:16 makes --wait required" "no finding" "no finding" "no finding" "no finding")" \
	octocat "$T2" "Thanks, looks good to me!"
COMMENTS_FIXTURE=$WORK/thread-thanks.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "a plain thanks is not an answer" nonzero
out_has "prose review: 1 finding(s) open — contradiction" "the finding is still open"

# ---------------------------------------------------------------------------
case_start "a reply from a bot answers nothing"
# A CI comment that happens to quote a finding is not a person deciding it is handled.
write_thread "$WORK/thread-bot.json" \
	github-actions "$T1" "$(prose_comment "agent/AGENTS.md:16 makes --wait required" "no finding" "no finding" "no finding" "no finding")" \
	"prose-review[bot]" "$T2" "finding 1: fixed (this is a bot quoting itself)"
COMMENTS_FIXTURE=$WORK/thread-bot.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "a bot reply is not an answer" nonzero
out_has "prose review: 1 finding(s) open — contradiction" "the finding stays open against a bot"

# ---------------------------------------------------------------------------
case_start "a newer clean review supersedes the one with findings"
# The review is the latest marked comment: a re-run that finds nothing is the review that stands, and
# an older one with findings must not keep the PR red forever.
write_thread "$WORK/thread-superseded.json" \
	github-actions "$T1" "$(prose_comment "agent/AGENTS.md:16 makes --wait required" "no finding" "no finding" "no finding" "no finding")" \
	github-actions "$T3" "$(prose_comment "no finding" "no finding" "no finding" "no finding" "no finding")"
COMMENTS_FIXTURE=$WORK/thread-superseded.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL"
COMMENTS_FIXTURE=""
expect_rc "the newest review is the one judged" 0
out_has "prose review: clean (5 checks)" "the newer review's five clean answers are the verdict"

# ---------------------------------------------------------------------------
case_start "--no-prose-review skips rule 5 and says so"
COMMENTS_FIXTURE=$WORK/thread-thanks.json
run_pr_ready "$WORK/prose-green.json" 209 --sha "$FULL" --no-prose-review
COMMENTS_FIXTURE=""
expect_rc "a skipped review does not block a green rollup" 0
out_has "prose review: skipped" "the run says the rule was skipped, not that it passed"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed in %d cases\n'  "$PASS_N" "$FAIL_N" "$CASE_N"
[ "$FAIL_N" -eq 0 ]
