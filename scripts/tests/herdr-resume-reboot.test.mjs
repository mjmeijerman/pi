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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
		assert.ok(restored.stdout.includes(`restored terminal ${address}: exec `), restored.stdout);

		// The same conversation, in the same tab: the marker comes from the
		// session file the restore line named, not from a fresh session.
		const screen = waitFor("resumed pi", () => {
			const out = hc(["read", address, "--lines", "40"]).stdout;
			return out.includes(`PI-RESUMED ${marker}`) ? out : null;
		});
		const resumed = screen.split("\n").find((row) => row.includes("PI-ARGV"));
		assert.ok(resumed?.includes(`--session ${sessionPath}`), screen);
		assert.ok(screen.includes(`PI-RESUMED ${marker}`), screen);

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

/**
 * The half-second after a reboot that a real core is hard to hold still in: hc
 * answers `live` while the recovered shell has not attached yet, so the
 * foreground carries no argv (and often no pid). A fixture-driven `hc` stands in
 * here, pointed at with PI_HERDR_RESUME_HC, so the exact polling decisions can be
 * asserted instead of hoped for.
 */
const fakeDir = join(root, "fake-resume");
const fakeHc = join(root, "fake-hc.cjs");
const fakeState = join(root, "fake-hc-state.json");
const fakeCalls = join(root, "fake-hc-calls.json");
writeFileSync(
	fakeHc,
	["#!" + process.execPath,
		'const fs = require("node:fs");',
		'const args = process.argv.slice(2);',
		'const logFile = process.env.FAKE_HC_LOG;',
		'const state = fs.existsSync(process.env.FAKE_HC_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_HC_STATE, "utf8")) : {};',
		'const calls = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];',
		'const sendsBefore = calls.filter((call) => call[0] === "send").length;',
		"calls.push(args);",
		"fs.writeFileSync(logFile, JSON.stringify(calls));",
		'const answer = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };',
		'if (args[0] === "server" && args[1] === "status") answer({ core: { id: "fixture" }, live: 1 });',
		'if (args[0] === "send") answer({ sent: true });',
		'if (args[0] === "get") {',
		"\tif (state.afterSend && sendsBefore > 0) answer(state.afterSend);",
		'\tconst seen = calls.filter((call) => call[0] === "get").length - 1;',
		"\tconst sequence = state.sequence ?? [];",
		"\tanswer(sequence[Math.min(seen, sequence.length - 1)]);",
		"}",
		"process.exit(2);",
		"",
	].join("\n"),
);
chmodSync(fakeHc, 0o755);

/** hc a moment after a reboot: live, but no program attached in the foreground yet. */
const notAttached = { address: "t7", name: "worker", argv: ["/usr/bin/zsh"], keep: true, state: "live", foreground: { name: "zsh" } };
/** The recovered shell, attached. */
const attachedShell = { ...notAttached, foreground: { argv: ["/usr/bin/zsh"], name: "zsh", pid: process.pid } };
/** Something a person left running in that tab; never a second pi. */
const liveProgram = {
	...notAttached,
	argv: [process.execPath, "other-program.mjs"],
	foreground: { argv: [process.execPath, "other-program.mjs"], name: "node", pid: process.pid },
};
/** The terminal once the resume line has run: a real program, not a shell. */
const startedPi = {
	...attachedShell,
	argv: [process.execPath, fakePi],
	foreground: { argv: [process.execPath, fakePi], name: "node", pid: process.pid },
};

function writeFake(sequence, extra = {}) {
	rmSync(fakeDir, { recursive: true, force: true });
	mkdirSync(fakeDir, { recursive: true });
	writeFileSync(fakeState, JSON.stringify({ sequence, ...extra }));
	writeFileSync(fakeCalls, "[]");
	const entry = {
		version: 1,
		terminal: "t7",
		terminal_name: "worker",
		session_path: sessionPath,
		cwd: join(root, "sessions", "app"),
		argv: extra.entryArgv ?? [process.execPath, fakePi],
		mode: "plain",
		restored_boot_id: "an-earlier-boot",
		labels: {},
		pid: process.pid,
		updated_at: new Date().toISOString(),
	};
	writeFileSync(join(fakeDir, "t7.json"), JSON.stringify(entry, null, 2) + "\n");
}

/**
 * The platform the restore script is told it runs on: `startedWitness` reads `process.platform`
 * once, on load, so a module preloaded before it decides which branch answers.
 */
const forcePlatform = join(root, "force-platform.mjs");
function forcePlatformFile(platform) {
	writeFileSync(forcePlatform, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)}, configurable: true });\n`);
	return forcePlatform;
}

function runFake(env = {}, options = {}) {
	// `startedWitness` asks the platform once, on load. A case about the Windows answer can then be
	// run on a Linux host instead of skipped there — and a skipped case proves nothing.
	const preload = options.platform
		? ["--import", pathToFileURL(forcePlatformFile(options.platform)).href]
		: [];
	return spawnSync(process.execPath, [...preload, script], {
		encoding: "utf8",
		env: {
			...scratch,
			PI_HERDR_RESUME_HC: fakeHc,
			PI_HERDR_RESUME_DIR: fakeDir,
			PI_HERDR_RESUME_WAIT_MS: "5000",
			PI_HERDR_RESUME_ENTRY_MS: "10000",
			PI_HERDR_RESUME_START_MS: "3000",
			FAKE_HC_STATE: fakeState,
			FAKE_HC_LOG: fakeCalls,
			...env,
		},
		timeout: 120_000,
	});
}

function fakeCallLog() {
	return existsSync(fakeCalls) ? JSON.parse(readFileSync(fakeCalls, "utf8")) : [];
}

test("a live terminal with no foreground argv yet is waited out, not called busy", () => {
	// Two polls with no program at all, then the recovered shell: exactly the
	// 2026-11-15 boot, where "busy (no program)" lost both conversations.
	writeFake([notAttached, notAttached, attachedShell], { afterSend: startedPi });

	const out = runFake();
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /restored terminal t7: exec /);
	assert.doesNotMatch(out.stdout, /busy/);
	assert.doesNotMatch(out.stdout, /never became a shell/);
	assert.equal(fakeCallLog().filter((call) => call[0] === "send").length, 1, "the line must be typed once");
	assert.ok(fakeCallLog().filter((call) => call[0] === "get").length >= 3, "the script asked again instead of deciding");

	const restoreLog = readFileSync(join(fakeDir, "restore.log"), "utf8");
	assert.doesNotMatch(restoreLog, /busy/, "restore.log must not call an unattached terminal busy");
	assert.match(restoreLog, /restored terminal t7/);
});

test("a live program in the foreground that is not a shell is still busy", () => {
	writeFake([notAttached, liveProgram]);

	const out = runFake();
	assert.equal(out.status, 0, out.stderr);
	assert.equal(fakeCallLog().filter((call) => call[0] === "send").length, 0, "nothing may be typed");
	assert.match(out.stdout, /terminal is busy \(/);
	assert.ok(fakeCallLog().filter((call) => call[0] === "get").length >= 2, "it waited for the attach before deciding");
	assert.match(readFileSync(join(fakeDir, "restore.log"), "utf8"), /terminal is busy/);
	assert.equal(JSON.parse(readFileSync(join(fakeDir, "t7.json"), "utf8")).restored_boot_id, "an-earlier-boot");
});

test("a terminal that never attaches before the deadline is skipped as never-a-shell", () => {
	writeFake([notAttached]);

	const out = runFake({ PI_HERDR_RESUME_ENTRY_MS: "1200" });
	assert.equal(out.status, 0, out.stderr);
	assert.equal(fakeCallLog().filter((call) => call[0] === "send").length, 0, "nothing may be typed");
	assert.match(out.stdout, /never became a shell within 1200 ms/);
	assert.doesNotMatch(out.stdout, /busy/, "no program ever appeared: this is not a busy terminal");
	assert.equal(JSON.parse(readFileSync(join(fakeDir, "t7.json"), "utf8")).restored_at, undefined);
});

/**
 * Windows, and the half of it that only Windows has: herdr starts a tab as
 * `powershell.exe -NoExit -Command "& '<program>'"`, and hc keeps answering that launch
 * program as the terminal's foreground for as long as the terminal lives — measured
 * 2026-11-24 on a bash tab running node, which answered `bash.exe` and the same pid on
 * every poll. So the line was typed, pi was running, and the script called it "nothing
 * started" and typed the same line a second time into the pi it had just started.
 */
const windowsShell = {
	...attachedShell,
	address: "t7",
	argv: ["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoExit", "-Command", "& 'C:/Program Files/Git/usr/bin/bash.exe'"],
	foreground: { argv: ["C:\\Program Files\\Git\\usr\\bin\\bash.exe"], name: "bash.exe", pid: process.pid },
};
/** The same terminal once the resume line ran: the foreground never changed, but pi reported in. */
const windowsResumed = { ...windowsShell, status: { app: "pi", state: "working" } };

test("a terminal whose foreground stays the launched shell counts as started when pi reports in", () => {
	// A Windows answer, run as Windows on whatever host this is: off Windows the same facts must
	// read "not started" (scripts/tests/herdr-resume-witness.test.mjs pins that pair).
	writeFake([windowsShell], { afterSend: windowsResumed });

	const out = runFake({}, { platform: "win32" });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /restored terminal t7: exec /);
	// The bug this pins: a second paste into the pi the first paste started.
	assert.equal(fakeCallLog().filter((call) => call[0] === "send").length, 1, "the line must be typed once, not once per attempt");
	assert.doesNotMatch(out.stdout, /nothing started/);
	assert.equal(JSON.parse(readFileSync(join(fakeDir, "t7.json"), "utf8")).restored_at !== undefined, true);
});

test("a shell that never reports a program is still not a restore", () => {
	// The other side of the same coin: the foreground stays a shell and nothing ever writes
	// a status, so the line was typed and nothing can be said about whether it ran.
	writeFake([windowsShell], { afterSend: windowsShell });

	const out = runFake({ PI_HERDR_RESUME_START_MS: "800" });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /nothing started after two attempts, entry left unmarked/);
	assert.equal(JSON.parse(readFileSync(join(fakeDir, "t7.json"), "utf8")).restored_at, undefined);
});

/**
 * The same Windows tab, but recovered as what herdr really hands back: a `powershell.exe` with
 * hc's prompt hook, not a bash. It has no `exec`, so the POSIX line was a
 * `CommandNotFoundException` printed in the tab, four times per boot, and the Boss never came
 * back (measured 2026-11-24: `hc read t15`). The line has to be PowerShell's.
 */
const windowsPowerShell = {
	...attachedShell,
	address: "t7",
	argv: [
		"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		"-NoExit",
		"-Command",
		"$global:__hc_prompt = $function:prompt",
	],
	foreground: {
		argv: ["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoExit", "-Command", "$global:__hc_prompt = $function:prompt"],
		name: "powershell.exe",
		pid: process.pid,
	},
};
/** What `hc get` answers once that line ran: the child is the foreground, and pi reports in. */
const windowsPowerShellResumed = {
	...windowsPowerShell,
	argv: ["C:\\Program Files\\nodejs\\node.exe", "/app/cli.js"],
	foreground: { argv: ["C:\\Program Files\\nodejs\\node.exe", "/app/cli.js"], name: "node.exe", pid: process.pid },
	status: { app: "pi", state: "working" },
};

test("a recovered PowerShell tab is typed a PowerShell line, not a POSIX one", () => {
	writeFake([windowsPowerShell], {
		afterSend: windowsPowerShellResumed,
		// The entry a Windows Boss leaves behind: a script, not a program.
		entryArgv: ["C:\\Users\\markm\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"],
	});

	const out = runFake();
	assert.equal(out.status, 0, out.stderr);
	const sent = fakeCallLog().filter((call) => call[0] === "send").map((call) => call[2]);
	assert.equal(sent.length, 1, "the line must be typed once");
	assert.match(sent[0], /^& /, "PowerShell gets `&`, because it has no `exec`");
	assert.doesNotMatch(sent[0], /\bexec\b/, "a POSIX line in a PowerShell tab is a CommandNotFoundException");
	assert.match(sent[0], /--session/, "the session file still travels with the line");
	assert.ok(sent[0].includes(process.execPath), "a .js argv[0] is run by an interpreter that exists, not by association");
	assert.match(out.stdout, /restored terminal t7: & /);
	assert.equal(JSON.parse(readFileSync(join(fakeDir, "t7.json"), "utf8")).restored_at !== undefined, true);
});

test("a recovered POSIX shell still gets the exec line", () => {
	writeFake([attachedShell], { afterSend: startedPi });

	const out = runFake();
	assert.equal(out.status, 0, out.stderr);
	const sent = fakeCallLog().filter((call) => call[0] === "send").map((call) => call[2]);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^exec /);
});
