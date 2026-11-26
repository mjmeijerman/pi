#!/usr/bin/env bash
# Tests for `delegate close <slug> --nothing` on a worker that never committed.
#
# Why these exist: measured 2026-11-26 on trunk 90c7573, a real probe worker (`tab-probe`: spawned,
# reported "probe ok", committed nothing) could not be closed at all.
#
#   $ bin/delegate close tab-probe --nothing "the live probe, no code intended"
#   delegate: refusing to close tab-probe: … names no bin/preflight run under ## Evidence
#   Fix: … /home/mark/.pi/bin/preflight --slug tab-probe
#
# and `bin/preflight --slug tab-probe` cannot run: preflight finds a branch by the `Agent-Slug:`
# trailer, and a worker that committed nothing has no such commit. So the one worker with nothing
# to prove is the one that could never close. The skip is now keyed to "no branch in the project
# carries `Agent-Slug: <slug>`", never to the flag alone, and `finish` says the same thing about
# the same worker instead of handing back a preflight that can only die.
#
# The cases below are both directions of that key, in a throwaway git repo with a stub herdr, a
# stub preflight and a stub publish:
#
#   1. a never-committed worker: plain `close` still refuses (no --nothing), `--nothing` still asks
#      for the wipe step, and with the wipe recorded it closes and the space keeps only its Boss tab;
#   2. a worker that did commit keeps the gate: same `--nothing` flag, same report shape, refused
#      because no `bin/preflight` line is under `## Evidence`;
#   3. the skip is this worker's own slug: another branch carrying another worker's trailer does not
#      put the gate back on a worker that committed nothing;
#   4. `finish` on a never-committed worker refuses with the wipe+close commands and never runs
#      preflight or publish — the answer `close` gives, not a red check to fix;
#   5. `finish` on a committed worker still runs the gate, publishes and closes: the guard is keyed
#      to the trailer, not to "finish always refuses".
#
# No network, no real herdr, nothing written outside $WORK. Set PI_CLOSE_DELEGATE to another
# `bin/delegate` (trunk's) to run the same suite against older code, which is how the report shows
# these cases failing before the fix.
#
# The live half is unrun here on purpose: a sandbox has no herdr-app, so the tab list cannot be
# read on this machine. After merge, on the host, this is the sequence and the output to expect:
#
#   bin/delegate spawn close-nothing-probe --cwd /home/mark/.pi "<write one line, commit nothing>"
#   bin/delegate wait close-nothing-probe --forever
#   bin/delegate wipe close-nothing-probe --skip "nothing landed, so there is no consolidation"
#   bin/delegate close close-nothing-probe --nothing "the live probe: nothing landed, nothing to gate"
#   herdr-app ls        # the harness space lists its Boss tab and nothing else
#   bin/delegate list   # the probe is gone
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC=${PI_CLOSE_DELEGATE:-$ROOT/bin/delegate}
[ -x "$SRC" ] || {
	printf 'FATAL: %s is not executable\n' "$SRC" >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	printf 'FATAL: node is not on PATH\n' >&2
	exit 1
}
command -v git >/dev/null 2>&1 || {
	printf 'FATAL: git is not on PATH\n' >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
export PI_LEGACY_BOSS_ROOT="$WORK/legacy"
export PI_SPACE_RULES_TEMPLATE="$ROOT/agent/space-rules.md"
export DELEGATE_POLL_SECONDS=0
# The throwaway repo sees nothing from this machine: no global hooks, no user identity.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-01-01T00:00:00 +0000'
mkdir -p "$HOME" "$PI_SPACE_ROOT/bin" "$WORK/stub" "$PI_LEGACY_BOSS_ROOT/state"
PATH="$WORK/stub:$PI_SPACE_ROOT/bin:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export PF_LOG="$WORK/preflight.log"
export PUB_LOG="$WORK/publish.log"
: >"$HERDR_LOG"
: >"$PF_LOG"
: >"$PUB_LOG"

# herdr-app: the ids a space and a tab answer with, the two closes quiet, and `ls` whatever the
# case put in HERDR_SPACES. A tab.close drops that tab from the listed space, because a stub that
# still lists it is a close this side cannot confirm.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HERDR_LOG"
case "$1 $2" in
"do space.new") printf '{"space":"s-boss","tab":"tb-boss","pane":"p-boss","terminal":"t-boss"}\n' ;;
"do tab.new") printf '{"space":"s-boss","tab":"tb2","pane":"p2","terminal":"t2"}\n' ;;
"do tab.close")
	ID=$(printf '%s\n' "$*" | sed -nE 's/.*--id ([^ ]+).*/\1/p')
	if [ -f "${HERDR_SPACES:-/nonexistent}" ] && [ -n "$ID" ]; then
		ID="$ID" node -e '
			const fs=require("fs");const f=process.argv[1];
			let j={spaces:[]};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
			for (const s of j.spaces||[]) s.tabs=(s.tabs||[]).filter((t)=>String(t.id??"")!==process.env.ID);
			fs.writeFileSync(f,JSON.stringify(j)+"\n");' "$HERDR_SPACES"
	fi
	printf '{}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
# The gate, as far as this suite is about it: it finds a worker's branch by its `Agent-Slug:`
# trailer, exactly as bin/preflight does, and dies the same way when no branch carries it. Anything
# that carries one is green here — this suite is not a preflight.
cat >"$WORK/stub/preflight" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$PF_LOG"
slug="" cwd=""
while [ "$#" -gt 0 ]; do
	case $1 in
	--slug) slug=${2:-}; shift 2 ;;
	--cwd) cwd=${2:-}; shift 2 ;;
	*) shift ;;
	esac
done
# The real gate reads a worker's cwd from its delegation record when --cwd is not given; a stub that
# only read the flag would "pass" a finish that never pointed it at the repo.
if [ -z "$cwd" ]; then
	cwd=$(node -e '
		const fs=require("fs"),p=require("path");
		const root=(process.env.PI_SPACE_ROOT||"")+"/state/spaces";let out="";
		for (const s of (fs.existsSync(root)?fs.readdirSync(root):[])) {
			try {
				const j=JSON.parse(fs.readFileSync(p.join(root,s,"delegations.json"),"utf8"));
				if (j[process.argv[1]] && j[process.argv[1]].cwd) out=j[process.argv[1]].cwd;
			} catch {}
		}
		process.stdout.write(out)' "$slug")
fi
for b in $(git -C "$cwd" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null); do
	if git -C "$cwd" log --format=%B "$b" 2>/dev/null | grep -qE "^Agent-Slug:[[:space:]]*${slug}[[:space:]]*$"; then
		printf 'preflight: %s in %s: every check passed\n' "$b" "$cwd"
		exit 0
	fi
done
printf 'preflight: error: no branch in %s carries Agent-Slug: %s (or several do), so there is nothing to check\n' "$cwd" "$slug" >&2
exit 1
STUB
# publish: it must never run in the never-committed cases, so it says what it was asked and exits 0.
cat >"$WORK/stub/publish" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$PUB_LOG"
printf 'published %s: #1 now at %s\n' "${1:-}" "$(git -C "$PWD" rev-parse --short HEAD 2>/dev/null || printf deadbee)"
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/stub/pi-bare"
cat >"$WORK/stub/jev" <<'STUB'
#!/usr/bin/env bash
case "$1" in
plan) printf '{"mode":"bare","route":"remote","thinking":"medium","reason":"stub jev","answered":{"mode":"bare","route":"remote","thinking":"medium"}}\n' ;;
*) printf '{}\n' ;;
esac
STUB
# `finish` runs the programs beside the delegate it uses, so the stub gate and publisher are its
# neighbours, and the copy under test is the one the envelope names.
cp "$SRC" "$ROOT/bin/space-lib.sh" "$ROOT/bin/records-lib.sh" "$ROOT/bin/shell-resolve.sh" \
	"$ROOT/bin/worker-argv.sh" "$PI_SPACE_ROOT/bin/"
cp "$WORK/stub/preflight" "$WORK/stub/publish" "$PI_SPACE_ROOT/bin/"
chmod +x "$WORK/stub/"* "$PI_SPACE_ROOT/bin/"*
DELEGATE="$PI_SPACE_ROOT/bin/delegate"

PASS_N=0
FAIL_N=0
CASE=""
new_case() {
	CASE="$1"
	printf '\n== %s\n' "$CASE"
}
pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	[ "$#" -eq 0 ] || printf '%s\n' "$@" | sed 's/^/     /'
}
run() { OUT=$("$@" 2>&1); RC=$?; }
sd() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1"; }

# The project: one commit on master, and an origin to compare against, so the trailer lookup runs
# the same way it does here. No network — origin is a bare repo in $WORK.
PROJ="$WORK/proj"
mkdir -p "$PROJ"
git -C "$PROJ" init -q -b master
git -C "$PROJ" config commit.gpgsign false
printf 'a\n' >"$PROJ/a.txt"
git -C "$PROJ" add a.txt
git -C "$PROJ" commit -qm 'initial'
git init -q --bare "$WORK/origin.git"
git -C "$PROJ" remote add origin "$WORK/origin.git"
git -C "$PROJ" push -q -u origin master
BASE=$(git -C "$PROJ" rev-parse HEAD)

"$ROOT/bin/space" new --name demo --project "$PROJ" >/dev/null 2>&1 || {
	printf 'FATAL: space new failed\n' >&2
	exit 1
}
SPACEDIR=$(sd demo)
[ -f "$SPACEDIR/space.json" ] || {
	printf 'FATAL: no space record at %s\n' "$SPACEDIR/space.json" >&2
	exit 1
}
mkdir -p "$SPACEDIR/reports" "$SPACEDIR/specs"
printf '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-boss","name":"Boss"}]}]}\n' >"$WORK/spaces.json"
HERDR_SPACES="$WORK/spaces.json"
export HERDR_SPACES

# A worker's record, written the way spawn writes it: a tab in the space, `cwd` the project, and
# `branch` the branch the boss checkout was on when it started — which is what a worker that never
# committed leaves behind, and why "the branch exists" was never the question.
record() {
	local slug=$1 tab=$2
	SLUG=$slug TAB=$tab SPEC="$SPACEDIR/specs/$slug.md" REPORT="$SPACEDIR/reports/$slug.md" \
		PROJ=$PROJ node -e '
		const fs=require("fs");const file=process.argv[1];
		let j={};try{j=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
		j[process.env.SLUG]={slug:process.env.SLUG,kind:"tab",space:"s-boss",spaceName:"demo",
			tab:process.env.TAB,terminal:"t-"+process.env.SLUG,cwd:process.env.PROJ,branch:"master",
			mode:"sandboxed",thinking:"medium",spec:process.env.SPEC,report:process.env.REPORT};
		fs.writeFileSync(file,JSON.stringify(j,null,2)+"\n");' "$SPACEDIR/delegations.json"
}

# The report of a worker that wrote its evidence and committed nothing: the five fields, an
# Evidence block with real output, `## Thrown away`, and no `Commit:` sha anywhere.
report_nothing() {
	cat >"$1" <<'REPORT'
# Report — the probe

Mission: the person can close a worker that landed nothing, instead of keeping it forever

Review tier: Low

Test change: none: no test file changed

## Evidence

Command: `printf 'probe ok\n'`

Output (last 20 lines):

```
probe ok
```

Nothing landed: the probe wrote one line to its own terminal and committed nothing.

## Thrown away

1. Deleted?      nothing was added, so nothing was removed.
2. Duplicated?   nothing here is a second copy of anything.
3. Next feature? this area is unchanged, so the next feature starts where this one did.
4. Learned?      a worker that lands nothing needs a close that asks it for nothing.
5. Rewrite?      nothing to rewrite: there is no code.
REPORT
}

# ============================================ 1. a worker that never committed can close --
new_case 'a never-committed worker: close without --nothing still refuses'
report_nothing "$SPACEDIR/reports/w1.md"
printf '# Worker w1\n\nMission: probe\n' >"$SPACEDIR/specs/w1.md"
record w1 tb1
run "$DELEGATE" close w1
if [ "$RC" -ne 0 ]; then pass 'closing without a reason is refused'; else fail 'a never-committed worker closed with no reason at all' "$OUT"; fi
case $OUT in
*"names no bin/preflight run under ## Evidence"*) pass 'the refusal is the gate, exactly as before' ;;
*) fail 'the refusal is not the gate this case pins' "$OUT" ;;
esac
if grep -q '"w1"' "$SPACEDIR/delegations.json"; then pass 'the record is kept'; else fail 'a refused close dropped the record'; fi

new_case 'close --nothing still asks for the wipe step'
run "$DELEGATE" close w1 --nothing "the live probe: nothing landed, so nothing needed a branch"
if [ "$RC" -ne 0 ]; then pass 'a close with no wipe line is still refused'; else fail 'the wipe gate was skipped as well' "$OUT"; fi
case $OUT in
*"no wipe step recorded for it"*) pass 'the refusal is the wipe step' ;;
*) fail 'the refusal does not name the wipe step' "$OUT" ;;
esac
case $OUT in
*"preflight evidence is not asked for"*) pass 'the preflight gate said out loud that it does not apply' ;;
*) fail 'the skip is silent' "$OUT" ;;
esac

new_case 'a never-committed worker with the wipe recorded closes'
run "$DELEGATE" wipe w1 --skip "nothing landed, so there is no consolidation to answer"
if [ "$RC" -eq 0 ]; then pass 'the wipe step is recorded'; else fail 'the wipe step was refused' "$OUT"; fi
run "$DELEGATE" close w1 --nothing "the live probe: nothing landed, so nothing needed a branch"
if [ "$RC" -eq 0 ]; then pass 'it closes'; else fail 'the close was refused' "$OUT"; fi
case $OUT in
*"preflight evidence is not asked for"*) pass 'the one line says why the gate was not asked' ;;
*) fail 'the skip is not said out loud' "$OUT" ;;
esac
case $OUT in
*"no branch in $PROJ carries a commit with Agent-Slug: w1"*) pass 'it names the branch it looked for, and where' ;;
*) fail 'the skip does not name the lookup' "$OUT" ;;
esac
if grep -qF 'do tab.close --id tb1' "$HERDR_LOG"; then pass 'the worker tab is closed'; else fail 'the worker tab was not closed' "$(cat "$HERDR_LOG")"; fi
if grep -qF 'do space.close' "$HERDR_LOG"; then
	fail 'space.close was called: a finished worker could take the space with it' "$(cat "$HERDR_LOG")"
else
	pass 'the space is never closed'
fi
if grep -q '"w1"' "$SPACEDIR/delegations.json"; then fail 'the record was kept after a close'; else pass 'the record is gone'; fi
if node -e '
	const fs=require("fs");
	const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter((l)=>l.trim());
	const row=lines.map((l)=>{try{return JSON.parse(l)}catch{return null}}).filter((j)=>j&&j.slug==="w1"&&j.command==="nothing");
	process.exit(row.length===1?0:1);' "$SPACEDIR/state/decisions.jsonl" 2>/dev/null; then
	pass 'state/decisions.jsonl keeps one "nothing" row for it'
else
	fail 'the no-op close left no row'
fi
LEFT=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=(j.spaces||[]).find((x)=>x.id==="s-boss");process.stdout.write(((s&&s.tabs)||[]).map((t)=>t.name||t.id).join(","));' "$WORK/spaces.json")
if [ "$LEFT" = 'Boss' ]; then pass 'the space lists its Boss tab and nothing else'; else fail "the space still holds another tab" "$LEFT"; fi

# ================================= 2. a worker that did commit keeps the preflight gate --
new_case 'a worker that committed keeps the gate, with the same --nothing flag'
git -C "$PROJ" checkout -q -b w2 "$BASE"
printf 'w2\n' >"$PROJ/b.txt"
git -C "$PROJ" add b.txt
git -C "$PROJ" commit -qm 'feat: w2 work' --trailer 'Agent-Slug: w2' --trailer 'Spec: specs/w2.md'
git -C "$PROJ" checkout -q master
report_nothing "$SPACEDIR/reports/w2.md"
printf '# Worker w2\n\nMission: w2\n' >"$SPACEDIR/specs/w2.md"
record w2 tb2
run "$DELEGATE" wipe w2 --skip "the consolidation step is not what this case is about"
if [ "$RC" -eq 0 ]; then pass 'the wipe step is recorded, so only the gate can refuse'; else fail 'the wipe step was refused' "$OUT"; fi
run "$DELEGATE" close w2 --nothing "the probe says nothing landed, but this branch carries a commit"
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'a worker whose branch carries its commit was closed with --nothing' "$OUT"; fi
case $OUT in
*"names no bin/preflight run under ## Evidence"*) pass 'the refusal is the preflight gate, not a skip' ;;
*) fail 'the gate was skipped for a worker that committed' "$OUT" ;;
esac
if grep -qF 'preflight evidence is not asked for' <<<"$OUT"; then fail 'the skip fired for a worker that committed' "$OUT"; else pass 'nothing skipped the gate'; fi
if grep -q '"w2"' "$SPACEDIR/delegations.json"; then pass 'the record is kept for the report to be fixed'; else fail 'a refused close dropped the record'; fi

# ============================= 3. the skip is this worker's own slug, not any branch --
new_case 'another branch carrying another worker does not put the gate back'
report_nothing "$SPACEDIR/reports/w3.md"
printf '# Worker w3\n\nMission: w3\n' >"$SPACEDIR/specs/w3.md"
record w3 tb3
run "$DELEGATE" wipe w3 --skip "nothing landed, so there is no consolidation to answer"
run "$DELEGATE" close w3 --nothing "the live probe: nothing landed, so nothing needed a branch"
if [ "$RC" -eq 0 ]; then pass 'it closes, though branch w2 carries Agent-Slug: w2'; else fail 'the gate came back over another worker branch' "$OUT"; fi

# ============================================== 4. finish agrees with close, and says so --
new_case 'finish on a never-committed worker refuses with the close command'
report_nothing "$SPACEDIR/reports/w4.md"
printf '# Worker w4\n\nMission: w4\n' >"$SPACEDIR/specs/w4.md"
record w4 tb4
: >"$PF_LOG"
: >"$PUB_LOG"
run "$DELEGATE" finish w4
if [ "$RC" -ne 0 ]; then pass 'it is refused'; else fail 'finish said it finished a worker that committed nothing' "$OUT"; fi
case $OUT in
*"close w4 --nothing"*) pass 'the refusal names close --nothing, the answer close gives' ;;
*) fail 'the refusal does not name the ways out' "$OUT" ;;
esac
case $OUT in
*"wipe w4 --skip"*) pass 'it names the wipe step the close needs first' ;;
*) fail 'the refusal omits the wipe step' "$OUT" ;;
esac
if [ -s "$PF_LOG" ]; then fail 'the gate ran for a worker with no branch to check' "$(cat "$PF_LOG")"; else pass 'preflight was never run'; fi
if [ -s "$PUB_LOG" ]; then fail 'publish ran for a worker with nothing to publish' "$(cat "$PUB_LOG")"; else pass 'nothing was published'; fi
if grep -q '"w4"' "$SPACEDIR/delegations.json"; then pass 'the worker is still open'; else fail 'the record was dropped by a refused finish'; fi

# ================================ 5. finish on a worker that committed still runs the gate --
new_case 'finish on a worker that committed runs the gate and closes'
git -C "$PROJ" checkout -q -b w5 "$BASE"
printf 'w5\n' >"$PROJ/c.txt"
git -C "$PROJ" add c.txt
git -C "$PROJ" commit -qm 'feat: w5 work' --trailer 'Agent-Slug: w5' --trailer 'Spec: specs/w5.md'
W5SHA=$(git -C "$PROJ" rev-parse HEAD)
git -C "$PROJ" checkout -q master
cat >"$SPACEDIR/reports/w5.md" <<REPORT
# Report — w5

Mission: a worker that committed still gets the gate finish always ran

Review tier: Low

Test change: none: no test file changed

## Evidence

Command: \`bin/preflight --slug w5\`

Output (last 20 lines):

\`\`\`
preflight: w5 in $PROJ: every check passed
\`\`\`

## Thrown away

1. Deleted?      nothing was added, so nothing was removed.
2. Duplicated?   nothing here is a second copy of anything.
3. Next feature? this area is unchanged, so the next feature starts where this one did.
4. Learned?      the guard is keyed to the trailer, not to the command.
5. Rewrite?      nothing to rewrite: there is no code.

Commit: $W5SHA
REPORT
printf '# Worker w5\n\nMission: w5\n' >"$SPACEDIR/specs/w5.md"
record w5 tb5
: >"$PF_LOG"
: >"$PUB_LOG"
HERDR_SPACES="$WORK/spaces.json"
printf '{"spaces":[{"id":"s-boss","name":"demo","tabs":[{"id":"tb-boss","name":"Boss"}]}]}\n' >"$WORK/spaces.json"
run "$DELEGATE" finish w5
if grep -qF -- '--slug w5' "$PF_LOG"; then pass 'the gate ran: finish is not a blanket refusal'; else fail 'the gate was skipped for a worker that committed' "$(cat "$PF_LOG")"; fi
if grep -qF 'w5' "$PUB_LOG"; then pass 'it published'; else fail 'nothing was published' "$(cat "$PUB_LOG")"; fi
if [ "$RC" -eq 0 ]; then pass 'the whole tail finished: publish, wipe, close'; else fail 'the finish stopped short' "$OUT"; fi
if grep -q '"w5"' "$SPACEDIR/delegations.json"; then fail 'the record survived a successful finish'; else pass 'the record is gone'; fi

printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
