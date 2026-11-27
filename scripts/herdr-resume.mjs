#!/usr/bin/env node
// herdr-resume: put the pi sessions back after a reboot.
//
// Radar basis: #95 Herdr.
//
// herdr-core survives a core restart and a host shutdown by replacing each lost
// program with a plain shell in the same tab, in the same folder (see
// `hc --skill`, `hc keep`). It never re-runs the program, on purpose. For an
// agent terminal that is the wrong half of the promise: the conversation is on
// disk, the tab is empty.
//
// This script closes that gap and nothing else:
//
//   - the resume entries are written by `agent/extensions/herdr-resume-map.ts`
//     while the pi session runs; one file per hc terminal;
//   - after a reboot this script asks hc for each of those terminals and, when
//     the terminal is a recovered *shell* (foreground is a shell and hc's own
//     `argv` is the replacement shell, not the lost program), types
//     `exec <argv> --session <session-file>` into it.
//
// It touches no terminal that never held pi: an entry only exists because a pi
// session ran there. It never leaves two pi in one tab: a terminal whose
// foreground carries a pi launcher *anywhere* in its argv is skipped — a
// sandboxed Boss reads as `bash …/pi-sandbox.sh -- pi …`, so `argv[0]` alone
// called a live Boss a shell and typed `exec …` into it — and hc's own
// `status.app` is asked as a second witness. That skip and every other action
// are recorded in the entry, so a second run in the same boot is a no-op; a
// line that was typed into something which turned out not to be a shell marks
// the entry for the boot instead of being retried on every pass. It never reads
// or writes terminal output: no screen capture, no pane history, no scrollback.
//
// It also prunes the map instead of walking it forever: an entry whose terminal
// the core has never heard of cannot come back as a shell, so the entry is
// deleted rather than waited on. Entries whose session file is gone go the same
// way. Both would otherwise sit in `hc get` until the per-entry deadline, every
// boot, for the life of the folder (`agent/extensions/herdr-resume-map.ts` only
// ever writes). Pruning is two questions, never one: an empty terminal list is
// not evidence, and a miss the core answers twice is.
//
// Usage: herdr-resume.mjs [--dry-run]
//
// Environment:
//   PI_HERDR_RESUME_DIR        entries folder (default ~/.pi/agent/herdr-resume)
//   PI_HERDR_RESUME_HC         hc binary (default: hc from PATH; a test hook)
//   PI_HERDR_RESUME_WAIT_MS    how long to wait for the core (default 120000)
//   PI_HERDR_RESUME_ENTRY_MS   per-terminal wait for the recovered shell (20000)
//   PI_HERDR_RESUME_START_MS   after a send, how long to wait for it to start (15000)
import { execFileSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The argv judgement and the line it implies are one reading, shared with `bin/guard`: a second
// copy is how two programs start disagreeing about whether a terminal is a shell. See
// `scripts/herdr-terminal.mjs`.
import { isQuietShell, isShellArgv, piWitness, resumeLine, runningProgram, shellFamily, startedWitness } from "./herdr-terminal.mjs";
export { resumeLine, shellFamily, startedWitness };

const env = process.env;
const home = env.HOME ?? "";
const dir = env.PI_HERDR_RESUME_DIR || join(home, ".pi", "agent", "herdr-resume");
// The entries and the log share one folder: the extension writes `<id>.json`
// next to it, under the same PI_HERDR_RESUME_DIR.
const entriesDir = dir;
const logFile = join(dir, "restore.log");
const hcBin = env.PI_HERDR_RESUME_HC || "hc";
const waitMs = Number(env.PI_HERDR_RESUME_WAIT_MS || "120000");
const entryMs = Number(env.PI_HERDR_RESUME_ENTRY_MS || "20000");
const startMs = Number(env.PI_HERDR_RESUME_START_MS || "15000");
const dryRun = process.argv.includes("--dry-run");

/** One line per decision: journal for the person, file for the next reader. */
function log(message) {
	const line = `${new Date().toISOString()} ${message}`;
	console.log(line);
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(logFile, `${line}\n`);
	} catch {
		// A log that cannot be written is not a reason to skip a restore.
	}
}

function hc(args) {
	try {
		const out = execFileSync(hcBin, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 8 * 1024 * 1024,
		});
		return { ok: true, out };
	} catch (error) {
		return { ok: false, out: String(error?.stdout ?? ""), error: String(error?.stderr ?? error?.message ?? error) };
	}
}

function hcJson(args) {
	const result = hc(args);
	if (!result.ok) return null;
	try {
		return JSON.parse(result.out);
	} catch {
		return null;
	}
}

function runnable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Every terminal address the core knows, asked once before the walk.
 *
 * `--all` on purpose: a finished terminal is a terminal hc knows, and its entry
 * may still name a session worth keeping. Only a terminal hc has never heard of
 * is dead, and asking `hc get` about it answers `not_found` until the per-entry
 * deadline runs out — the wait that made the unit time out.
 *
 * `null` means the question failed: that is never a reason to delete an entry.
 */
function knownTerminals() {
	const list = hcJson(["ls", "--json", "--all"]);
	if (!list || !Array.isArray(list.terminals)) return null;
	const known = new Set();
	for (const terminal of list.terminals) {
		if (typeof terminal?.address === "string") known.add(terminal.address);
	}
	return known;
}

/** The core that hosts the terminals starts with the window; wait for it once. */
function waitForCore() {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (hcJson(["server", "status"]) !== null) return true;
		if (Date.now() >= deadline) return false;
		sleep(1000);
	}
}

/**
 * The recovered shell appears a moment after the core answers (`hc keep` has a
 * short grace delay), so ask again instead of concluding too early.
 *
 * A terminal that has only just come back is reported `state: "live"` *before*
 * the recovered shell has replaced the lost program, and then its foreground
 * carries no `argv` (often no `pid` either). That is "not attached yet", not
 * "busy": the answer here is to wait, exactly as one waits for a foreground that
 * is not a shell yet. Only two things answer straight away — the terminal is no
 * longer live, or a real program that is not a shell is running in it.
 */
function waitForTerminal(terminal, deadline) {
	let facts = null;
	for (;;) {
		const next = hcJson(["get", terminal, "--json"]);
		if (next) {
			facts = next;
			if (facts.state !== "live") return facts;
			// A wrapped pi (`bash …/pi-sandbox.sh -- pi …`) reads as a shell by `argv[0]` and is
			// a live Boss: returning here is what let a resume line be typed into one.
			if (isQuietShell(facts)) return facts;
			if (runningProgram(facts)) return facts;
		}
		if (Date.now() >= deadline) return facts;
		sleep(500);
	}
}

function waitForStart(terminal, deadline) {
	for (;;) {
		const facts = hcJson(["get", terminal, "--json"]);
		if (facts && facts.state === "live" && startedWitness(facts)) return facts;
		if (Date.now() >= deadline) return null;
		sleep(500);
	}
}

/** The kernel's boot id: a service rerun in the same boot must not type twice. */
function bootId() {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return "";
	}
}

function readEntries() {
	if (!existsSync(entriesDir)) return [];
	return readdirSync(entriesDir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const path = join(entriesDir, name);
			try {
				return { path, entry: JSON.parse(readFileSync(path, "utf8")) };
			} catch (error) {
				log(`skip ${name}: unreadable entry (${error?.message ?? error})`);
				return null;
			}
		})
		.filter(Boolean);
}

/**
 * A dead entry is deleted, not skipped once per boot forever: nothing else ever
 * removes one, so the folder would grow by one file per hc terminal, always.
 */
function forget(path, message) {
	if (dryRun) {
		log(`would delete ${message}`);
		return;
	}
	try {
		unlinkSync(path);
		log(`deleted ${message}`);
	} catch (error) {
		log(`failed to delete ${message}: ${error?.message ?? error}`);
	}
}

function markRestored(path, entry, bootId) {
	const next = { ...entry, restored_at: new Date().toISOString(), restored_boot_id: bootId };
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(temp, path);
}

/**
 * A paste that landed in something which was not a shell. Not `restored_at` (nothing was restored)
 * and not left unmarked either: the entry would be typed into the same live program on every
 * guard pass. The mark is per boot, so the next boot tries again.
 */
function markAttempted(path, entry, bootId) {
	const next = { ...entry, attempted_at: new Date().toISOString(), attempted_boot_id: bootId };
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(temp, path);
}

function main() {
	const entries = readEntries();
	if (entries.length === 0) {
		log(`nothing to restore: no entries in ${entriesDir}`);
		return 0;
	}
	const boot = bootId();

	if (!waitForCore()) {
		log(`skip all: hc did not answer within ${waitMs} ms (${hcBin} server status)`);
		return 0;
	}

	// One question for every entry, instead of one per entry: a terminal the
	// core does not know is not a wait, it is a deletion.
	const known = knownTerminals();
	if (known === null) log(`skip pruning: ${hcBin} ls did not answer with a terminal list`);
	else if (known.size === 0) log(`keep every entry: ${hcBin} ls answered with an empty terminal list, which is not evidence that a terminal is gone`);

	// A miss is not a deletion on one read: on 2026-11-26 one `hc ls` answered an empty list while
	// four Bosses were live, and every entry in the folder was deleted in one pass. So a terminal
	// the first list does not know is asked about again, and only a second non-empty list that also
	// lacks it is the core agreeing it is gone. `undefined` is "not asked yet", `null` is "no usable
	// second answer" — asked at most once, only when an entry is actually missing.
	let reread;
	const goneFromCore = (terminal) => {
		if (known === null || known.size === 0) return false;
		if (known.has(terminal)) return false;
		if (reread === undefined) {
			const again = knownTerminals();
			reread = again !== null && again.size > 0 ? again : null;
			if (reread === null) log(`keep every entry: the second ${hcBin} ls did not answer with a non-empty terminal list`);
		}
		return reread !== null && !reread.has(terminal);
	};

	let restored = 0;
	let pruned = 0;
	for (const { path, entry } of entries) {
		const terminal = typeof entry.terminal === "string" ? entry.terminal : "";
		if (!terminal) {
			log("skip ?: entry has no terminal id");
			continue;
		}
		const where = `terminal ${terminal}${entry.tab ? ` (${entry.tab})` : ""}`;

		if (typeof entry.session_path !== "string" || !existsSync(entry.session_path)) {
			forget(path, `${where}: session file is gone (${entry.session_path ?? "unset"})`);
			pruned += 1;
			continue;
		}
		if (goneFromCore(terminal)) {
			forget(path, `${where}: hc does not know this terminal`);
			pruned += 1;
			continue;
		}
		if (!Array.isArray(entry.argv) || entry.argv.length === 0) {
			log(`skip ${where}: entry has no launch argv (mode ${entry.mode ?? "unknown"})`);
			continue;
		}
		if (!runnable(String(entry.argv[0]))) {
			log(`skip ${where}: not executable: ${entry.argv[0]}`);
			continue;
		}
		if (boot && entry.restored_boot_id === boot) {
			log(`skip ${where}: already restored in this boot at ${entry.restored_at}`);
			continue;
		}
		if (boot && entry.attempted_boot_id === boot) {
			log(`skip ${where}: typed into a program that was not a shell earlier in this boot at ${entry.attempted_at}`);
			continue;
		}

		const facts = waitForTerminal(terminal, Date.now() + entryMs);
		if (!facts) {
			// Only reachable when the terminal list could not be read and the core
			// still refuses this one: keep the entry, one boot of waiting is cheaper
			// than a deletion the core never agreed to.
			log(`skip ${where}: hc does not know this terminal`);
			continue;
		}
		if (facts.state !== "live") {
			log(`skip ${where}: terminal is ${facts.state}`);
			continue;
		}
		const busy = piWitness(facts);
		if (busy) {
			// A live pi, whoever wraps it: one paste into a person's Boss is the bug.
			log(`skip ${where}: terminal is busy (${busy})`);
			continue;
		}
		if (!isShellArgv(facts.foreground?.argv)) {
			if (!Array.isArray(facts.foreground?.argv) || facts.foreground.argv.length === 0) {
				// The deadline passed and still nothing is attached: hc says `live`
				// but the recovered shell never showed up. This is not a busy
				// terminal — typing into it would land in no program at all.
				log(`skip ${where}: terminal never became a shell within ${entryMs} ms (foreground has no program)`);
				continue;
			}
			// Something is running there — a person, or pi itself. Never a second pi.
			const running = facts.foreground.argv.join(" ");
			log(`skip ${where}: terminal is busy (${running})`);
			continue;
		}
		if (!isShellArgv(facts.argv)) {
			// hc still holds the launch command: the program exited on its own,
			// nobody lost it. Resuming would overrule the person quitting pi.
			log(`skip ${where}: hc still holds the launch argv (${(facts.argv ?? []).join(" ")}), not a recovered shell`);
			continue;
		}
		const line = resumeLine(entry, facts);
		if (dryRun) {
			log(`would send ${where}: ${line}`);
			continue;
		}
		let started = false;
		for (let attempt = 1; attempt <= 2 && !started; attempt += 1) {
			const send = hc(["send", terminal, line]);
			if (!send.ok) {
				log(`failed ${where}: hc send exited non-zero (${send.error.trim() || "no stderr"})`);
				break;
			}
			started = waitForStart(terminal, Date.now() + startMs) !== null;
			if (!started && attempt === 1) {
				// The shell took the keystrokes but ran nothing. The usual cause is a
				// first-run prompt eating the first character of the pasted line; the
				// shell is at a clean prompt now, so the same line works once more.
				log(`retry ${where}: the line was typed but nothing started`);
			}
		}
		if (!started) {
			const after = hcJson(["get", terminal, "--json"]);
			if (after && !isQuietShell(after)) {
				// The line went into something that was not a shell — a live program that
				// ignores pasted text. Marked for this boot, never retried on every pass.
				log(`failed ${where}: the line was typed into something that is not a shell (${piWitness(after) || (after.foreground?.argv ?? []).join(" ")}), marked for this boot`);
				markAttempted(path, entry, boot);
				continue;
			}
			log(`failed ${where}: nothing started after two attempts, entry left unmarked`);
			continue;
		}
		markRestored(path, entry, boot);
		restored += 1;
		log(`restored ${where}: ${line}`);
	}

	if (restored === 0 && pruned === 0 && !dryRun) log("nothing restored: every entry was skipped");
	return 0;
}

process.exitCode = main();
