// Tests for `agent-pane.sh spawn … --visible --sandbox` — the learner's launch.
//
// The behaviour under test is the shape of the launch, not its prose:
//   1. a visible worker gets its own herdr space and tab, made by the host;
//   2. the pi inside it is started through scripts/pisandbox, with the working
//      directory read-write — the host creates the space, the sandbox runs work;
//   3. a machine that cannot make a space fails loudly instead of starting a
//      hidden worker nobody can see or stop.
//
// Every case runs the real script against stub `herdr-app` and `hc` binaries that
// record what they were asked to do, so the assertions read the actual calls.
// Nothing here touches herdr, pi, or the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts", "agent-pane.sh");
const PISANDBOX = join(ROOT, "scripts", "pisandbox");

/**
 * A PATH that holds everything the script needs except the named binary.
 *
 * The sandbox case is "herdr-app is not reachable", and prepending a directory to
 * `$PATH` does not remove the real binary — lookup skips a non-executable file and
 * keeps going. So the path is built from symlinks instead: node, hc and grep, nothing
 * else, and `command -v herdr-app` is then honestly false.
 */
function pathWithout(fixture, missing) {
	const dir = join(fixture.dir, `without-${missing}`);
	mkdirSync(dir, { recursive: true });
	for (const bin of ["bash", "node", "hc", "grep", "cat", "mkdir", "dirname", "env"]) {
		if (bin === missing) continue;
		// `hc` comes from the fixture's own stub: the real one would kill a real terminal.
		const found =
			bin === "hc"
				? join(fixture.dir, "bin", "hc")
				: spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
		if (found) symlinkSync(found, join(dir, bin));
	}
	return dir;
}

const tmp = mkdtempSync(join(tmpdir(), "agent-pane-visible-"));

let caseId = 0;

/**
 * A stub host: `herdr-app` and `hc` record their argv, and `herdr-app` answers
 * space.new with the JSON the real app prints. `spaceNew` decides how it answers.
 */
function fixture({ spaceNew = "ok", spaceClose = "ok", hc = true, herdrApp = true } = {}) {
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
if [ "$1" = do ] && [ "$2" = space.close ]; then
	case "${spaceClose}" in
		ok) printf '{"closed":"s9"}\\n' ;;
		boom) echo 'space.close failed: not talking to a herdr core' >&2; exit 3 ;;
		gone) printf '{"error":"no space \\\\"s9\\\\""}\\n'; exit 1 ;;
	esac
	exit 0
fi
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
	send|kill|rm) printf '{}\\n' ;;
	*) printf '{"address":"t14z"}\\n' ;;
esac
`,
		);
		chmodSync(stub, 0o755);
	}

	const run = (args, extraEnv = {}) =>
		spawnSync("bash", [SCRIPT, ...args], {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
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
	//
	// The PATH is built, not prepended: on a host where the real herdr-app *is* on PATH,
	// `${dir}/bin:${PATH}` still reaches it, and this case then did exactly the thing it
	// refuses — it made a real space named learn-1200 running a real pi in the fixture's
	// temp directory, left it open, and recorded no state to close it by. Two of them
	// were live on 2026-11-18 (`hc ls`: "learn-1200 / learn-1200"), which is what the
	// person meant by "I see 2 learn-1200 spaces still open".
	const f = fixture({ herdrApp: false });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"], {
		PATH: pathWithout(f, "herdr-app"),
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /herdr-app not found in PATH/);
	assert.equal(f.calls().length, 0, "nothing was started, least of all a real space on the host");
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

test("a worker with no herdr-app in reach is stopped, and the space it left is named", () => {
	// A sandboxed learner cannot reach herdr-app, so its own `close` used to delete the
	// entry and print success while the space stayed in the person's window: that is how
	// two `learn-1200` spaces outlived every record of them (2026-11-18). The worker still
	// has to stop — but the entry stays, and the failure is on stderr with the space id.
	const f = fixture();
	assert.equal(f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]).status, 0);
	const r = f.run(["close", "learn-1200"], { PATH: pathWithout(f, "herdr-app") });
	assert.notEqual(r.status, 0, "a close that leaves a space open is not a finished close");
	assert.match(r.stderr, /s9 is still open/, "the space id is the thing the host needs");
	assert.match(r.stderr, /herdr-app is not in PATH/);
	const report = JSON.parse(r.stdout.trim().split("\n").pop());
	assert.equal(report.space_closed, false);
	assert.equal(JSON.parse(readFileSync(f.state, "utf8"))["learn-1200"].space, "s9", "`list` must still find it");
	assert.ok(f.calls().some((call) => call.bin === "hc" && call.argv[0] === "kill"), "the worker itself stops anyway");
});

test("a space.close that fails is reported in the app's words, and the entry survives", () => {
	const f = fixture({ spaceClose: "boom" });
	assert.equal(f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]).status, 0);
	const r = f.run(["close", "learn-1200"]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /space s9 is still open/);
	assert.match(r.stderr, /not talking to a herdr core/, "the app's own words, not a summary of them");
	assert.equal(JSON.parse(readFileSync(f.state, "utf8"))["learn-1200"].space, "s9");
});

test("a space that is already gone is a finished close, not a failure to retry forever", () => {
	const f = fixture({ spaceClose: "gone" });
	assert.equal(f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"]).status, 0);
	const r = f.run(["close", "learn-1200"]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).space_closed, true);
	assert.equal(JSON.parse(readFileSync(f.state, "utf8"))["learn-1200"], undefined);
});
