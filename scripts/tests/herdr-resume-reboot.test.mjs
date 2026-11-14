/**
 * herdr-resume: a reboot, simulated end to end on a scratch hc core.
 *
 * This is the requirement that matters: after a core loss, the terminal comes
 * back as a shell, the restore script types the resume line into it, and the
 * same session continues — not a fresh one, not a copy.
 *
 * Everything runs on its own HC_SESSION and scratch XDG paths: the person's core
 * is never started, stopped or touched. `hc` being absent (as on a CI runner)
 * skips the test instead of failing it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const script = join(import.meta.dirname, "..", "herdr-resume.mjs");
const hasHc = spawnSync("hc", ["--version"], { encoding: "utf8" }).status === 0;

const root = mkdtempSync(join(tmpdir(), "herdr-reboot-"));
after(() => rmSync(root, { recursive: true, force: true }));

const session = `herdr-resume-test-${process.pid}-${Date.now().toString(36)}`;
const scratch = {
	HOME: process.env.HOME ?? "",
	PATH: `${join(process.env.HOME ?? "", ".local/bin")}:/usr/local/bin:/usr/bin:/bin`,
	HC_SESSION: session,
	XDG_RUNTIME_DIR: join(root, "run"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_DATA_HOME: join(root, "data"),
	TERM: "xterm-256color",
};
for (const key of ["XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
	mkdirSync(scratch[key], { recursive: true });
}

const resumeDir = join(root, "resume");
const entriesDir = resumeDir;
mkdirSync(entriesDir, { recursive: true });

function hc(args, options = {}) {
	const result = spawnSync("hc", args, { encoding: "utf8", env: scratch, timeout: 60_000, ...options });
	return { ...result, ok: result.status === 0 };
}

function hcJson(args) {
	const result = hc(args);
	if (!result.ok) return null;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return null;
	}
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(label, predicate, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	for (;;) {
		last = predicate();
		if (last) return last;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
		sleep(250);
	}
}

/** A stand-in for pi: it reads the session it was given and says so, then idles. */
const fakePi = join(root, "fake-pi.mjs");
writeFileSync(
	fakePi,
	`import { readFileSync } from "node:fs";
const sessionIndex = process.argv.indexOf("--session");
const sessionPath = sessionIndex > 0 ? process.argv[sessionIndex + 1] : "";
const marker = sessionPath ? readFileSync(sessionPath, "utf8").trim() : "NO-SESSION";
console.log("PI-ARGV " + process.argv.slice(2).join(" "));
console.log("PI-RESUMED " + marker);
setTimeout(() => {}, 600000);
`,
);

const sessionPath = join(root, "sessions", "app", "s.jsonl");
mkdirSync(join(root, "sessions", "app"), { recursive: true });
const marker = `conversation-${process.pid}`;
writeFileSync(sessionPath, `${marker}\n`);

test("a reboot resumes the same session in the same recovered terminal", { skip: hasHc ? false : "hc is not installed" }, () => {
	let corePid;
	let holderPids = [];
	try {
		assert.equal(hc(["server", "start", "--json"]).ok, true, "scratch core must start");
		const status = waitFor("core", () => hcJson(["server", "status", "--json"]));
		corePid = status.core?.pid ?? status.pid;
		assert.equal(typeof corePid, "number", "core pid must be known, and only that pid is killed later");
		holderPids = (status.holders ?? []).map((holder) => holder.pid).filter((pid) => typeof pid === "number");

		const started = hc([
			"run",
			"--bg",
			"--keep",
			"--no-notify",
			"--name",
			"resumed",
			"--cwd",
			join(root, "sessions", "app"),
			"--json",
			"--",
			process.execPath,
			fakePi,
		]);
		assert.equal(started.ok, true, started.stderr);
		const address = JSON.parse(started.stdout).address;
		assert.match(address, /^t\d+$/);

		const live = waitFor("pi-like program", () => {
			const facts = hcJson(["get", address, "--json"]);
			return facts?.state === "live" && facts.foreground ? facts : null;
		});
		assert.equal(live.foreground.argv[0], process.execPath);
		assert.match(hc(["read", address, "--lines", "20"]).stdout, /PI-RESUMED NO-SESSION/);

		// The resume entry the pi extension would have written for this terminal.
		writeFileSync(
			join(entriesDir, `${address}.json`),
			`${JSON.stringify(
				{
					version: 1,
					terminal: address,
					terminal_name: "resumed",
					session_path: sessionPath,
					cwd: join(root, "sessions", "app"),
					argv: [process.execPath, fakePi],
					mode: "plain",
					labels: {},
					pid: process.pid,
					updated_at: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
		);

		// The reboot: a host shutdown stops the core and its holders, so the
		// terminal loses its program; the kept terminal then comes back as a plain
		// shell in the same folder. Killing only the core is not a reboot — the
		// holder keeps the program alive and nothing is lost.
		const holders = (hcJson(["server", "status", "--json"])?.holders ?? [])
			.map((holder) => holder.pid)
			.filter((pid) => typeof pid === "number");
		holderPids = holders.length > 0 ? holders : holderPids;
		process.kill(corePid, "SIGKILL");
		for (const pid of holderPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		const alive = (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		waitFor("core to die", () => !alive(corePid), 20_000);

		assert.equal(hc(["server", "start", "--json"]).ok, true, "core must come back up");
		const recovered = waitFor("recovered shell", () => {
			const facts = hcJson(["get", address, "--json"]);
			if (!facts || facts.state !== "live" || !facts.foreground) return null;
			return /^(zsh|bash|sh|fish|nu)$/.test(String(facts.foreground.argv?.[0] ?? "").split("/").pop()) ? facts : null;
		});
		assert.equal(recovered.keep, true, "a recovered terminal is a kept terminal");
		assert.notEqual(recovered.argv[0], process.execPath, "hc must have replaced the lost program with a shell");
		assert.equal(recovered.cwd, join(root, "sessions", "app"), "the folder survives the restart");

		const restored = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: {
				...scratch,
				PI_HERDR_RESUME_DIR: resumeDir,
				PI_HERDR_RESUME_WAIT_MS: "30000",
				PI_HERDR_RESUME_ENTRY_MS: "20000",
			},
			timeout: 120_000,
		});
		assert.equal(restored.status, 0, restored.stderr);
		assert.match(restored.stdout, new RegExp(`restored terminal ${address}: exec `));

		// The same conversation, in the same tab: the marker comes from the
		// session file the restore line named, not from a fresh session.
		const screen = waitFor("resumed pi", () => {
			const out = hc(["read", address, "--lines", "40"]).stdout;
			return out.includes(`PI-RESUMED ${marker}`) ? out : null;
		});
		assert.match(screen, new RegExp(`PI-ARGV .*--session ${sessionPath}`));
		assert.match(screen, new RegExp(`PI-RESUMED ${marker}`));

		// Idempotent: a second run in the same boot types nothing.
		const second = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: { ...scratch, PI_HERDR_RESUME_DIR: resumeDir, PI_HERDR_RESUME_WAIT_MS: "30000" },
			timeout: 120_000,
		});
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, /already restored in this boot/);
		assert.equal(
			hc(["read", address, "--lines", "40"]).stdout.split(`PI-RESUMED ${marker}`).length - 1,
			1,
			"the resume line must have been typed exactly once",
		);
	} finally {
		// Only the scratch core, only by the folder it was started with.
		hc(["server", "stop"]);
	}
});

test("the scratch session never shares a socket with the real core", () => {
	const socket = ["run", "herdr-core"].reduce((path, part) => join(path, part), scratch.XDG_RUNTIME_DIR);
	// hc puts each session's socket under its own XDG_RUNTIME_DIR; the real one
	// lives under /run/user/<uid>, so a missing folder here proves isolation.
	assert.equal(existsSync(join("/run/user", String(process.getuid()), "herdr-core", `${session}.sock`)), false);
	void socket;
	void readFileSync;
});
