/**
 * herdr-resume: what the restore script does with each kind of terminal.
 *
 * `hc` is a small node script on PATH that answers from a fixture file and
 * records every `send`, so the exact line typed into a terminal is asserted.
 * No hc core is started here; the reboot simulation lives in
 * scripts/tests/herdr-resume-reboot.test.mjs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const here = import.meta.dirname;
const script = join(here, "..", "herdr-resume.mjs");
const root = mkdtempSync(join(tmpdir(), "herdr-resume-"));
const binDir = join(root, "bin");
const stateRoot = join(root, "state");
const entriesDir = stateRoot;
const stateFile = join(root, "hc-state.json");
const logFile = join(root, "hc-calls.json");
const sessionPath = join(root, "sessions", "app", "s.jsonl");
const wrapper = join(root, "pi-sandboxed");

mkdirSync(binDir, { recursive: true });
mkdirSync(join(root, "sessions", "app"), { recursive: true });
writeFileSync(sessionPath, '{"role":"user","content":"hello"}\n');
writeFileSync(wrapper, "#!/bin/sh\n");
chmodSync(wrapper, 0o755);

/** Fake hc: fixture state in, calls out. Exit 3 mirrors hc's not_found. */
writeFileSync(
	join(binDir, "hc"),
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_HC_STATE;
const logFile = process.env.FAKE_HC_LOG;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const calls = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
calls.push(args);
fs.writeFileSync(logFile, JSON.stringify(calls));
const fail = (json) => { process.stdout.write(JSON.stringify(json)); process.exit(3); };
if (args[0] === "server" && args[1] === "status") {
	if (state.coreDown) process.exit(1);
	process.stdout.write(JSON.stringify({ core: { id: "scratch" }, live: 1 }));
	process.exit(0);
}
if (args[0] === "get") {
	// What the terminal looks like once the typed line has run (and after how
	// many ignored sends, if the fixture models a swallowed first attempt).
	const sentCount = calls.filter((call) => call[0] === "send").length;
	if (state.afterSend && sentCount > (state.ignoreSends ?? 0)) {
		process.stdout.write(JSON.stringify(state.afterSend));
		process.exit(0);
	}
	// A sequence of snapshots, one per call: hc's view while recovery is in flight.
	if (Array.isArray(state.sequence)) {
		const seen = calls.filter((call) => call[0] === "get").length - 1;
		process.stdout.write(JSON.stringify(state.sequence[Math.min(seen, state.sequence.length - 1)]));
		process.exit(0);
	}
	const terminal = state.terminals?.[args[1]];
	if (!terminal) fail({ error: { kind: "not_found", message: "no terminal" } });
	process.stdout.write(JSON.stringify(terminal));
	process.exit(0);
}
if (args[0] === "send") {
	if (state.sendFails) { process.stderr.write("send refused\\n"); process.exit(9); }
	process.stdout.write(JSON.stringify({ sent: true }));
	process.exit(0);
}
process.exit(2);
`,
);
chmodSync(join(binDir, "hc"), 0o755);

/** A recovered shell: hc rewrote argv to the replacement shell, foreground is it. */
function recoveredTerminal(overrides = {}) {
	return {
		address: "t3",
		name: "review",
		argv: ["/usr/bin/zsh"],
		keep: true,
		state: "live",
		foreground: { argv: ["/usr/bin/zsh"], name: "zsh", pid: 4242 },
		labels: { "herdr.space": "big-boss-pi", "herdr.tab": "worker" },
		...overrides,
	};
}

/** The terminal after the resume line ran: pi in the foreground, not the shell. */
function runningPi(overrides = {}) {
	return recoveredTerminal({
		argv: [wrapper, "--thinking", "high"],
		foreground: { argv: [wrapper, "--thinking", "high"], name: "pi", pid: process.pid },
		...overrides,
	});
}

function writeState(terminal, extra = {}) {
	writeFileSync(stateFile, JSON.stringify({ terminals: { t3: terminal }, ...extra }));
}

function writeEntry(overrides = {}) {
	mkdirSync(entriesDir, { recursive: true });
	const entry = {
		version: 1,
		terminal: "t3",
		terminal_name: "review",
		session_path: sessionPath,
		session_id: "session-1",
		cwd: "/home/mark/projects/app",
		argv: [wrapper],
		mode: "sandbox",
		tab: "worker",
		labels: {},
		pid: 1,
		updated_at: new Date().toISOString(),
		...overrides,
	};
	writeFileSync(join(entriesDir, "t3.json"), `${JSON.stringify(entry, null, 2)}\n`);
	return entry;
}

function run(args = [], env = {}) {
	const result = execFileSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${binDir}:/usr/bin:/bin`,
			PI_HERDR_RESUME_DIR: stateRoot,
			PI_HERDR_RESUME_WAIT_MS: "0",
			PI_HERDR_RESUME_ENTRY_MS: "0",
			PI_HERDR_RESUME_START_MS: "1500",
			FAKE_HC_STATE: stateFile,
			FAKE_HC_LOG: logFile,
			...env,
		},
	});
	return result;
}

function calls() {
	return existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : [];
}

function sends() {
	return calls().filter((call) => call[0] === "send");
}

after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
	// Fresh fixture + fresh entry folder per test, exactly what the script reads.
	rmSync(stateRoot, { recursive: true, force: true });
	writeFileSync(stateFile, "{}");
	writeFileSync(logFile, "[]");
	mkdirSync(entriesDir, { recursive: true });
});

test("a recovered shell gets the same session exec'd back into it", () => {
	writeState(recoveredTerminal(), { afterSend: runningPi() });
	const entry = writeEntry({ argv: [wrapper, "--thinking", "high", "-a"] });

	const out = run();
	assert.equal(sends().length, 1);
	const text = sends()[0][2];
	assert.match(text, /^exec /);
	assert.ok(text.includes(`${wrapper} --thinking high -a --session ${sessionPath}`), text);
	assert.ok(text.includes(`${sessionPath}`), "the session file must be named on the line");
	assert.match(out, /restored terminal t3 \(worker\)/);

	const saved = JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8"));
	assert.equal(saved.session_path, entry.session_path);
	assert.equal(typeof saved.restored_at, "string");
	assert.match(saved.restored_boot_id, /./);
});

test("words a shell would split are quoted", () => {
	writeState(recoveredTerminal(), { afterSend: runningPi() });
	const weird = join(root, "with space", "pi wrapper");
	mkdirSync(join(root, "with space"), { recursive: true });
	writeFileSync(weird, "#!/bin/sh\n");
	chmodSync(weird, 0o755);
	writeEntry({ argv: [weird, "--label", "two words"] });

	run();
	const text = sends()[0][2];
	assert.equal(text, `exec '${weird}' --label 'two words' --session ${sessionPath}`);
});

test("a session file that is gone is skipped", () => {
	writeState(recoveredTerminal());
	writeEntry({ session_path: join(root, "sessions", "gone.jsonl") });

	const out = run();
	assert.equal(sends().length, 0);
	assert.match(out, /session file is gone/);
});

test("a terminal that is running something is never given a second pi", () => {
	writeState(
		recoveredTerminal({
			argv: ["/home/mark/.local/share/pnpm/bin/pi", "--session", sessionPath],
			foreground: { argv: ["/home/mark/.local/share/pnpm/bin/pi", "--session", sessionPath], name: "pi", pid: 9 },
		}),
	);
	writeEntry();

	const out = run();
	assert.equal(sends().length, 0);
	assert.match(out, /terminal is busy/);
});

test("a finished terminal is skipped", () => {
	writeState(recoveredTerminal({ state: "finished", foreground: undefined }));
	writeEntry();

	const out = run();
	assert.equal(sends().length, 0);
	assert.match(out, /terminal is finished/);
});

test("a dead foreground during recovery is waited out, not called busy", () => {
	const stale = recoveredTerminal({
		argv: [wrapper, "--thinking", "high"],
		foreground: { argv: ["pi", "--thinking", "high"], name: "pi", pid: 999999 },
	});
	writeFileSync(stateFile, JSON.stringify({ sequence: [stale, recoveredTerminal(), runningPi()] }));
	writeEntry({ argv: [wrapper, "--thinking", "high"] });

	run([], { PI_HERDR_RESUME_ENTRY_MS: "5000" });
	assert.equal(sends().length, 1, "the recovered shell must still be resumed");
	assert.ok(calls().filter((call) => call[0] === "get").length >= 2, "the script asked twice");
});

test("a swallowed first line is retried once", () => {
	// The first send lands on a first-run prompt that eats its first character.
	writeState(recoveredTerminal(), { afterSend: runningPi(), ignoreSends: 1 });
	writeEntry();

	const out = run([], { PI_HERDR_RESUME_START_MS: "500" });
	assert.equal(sends().length, 2, "the line must be typed again");
	assert.match(out, /retry terminal t3 \(worker\): the line was typed but nothing started/);
	assert.match(out, /restored terminal t3/);
});

test("two swallowed lines are a logged failure, not a restore", () => {
	writeState(recoveredTerminal(), { afterSend: runningPi(), ignoreSends: 99 });
	writeEntry();

	const out = run([], { PI_HERDR_RESUME_START_MS: "300" });
	assert.equal(sends().length, 2);
	assert.match(out, /failed terminal t3 \(worker\): nothing started after two attempts/);
	assert.equal(JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8")).restored_at, undefined);
});

test("a live foreground is busy, and is not waited out", () => {
	writeState(
		recoveredTerminal({
			argv: [wrapper],
			foreground: { argv: [wrapper], name: "pi", pid: process.pid },
		}),
	);
	writeEntry();

	const out = run([], { PI_HERDR_RESUME_ENTRY_MS: "20000" });
	assert.equal(sends().length, 0);
	assert.match(out, /terminal is busy/);
	assert.equal(calls().filter((call) => call[0] === "get").length, 1, "one look is enough to see a live program");
});

test("a shell that still holds the launch argv is a person quitting, not a loss", () => {
	writeState(recoveredTerminal({ argv: [wrapper, "--thinking", "high"] }));
	writeEntry({ argv: [wrapper, "--thinking", "high"] });

	const out = run();
	assert.equal(sends().length, 0);
	assert.match(out, /hc still holds the launch argv/);
});

test("a second run in the same boot is a no-op", () => {
	writeState(recoveredTerminal(), { afterSend: runningPi() });
	writeEntry();

	run();
	assert.equal(sends().length, 1);
	const out = run();
	assert.equal(sends().length, 1, "a second run must not type the line again");
	assert.match(out, /already restored in this boot/);
});

test("--dry-run says what it would do and types nothing", () => {
	writeState(recoveredTerminal(), { afterSend: runningPi() });
	writeEntry();

	const out = run(["--dry-run"]);
	assert.equal(sends().length, 0);
	assert.match(out, /would send terminal t3/);
	assert.equal(JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8")).restored_at, undefined);
});

test("a launch programme that is not executable is skipped", () => {
	writeState(recoveredTerminal());
	writeEntry({ argv: [join(root, "missing-wrapper")] });

	const out = run();
	assert.equal(sends().length, 0);
	assert.match(out, /not executable/);
});

test("an entry without a launch argv is skipped", () => {
	writeState(recoveredTerminal());
	writeEntry({ argv: [], mode: "unknown" });

	const out = run();
	assert.equal(sends().length, 0);
	assert.match(out, /no launch argv \(mode unknown\)/);
});

test("nothing runs before the core answers", () => {
	writeState(recoveredTerminal(), { coreDown: true });
	writeEntry();

	const out = run();
	assert.equal(calls().filter((call) => call[0] === "get").length, 0);
	assert.match(out, /hc did not answer/);
});

test("no entries at all is a clean exit", () => {
	const out = run();
	assert.match(out, /nothing to restore/);
	assert.equal(sends().length, 0);
});

test("a refused send is logged and leaves the entry unmarked", () => {
	writeState(recoveredTerminal(), { sendFails: true, afterSend: runningPi() });
	writeEntry();

	const out = run();
	assert.match(out, /failed terminal t3/);
	assert.equal(JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8")).restored_at, undefined);
});
