#!/usr/bin/env bash
# Tests for one question: what command is the Boss resumed with?
#
# Why these exist: the guard found the right session and adopted the right space, and still brought
# a respawned Boss back as `pi` — a sandboxed Boss — because the `~/.pi/agent/herdr-resume` entry it
# read was written before the bare-Boss rule and its `argv` was used verbatim as the base. The entry
# remembers a session; it does not get to decide a command. So each case below parks a stale entry,
# runs one pass, and reads the argv a stub `herdr-app` was asked to open:
#
#   1. an entry carrying `["pi"]` opens this tree's `bin/pi-bare`;
#   2. an entry carrying a sandbox wrapper (`pisandbox -- pi`) opens the same bare argv;
#   3. an entry carrying `--thinking high` opens bare, with no flag of the entry's;
#   4. an entry that already carried `--session` opens the newest session, exactly once.
#
# Every case also checks the record: `boss_argv` and the Boss tab's argv are the argv that was
# opened, never the entry's, or the next resume reads the stale one back out of the record.
#
# No network, no desktop app, nothing written outside $WORK. Set PI_IDENTITY_BIN to another `bin/`
# (trunk's `guard`, `space` and `space-lib.sh`) to run the same cases against older code, which is
# how the report shows a case failing before the fix.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BINDIR=${PI_IDENTITY_BIN:-$ROOT/bin}
GUARD="$BINDIR/guard"
for prog in "$GUARD" "$BINDIR/space-lib.sh"; do
	[ -e "$prog" ] || {
		printf 'FATAL: %s is missing\n' "$prog" >&2
		exit 1
	}
done
[ -x "$GUARD" ] || {
	printf 'FATAL: %s is not executable\n' "$GUARD" >&2
	exit 1
}
for prog in node bash; do
	command -v "$prog" >/dev/null 2>&1 || {
		printf 'FATAL: %s is not on PATH\n' "$prog" >&2
		exit 1
	}
done
# The tree the tools live in: that is where a bare Boss is, and the guard reads its own `..`.
PI_HOME=$(cd -- "$BINDIR/.." && pwd)
BARE="$PI_HOME/bin/pi-bare"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home"
export PI_SPACE_ROOT="$WORK/root"
export PI_BOSS_ROOT="$WORK/root"
mkdir -p "$HOME" "$PI_SPACE_ROOT" "$WORK/stub" "$WORK/resume" "$WORK/sessions"
PATH="$WORK/stub:$PATH"
export PATH
export HERDR_LOG="$WORK/herdr.log"
export HERDR_LS_LOG="$WORK/herdr-ls.log"
export HERDR_SPACES="$WORK/spaces.json"
export PI_HERDR_RESUME_DIR="$WORK/resume"
export PI_SESSIONS_DIR="$WORK/sessions"

# herdr-app: every action is written down, `ls` answers whatever the case put in $HERDR_SPACES.
cat >"$WORK/stub/herdr-app" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
"ls "*) printf '%s\n' "$*" >>"$HERDR_LS_LOG" ;;
*) printf '%s\n' "$*" >>"$HERDR_LOG" ;;
esac
case "$1 $2" in
"do space.new") printf '{"space":"sp-new","tab":"tb-new","pane":"p-new","terminal":"t-new"}\n' ;;
"do tab.new") printf '{"space":"sp-new","tab":"tb-new","pane":"p-new","terminal":"t-new"}\n' ;;
"ls "*) if [ -f "${HERDR_SPACES:-/nonexistent}" ]; then cat "$HERDR_SPACES"; else printf '{"spaces":[]}\n'; fi ;;
*) printf '{}\n' ;;
esac
STUB
# The resume sweep is not what this file checks.
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/stub/herdr-resume.mjs"
chmod +x "$WORK/stub/"*
export PI_GUARD_RESUME_SCRIPT="$WORK/stub/herdr-resume.mjs"

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
run() { OUT=$(timeout 60 "$@" 2>&1); RC=$?; }
sd() { printf '%s' "$PI_SPACE_ROOT/state/spaces/$1"; }
record() { printf '%s' "$(sd "$1")/space.json"; }
herdr() { cat "$HERDR_LOG" 2>/dev/null || true; }
clear_log() { : >"$HERDR_LOG"; : >"$HERDR_LS_LOG"; }
spaces() { printf '%s\n' "$1" >"$HERDR_SPACES"; }
field() { # <record> <field> — a scalar or a JSON array, as text
	node -e '
		const fs = require("fs");
		const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		const v = j[process.argv[2]];
		process.stdout.write(Array.isArray(v) ? JSON.stringify(v) : String(v ?? ""));
	' "$1" "$2"
}
tab_argv() { # <record> [tab-name]
	node -e '
		const fs = require("fs");
		const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		const want = process.argv[2] || "Boss";
		const t = (Array.isArray(j.tabs) ? j.tabs : []).find((x) => x && x.name === want);
		process.stdout.write(t ? JSON.stringify(t.argv || []) : "");
	' "$1" "${2:-}"
}
# A record the way `bin/space new` writes it, plus whatever the case adds.
make_record() { # <slug> <name> <project> <id> [extra-json]
	local extra=${5:-}
	[ -n "$extra" ] || extra='{}'
	node -e '
		const fs = require("fs"), [dir, name, project, id, extra] = process.argv.slice(1);
		fs.mkdirSync(dir + "/reports", { recursive: true });
		const rec = Object.assign({
			name, id, project, git: false, remote: "", created: "2026-01-01T00:00:00.000Z",
			boss: "Boss", uberboss_tab: "", terminals: [],
			tabs: [{ name: "Boss", folder: project, argv: [] }],
		}, JSON.parse(extra));
		fs.writeFileSync(dir + "/space.json", JSON.stringify(rec, null, 2) + "\n");
	' "$(sd "$1")" "$2" "$3" "$4" "$extra"
}
# A session file: its own first line carries the `cwd` the guard searches by, and its mtime is the
# only thing that says which one is newest.
mk_session() { # <folder-slug> <file> <cwd> <mtime-epoch>
	local dir="$WORK/sessions/$1"
	mkdir -p "$dir"
	printf '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"%s"}\n' "$3" >"$dir/$2"
	touch -d "@$4" "$dir/$2"
	printf '%s' "$dir/$2"
}
park_entry() { # <terminal> <space-id> <session> <cwd> <argv-json> — the stale entry, exactly as found
	node -e '
		const fs = require("fs"), [dir, terminal, space, session, cwd, argv] = process.argv.slice(1);
		fs.writeFileSync(dir + "/" + terminal + ".json", JSON.stringify({
			version: 1, terminal, space, session_path: session, cwd,
			argv: JSON.parse(argv), updated_at: "2026-01-02T00:00:00.000Z",
		}, null, 2) + "\n");
	' "$PI_HERDR_RESUME_DIR" "$1" "$2" "$3" "$4" "$5"
}
# The Boss tab is missing (the space holds a tab that is not it), so one pass has to open it.
park_space() { # <slug> <name> <id>
	spaces '{"spaces":[{"id":"'"$3"'","name":"'"$2"'","folder":"'"$PROJ"'","tabs":[{"id":"tb-other","name":"other"}]}]}'
}
# opened_argv <slug> — the argv the stub was asked to open, as one JSON array.
opened_argv() {
	printf '%s\n' "$(herdr)" | grep -F "do tab.new --name Boss --space" | sed -e 's/.*--argv //' -e 's/ --focus false$//'
}
expect_bare() { # <case label> <expected session>
	local want argv
	want=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1], "--session", process.argv[2]]))' "$BARE" "$2")
	argv=$(opened_argv "$1")
	if [ "$argv" = "$want" ]; then
		pass "the Boss tab is opened as $want"
	else
		fail "the Boss tab was not opened bare on the newest session (wanted $want)" "$(herdr)"
	fi
	if [ "$(field "$(record "$1")" boss_argv)" = "$want" ]; then
		pass 'the record keeps that argv as boss_argv'
	else
		fail 'the record'"'"'s boss_argv is not the argv that was opened' "$(cat "$(record "$1")")"
	fi
	if [ "$(tab_argv "$(record "$1")")" = "$want" ]; then
		pass 'the record keeps it on the Boss tab too'
	else
		fail 'the recorded Boss tab does not carry the opened argv' "$(cat "$(record "$1")")"
	fi
	if printf '%s\n' "$(herdr)" | grep -qE '"pi"|pisandbox|pi-sandboxed'; then
		fail 'a stale interpreter or sandbox wrapper reached the app' "$(herdr)"
	else
		pass 'no stale interpreter and no sandbox in the opened argv'
	fi
}

PROJ="$WORK/proj"
mkdir -p "$PROJ"
printf 'x\n' >"$PROJ/a.txt"
OLD=$(mk_session --proj-old-- 2026-01-01T00-00-00Z_a.jsonl "$PROJ" 1767225600)
NEW=$(mk_session --proj-new-- 2026-03-01T00-00-00Z_b.jsonl "$PROJ" 1772323200)
mk_session --proj-elsewhere-- 2026-04-01T00-00-00Z_c.jsonl "$WORK/elsewhere" 1775001600 >/dev/null

# ------------------------------------------- an entry from before the bare-Boss rule: ["pi"] --
new_case 'an entry carrying ["pi"] opens this tree'"'"'s pi-bare'
make_record pi pi "$PROJ" sp-pi
park_space pi pi sp-pi
park_entry t-pi sp-pi "$OLD" "$PROJ" '["pi"]'
clear_log
run "$GUARD" --once --space pi
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
expect_bare pi "$NEW"

# --------------------------------------------------------------- an entry carrying a sandbox --
new_case 'an entry carrying a sandbox wrapper opens the same bare argv'
make_record sand sand "$PROJ" sp-sand
park_space sand sand sp-sand
park_entry t-sand sp-sand "$OLD" "$PROJ" '["/x/pisandbox","--","pi"]'
clear_log
run "$GUARD" --once --space sand
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
expect_bare sand "$NEW"

# ------------------------------------------------- a flag in a dead entry is not carried over --
new_case 'a flag in a dead entry is not carried over'
make_record flag flag "$PROJ" sp-flag
park_space flag flag sp-flag
park_entry t-flag sp-flag "$OLD" "$PROJ" '["pi","--thinking","high"]'
clear_log
run "$GUARD" --once --space flag
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
expect_bare flag "$NEW"
if printf '%s\n' "$(herdr)" | grep -qF -- '--thinking'; then
	fail 'the entry'"'"'s --thinking survived into the opened argv' "$(herdr)"
else
	pass 'the entry'"'"'s --thinking is dropped: a flag from an entry is the same stale trust'
fi

# ------------------------------------------------------- one --session, even from an entry --
new_case 'an entry that already carried --session still yields exactly one'
make_record ses ses "$PROJ" sp-ses
park_space ses ses sp-ses
park_entry t-ses sp-ses "$OLD" "$PROJ" '["pi","--session","'"$OLD"'"]'
clear_log
run "$GUARD" --once --space ses
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
expect_bare ses "$NEW"
if [ "$(opened_argv ses | grep -o -- '--session' | wc -l)" -eq 1 ]; then
	pass 'exactly one --session in the opened argv'
else
	fail 'the opened argv carries two --session flags' "$(herdr)"
fi
# The same, when the record itself is the one carrying the old session.
new_case 'a record that already carried --session still yields exactly one'
make_record sesrec sesrec "$PROJ" sp-sesrec \
	"{\"boss_argv\":[\"$BARE\",\"--session\",\"$OLD\"],\"tabs\":[{\"name\":\"Boss\",\"folder\":\"$PROJ\",\"argv\":[\"$BARE\",\"--session\",\"$OLD\"]}]}"
park_space sesrec sesrec sp-sesrec
clear_log
run "$GUARD" --once --space sesrec
if [ "$RC" -eq 0 ]; then pass 'the pass exits 0'; else fail 'the pass failed' "$OUT"; fi
expect_bare sesrec "$NEW"
if [ "$(opened_argv sesrec | grep -o -- '--session' | wc -l)" -eq 1 ]; then
	pass 'exactly one --session in the opened argv'
else
	fail 'the opened argv carries two --session flags' "$(herdr)"
fi

printf '\n%s: %d passed, %d failed\n' "${0##*/}" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
