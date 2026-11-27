#!/usr/bin/env node
// herdr-fill: fill the empty Boss shell a boot left behind, in the tab it is already in.
//
// Measured 2026-11-27, the 09:16:33 boot: herdr's own layout restore handed every space back as a
// plain shell in the Boss tab, and `bin/guard` answered by opening a *second* tab with the same
// name — four spaces became eight tabs, half of them shells wearing an agent's name. The tab was
// already there, in the right folder, on the right terminal: what was missing was the line that
// starts pi in it, which `scripts/herdr-resume.mjs` has been typing into recovered tabs for months.
//
// This is that one line, for the guard:
//
//   herdr-fill.mjs --terminal <id> --argv '<json array>' [--wait-ms <n>]
//
// reads the terminal (`hc get <terminal> --json`), judges it with the same reading of argv
// `herdr-resume` uses (`scripts/herdr-terminal.mjs`), and only when it is a *quiet shell* types the
// record's argv into it — `exec …` on POSIX, `& …` on PowerShell, the line for cmd — then waits a
// bounded time for the foreground to stop being that shell. Answers one JSON object:
//
//   {"outcome":"filled",         "terminal":"t1","line":"exec …"}
//   {"outcome":"busy",           "terminal":"t1","reason":"foreground pi"}
//   {"outcome":"not-a-shell",    "terminal":"t1","reason":"node ..."}   a program is in front of it
//   {"outcome":"still-launch",   "terminal":"t1"}                        hc still holds the program
//   {"outcome":"unreadable",     "terminal":"t1","reason":"…"}           hc did not answer
//   {"outcome":"send-failed",    "terminal":"t1","reason":"…"}           hc send said no
//   {"outcome":"nothing-started","terminal":"t1","line":"exec …"}        typed twice, nothing ran
//
// The refusal that matters is `busy`: a terminal with a pi launcher in its foreground is never
// typed into. `exec …` into a live Boss is #222, and it is a case in
// `scripts/tests/test-guard-supervisor.sh`, not a comment.
//
//   herdr-fill.mjs --judge <terminal>…
//
// answers `yes|no|unknown`: is a pi launcher in any of these terminals (the question `bin/guard`
// asks about a Boss tab before it does anything). One reading, two questions.
//
// Environment:
//   PI_GUARD_FILL_HC          hc binary (default: hc from PATH; a test hook)
//   PI_GUARD_FILL_WAIT_MS     after a send, how long to wait for it to start (default 3000, 2-5 s)
import { execFileSync } from "node:child_process";
import { isQuietShell, isShellArgv, launchLine, piWitness, startedWitness } from "./herdr-terminal.mjs";

const ATTEMPTS = 2;
const env = process.env;
const hcBin = env.PI_GUARD_FILL_HC || env.PI_HERDR_FILL_HC || "hc";
const waitMs = Math.max(200, Number(env.PI_GUARD_FILL_WAIT_MS || "3000"));

function hc(args) {
	try {
		const out = execFileSync(hcBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
		return { ok: true, out };
	} catch (error) {
		return { ok: false, out: String(error?.stdout ?? ""), error: String(error?.stderr ?? error?.message ?? error) };
	}
}

function facts(terminal) {
	const result = hc(["get", terminal, "--json"]);
	if (!result.ok) return null;
	try {
		const one = JSON.parse(result.out);
		return one && typeof one === "object" ? one : null;
	} catch {
		return null;
	}
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The answer `bin/guard`'s boss_live asks of a Boss tab. `unknown` is not a refusal: it is one
 * terminal out of the judgement, and only a positive `no` lets the guard touch anything.
 */
function judge(terminals) {
	let pi = false;
	let shells = 0;
	let other = 0;
	let unread = 0;
	for (const terminal of terminals) {
		const one = facts(terminal);
		if (!one || one.state !== "live") {
			unread += 1;
			continue;
		}
		if (piWitness(one)) {
			pi = true;
			continue;
		}
		if (isShellArgv(one.foreground?.argv)) {
			shells += 1;
			continue;
		}
		other += 1;
	}
	if (pi) return "yes";
	if (shells > 0 && other === 0 && unread === 0) return "no";
	return "unknown";
}

/** Wait, bounded, for something to have started in the terminal. */
function waitForStart(terminal, deadline) {
	for (;;) {
		const one = facts(terminal);
		if (one && one.state === "live" && startedWitness(one)) return one;
		if (Date.now() >= deadline) return null;
		sleep(Math.min(250, waitMs));
	}
}

function fill(terminal, argv) {
	const one = facts(terminal);
	if (!one) return { outcome: "unreadable", reason: `${hcBin} get ${terminal} did not answer` };
	if (one.state !== "live") return { outcome: "unreadable", reason: `terminal is ${one.state}` };
	const busy = piWitness(one);
	if (busy) return { outcome: "busy", reason: busy };
	if (!Array.isArray(one.foreground?.argv) || one.foreground.argv.length === 0) {
		// hc says live and attached nothing: this is not a shell, and it is not busy either. Typing
		// here lands in no program at all.
		return { outcome: "unreadable", reason: "the terminal has no foreground program" };
	}
	if (!isShellArgv(one.foreground?.argv)) {
		return { outcome: "not-a-shell", reason: one.foreground.argv.join(" ") };
	}
	if (!isShellArgv(one.argv)) {
		// hc still holds the launch command: the program exited on its own and nobody lost it.
		// Filling would overrule the person quitting pi.
		return { outcome: "still-launch", reason: "hc still holds the launch argv" };
	}
	const line = launchLine(argv, one);
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const send = hc(["send", terminal, line]);
		if (!send.ok) return { outcome: "send-failed", reason: send.error.trim() || "hc send exited non-zero" };
		if (waitForStart(terminal, Date.now() + waitMs)) return { outcome: "filled", line };
	}
	const after = facts(terminal);
	if (after && !isQuietShell(after)) {
		// The keystrokes went into something that is not a shell any more: never again this boot.
		return { outcome: "not-a-shell", reason: piWitness(after) || (after.foreground?.argv ?? []).join(" ") };
	}
	return { outcome: "nothing-started", line };
}

function main(argv) {
	if (argv[0] === "--judge") {
		process.stdout.write(judge(argv.slice(1).filter(Boolean)));
		return 0;
	}
	let terminal = "";
	let launch = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--terminal") terminal = String(argv[(i += 1)] ?? "");
		else if (argv[i] === "--argv") {
			try {
				launch = JSON.parse(String(argv[(i += 1)] ?? "[]"));
			} catch {
				launch = [];
			}
		}
	}
	if (!terminal || !Array.isArray(launch) || launch.length === 0) {
		process.stderr.write("usage: herdr-fill.mjs --terminal <id> --argv '<json array>' | --judge <terminal>…\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify({ terminal, ...fill(terminal, launch) })}\n`);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
