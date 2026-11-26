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
if (args[0] === "ls") {
	// What the core knows: 'known' names the addresses, --all included. 'knownSequence' is one
	// answer per read, so a case can say "empty, then a full list" — the read race that deleted
	// every live entry once.
	let known = state.known ?? Object.keys(state.terminals ?? {});
	if (Array.isArray(state.knownSequence)) {
		const seen = calls.filter((call) => call[0] === "ls").length - 1;
		known = state.knownSequence[Math.min(seen, state.knownSequence.length - 1)] ?? [];
	}
	if (state.lsFails) process.exit(1);
	if (Array.isArray(state.lsFailsSequence)) {
		const seen = calls.filter((call) => call[0] === "ls").length - 1;
		if (state.lsFailsSequence[Math.min(seen, state.lsFailsSequence.length - 1)]) process.exit(1);
	}
	process.stdout.write(JSON.stringify({ terminals: known.map((address) => ({ address })) }));
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
		labels: { "herdr.space": "harness", "herdr.tab": "worker" },
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

/**
 * A sandboxed Boss as the machine actually shows it: `argv[0]` is `bash`, and `pi` is four
 * words further along. `isShellArgv(argv[0])` called this a recovered shell, and the resume line
 * was pasted into a live Boss.
 */
function wrappedPi(overrides = {}) {
	return recoveredTerminal({
		argv: ["bash", "/home/mark/.pi/sandbox/pi-sandbox.sh", "--", "pi", "--session", sessionPath],
		foreground: {
			argv: ["bash", "/home/mark/.pi/sandbox/pi-sandbox.sh", "--", "pi", "--session", sessionPath],
			name: "bash",
			pid: process.pid,
		},
		...overrides,
	});
}

function writeState(terminal, extra = {}) {
	writeFileSync(stateFile, JSON.stringify({ terminals: { t3: terminal }, known: ["t3"], ...extra }));
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
	writeFileSync(stateFile, JSON.stringify({ sequence: [stale, recoveredTerminal(), runningPi()], known: ["t3"] }));
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

test("an entry whose terminal hc does not know is deleted, without a wait", () => {
	// The core knows only t9; the entry names t3, a terminal no core has heard
	// of since a reboot. `hc get t3` answers not_found until the deadline: the
	// wait that made the unit time out.
	writeState(recoveredTerminal(), { known: ["t9"] });
	writeEntry();

	const out = run([], { PI_HERDR_RESUME_ENTRY_MS: "20000" });
	assert.equal(existsSync(join(stateRoot, "t3.json")), false, "the dead entry must be gone");
	assert.match(out, /deleted terminal t3 \(worker\): hc does not know this terminal/);
	assert.equal(sends().length, 0);
	assert.equal(calls().filter((call) => call[0] === "get").length, 0, "an unknown terminal is not worth one get");
	assert.equal(calls().filter((call) => call[0] === "ls").length, 2, "a miss is one read; the deletion needs the second one");
});

test("an empty terminal list deletes nothing: it is not evidence a terminal is gone", () => {
	// Measured 2026-11-26: one `hc ls` answered an empty list while four Bosses were live, and the
	// whole folder was deleted in one pass. The list that says "no terminals at all" is the read
	// race, not four closed tabs.
	writeState(recoveredTerminal(), { known: [], afterSend: runningPi() });
	const entry = writeEntry();

	const out = run();
	assert.equal(existsSync(join(stateRoot, "t3.json")), true, "an empty list must not delete the entry");
	assert.match(out, /empty terminal list, which is not evidence/);
	assert.equal(JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8")).restored_at !== undefined, true, "the entry is still acted on, not just kept");
	assert.ok(sends().length === 1, out);
	assert.ok(sends()[0][2].includes(entry.session_path), sends()[0][2]);
});

test("a terminal the first read misses but the second read names is kept", () => {
	// The other half of the same race: a list that is *not* empty, taken while the core was still
	// bringing terminals back, and the entry is a live one. One read says "gone"; the second
	// read — the same question, a moment later — says the core knows t3.
	writeState(recoveredTerminal(), { knownSequence: [["t9"], ["t3", "t9"]], afterSend: runningPi() });
	writeEntry();

	const out = run();
	assert.equal(existsSync(join(stateRoot, "t3.json")), true, "the entry must survive a read race");
	assert.doesNotMatch(out, /deleted terminal t3/);
	assert.equal(calls().filter((call) => call[0] === "ls").length, 2);
});

test("a second read that answers an empty list keeps the entry", () => {
	// One non-empty miss, then an empty answer: the core shrank to nothing between two reads, which
	// is the same read race as an empty first answer. Keeping is the cheap side of that bet.
	writeState(recoveredTerminal(), { knownSequence: [["t9"], []], afterSend: runningPi() });
	writeEntry();

	const out = run();
	assert.equal(existsSync(join(stateRoot, "t3.json")), true, "the entry must survive a shrinking list");
	assert.doesNotMatch(out, /deleted terminal t3/);
	assert.match(out, /the second hc ls did not answer with a non-empty terminal list/);
});

test("a second read that fails keeps the entry", () => {
	// Silence is not a finding: a confirm read the core did not answer is the reason the entry
	// stays, and the log says which question failed instead of pretending it was answered.
	writeState(recoveredTerminal(), { knownSequence: [["t9"]], lsFailsSequence: [false, true], afterSend: runningPi() });
	writeEntry();

	const out = run();
	assert.equal(existsSync(join(stateRoot, "t3.json")), true, "a failed confirm read must not delete the entry");
	assert.doesNotMatch(out, /deleted terminal t3/);
	assert.match(out, /the second hc ls did not answer with a non-empty terminal list/);
});

test("an entry whose session file is gone is deleted, not kept", () => {
	writeState(recoveredTerminal());
	writeEntry({ session_path: join(root, "sessions", "gone.jsonl") });

	const out = run();
	assert.equal(existsSync(join(stateRoot, "t3.json")), false, "the dead entry must be gone");
	assert.match(out, /deleted terminal t3 \(worker\): session file is gone/);
	assert.equal(sends().length, 0);
});

test("--dry-run deletes nothing", () => {
	writeState(recoveredTerminal(), { known: ["t9"] });
	writeEntry();

	const out = run(["--dry-run"]);
	assert.match(out, /would delete terminal t3 \(worker\): hc does not know this terminal/);
	assert.equal(existsSync(join(stateRoot, "t3.json")), true, "a dry run must not prune");
});

test("no terminal list means no pruning", () => {
	// `hc ls` failing is not an answer, so nothing may be deleted on it.
	writeState(recoveredTerminal(), { lsFails: true });
	writeEntry();

	const out = run();
	assert.match(out, /skip pruning/);
	assert.equal(existsSync(join(stateRoot, "t3.json")), true);
});

// ------------------------------------------------ a wrapped pi is busy, not a shell --

test("a sandboxed Boss that reads as `bash` is busy, and nothing is typed into it", () => {
	writeState(wrappedPi());
	writeEntry();

	const out = run([], { PI_HERDR_RESUME_ENTRY_MS: "20000" });
	assert.equal(sends().length, 0, "a live Boss must never be sent an exec line");
	assert.match(out, /terminal is busy \(foreground bash \/home\/mark\/\.pi\/sandbox\/pi-sandbox\.sh/);
});

test("hc's own status.app is a second witness: `pi` there is busy too", () => {
	// The foreground is a plain shell and the app still says pi: one witness saw a live Boss
	// while the argv said nothing.
	writeState(recoveredTerminal({ status: { app: "pi", state: "done" }, foreground: { argv: ["/usr/bin/zsh"], name: "zsh", pid: process.pid } }));
	writeEntry();

	const out = run([], { PI_HERDR_RESUME_ENTRY_MS: "20000" });
	assert.equal(sends().length, 0);
	assert.match(out, /terminal is busy \(app pi\)/);
});

test("a paste that lands in a wrapped pi marks the entry for this boot, and is not retried", () => {
	// The recovered shell swallows the line, and what comes back is a wrapped pi. The first run
	// is today's two attempts; the second run must not type a third.
	writeState(recoveredTerminal(), { afterSend: wrappedPi() });
	writeEntry();

	const first = run([], { PI_HERDR_RESUME_START_MS: "200" });
	assert.equal(sends().length, 2);
	assert.match(first, /failed terminal t3 \(worker\): the line was typed into something that is not a shell/);
	assert.match(first, /marked for this boot/);
	const saved = JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8"));
	assert.equal(saved.restored_at, undefined, "nothing was restored");
	assert.match(saved.attempted_boot_id, /./);

	const second = run([], { PI_HERDR_RESUME_START_MS: "200" });
	assert.equal(sends().length, 2, "the same boot must not paste the line again");
	assert.match(second, /typed into a program that was not a shell earlier in this boot/);
});

test("a swallowed line in a real shell is still retried on the next pass", () => {
	// The first-run-prompt case is safe to retype, so it must not be marked for the boot.
	writeState(recoveredTerminal(), { afterSend: runningPi(), ignoreSends: 99 });
	writeEntry();

	run([], { PI_HERDR_RESUME_START_MS: "200" });
	assert.equal(JSON.parse(readFileSync(join(stateRoot, "t3.json"), "utf8")).attempted_at, undefined);
});
