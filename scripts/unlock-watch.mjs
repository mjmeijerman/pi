#!/usr/bin/env node
/**
 * unlock-watch — finish a boot that started before the volume was readable.
 *
 * Radar basis: blip 20 (stateful guardrails), blip 95 (Herdr).
 *
 * Why this exists, measured 2026-11-26: `D:/` is BitLocker-locked at logon, so the `backupdrive`
 * space comes back as an empty shell. The logon entries run once, while `D:/` is still locked:
 * `scripts/herdr-resume.mjs` finds nothing to type into and `bin/guard` answers "project folder is
 * gone, skipped". Nothing runs again when the person unlocks the volume, so the fix was two
 * commands typed by hand (`bin/guard --once --space backupdrive`, then `herdr-resume.sh`).
 *
 * This is that wait, and nothing else:
 *
 *   - it waits for a *file* on the volume to read (`D:/AGENTS.md` by default). `-d D:/` is the
 *     wrong question: a locked BitLocker volume answers yes to it before a byte is readable, and
 *     a volume that is not mounted yet answers no. A file read is the question that is true only
 *     when the person's unlock has landed.
 *   - when it reads, it runs one pass of the guard for that one space and the resume sweep, then
 *     says so in one line — and stops. Not a second guard and not a second resume: `bin/guard`
 *     and `scripts/herdr-resume.mjs` are called, never copied. Their rules (a live pi never gets a
 *     second paste, one restore per boot, a busy terminal is skipped, nothing is closed) are why
 *     running them again is safe; this file has no typing of its own.
 *   - while the marker cannot be read it says nothing at all. One line per run is the whole log,
 *     because a poll every few seconds that narrated itself would bury the one line that matters.
 *   - it is bounded: a poll interval, then a longer one after `--patience` (10 s for the first 5
 *     minutes, then 5 minutes), never a spin and never a 5-second loop for an hour. `--timeout`
 *     ends it; the default waits.
 *
 * Invoked by `bin/guard` when a recorded space sits on a drive root that is not readable yet (one
 * watcher per space, by pid file), and runnable by hand for the same job. It is a node script on
 * purpose: the Windows logon entry reaches it through the guard's own resolved `node`, not through
 * a second hidden launcher and not through `PATH`.
 *
 * Usage:
 *   node scripts/unlock-watch.mjs --space <slug> [options]
 *
 *   --space <slug>        the recorded space to finish booting (required)
 *   --project <folder>    override the record's project folder
 *   --marker <file>       what "readable" means (default <project>/AGENTS.md)
 *   --guard <path>        bin/guard (default <this checkout>/bin/guard)
 *   --resume <path>       scripts/herdr-resume.mjs (default <this checkout>/scripts/…)
 *   --log <file>          where the one line goes (default <state>/unlock-watch.log)
 *   --pid-file <file>     written with this process's pid, removed on exit
 *   --interval <d>        poll while the marker is unreadable (default 10s)
 *   --patience <d>        how long to poll fast before falling back (default 5m)
 *   --slow-interval <d>   the fallback interval, after --patience (default 5m)
 *   --timeout <d>         give up after this long; 0 (the default) waits
 *   --once                ask the marker once, act or say it is still unreadable, and exit
 *   --dry-run             say what it would run and touch no space
 *   --quiet               no stdout (the guard spawns it this way; the line is in --log)
 *
 * A duration is a number with `ms`, `s`, `m` or `h` (a bare number is seconds).
 *
 * Environment (all optional, the flags win):
 *   PI_UNLOCK_MARKER, PI_UNLOCK_GUARD, PI_UNLOCK_RESUME, PI_UNLOCK_LOG, PI_UNLOCK_PID_FILE,
 *   PI_UNLOCK_INTERVAL, PI_UNLOCK_PATIENCE, PI_UNLOCK_SLOW_INTERVAL, PI_UNLOCK_TIMEOUT,
 *   PI_UNLOCK_BASH (the bash `bin/guard` is run with; it is a bash script, not an executable on
 *   Windows) and PI_UNLOCK_QUIET. `PI_SPACE_ROOT` and every `PI_HERDR_RESUME_*` / `PI_GUARD_*`
 *   value is passed through untouched, so the resume sweep keeps its own test hooks.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** The checkout this file lives in: `bin/guard` and `scripts/herdr-resume.mjs` are beside it. */
const piHome = dirname(here);
const stateDir = join(process.env.PI_SPACE_ROOT || piHome, "state");

const env = process.env;

function usage() {
	process.stderr.write(`${readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, "")}`);
	process.exit(2);
}

/** A duration: `10s`, `5m`, `500ms`, or a bare number of seconds. */
function duration(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/.exec(String(value).trim());
	if (!match) throw new Error(`not a duration: ${value}`);
	const scale = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? "s"];
	return Math.round(Number(match[1]) * scale);
}

function parse(argv) {
	const opts = {
		space: env.PI_UNLOCK_SPACE || "",
		project: "",
		marker: env.PI_UNLOCK_MARKER || "",
		guard: env.PI_UNLOCK_GUARD || join(piHome, "bin", "guard"),
		resume: env.PI_UNLOCK_RESUME || join(piHome, "scripts", "herdr-resume.mjs"),
		log: env.PI_UNLOCK_LOG || join(stateDir, "unlock-watch.log"),
		pidFile: env.PI_UNLOCK_PID_FILE || "",
		interval: duration(env.PI_UNLOCK_INTERVAL, 10000),
		patience: duration(env.PI_UNLOCK_PATIENCE, 300000),
		slowInterval: duration(env.PI_UNLOCK_SLOW_INTERVAL, 300000),
		timeout: duration(env.PI_UNLOCK_TIMEOUT, 0),
		once: false,
		dryRun: false,
		quiet: env.PI_UNLOCK_QUIET === "1",
	};
	const takes = {
		"--space": "space",
		"--project": "project",
		"--marker": "marker",
		"--guard": "guard",
		"--resume": "resume",
		"--log": "log",
		"--pid-file": "pidFile",
	};
	const durations = {
		"--interval": "interval",
		"--patience": "patience",
		"--slow-interval": "slowInterval",
		"--timeout": "timeout",
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const next = () => (inline !== undefined ? inline : argv[++i]);
		if (flag === "--help" || flag === "-h") usage();
		else if (flag === "--once") opts.once = true;
		else if (flag === "--dry-run") opts.dryRun = true;
		else if (flag === "--quiet") opts.quiet = true;
		else if (takes[flag]) opts[takes[flag]] = next();
		else if (durations[flag]) opts[durations[flag]] = duration(next(), 0);
		else throw new Error(`unknown option ${arg} (--help)`);
	}
	return opts;
}

const opts = (() => {
	try {
		return parse(process.argv.slice(2));
	} catch (error) {
		// A bad flag is one line for the person who typed it, not a stack trace.
		process.stderr.write(`unlock-watch: ${error?.message ?? error}\n`);
		process.exit(2);
	}
})();
if (!opts.space) usage();
if (!opts.project) {
	// The record is the only place the folder is written down; the guard passes it, a person
	// running this by hand does not have to.
	try {
		opts.project = JSON.parse(readFileSync(join(stateDir, "spaces", opts.space, "space.json"), "utf8")).project || "";
	} catch {
		opts.project = "";
	}
}
if (!opts.project) {
	process.stderr.write(`unlock-watch: no project folder for ${opts.space} (no record at ${join(stateDir, "spaces", opts.space, "space.json")}, and no --project)\n`);
	process.exit(2);
}
opts.marker = opts.marker || join(opts.project, "AGENTS.md");

/** One line per run, and no other line: the file and stdout say the same thing once. */
function say(message) {
	const line = `${new Date().toISOString()} ${message}`;
	if (!opts.quiet) process.stdout.write(`${line}\n`);
	try {
		mkdirSync(dirname(opts.log), { recursive: true });
		appendFileSync(opts.log, `${line}\n`);
	} catch {}
}

/**
 * Readable / missing / locked — the one question this program waits on.
 *
 * `missing` is not `locked`: a marker that is not there on a folder that lists is a wrong marker
 * name, and polling it for an hour would be a program that never says what is wrong. A volume
 * that is locked (or not mounted) fails the listing itself, which is the case that has to wait.
 */
function markerState() {
	try {
		readFileSync(opts.marker);
		return "readable";
	} catch (error) {
		if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			try {
				readdirSync(opts.project);
				return "missing";
			} catch {
				return "locked";
			}
		}
		return "locked";
	}
}

/** Sleep without a spin: no timer, no CPU, and a poll that costs nothing while it waits. */
function sleep(ms) {
	if (!(ms > 0)) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function elapsed(start) {
	const ms = Date.now() - start;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60000);
	return `${minutes}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

/** bash: `bin/guard` is a bash script. On Windows a shebang is not executable at all. */
function resolveBash() {
	if (env.PI_UNLOCK_BASH) return env.PI_UNLOCK_BASH;
	const exe = process.platform === "win32" ? ["bash.exe", "bash"] : ["bash"];
	for (const dir of (env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
		if (!dir) continue;
		for (const name of exe) {
			const candidate = join(dir, name);
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {}
		}
	}
	for (const candidate of [`${env.ProgramFiles || "C:\\Program Files"}\\Git\\bin\\bash.exe`, "/bin/bash", "/usr/bin/bash"]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return "";
}

function run(program, args, label) {
	const result = spawnSync(program, args, {
		encoding: "utf8",
		timeout: 180000,
		env: env,
		windowsHide: true,
	});
	if (result.error) return { ok: false, out: "", why: `${label} did not start: ${result.error.message}` };
	const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.status !== 0) return { ok: false, out, why: `${label} exited ${result.status}` };
	return { ok: true, out, why: "" };
}

/**
 * act — the one thing this program does when the marker reads: the guard's pass for this space,
 * then the resume sweep, in that order. Their own idempotency is the reason a second run is safe,
 * so nothing is tracked here about what has been done before.
 */
function act(waited) {
	const lines = [];
	if (!existsSync(opts.guard)) {
		lines.push(`guard: not run (${opts.guard} missing)`);
	} else {
		const bash = resolveBash();
		if (!bash) {
			lines.push("guard: not run (no bash found — set PI_UNLOCK_BASH)");
		} else {
			const pass = run(bash, [opts.guard, "--once", "--space", opts.space], "guard");
			const said = pass.out.split("\n").map((l) => l.trim()).filter(Boolean);
			if (!pass.ok) lines.push(`guard: ${pass.why}`);
			else if (said.length === 0) lines.push("guard: nothing to repair");
			else lines.push(`guard: ${said.length} action(s) — ${said[said.length - 1]}`);
		}
	}
	if (!existsSync(opts.resume)) {
		lines.push(`resume: not run (${opts.resume} missing)`);
	} else {
		const sweep = run(process.execPath, [opts.resume], "resume");
		if (!sweep.ok) lines.push(`resume: ${sweep.why}`);
		else {
			const said = sweep.out.split("\n");
			const restored = said.filter((l) => /^\d{4}-\d{2}-\d{2}T\S+ restored /.test(l)).length;
			const skipped = said.filter((l) => /^\d{4}-\d{2}-\d{2}T\S+ skip /.test(l)).length;
			// What the sweep said, never more: `nothing to restore` is its own wording for "every
			// entry was skipped", and a live pi is one of the reasons it gives.
			const restore = restored === 0 ? "nothing to restore" : `restored ${restored}`;
			lines.push(`resume: ${restore}${skipped > 0 ? `, ${skipped} skipped` : ""}`);
		}
	}
	return lines.join("; ");
}

/** The pid file is the guard's one-watcher-per-space lock; it is left behind by a crash only. */
function dropPidFile() {
	if (!opts.pidFile) return;
	try {
		if (readFileSync(opts.pidFile, "utf8").trim() === String(process.pid)) rmSync(opts.pidFile, { force: true });
	} catch {}
}

function main() {
	const start = Date.now();
	if (!opts.dryRun && opts.pidFile) {
		try {
			mkdirSync(dirname(opts.pidFile), { recursive: true });
			writeFileSync(opts.pidFile, `${process.pid}\n`);
		} catch {}
	}
	process.on("exit", dropPidFile);
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));

	let waited = "";
	for (;;) {
		const state = markerState();
		if (state === "readable") {
			if (opts.dryRun) {
				say(`${opts.space}: ${opts.marker} is readable — dry-run: would run ${opts.guard} --once --space ${opts.space}, then ${opts.resume}`);
				return 0;
			}
			say(`${opts.space}: ${opts.marker} readable${waited ? ` after ${waited}` : ""} — ${act(start)}`);
			return 0;
		}
		if (state === "missing") {
			say(`${opts.space}: ${opts.project} is readable but ${opts.marker} is not a file, so nothing was run — pass --marker with a file that is on the volume`);
			return 0;
		}
		if (opts.once) {
			say(`${opts.space}: ${opts.marker} is still unreadable — --once asked once, nothing was run`);
			return 0;
		}
		if (opts.timeout > 0 && Date.now() - start >= opts.timeout) {
			say(`${opts.space}: ${opts.marker} is still unreadable after ${elapsed(start)} — gave up, no guard pass and no resume`);
			return 0;
		}
		waited = elapsed(start);
		const waitedMs = Date.now() - start;
		sleep(waitedMs < opts.patience ? opts.interval : opts.slowInterval);
	}
}

try {
	process.exitCode = main();
} catch (error) {
	say(`${opts.space}: stopped on an error — ${error?.message ?? error}`);
	process.exitCode = 1;
}
