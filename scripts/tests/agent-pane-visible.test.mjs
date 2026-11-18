// Tests for `agent-pane.sh spawn … --visible --sandbox` — the learner's launch.
//
// The behaviour under test is the shape of the launch, not its prose:
//   1. a visible worker gets its own herdr space and tab, made by the host;
//   2. the pi inside it is started through scripts/pisandbox, with the working
//      directory read-write — the host creates the space, the sandbox runs work;
//   3. the person is put back on the space and tab they were reading, by id, and
//      the worker stays visible in `list` regardless — nothing is hidden to get
//      the view back;
//   4. a machine that cannot make a space fails loudly instead of starting a
//      hidden worker nobody can see or stop.
//
// Every case runs the real script against stub `herdr-app` and `hc` binaries that
// record what they were asked to do, so the assertions read the actual calls.
// Nothing here touches herdr, pi, or the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts", "agent-pane.sh");
const PISANDBOX = join(ROOT, "scripts", "pisandbox");

const tmp = mkdtempSync(join(tmpdir(), "agent-pane-visible-"));

let caseId = 0;

/**
 * A stub host: `herdr-app` and `hc` record their argv, and `herdr-app` answers
 * space.new with the JSON the real app prints. `spaceNew` decides how it answers.
 *
 * `status` is what the window says the person is looking at: "s1" and "t1" unless
 * a case asks for something else, which is deliberately not the space space.new
 * makes ("s9") — a restore that selects the new space would be a hardcoded answer,
 * not the person's.
 */
function fixture({ spaceNew = "ok", hc = true, herdrApp = true, status = "ok", restores = true } = {}) {
	const dir = join(tmp, `case-${++caseId}`);
	const bin = join(dir, "bin");
	const work = join(dir, "work");
	mkdirSync(bin, { recursive: true });
	mkdirSync(work, { recursive: true });
	const record = join(dir, "calls.jsonl");
	const spec = join(dir, "learn-1200.md");
	writeFileSync(spec, "# learner\n");

	if (herdrApp) {
		const app = join(bin, "herdr-app");
		writeFileSync(
			app,
			`#!/usr/bin/env bash
printf '{"bin":"herdr-app","argv":%s}\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@")" >> "${record}"
if [ "$1" = "status" ]; then
	case "${status}" in
		ok) printf '{"space":"s1","tab":"t1","focused_pane":"p1"}\\n' ;;
		broken) echo "herdr-app: the window is not reachable" >&2; exit 1 ;;
		esac
	exit 0
fi
case "$1:$2" in
	do:space.select|do:tab.select) [ "${restores ? 1 : 0}" = 1 ] || exit 4; printf '{}\\n'; exit 0 ;;
esac
case "${spaceNew}" in
	ok) printf '{"space":"s9","tab":"t2","terminal":"t14z"}\\n' ;;
	empty) printf '{}\\n' ;;
	*) echo "space.new failed: no such folder" >&2; exit 3 ;;
esac
`,
		);
		chmodSync(app, 0o755);
	}

	if (hc) {
		const stub = join(bin, "hc");
		writeFileSync(
			stub,
			`#!/usr/bin/env bash
printf '{"bin":"hc","argv":%s}\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@")" >> "${record}"
case "$1" in
	read) printf 'escape interrupt   /commands\\n' ;;
	ls) printf '{"terminals":[{"address":"t14z","status":"running","where":"agents"}]}\\n' ;;
	send|kill|rm) printf '{}\\n' ;;
	*) printf '{"address":"t14z"}\\n' ;;
esac
`,
		);
		chmodSync(stub, 0o755);
	}

	// With no stub and no herdr-app: a PATH without the host's ~/.local/bin, so the
	// case tests the refusal and not whatever this machine happens to have installed.
	const basePath = herdrApp ? process.env.PATH : ["/usr/local/bin", "/usr/bin", "/bin"].join(":");
	const run = (args, extraEnv = {}) =>
		spawnSync("bash", [SCRIPT, ...args], {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${basePath}`,
				STATE: join(dir, "panes.json"),
				PISANDBOX,
				...extraEnv,
			},
		});

	const calls = () =>
		existsSync(record)
			? readFileSync(record, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];

	return { dir, work, spec, run, calls, state: join(dir, "panes.json") };
}

test("a visible worker gets its own space, tab and terminal", () => {
	const f = fixture();
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);

	const report = JSON.parse(r.stdout.trim().split("\n").pop());
	assert.equal(report.terminal, "t14z");
	assert.equal(report.space, "s9");
	assert.equal(report.hidden, false, "it must be findable in the agents pane");
	assert.equal(report.sandboxed, true);

	const newSpace = f.calls().find((call) => call.argv.includes("space.new"));
	assert.ok(newSpace, "space.new is what makes it visible");
	assert.deepEqual(newSpace.argv.slice(0, 2), ["do", "space.new"]);
	assert.ok(newSpace.argv.includes("--name") && newSpace.argv.includes("learn-1200"));
	assert.ok(newSpace.argv.includes("--tab"), "a space with no tab shows an empty pane");
	const folder = newSpace.argv[newSpace.argv.indexOf("--folder") + 1];
	assert.equal(folder, f.work, "the worker starts in the cwd it was given");

	// The state file is what `list`, `show` and `close` read: the space has to be there.
	const state = JSON.parse(readFileSync(f.state, "utf8"));
	assert.equal(state["learn-1200"].space, "s9");
	assert.equal(state["learn-1200"].hidden, false);
	assert.equal(state["learn-1200"].sandboxed, true);
});

test("the pi inside the space is started through the sandbox, with the cwd writable", () => {
	const f = fixture();
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);

	const newSpace = f.calls().find((call) => call.argv.includes("space.new"));
	const argv = JSON.parse(newSpace.argv[newSpace.argv.indexOf("--argv") + 1]);
	assert.equal(argv[0], "sh");
	const line = argv[2];
	assert.match(line, /exec .*scripts\/pisandbox/, "the runner is the sandbox, not bare pi");
	assert.match(line, / --rw \S+ -- /, "the directory it works in is read-write");
	assert.ok(line.includes(`--rw ${f.work} --`), "and it is the directory the worker was given");
	assert.match(line, / -- \S*pi -a$/, "pi runs inside the sandbox, attached in the space");

	// Not the hidden path: a space and a terminal are the evidence, and `hc run --bg`
	// would have made a terminal nobody can see.
	assert.equal(
		f.calls().some((call) => call.bin === "hc" && call.argv.includes("run")),
		false,
		"a visible worker is not started with hc run",
	);
	const sent = f.calls().find((call) => call.bin === "hc" && call.argv[0] === "send");
	assert.ok(sent, "the spec is sent once the banner is up");
	assert.match(sent.argv.at(-1), /^Read .*learn-1200\.md and do it$/);
});

test("the markers that stop a learner starting a learner survive into the space", () => {
	const f = fixture();
	const r = f.run([
		"spawn",
		"learn-1200",
		f.spec,
		"--cwd",
		f.work,
		"--visible",
		"--sandbox",
		"--env",
		"PI_SELF_LEARN=1",
	]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	const newSpace = f.calls().find((call) => call.argv.includes("space.new"));
	const argv = JSON.parse(newSpace.argv[newSpace.argv.indexOf("--argv") + 1]);
	assert.match(argv[2], /export PI_SELF_LEARN=1/, "herdr starts the space from its own env, so it is passed on");
});

test("space.new that makes no space is a failure, not a worker", () => {
	const f = fixture({ spaceNew: "empty" });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.notEqual(r.status, 0, "exit 0 without a space is the bug this refuses");
	assert.match(r.stderr, /space\.new made no space/);
	assert.equal(r.stdout.trim(), "", "nothing that looks like a spawn report");
});

test("space.new that fails says so and changes nothing", () => {
	const f = fixture({ spaceNew: "boom" });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /space\.new failed for learn-1200/);
	assert.match(r.stderr, /no such folder/, "the app's own words, not a summary of them");
});

test("no herdr-app means a loud refusal, not a hidden worker", () => {
	// A sandbox cannot see herdr-app: its own core would make a terminal nobody can
	// reach, which is the silent half-launch this refuses.
	const f = fixture({ herdrApp: false });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /herdr-app not found in PATH/);
	assert.equal(f.calls().length, 0, "nothing was started");
});

test("spawn puts the person back on the space and tab they were reading", () => {
	// space.new always shows the new space, so a visible spawn moves the view. The
	// worker belongs in the agents pane; the person belongs where they were.
	const f = fixture();
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.equal(r.stderr.trim(), "", "a restore that works says nothing");

	const calls = f.calls();
	const at = (name) => calls.findIndex((call) => call.bin === "herdr-app" && call.argv.includes(name));
	const newSpace = at("space.new");
	const selected = calls.filter((call) => call.bin === "herdr-app" && call.argv.includes("space.select"));
	const tabSelected = calls.filter((call) => call.bin === "herdr-app" && call.argv.includes("tab.select"));

	assert.equal(selected.length, 1, "one space is selected again, not zero and not the new one");
	assert.deepEqual(selected[0].argv, ["do", "space.select", "--id", "s1"], "the space that was on screen before");
	assert.deepEqual(tabSelected[0].argv, ["do", "tab.select", "--id", "t1"], "and its tab");
	assert.ok(at("space.select") > newSpace, "after space.new, not before it");
	assert.ok(
		calls.some((call) => call.argv.includes("status")),
		"the view is read from the window, so the restore is never a hardcoded space",
	);
	assert.ok(
		!selected.some((call) => call.argv.includes("s9")),
		"selecting the new space would be the bug, not the fix",
	);
});

test("--no-restore leaves the new space in front", () => {
	const f = fixture();
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox", "--no-restore"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.equal(
		f.calls().some((call) => call.argv.includes("space.select") || call.argv.includes("tab.select")),
		false,
		"the old behaviour, for watching the worker appear",
	);
});

test("a window that cannot be read warns and still starts the worker", () => {
	// A view that cannot be read must not cost a worker: the spawn stands, one line
	// says where the person's view stayed.
	const f = fixture({ status: "broken" });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /could not read the space on screen before the spawn, so focus stayed on space s9/);
	assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).space, "s9", "the worker exists anyway");
});

test("a restore that fails is a warning, not a failed spawn", () => {
	const f = fixture({ restores: false });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /could not restore focus to space s1, so focus stayed on space s9/);
	assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).terminal, "t14z");
});

test("list shows a visible worker's space, not 'hidden'", () => {
	// The nothing-is-hidden property: a space a person cannot find is the bug this
	// whole path replaced. Getting the view back must not make the worker look hidden.
	const f = fixture();
	assert.equal(f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]).status, 0);
	const r = f.run(["list"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stdout, /learn-1200\s+t14z/);
	assert.match(r.stdout, /space s9/, "the space is named, so it can be watched and closed");
	assert.doesNotMatch(r.stdout, /hidden/);
});

test("a working directory with a space in it is still one argument", () => {
	// `%q` quoting: the launch line is handed to a shell, so an unquoted path would
	// split into two words and start pi in the wrong place.
	const f = fixture();
	const spaced = join(f.dir, "work dir");
	mkdirSync(spaced, { recursive: true });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", spaced, "--visible", "--sandbox"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	const newSpace = f.calls().find((call) => call.argv.includes("space.new"));
	const argv = JSON.parse(newSpace.argv[newSpace.argv.indexOf("--argv") + 1]);
	assert.ok(argv[2].includes(spaced.replace(/ /g, "\\ ")), `quoted: ${argv[2]}`);
});

test("closing a visible worker closes its space too", () => {
	const f = fixture();
	assert.equal(f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]).status, 0);
	const r = f.run(["close", "learn-1200"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	const calls = f.calls();
	assert.ok(
		calls.some((call) => call.bin === "herdr-app" && call.argv.includes("space.close")),
		"the space it made is closed, not left as an empty tab",
	);
	assert.ok(calls.some((call) => call.bin === "hc" && call.argv[0] === "kill"));
	assert.equal(existsSync(f.state) && JSON.parse(readFileSync(f.state, "utf8"))["learn-1200"], undefined);
});

test("a worker with no herdr-app in reach can still be closed", () => {
	// The learner is sandboxed: it cannot see herdr-app, and its own `close` must not
	// die on the way out. Best effort, exit 0.
	const f = fixture();
	assert.equal(f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]).status, 0);
	const r = f.run(["close", "learn-1200"], { PATH: `${join(f.dir, "no-bin")}:${process.env.PATH}` });
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});
