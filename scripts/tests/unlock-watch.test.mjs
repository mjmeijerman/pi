/**
 * unlock-watch: what happens when the volume the space lives on is not there yet.
 *
 * Measured 2026-11-26: `D:/` comes back BitLocker-locked at logon, so the `backupdrive` space is
 * skipped as "project folder is gone" and the Boss tab stays an empty shell until somebody types
 * two commands. `scripts/unlock-watch.mjs` waits for a file on the volume and then runs those two
 * commands — `bin/guard --once --space <slug>` and `scripts/herdr-resume.mjs`. Pinned here: it does
 * the restore exactly once and says so in one line; a second run with pi already live does
 * nothing; and while the marker is unreadable it asks for no restore at all.
 *
 * Both programs are stubs, and that is deliberate: the guard is asked with the argv a stub wrote
 * down, and the sweep answers in `scripts/herdr-resume.mjs`'s own line format (`restored …`,
 * `skip …`) so the one line under test is the one the watcher writes. The sweep stub records a
 * `send` only in its restore answer — a `send` is the paste into a terminal, which is the thing
 * this whole feature must never do before the volume is readable. The real `herdr-resume.mjs` is
 * what the watcher runs when nothing overrides it, and the last test runs exactly that, on an empty
 * entries folder, so "the real sweep is called" is a fact and not a reading of the source.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const here = import.meta.dirname;
const script = join(here, "..", "unlock-watch.mjs");
const realResume = join(here, "..", "herdr-resume.mjs");
const slug = "backupdrive";

const root = mkdtempSync(join(tmpdir(), "unlock-watch-"));
const binDir = join(root, "bin");
const volume = join(root, "volume");
const entriesDir = join(root, "entries");
const marker = join(volume, "AGENTS.md");
const sweepLog = join(root, "sweep-calls.json");
const guardLog = join(root, "guard-calls.log");
const logFile = join(root, "unlock-watch.log");
const guardStub = join(binDir, "guard");
const sweepStub = join(binDir, "herdr-resume.mjs");

mkdirSync(binDir, { recursive: true });
mkdirSync(entriesDir, { recursive: true });
mkdirSync(volume, { recursive: true });

/** Stub bin/guard: the watcher runs it through bash, so it is a script and not a node program. */
writeFileSync(
	guardStub,
	`#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_GUARD_LOG"
printf 'backupdrive: Boss tab resumed from a stub\\n'
`,
);
chmodSync(guardStub, 0o755);

/**
 * Stub `scripts/herdr-resume.mjs`: answers in the real script's line format and records the paste
 * it would have made. `FAKE_SWEEP_MODE` decides which answer: `restore` is a recovered shell, `live`
 * is the same terminal with pi already in it (the real script's "pi never gets a second paste" rule).
 */
writeFileSync(
	sweepStub,
	`import { existsSync, readFileSync, writeFileSync } from "node:fs";
const calls = existsSync(process.env.FAKE_SWEEP_LOG) ? JSON.parse(readFileSync(process.env.FAKE_SWEEP_LOG, "utf8")) : [];
const mode = process.env.FAKE_SWEEP_MODE || "restore";
calls.push({ argv: process.argv.slice(2), mode, at: Date.now() });
if (mode === "restore") calls.push({ send: "t13", line: "exec pi-bare --session /x.jsonl" });
writeFileSync(process.env.FAKE_SWEEP_LOG, JSON.stringify(calls));
const stamp = new Date().toISOString();
if (mode === "restore") process.stdout.write(stamp + " restored terminal t13 (Boss): exec pi-bare --session /x.jsonl\\n");
else {
	process.stdout.write(stamp + " skip terminal t13 (Boss): terminal is busy (pi --session /x.jsonl)\\n");
	process.stdout.write(stamp + " nothing restored: every entry was skipped\\n");
}
`,
);

/**
 * Start the watcher, and for the case that models a locked volume being unlocked, make the marker
 * readable after `flipAfterMs`. Returns the exit code and everything it printed.
 */
function watch({ args = [], env = {}, flipAfterMs = 0, resume = sweepStub } = {}) {
	return new Promise((resolve) => {
		let stdout = "";
		const child = spawn(
			process.execPath,
			[script, "--space", slug, "--project", volume, "--guard", guardStub, "--resume", resume, "--log", logFile, ...args],
			{
				env: {
					...process.env,
					PI_SPACE_ROOT: root,
					PI_HERDR_RESUME_DIR: entriesDir,
					FAKE_SWEEP_LOG: sweepLog,
					FAKE_GUARD_LOG: guardLog,
					...env,
				},
			},
		);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stdout += chunk;
		});
		if (flipAfterMs > 0) {
			const flip = setTimeout(() => {
				rmSync(marker, { recursive: true, force: true });
				writeFileSync(marker, "the volume is readable now\n");
			}, flipAfterMs);
			child.on("exit", () => clearTimeout(flip));
		}
		child.on("exit", (code) => resolve({ code, stdout }));
	});
}

function sweeps() {
	return existsSync(sweepLog) ? JSON.parse(readFileSync(sweepLog, "utf8")) : [];
}

/** Every paste the sweep would have made. One before the volume is readable is the bug. */
function sends() {
	return sweeps().filter((call) => call.send);
}

function lines() {
	return existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : [];
}

function guardCalls() {
	return existsSync(guardLog) ? readFileSync(guardLog, "utf8").split("\n").filter(Boolean) : [];
}

after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
	for (const file of [logFile, guardLog, sweepLog]) rmSync(file, { force: true });
	rmSync(marker, { recursive: true, force: true });
	rmSync(entriesDir, { recursive: true, force: true });
	mkdirSync(entriesDir, { recursive: true });
	mkdirSync(volume, { recursive: true });
});

test("a locked volume that becomes readable runs one guard pass, one restore, and says so once", async () => {
	// Locked is modelled as a marker that cannot be read while the folder lists — exactly what a
	// BitLocker volume does to a file that really is there. It flips readable mid-wait.
	mkdirSync(marker);
	const result = await watch({
		args: ["--interval", "50ms", "--patience", "300ms", "--slow-interval", "100ms", "--timeout", "20s"],
		flipAfterMs: 250,
		env: { FAKE_SWEEP_MODE: "restore" },
	});

	assert.equal(result.code, 0);
	assert.equal(sends().length, 1, `exactly one restore, got: ${JSON.stringify(sweeps())}`);
	assert.equal(sweeps().filter((call) => call.argv).length, 1, "the sweep was asked once, not once per poll");
	// The guard pass comes first and is for this one space: the watcher calls the program, it does
	// not repair anything itself.
	assert.deepEqual(guardCalls(), ["--once --space backupdrive"], "one guard pass, for the one space");
	const said = lines();
	assert.equal(said.length, 1, `exactly one line in the log, got ${JSON.stringify(said)}`);
	assert.match(said[0], new RegExp(`${slug}: .*AGENTS\\.md readable after `));
	assert.match(said[0], /guard: 1 action/);
	assert.match(said[0], /resume: restored 1/);
});

test("a second run, with pi already live, does nothing and says so", async () => {
	writeFileSync(marker, "readable\n");
	// pi is in the Boss: the sweep's own rule (a live pi never gets a second paste) is what decides.
	const result = await watch({ args: ["--timeout", "10s"], env: { FAKE_SWEEP_MODE: "live" } });

	assert.equal(result.code, 0);
	assert.deepEqual(sends(), [], "nothing was typed into a live pi");
	assert.deepEqual(guardCalls(), ["--once --space backupdrive"], "the pass is still run — it is what finds pi already there");
	const said = lines();
	assert.equal(said.length, 1, `exactly one line, got ${JSON.stringify(said)}`);
	assert.match(said[0], /resume: nothing to restore, 1 skipped/);
});

test("while the marker is unreadable nothing is sent and the guard is not run", async () => {
	mkdirSync(marker);
	const result = await watch({ args: ["--interval", "50ms", "--timeout", "300ms"], env: { FAKE_SWEEP_MODE: "restore" } });

	assert.equal(result.code, 0);
	assert.deepEqual(sends(), [], "no paste while the volume is unreadable");
	assert.deepEqual(sweeps(), [], "the sweep was not started before the volume was readable");
	assert.deepEqual(guardCalls(), [], "the guard pass waits for the volume, it does not run before it");
	const said = lines();
	assert.equal(said.length, 1, `exactly one line, got ${JSON.stringify(said)}`);
	assert.match(said[0], /still unreadable after .* gave up/);
});

test("a readable folder with no marker is named, not polled for", async () => {
	// The marker name is what is wrong here, not the volume: polling would be a silent hour on a
	// machine whose disk is fine.
	const result = await watch({ args: ["--interval", "50ms", "--timeout", "10s"] });

	assert.equal(result.code, 0);
	assert.deepEqual(sweeps(), []);
	assert.deepEqual(guardCalls(), []);
	const said = lines();
	assert.equal(said.length, 1, `exactly one line, got ${JSON.stringify(said)}`);
	assert.match(said[0], /is readable but .*AGENTS\.md is not a file/);
	assert.match(said[0], /--marker/);
});

test("--once reports the locked volume once and exits instead of waiting", async () => {
	mkdirSync(marker);
	const started = Date.now();
	const result = await watch({ args: ["--once"] });

	assert.equal(result.code, 0);
	assert.ok(Date.now() - started < 10000, "--once did not wait for the volume");
	assert.deepEqual(sweeps(), []);
	assert.equal(lines().length, 1);
	assert.match(lines()[0], /still unreadable — --once asked once/);
});

test("the real scripts/herdr-resume.mjs is what runs when nothing overrides it", async () => {
	// An empty entries folder: the real sweep starts, says there is nothing to restore, and the
	// watcher reports that. Nothing is typed, and no hc core is needed to prove the call is made.
	writeFileSync(marker, "readable\n");
	const result = await watch({ args: ["--timeout", "10s"], resume: realResume });

	assert.equal(result.code, 0, `the real sweep exited non-zero: ${result.stdout}`);
	const said = lines();
	assert.equal(said.length, 1, `exactly one line, got ${JSON.stringify(said)}`);
	assert.match(said[0], /resume: nothing to restore$/);
	assert.deepEqual(guardCalls(), ["--once --space backupdrive"]);
});
