/**
 * herdr-resume-map: the entry a pi session writes so a reboot can find it again.
 *
 * The real extension module is loaded per scenario (query-string cache bust), the
 * pi platform is the fake, and `hc` is a shell script on PATH that answers with
 * the labels herdr-app puts on a tab. No hc core is touched.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const root = mkdtempSync(join(tmpdir(), "pi-herdr-resume-"));
const home = join(root, "home");
const binDir = join(root, "bin");
const entries = join(home, "herdr-resume-entries");
mkdirSync(home, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(entries, { recursive: true });

/** A terminal with herdr-app's space/tab labels, as `hc get` reports it. */
writeFileSync(
	join(binDir, "hc"),
	`#!/bin/sh
if [ "$1" = get ]; then
	printf '%s\\n' '{"address":"t7","name":"review","scope":"abc","state":"live","labels":{"herdr.space":"big-boss-pi","herdr.tab":"worker"}}'
	exit 0
fi
exit 1
`,
);
chmodSync(join(binDir, "hc"), 0o755);

// Candidate wrappers the launch derivation looks for.
for (const wrapper of ["big-boss-pi/bin/pi-bare", "big-boss-pi/bin/pi-sandboxed", "big-boss-pi/bin/pi-nonet", ".pi/scripts/pisandbox"]) {
	const path = join(home, wrapper);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\n");
	chmodSync(path, 0o755);
}

const ENV_KEYS = [
	"HC_TERMINAL_ID",
	"PI_HERDR_RESUME_DIR",
	"PI_BARE",
	"PI_WORKER",
	"PI_SANDBOX_MODE",
	"PI_SANDBOX_NET",
	"PATH",
	"HOME",
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const savedArgv = process.argv;

let counter = 0;
let terminal = "t7";

beforeEach(() => {
	rmSync(entries, { recursive: true, force: true });
	mkdirSync(entries, { recursive: true });
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PATH = `${binDir}:/usr/bin:/bin`;
	process.env.HOME = home;
	process.env.PI_HERDR_RESUME_DIR = entries;
	terminal = `t${++counter}`;
	process.env.HC_TERMINAL_ID = terminal;
});

afterEach(() => {
	process.argv = savedArgv;
});

after(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	process.chdir(tmpdir());
	rmSync(root, { recursive: true, force: true });
});

async function load() {
	const mod = await import(`${new URL("../herdr-resume-map.ts", import.meta.url).href}?v=${counter}-${Math.random()}`);
	return mod;
}

function ctxFor(sessionPath: string | undefined, overrides: Record<string, any> = {}) {
	return createFakeCtx({
		mode: "tui",
		cwd: "/home/mark/projects/app",
		model: { provider: "anthropic", id: "claude-x" },
		thinkingLevel: "high",
		sessionManager: {
			getSessionFile: () => sessionPath,
			getSessionId: () => "session-1",
		},
		...overrides,
	}).ctx;
}

function onlyEntry() {
	const files = readdirSync(entries).filter((name) => name.endsWith(".json"));
	assert.equal(files.length, 1, `expected exactly one entry, found ${files.join(", ") || "none"}`);
	return JSON.parse(readFileSync(join(entries, files[0]), "utf8"));
}

test("outside hc nothing is written", async () => {
	delete process.env.HC_TERMINAL_ID;
	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);
	const sessionPath = join(root, "sessions", "a.jsonl");
	await fake.emit("session_start", { reason: "startup" }, ctxFor(sessionPath));
	assert.equal(existsSync(entries) && readdirSync(entries).length, 0);
});

test("a sandboxed worker records the wrapper, the flags and the labels", async () => {
	process.env.PI_WORKER = "1";
	process.env.PI_SANDBOX_MODE = "bwrap";
	process.env.PI_SANDBOX_NET = "on";
	const argv = ["/path/to/node", join(root, "fake-pi.mjs"), "--thinking", "high", "-a"];
	writeFileSync(argv[1], "");
	process.argv = argv;

	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);
	const sessionPath = join(root, "sessions", "b.jsonl");
	await fake.emit("session_start", { reason: "startup" }, ctxFor(sessionPath));

	const entry = onlyEntry();
	assert.equal(entry.terminal, terminal);
	assert.equal(entry.session_path, sessionPath);
	assert.equal(entry.session_id, "session-1");
	assert.equal(entry.cwd, "/home/mark/projects/app");
	assert.equal(entry.mode, "sandbox");
	assert.deepEqual(entry.argv, [join(home, "big-boss-pi/bin/pi-sandboxed"), "--thinking", "high", "-a"]);
	assert.equal(entry.wrapper, join(home, "big-boss-pi/bin/pi-sandboxed"));
	assert.equal(entry.model, "claude-x");
	assert.equal(entry.thinking, "high");
	assert.equal(entry.space, "big-boss-pi");
	assert.equal(entry.tab, "worker");
	assert.equal(typeof entry.boot_id, "string");
	assert.equal(entry.version, 1);
});

test("the pi binary is recorded when no wrapper is involved", async () => {
	const argv = ["/path/to/node", join(root, "fake-pi.mjs"), "--thinking", "low"];
	writeFileSync(argv[1], "");
	process.argv = argv;

	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);
	await fake.emit("session_start", { reason: "startup" }, ctxFor(join(root, "sessions", "c.jsonl")));

	const entry = onlyEntry();
	assert.equal(entry.mode, "plain");
	assert.deepEqual(entry.argv, [argv[1], "--thinking", "low"]);
	assert.equal(entry.pi_bin, argv[1]);
});

test("no TUI session and no session file write nothing", async () => {
	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);

	await fake.emit("session_start", { reason: "startup" }, ctxFor(join(root, "sessions", "d.jsonl"), { mode: "print" }));
	await fake.emit("session_start", { reason: "startup" }, ctxFor(join(root, "sessions", "e.jsonl"), { mode: "rpc" }));
	await fake.emit("session_start", { reason: "startup" }, ctxFor(undefined));

	assert.equal(readdirSync(entries).length, 0);
});

test("switching sessions rewrites the one entry for that terminal", async () => {
	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);
	await fake.emit("session_start", { reason: "startup" }, ctxFor(join(root, "sessions", "old.jsonl")));
	const before = onlyEntry();
	assert.equal(before.session_path, join(root, "sessions", "old.jsonl"));

	await fake.emit("session_start", { reason: "resume" }, ctxFor(join(root, "sessions", "new.jsonl")));
	const after = onlyEntry();
	assert.equal(after.session_path, join(root, "sessions", "new.jsonl"));
	assert.equal(readdirSync(entries).filter((name) => name.endsWith(".json")).length, 1);
});

test("an unchanged session is not rewritten on every turn", async () => {
	const argv = ["/path/to/node", join(root, "fake-pi.mjs")];
	writeFileSync(argv[1], "");
	process.argv = argv;

	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);
	const ctx = ctxFor(join(root, "sessions", "same.jsonl"));
	await fake.emit("session_start", { reason: "startup" }, ctx);

	// A rewrite would replace the file; a skipped write leaves this marker alone.
	const file = join(entries, readdirSync(entries)[0]);
	writeFileSync(file, "touched\n");
	await fake.emit("agent_start", {}, ctx);
	await fake.emit("agent_settled", {}, ctx);
	assert.equal(readFileSync(file, "utf8"), "touched\n");
});

test("a session that gains its file later is recorded then", async () => {
	const mod = await load();
	const fake = createFakePi();
	mod.default(fake.pi);
	await fake.emit("session_start", { reason: "new" }, ctxFor(undefined));
	assert.equal(readdirSync(entries).length, 0);

	await fake.emit("agent_start", {}, ctxFor(join(root, "sessions", "late.jsonl")));
	assert.equal(onlyEntry().session_path, join(root, "sessions", "late.jsonl"));
});

test("deriveLaunch keeps the mode honest and never guesses a launch", async () => {
	const mod = await load();
	const exists = (path: string) => existsSync(path);
	const base = { env: {}, argv: ["/path/node", join(root, "fake-pi.mjs"), "-a"], home, exists };
	writeFileSync(join(root, "fake-pi.mjs"), "");

	assert.deepEqual(mod.deriveLaunch(base).argv, [join(root, "fake-pi.mjs"), "-a"]);
	assert.equal(mod.deriveLaunch(base).mode, "plain");

	const bare = mod.deriveLaunch({ ...base, env: { PI_BARE: "1" } });
	assert.equal(bare.mode, "bare");
	assert.deepEqual(bare.argv, [join(root, "fake-pi.mjs"), "-a"]);

	const bareWorker = mod.deriveLaunch({ ...base, env: { PI_BARE: "1", PI_WORKER: "1" } });
	assert.deepEqual(bareWorker.argv, [join(home, "big-boss-pi/bin/pi-bare"), "-a"]);

	const sandbox = mod.deriveLaunch({ ...base, env: { PI_SANDBOX_MODE: "bwrap", PI_SANDBOX_NET: "on" } });
	assert.deepEqual(sandbox.argv, [join(home, ".pi/scripts/pisandbox"), "--", "-a"]);
	assert.equal(sandbox.mode, "sandbox");

	const noNet = mod.deriveLaunch({ ...base, env: { PI_SANDBOX_MODE: "bwrap", PI_SANDBOX_NET: "off" } });
	assert.deepEqual(noNet.argv, [join(home, ".pi/scripts/pisandbox"), "--no-net", "--", "-a"]);
	assert.equal(noNet.mode, "sandbox-nonet");

	const noNetWorker = mod.deriveLaunch({ ...base, env: { PI_SANDBOX_MODE: "bwrap", PI_SANDBOX_NET: "off", PI_WORKER: "1" } });
	assert.deepEqual(noNetWorker.argv, [join(home, "big-boss-pi/bin/pi-nonet"), "-a"]);

	// A sandbox marker with no wrapper on disk is not a licence to run bare.
	const unknown = mod.deriveLaunch({ ...base, env: { PI_SANDBOX_MODE: "bwrap", PI_WORKER: "1" }, exists: () => false });
	assert.equal(unknown.mode, "unknown");
	assert.deepEqual(unknown.argv, []);
});

test("the session flags already on the command line do not survive", async () => {
	const mod = await load();
	const path = join(root, "fake-pi.mjs");
	writeFileSync(path, "");
	const launch = mod.deriveLaunch({
		env: {},
		argv: ["/path/node", path, "-a", "--session", "/tmp/s.jsonl", "--session-id=abc", "-c", "--thinking", "high"],
		home,
		exists: () => true,
	});
	assert.deepEqual(launch.argv, [path, "-a", "--thinking", "high"]);
	assert.deepEqual(mod.withoutSessionArgs(["-r", "--fork", "/tmp/x", "--fork=/tmp/y", "-n", "name"]), ["-n", "name"]);
});

test("shell and label helpers", async () => {
	const mod = await load();
	assert.equal(mod.isShellArgv(["/usr/bin/zsh"]), true);
	assert.equal(mod.isShellArgv(["bash", "-l"]), true);
	assert.equal(mod.isShellArgv(["/home/mark/.local/share/pnpm/bin/pi"]), false);
	assert.equal(mod.isShellArgv([]), false);
	assert.equal(mod.isShellArgv(undefined), false);

	assert.deepEqual(mod.spaceTabOf({ "herdr.space": "s", "herdr.tab": "t" }), { space: "s", tab: "t" });
	assert.deepEqual(mod.spaceTabOf({ space: "s2", tab: "t2" }), { space: "s2", tab: "t2" });
	assert.deepEqual(mod.spaceTabOf({}), {});
	assert.deepEqual(mod.spaceTabOf(undefined), {});

	assert.equal(mod.entryFileName("t7"), "t7.json");
	assert.equal(mod.entryFileName("../../etc/passwd"), ".._.._etc_passwd.json");
	assert.equal(mod.entriesDir({ PI_HERDR_RESUME_DIR: "/tmp/x" }, "/home/h"), "/tmp/x");
	assert.equal(mod.entriesDir({}, "/home/h"), "/home/h/.pi/agent/herdr-resume");
});
