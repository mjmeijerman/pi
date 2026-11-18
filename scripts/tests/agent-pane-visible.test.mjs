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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts", "agent-pane.sh");
const PISANDBOX = join(ROOT, "scripts", "pisandbox");

const tmp = mkdtempSync(join(tmpdir(), "agent-pane-visible-"));

// Nothing here may reach the host's herdr. A fixture that falls through to the real
// herdr-app makes a real space: five learn-1200 spaces appeared on this host from a
// test run that only meant to prove the app was missing. Every directory that holds a
// real herdr-app or hc is dropped from the PATH the fixtures get, and the last test
// in this file fails if one comes back.
const HOST_BINS = ["herdr-app", "hc"];
const SAFE_PATH = (process.env.PATH ?? "")
	.split(":")
	.filter((dir) => dir && !HOST_BINS.some((bin) => existsSync(join(dir, bin))))
	.join(":");

// What a real space says when its pi cannot start: pi-sandbox.sh's own error line.
const BANNERLESS = "pi-sandbox.sh: error: pi is not on PATH (looked for an executable named 'pi')";

let caseId = 0;

/**
 * A stub host: `herdr-app` and `hc` record their argv, and `herdr-app` answers
 * space.new with the JSON the real app prints. `spaceNew` decides how it answers.
 */
function fixture({ spaceNew = "ok", hc = true, herdrApp = true, banner = true } = {}) {
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
		const bannerStub = banner
			? "printf 'escape interrupt   /commands\\n'"
			: `printf '%s\\n' "${BANNERLESS}" >&2; exit 1`;
		writeFileSync(
			stub,
			`#!/usr/bin/env bash
printf '{"bin":"hc","argv":%s}\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@")" >> "${record}"
case "$1" in
	read) ${bannerStub} ;;
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
				PATH: `${bin}:${SAFE_PATH}`,
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

	return { dir, bin, work, spec, run, calls, state: join(dir, "panes.json") };
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
	assert.match(line, / -- -a$/, "only pi's own arguments follow --, so pi gets no binary path as a message");

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
	const r = f.run(["close", "learn-1200"], { PATH: `${join(f.dir, "no-bin")}:${SAFE_PATH}` });
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});

test("a runner line whose PATH has no pi directory still finds pi", () => {
	// The bug this pins: herdr starts the space from the app's own environment, whose
	// PATH has no ~/.local/share/pnpm/bin, so pi-sandbox.sh's `command -v pi` died and
	// the space sat there with nothing in it. Run the built line for real, with the pi
	// outside the host PATH, and read what the sandbox wrapper was handed.
	const f = fixture();
	const piBinDir = join(f.dir, "pi-stub", "bin");
	mkdirSync(piBinDir, { recursive: true });
	const piStub = join(piBinDir, "pi");
	writeFileSync(piStub, "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(piStub, 0o755);

	const sandboxStub = join(f.dir, "record-pisandbox");
	const record = join(f.dir, "sandbox-call.txt");
	writeFileSync(
		sandboxStub,
		`#!/usr/bin/env bash
{ printf 'path=%s\\n' "$PATH"; printf 'argv=%s\\n' "$*"; } > "${record}"
`,
	);
	chmodSync(sandboxStub, 0o755);

	// A PATH shaped like herdr's: node and bash, a pi nowhere on it.
	const herdrPath = `${f.bin}:${f.dir}/no-bin:/usr/bin:/bin`;
	const out = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"], {
		PISANDBOX: sandboxStub,
		PI_BIN: piStub,
		PATH: herdrPath,
	});
	assert.equal(out.status, 0, `stderr: ${out.stderr}`);
	const newSpace = f.calls().find((call) => call.argv.includes("space.new"));
	const line = JSON.parse(newSpace.argv[newSpace.argv.indexOf("--argv") + 1])[2];

	const ran = spawnSync("bash", ["-c", line], {
		encoding: "utf8",
		env: { HOME: process.env.HOME, PATH: herdrPath },
	});
	assert.equal(ran.status, 0, `the runner line has to start: ${ran.stderr}`);
	const call = readFileSync(record, "utf8");
	const path = call.match(/^path=(.*)$/m)[1];
	const args = call.match(/^argv=(.*)$/m)[1];
	assert.equal(path.split(":")[0], piBinDir, "the binary's own directory goes first on the PATH the sandbox sees");
	assert.equal(args, `--rw ${f.work} -- -a`, "the wrapper gets pi's arguments, not a second copy of the binary");
	const found = spawnSync("bash", ["-c", "command -v pi"], { encoding: "utf8", env: { PATH: path } });
	assert.equal(found.stdout.trim(), piStub, "so `command -v pi` — the check that used to die — finds it");
});

test("a space whose pi never starts is closed, and the spawn fails", () => {
	const f = fixture({ banner: false });
	const r = f.run(["spawn", "learn-1200", f.spec, "--cwd", f.work, "--visible", "--sandbox"], {
		PI_PANE_BANNER_TRIES: "1",
		PI_PANE_BANNER_PAUSE: "0",
	});
	assert.notEqual(r.status, 0, "a space with no pi in it is not a worker");
	assert.equal(r.stdout.trim(), "", "nothing that looks like a spawn report");
	assert.match(r.stderr, /pi did not start in t14z/);
	assert.match(r.stderr, /pi-sandbox\.sh: error: pi is not on PATH/, "the terminal's own first error line, not a summary");
	const calls = f.calls();
	const closed = calls.find((call) => call.bin === "herdr-app" && call.argv.includes("space.close"));
	assert.ok(closed, "the space it made is closed, not left behind as an empty tab");
	assert.equal(closed.argv[closed.argv.indexOf("--id") + 1], "s9", "the space that was just made");
	assert.ok(calls.some((call) => call.bin === "hc" && call.argv[0] === "kill"), "and the terminal goes with it");
	const state = existsSync(f.state) ? JSON.parse(readFileSync(f.state, "utf8")) : {};
	assert.equal(state["learn-1200"], undefined, "no state entry for a worker that never started");
});

test("the fixture PATH cannot reach the real herdr on this host", () => {
	// This fails the day a host puts herdr-app or hc on a PATH the fixtures keep: from
	// then on a single test can make a real space, and five leaked learn-1200 spaces is
	// what that looked like.
	for (const bin of HOST_BINS) {
		const found = spawnSync("bash", ["-c", `command -v ${bin} || true`], { encoding: "utf8", env: { PATH: SAFE_PATH } });
		assert.equal(
			found.stdout.trim(),
			"",
			`${bin} is reachable from the test PATH (${found.stdout.trim()}); a fixture could spawn a real space`,
		);
	}
});
