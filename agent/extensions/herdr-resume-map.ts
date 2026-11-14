/**
 * herdr-resume-map: the index that lets a reboot bring the pi sessions back.
 *
 * Radar basis: #95 Herdr.
 *
 * herdr-core keeps a terminal alive through a core or host restart and replaces
 * the lost program with a plain shell — it never re-runs the program (see
 * `hc --skill`, `hc keep`). That is the right default for a command, and the
 * wrong outcome for an agent: the conversation is still in
 * `~/.pi/agent/sessions/*.jsonl`, but nothing in the tab points at it.
 *
 * So every pi session that runs inside an hc terminal writes one small entry:
 * the session file, the argv that reproduces the session (wrapper, its flags,
 * pi's own flags, model, thinking), the folder, and the space/tab labels. The
 * restore service (`scripts/herdr-resume.mjs`, `systemd/herdr-resume.service`)
 * reads those entries after a reboot and execs the same session back into the
 * same recovered terminal.
 *
 * Nothing is written outside hc: without `$HC_TERMINAL_ID` this extension does
 * nothing at all. No terminal screen text is captured here either — only the
 * path to the session file, so a reboot cannot spill conversation content onto
 * disk through this path.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

/** Bumped when the entry shape changes in a way the restore script must notice. */
export const ENTRY_VERSION = 1;

export type LaunchMode = "bare" | "sandbox" | "sandbox-nonet" | "plain" | "unknown";

export interface Launch {
	/** Program plus arguments, ready to exec (no `--session`). */
	argv: string[];
	/** `bare` | `sandbox` | `sandbox-nonet` | `plain` | `unknown`. */
	mode: LaunchMode;
	/** Wrapper programme, when the launch went through one. */
	wrapper?: string;
	/** The pi binary the session itself runs. */
	piBin?: string;
	/** pi's own arguments, without the wrapper. */
	piArgv: string[];
}

/** The shells hc starts a lost program back with (`hc --skill`, recovery). */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "nu", "pwsh", "powershell", "elvish", "xonsh"]);

/** True when this argv is a shell, i.e. what recovery leaves behind. */
export function isShellArgv(argv: string[] | null | undefined): boolean {
	if (!Array.isArray(argv) || argv.length === 0) return false;
	const name = basename(String(argv[0]))
		.toLowerCase()
		.replace(/\.exe$/, "");
	return SHELLS.has(name);
}

/** Where the resume entries live; the restore service reads the same path. */
export function entriesDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME ?? ""): string {
	if (env.PI_HERDR_RESUME_DIR) return env.PI_HERDR_RESUME_DIR;
	return join(home, ".pi", "agent", "herdr-resume");
}

/** `t7` and friends; anything else is escaped so a weird id cannot leave the folder. */
export function entryFileName(terminalId: string): string {
	return `${terminalId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}

export interface DeriveInput {
	env: NodeJS.ProcessEnv;
	/** `process.argv` of this pi process. */
	argv: string[];
	home: string;
	/** Injectable for tests; defaults to a filesystem check. */
	exists?: (path: string) => boolean;
}

function firstExisting(paths: string[], exists: (path: string) => boolean): string | undefined {
	for (const path of paths) if (exists(path)) return path;
	return undefined;
}

/**
 * The flags that picked a session are dropped: the restore line names the
 * session file itself, so a recorded `--session <path>` would hand it two.
 */
const SESSION_FLAGS = new Set(["--session", "--session-id", "--fork"]);
const SESSION_SWITCHES = new Set(["-c", "--continue", "-r", "--resume"]);

export function withoutSessionArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (SESSION_FLAGS.has(arg)) {
			index += 1;
			continue;
		}
		if (SESSION_SWITCHES.has(arg)) continue;
		if (/^--(session|session-id|fork)=/.test(arg)) continue;
		out.push(arg);
	}
	return out;
}

/**
 * Rebuild the command line that started this pi, from the markers the wrappers
 * leave in the environment.
 *
 * The wrappers (`scripts/pi-bare`, `scripts/pisandbox`,
 * `big-boss-pi/bin/pi-sandboxed|pi-nonet|pi-bare`) are the only place a mode is
 * decided, and each one exports a marker, so the marker is a faithful record of
 * the wrapper. Inside bubblewrap `/proc` shows only the sandbox's own
 * processes, so walking the parent chain is not an option; the markers are.
 *
 * A mode that cannot be rebuilt yields `unknown` with an empty argv, because a
 * guessed launch is worse than no launch: resuming a sandboxed worker outside
 * its sandbox is a privilege change nobody asked for.
 */
export function deriveLaunch(input: DeriveInput): Launch {
	const { env, argv, home } = input;
	const exists = input.exists ?? ((path: string) => existsSync(path));
	const piArgv = withoutSessionArgs(argv.slice(2));
	const piBin = typeof argv[1] === "string" && isAbsolute(argv[1]) && exists(argv[1]) ? argv[1] : undefined;

	const worker = env.PI_WORKER === "1";
	const workerBare = join(home, "big-boss-pi", "bin", "pi-bare");
	const workerSandboxed = join(home, "big-boss-pi", "bin", "pi-sandboxed");
	const workerNoNet = join(home, "big-boss-pi", "bin", "pi-nonet");
	const sandbox = join(home, ".pi", "scripts", "pisandbox");

	if (env.PI_BARE === "1") {
		const wrapper = worker ? firstExisting([workerBare], exists) : undefined;
		const out = wrapper ? [wrapper, ...piArgv] : piBin ? [piBin, ...piArgv] : [];
		return { argv: out, mode: out.length ? "bare" : "unknown", wrapper, piBin, piArgv };
	}

	if (env.PI_SANDBOX_MODE === "bwrap") {
		const noNet = env.PI_SANDBOX_NET === "off";
		const mode: LaunchMode = noNet ? "sandbox-nonet" : "sandbox";
		if (worker) {
			const wrapper = firstExisting([noNet ? workerNoNet : workerSandboxed], exists);
			if (!wrapper) return { argv: [], mode: "unknown", piBin, piArgv };
			return { argv: [wrapper, ...piArgv], mode, wrapper, piBin, piArgv };
		}
		if (!exists(sandbox)) return { argv: [], mode: "unknown", piBin, piArgv };
		return {
			argv: [sandbox, ...(noNet ? ["--no-net"] : []), "--", ...piArgv],
			mode,
			wrapper: sandbox,
			piBin,
			piArgv,
		};
	}

	return piBin
		? { argv: [piBin, ...piArgv], mode: "plain", piBin, piArgv }
		: { argv: [], mode: "unknown", piBin, piArgv };
}

/** Space and tab names, as herdr-app labels its terminals (`scripts/agent-pane.sh`). */
export function spaceTabOf(labels: Record<string, string> | undefined): { space?: string; tab?: string } {
	const out: { space?: string; tab?: string } = {};
	if (!labels) return out;
	for (const key of ["herdr.space", "space"]) {
		const value = labels[key];
		if (typeof value === "string" && value.length > 0) {
			out.space = value;
			break;
		}
	}
	for (const key of ["herdr.tab", "tab"]) {
		const value = labels[key];
		if (typeof value === "string" && value.length > 0) {
			out.tab = value;
			break;
		}
	}
	return out;
}

/** The kernel's boot id, so a restart is told from a same-boot service rerun. */
export function kernelBootId(): string | undefined {
	try {
		const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export interface TerminalFacts {
	name?: string;
	scope?: string;
	labels: Record<string, string>;
}

/**
 * Labels and name of this terminal, asked of `hc`.
 *
 * Best effort on purpose: a sandboxed worker cannot always reach the core that
 * hosts it, and a missing label must never cost the person their session. The
 * entry is written either way; `space`/`tab` are the only fields that go
 * missing.
 */
export function readTerminalFacts(terminalId: string, timeoutMs = 2000): TerminalFacts | undefined {
	try {
		const out = execFileSync("hc", ["get", terminalId, "--json"], {
			encoding: "utf8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const parsed = JSON.parse(out) as { name?: unknown; scope?: unknown; labels?: unknown };
		const labels: Record<string, string> = {};
		if (parsed.labels && typeof parsed.labels === "object") {
			for (const [key, value] of Object.entries(parsed.labels as Record<string, unknown>)) {
				if (typeof value === "string") labels[key] = value;
			}
		}
		return {
			name: typeof parsed.name === "string" ? parsed.name : undefined,
			scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
			labels,
		};
	} catch {
		return undefined;
	}
}

export interface ResumeEntry {
	version: number;
	terminal: string;
	terminal_name?: string;
	scope?: string;
	session_path: string;
	session_id?: string;
	cwd: string;
	/** Command line that reproduces this session; `--session` is appended on restore. */
	argv: string[];
	mode: LaunchMode;
	wrapper?: string;
	pi_bin?: string;
	model?: string;
	thinking?: string;
	space?: string;
	tab?: string;
	labels: Record<string, string>;
	boot_id?: string;
	pid: number;
	updated_at: string;
}

export interface EntryInput {
	terminalId: string;
	sessionPath: string;
	sessionId?: string;
	cwd: string;
	launch: Launch;
	model?: string;
	thinking?: string;
	facts?: TerminalFacts;
}

/** Build the entry, without touching the disk (the extension only decides when). */
export function buildEntry(input: EntryInput): ResumeEntry {
	const { space, tab } = spaceTabOf(input.facts?.labels);
	const entry: ResumeEntry = {
		version: ENTRY_VERSION,
		terminal: input.terminalId,
		session_path: input.sessionPath,
		cwd: input.cwd,
		argv: input.launch.argv,
		mode: input.launch.mode,
		labels: input.facts?.labels ?? {},
		pid: process.pid,
		updated_at: new Date().toISOString(),
	};
	if (input.facts?.name) entry.terminal_name = input.facts.name;
	if (input.facts?.scope) entry.scope = input.facts.scope;
	if (input.sessionId) entry.session_id = input.sessionId;
	if (input.launch.wrapper) entry.wrapper = input.launch.wrapper;
	if (input.launch.piBin) entry.pi_bin = input.launch.piBin;
	if (input.model) entry.model = input.model;
	if (input.thinking) entry.thinking = input.thinking;
	if (space) entry.space = space;
	if (tab) entry.tab = tab;
	const boot = kernelBootId();
	if (boot) entry.boot_id = boot;
	return entry;
}

/** Write one entry for one terminal; the terminal id is the key, so this overwrites. */
export function writeEntry(entry: ResumeEntry, dir = entriesDir()): string {
	const fileName = entryFileName(entry.terminal);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, fileName);
	const temp = join(dir, `.${fileName}.${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`);
	renameSync(temp, target);
	return target;
}

export default function herdrResumeMap(pi: ExtensionAPI) {
	const terminalId = process.env.HC_TERMINAL_ID;
	// Outside hc there is nothing to restore into, and no reason to write.
	if (!terminalId) return;

	const dir = entriesDir();
	let lastKey = "";
	let facts: TerminalFacts | undefined | null = null;

	function record(ctx: any): void {
		try {
			// TUI only: `-p`, JSON and RPC sessions have no terminal a person
			// comes back to, and RPC still reports hasUI=true.
			if (ctx?.mode !== "tui") return;

			const sessionPath: unknown = ctx?.sessionManager?.getSessionFile?.();
			if (typeof sessionPath !== "string" || !isAbsolute(sessionPath)) return;

			const launch = deriveLaunch({ env: process.env, argv: process.argv, home: process.env.HOME ?? "" });

			// Asked once per process: labels do not change under a running session,
			// and `hc get` costs a subprocess.
			if (facts === null) facts = readTerminalFacts(terminalId);

			const sessionId: unknown = ctx?.sessionManager?.getSessionId?.();
			const entry = buildEntry({
				terminalId,
				sessionPath,
				sessionId: typeof sessionId === "string" ? sessionId : undefined,
				cwd: String(ctx?.cwd ?? process.cwd()),
				launch,
				model: typeof ctx?.model?.id === "string" ? ctx.model.id : undefined,
				thinking: typeof ctx?.thinkingLevel === "string" ? ctx.thinkingLevel : undefined,
				facts: facts ?? undefined,
			});

			// Every field except the timestamp: a turn that changes nothing must
			// not rewrite the file, and a switch or a new model must.
			const { updated_at: _stamp, ...stable } = entry;
			const key = JSON.stringify(stable);
			if (key === lastKey) return;
			writeEntry(entry, dir);
			lastKey = key;
		} catch (error) {
			// A resume map that fails to write must never break the session, but a
			// map that fails silently is a restore that never happens: one line.
			try {
				appendFileSync(join(dir, "extension.log"), `${new Date().toISOString()} ${String(error)}\n`);
			} catch {
				// nothing left to do
			}
		}
	}

	pi.on("session_start", (_event: any, ctx: any) => record(ctx));
	// A session can gain its file (or change folder) after the first turn: keep
	// the map honest without copying screen text or rereading the transcript.
	pi.on("agent_start", (_event: any, ctx: any) => record(ctx));
	pi.on("agent_settled", (_event: any, ctx: any) => record(ctx));
}
