/**
 * Self-learning harness: after a compaction, a *separate* pi session judges
 * whether the harness itself should change.
 *
 * Radar basis: #11 feedback flywheel (Trial), #18 self-improving harness
 * (Trial), #36 agent instruction bloat (Caution), #17 risk-tiered human
 * oversight (Trial), #42 human-in-the-loop theater (Caution).
 *
 * Three rules shape everything here:
 *
 * 1. **The session is not the student.** This extension never edits the repo and
 *    never patches the prompt. It writes a queue file and starts another pi
 *    process (a Herdr pane when Herdr is up, otherwise a headless sandboxed
 *    run), so a slow or talkative reflection cannot stall, pollute or lengthen
 *    the conversation that triggered it. The child gets `PI_SELF_LEARN=1` and
 *    therefore never spawns a learner of its own.
 * 2. **Most compactions do nothing.** A gate runs first, with no model call: two
 *    or more of the same failed tool signature, or one `/suggest` note, in the
 *    window since the last compaction. Everything else is silence — a reflection
 *    nobody needed is cost with extra steps.
 * 3. **The output is a proposal, never a change.** Applying it is a High-tier
 *    review. An agent that rewrites its own system prompt unread is the failure
 *    mode blips 17 and 42 are about.
 *
 * Proposals land in `~/.pi/agent/proposals/` (outside git, next to
 * `suggestions.jsonl` and `retro/`), one Markdown file with a `git apply`-able
 * diff or a recorded "nothing". `proposals/runs.jsonl` is the audit trail and
 * the machine-wide debounce: no lock file to go stale.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROPOSAL_DIR = join(DIR, "proposals");
const QUEUE_DIR = join(PROPOSAL_DIR, "queue");
const LOG = join(PROPOSAL_DIR, "runs.jsonl");
const SUGGESTIONS = join(DIR, "suggestions.jsonl");
const REPO = join(homedir(), ".pi");
const SPEC = join(REPO, "agent", "prompts", "learn.md");

/** Two occurrences of one failure is a pattern; one is an accident. */
export const MIN_REPEATS = 2;
/** At most one learner per session this often. */
export const MIN_GAP_MS = 10 * 60 * 1000;
/** A session that keeps failing may teach twice; not more. */
export const MAX_PER_SESSION = 2;

/** One repeated failure: how often, where, and a redacted sample. */
export interface Failure {
	count: number;
	tool: string;
	/** Redacted, clipped error text. A bare hash is undiagnosable. */
	sample: string;
}

export interface Evidence {
	/** Failed-tool signature → occurrences since the last compaction. */
	errors: Map<string, Failure>;
	/** `/suggest` notes the user wrote since the last compaction. */
	notes: number;
	spawnsThisSession: number;
	/** Last learner anywhere on this machine, from runs.jsonl (any session). */
	lastSpawnAt: number | null;
	now: number;
}

export interface Decision {
	spawn: boolean;
	reason: string;
}

/** The repeated failure with the highest count, if any reached the threshold. */
export function worstError(errors: Map<string, Failure>): [string, number] | null {
	let best: [string, number] | null = null;
	for (const [signature, failure] of errors) {
		if (failure.count < MIN_REPEATS) continue;
		if (!best || failure.count > best[1]) best = [signature, failure.count];
	}
	return best;
}

/** Should this compaction start a learner? Pure: the whole gate is here. */
export function decideLearner(input: Evidence): Decision {
	const { errors, notes, spawnsThisSession, lastSpawnAt, now } = input;
	const repeated = worstError(errors);
	if (!repeated && notes < 1) {
		return { spawn: false, reason: "no repeated failure and no /suggest note — nothing to learn" };
	}
	if (spawnsThisSession >= MAX_PER_SESSION) {
		return { spawn: false, reason: `already started ${spawnsThisSession} learners this session` };
	}
	if (lastSpawnAt !== null && now - lastSpawnAt < MIN_GAP_MS) {
		const mins = Math.ceil((MIN_GAP_MS - (now - lastSpawnAt)) / 60000);
		return { spawn: false, reason: `last learner ran ${Math.round((now - lastSpawnAt) / 60000)} min ago — next in ${mins} min` };
	}
	const why = repeated
		? `${repeated[1]}× ${shortSignature(repeated[0])}`
		: `${notes} /suggest note${notes === 1 ? "" : "s"}`;
	return { spawn: true, reason: why };
}

/** Byte-stable signature for a failure: the message, minus ids and numbers. */
export function signatureOf(tool: string, message: string): string {
	const normal = message
		.replace(/0x[0-9a-f]+/gi, "0x…")
		.replace(/\b\d{3,}\b/g, "N")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	return createHash("sha256").update(`${tool}\u0000${normal}`).digest("hex").slice(0, 12);
}

/** Long enough to recognise, short enough that a queue file stays readable. */
export function clipSample(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

export function shortSignature(signature: string): string {
	return signature.slice(0, 12);
}

const SECRET_PATTERNS: [RegExp, string][] = [
	[/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "<redacted-key>"],
	[/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-token>"],
	[/\bAKIA[0-9A-Z]{12,}/g, "<redacted-aws-key>"],
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted-email>"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>"],
	[/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=<redacted>"],
];

/** Evidence is copied into a prompt, so it leaves with the secrets removed. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/** How the learner is started, given what this machine has. */
export interface Launcher {
	argv: string[];
	/** "pane" is visible in Herdr; "headless" runs detached with a log. */
	kind: "pane" | "headless";
}

/**
 * Prefer a Herdr pane: the work is visible, it is a real pi session, and the
 * user can watch or close it. Fall back to a detached sandboxed `pi -p` so the
 * feature still works without Herdr (and in a plain ssh session).
 */
export function pickLauncher(has: (cmd: string) => boolean, slug: string, specPath: string): Launcher {
	const paneScript = join(REPO, "scripts", "agent-pane.sh");
	if (has("hc") && existsSync(paneScript)) {
		return { argv: [paneScript, "spawn", slug, specPath], kind: "pane" };
	}
	const pisandbox = join(REPO, "scripts", "pisandbox");
	const prompt = `Read and execute ${specPath}`;
	if (existsSync(pisandbox)) {
		return { argv: [pisandbox, "--", "pi", "-p", prompt], kind: "headless" };
	}
	return { argv: ["pi", "-p", prompt], kind: "headless" };
}

export interface SelfLearnDeps {
	/** Start the learner; the default spawns detached and never waits. */
	start?: (launcher: Launcher, env: NodeJS.ProcessEnv) => void;
	/** `/suggest` notes written since `sinceIso`. */
	countNotes?: (sinceIso: string | null) => Promise<number>;
	/** Command availability probe, for the launcher choice. */
	has?: (cmd: string) => boolean;
	now?: () => number;
}

function detached(launcher: Launcher, env: NodeJS.ProcessEnv): void {
	const child = spawn(launcher.argv[0], launcher.argv.slice(1), {
		detached: true,
		stdio: launcher.kind === "headless" ? "ignore" : ["ignore", "ignore", "ignore"],
		cwd: REPO,
		env: { ...process.env, ...env },
	});
	child.unref();
}

export default function selfLearn(pi: ExtensionAPI, deps: SelfLearnDeps = {}) {
	const start = deps.start ?? detached;
	const has = deps.has ?? ((cmd: string) => existsSync(`/home/mark/.local/bin/${cmd}`));
	const now = deps.now ?? (() => Date.now());
	const countNotes = deps.countNotes ?? (async (sinceIso: string | null) => {
		try {
			const raw = await readFile(SUGGESTIONS, "utf8");
			return raw
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line) as { kind?: string; ts?: string };
					} catch {
						return null;
					}
				})
				.filter((entry): entry is { kind?: string; ts?: string } => entry !== null)
				.filter((entry) => entry.kind === "note" && (!sinceIso || (entry.ts ?? "") > sinceIso)).length;
		} catch {
			return 0;
		}
	});

	let errors = new Map<string, Failure>();
	let lastCompactIso: string | null = null;
	let spawns = 0;
	let lastSpawnAt: number | null = null;
	let disabled = Boolean(process.env.PI_SELF_LEARN);

	const reset = () => {
		errors = new Map();
		lastCompactIso = null;
		spawns = 0;
		lastSpawnAt = null;
	};

	pi.on("session_start", () => {
		reset();
	});

	pi.on("tool_result", (event: any) => {
		if (!event?.isError) return;
		const tool = event.toolName ?? "unknown";
		const message = typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "");
		const signature = signatureOf(tool, message);
		const seen = errors.get(signature);
		if (seen) seen.count += 1;
		else errors.set(signature, { count: 1, tool, sample: clipSample(redact(message)) });
	});

	async function learn(trigger: "compact" | "manual", ctx: any): Promise<Decision> {
		const at = now();
		const notes = await countNotes(lastCompactIso);
		const machineLast = await lastSpawnAnywhere();
		const candidates = [lastSpawnAt, machineLast].filter((value): value is number => typeof value === "number");
		const lastAnywhere = candidates.length ? Math.max(...candidates) : null;
		const decision = decideLearner({ errors, notes, spawnsThisSession: spawns, lastSpawnAt: lastAnywhere, now: at });
		if (!decision.spawn) return decision;

		const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
		const queuePath = join(QUEUE_DIR, `${stamp}.md`);
		const proposalPath = join(PROPOSAL_DIR, `${new Date(at).toISOString().slice(0, 10)}-${stamp.slice(11)}.md`);
		await mkdir(QUEUE_DIR, { recursive: true });
		await writeFile(queuePath, evidenceMarkdown({ trigger, decision, errors, notes, at, proposalPath }), "utf8");

		const launcher = pickLauncher(has, `learn-${stamp.slice(11, 16)}`, queuePath);
		try {
			start(launcher, { PI_SELF_LEARN: "1" });
		} catch (error) {
			await record({ ts: new Date(at).toISOString(), kind: "spawn-failed", reason: String(error) });
			return { spawn: false, reason: `could not start a learner: ${String(error)}` };
		}

		spawns += 1;
		lastSpawnAt = at;
		lastCompactIso = new Date(at).toISOString();
		errors = new Map();
		await record({
			ts: new Date(at).toISOString(),
			kind: "spawned",
			trigger,
			launcher: launcher.kind,
			queue: queuePath,
			reason: decision.reason,
		});
		try {
			ctx?.ui?.notify(`learner started in a separate pi session (${launcher.kind}): ${decision.reason}`, "info");
		} catch {
			// A notify failing must never break the session.
		}
		return decision;
	}

	/**
	 * Last learner started by any session on this machine. The run log is the
	 * debounce instead of a lock file: a crashed learner leaves nothing to clean
	 * up, and two sessions cannot both start a reflection in the same minute.
	 */
	async function lastSpawnAnywhere(): Promise<number | null> {
		try {
			const raw = await readFile(LOG, "utf8");
			const stamped = raw
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line) as { kind?: string; ts?: string };
					} catch {
						return null;
					}
				})
				.filter((entry): entry is { kind?: string; ts?: string } => entry?.kind === "spawned")
				.map((entry) => Date.parse(entry.ts ?? ""))
				.filter((value) => Number.isFinite(value));
			return stamped.length ? Math.max(...stamped) : null;
		} catch {
			return null;
		}
	}

	async function record(entry: Record<string, unknown>): Promise<void> {
		try {
			await mkdir(PROPOSAL_DIR, { recursive: true });
			await appendFile(LOG, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// Logging is not worth an exception.
		}
	}

	pi.on("session_compact", async (_event: any, ctx: any) => {
		if (disabled) return;
		try {
			await learn("compact", ctx);
		} catch {
			// The gate failing must never break the session that just compacted.
		}
	});

	pi.registerCommand("learn", {
		description: "Judge the harness from this session's evidence in a separate pi session",
		handler: async (_args: string, ctx: any) => {
			const decision = await learn("manual", ctx);
			if (!decision.spawn && decision.reason.startsWith("already")) {
				ctx.ui.notify(`learner not started: ${decision.reason}`, "warning");
			} else if (!decision.spawn) {
				ctx.ui.notify(`nothing worth learning right now: ${decision.reason}`, "info");
			}
		},
	});

	return { learn, reset, setDisabled: (value: boolean) => (disabled = value) };
}

function evidenceMarkdown(input: {
	trigger: "compact" | "manual";
	decision: Decision;
	errors: Map<string, Failure>;
	notes: number;
	at: number;
	proposalPath: string;
}): string {
	const { trigger, decision, errors, notes, at, proposalPath } = input;
	const lines: string[] = [
		`# Self-learn evidence ${new Date(at).toISOString()}`,
		"",
		`Trigger: ${trigger}. Gate: ${decision.reason}.`,
		`Write your proposal to: \`${proposalPath}\``,
		`Spec: \`${SPEC}\`.`,
		"",
		"## Failed tool calls since the last compaction",
		"",
	];
	if (errors.size === 0) lines.push("None.");
	else {
		lines.push(
			"| signature | tool | count | what it said (redacted) |",
			"| --- | --- | --- | --- |",
		);
		for (const [signature, failure] of [...errors].sort((a, b) => b[1].count - a[1].count)) {
			const sample = failure.sample.replace(/\|/g, "\\|").replace(/\n/g, " ");
			lines.push(`| \`${shortSignature(signature)}\` | ${failure.tool} | ${failure.count} | ${sample} |`);
		}
	}
	lines.push("", `## /suggest notes since the last compaction`, "", notes === 0 ? "None." : `${notes} note(s) — see \`${SUGGESTIONS}\` (already redacted).`, "");
	lines.push(
		"## How this was produced",
		"",
		"`agent/extensions/self-learn.ts` counted failed tool results in the session that just",
		"compacted and tripped its gate. Messages are hashed to a signature before they are",
		"counted, so raw error text is not in this file.",
	);
	return `${redact(lines.join("\n"))}\n`;
}
