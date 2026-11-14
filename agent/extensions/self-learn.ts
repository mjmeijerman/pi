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
 *    therefore never spawns a learner of its own. A launch is *verified*: a pane
 *    that exits 0 without creating a herdr space is a failure, and the headless
 *    launcher takes over.
 * 2. **Most compactions do nothing.** A gate runs first, with no model call: two
 *    or more of the same failed tool signature, or one `/suggest` note, in the
 *    window since the last compaction. Everything else is silence — a reflection
 *    nobody needed is cost with extra steps.
 * 3. **The output is a proposal and a branch, never a merge.** The learner writes
 *    one proposal, commits it on its own feature branch and hands the PR to
 *    big-boss-pi; reading and merging stays a High-tier human review. An agent
 *    that rewrites its own system prompt unread is the failure mode blips 17 and
 *    42 are about.
 *
 * Detection has two sources, because there are two compaction paths: pi's own
 * `session_compact` event, and a compaction entry committed at a turn boundary
 * with no event (what pi-observational-memory does — it runs below pi's own
 * auto-compaction threshold, so without this the learner would never start).
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
const PANE_SCRIPT = join(REPO, "scripts", "agent-pane.sh");
/** The boss publishes; the learner hands it the branch, the sha and the proposal. */
const BBP_BARE = join(homedir(), "big-boss-pi", "bin", "pi-bare");

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

/**
 * Ids of the compaction entries on a branch, oldest first.
 *
 * Why this exists: pi-observational-memory (0.87+) returns its compaction draft
 * from its `turn_end` handler, so pi commits it in `_commitBoundaryDrafts` →
 * `sessionManager.appendCompaction` and emits only the internal `entry_appended`
 * event. `session_compact` never fires for that path, and om compacts well below
 * pi's own auto-compaction threshold, so an extension that only listens for
 * `session_compact` never learns. The committed entry is the signal.
 */
export function compactionEntryIds(entries: unknown): string[] {
	if (!Array.isArray(entries)) return [];
	const ids: string[] = [];
	for (const entry of entries as { type?: string; id?: string }[]) {
		if (entry?.type === "compaction" && typeof entry.id === "string") ids.push(entry.id);
	}
	return ids;
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
	/**
	 * Where the learner starts. Always the repo: the queue directory made the one
	 * learner that ever ran work in `~/.pi/agent/proposals/queue` and never reach
	 * the code it was meant to judge.
	 */
	cwd: string;
}

/**
 * Prefer a Herdr pane: the work is visible, it is a real pi session, and the
 * user can watch or close it. Fall back to a detached sandboxed `pi -p` so the
 * feature still works without Herdr (and in a plain ssh session).
 *
 * `cwd` is passed explicitly (`--cwd`) because agent-pane.sh otherwise spawns in
 * the spec's directory — the queue, not the repo.
 */
export function pickLauncher(
	has: (cmd: string) => boolean,
	slug: string,
	specPath: string,
	exists: (path: string) => boolean = existsSync,
	cwd: string = REPO,
	preferPane = true,
): Launcher {
	if (preferPane && has("hc") && exists(PANE_SCRIPT)) {
		return { argv: [PANE_SCRIPT, "spawn", slug, specPath, "--cwd", cwd], kind: "pane", cwd };
	}
	const pisandbox = join(REPO, "scripts", "pisandbox");
	const prompt = `Read and execute ${specPath}`;
	if (exists(pisandbox)) {
		return { argv: [pisandbox, "--", "pi", "-p", prompt], kind: "headless", cwd };
	}
	return { argv: ["pi", "-p", prompt], kind: "headless", cwd };
}

function shellQuote(word: string): string {
	return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * Make a headless learner close its own space when pi exits, however it exits.
 *
 * A pane learner can run `agent-pane.sh close SLUG` as its last step; a headless
 * one has no space, so the same call is harmless. Wrapping the command is the
 * part the extension can enforce instead of hoping the prompt was remembered.
 */
export function withSelfClose(launcher: Launcher, slug: string): Launcher {
	if (launcher.kind !== "headless") return launcher;
	const command = launcher.argv.map(shellQuote).join(" ");
	const close = [PANE_SCRIPT, "close", slug].map(shellQuote).join(" ");
	return { ...launcher, argv: ["sh", "-c", `${command}; rc=$?; ${close} >/dev/null 2>&1 || true; exit $rc`] };
}

/** What a launch attempt actually produced. `ok: false` is the interesting case. */
export interface LaunchResult {
	ok: boolean;
	/** Exit status of the launcher, when it exited. Null when it never did. */
	status?: number | null;
	/** Clipped, redacted stderr (or the reason), or the terminal id on success. */
	detail?: string;
}

/** agent-pane.sh waits up to 40 s for pi's banner before it sends the spec. */
export const PANE_TIMEOUT_MS = 45_000;
/** A headless learner that is still alive after this has started. */
export const HEADLESS_GRACE_MS = 2_000;
const MAX_DETAIL = 400;
const MAX_CAPTURE = 64 * 1024;

/** One line, secrets removed, clipped: stderr goes into runs.jsonl verbatim. */
export function clipDetail(text: string): string {
	const oneLine = redact(text).replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL - 1)}…` : oneLine;
}

/**
 * The terminal id agent-pane.sh prints on success: `{"slug":…,"terminal":"t7"…}`.
 * Empty, unparsable or terminal-less stdout means no space was created, however
 * cheerfully the script exited — the bug that wrote four lying `spawned` rows.
 */
export function paneTerminal(stdout: string): string | null {
	for (const raw of stdout.split("\n").reverse()) {
		const line = raw.trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as { terminal?: unknown };
			if (typeof parsed.terminal === "string" && parsed.terminal.trim()) return parsed.terminal.trim();
		} catch {
			// Not the spawn report; keep looking.
		}
	}
	return null;
}

/**
 * Run the launcher and check that a learner exists afterwards.
 *
 * A pane launch must exit 0 *and* print a terminal id: a space that does not
 * appear is a failure. A headless launch is checked by survival — if it is still
 * running after the grace window it started, and a fast exit is a fast failure.
 * Never throws, never rejects: this runs in the background of a live session.
 */
export function verifyLaunch(
	launcher: Launcher,
	env: NodeJS.ProcessEnv,
	options: { paneTimeoutMs?: number; graceMs?: number } = {},
): Promise<LaunchResult> {
	const pane = launcher.kind === "pane";
	const timeoutMs = pane ? (options.paneTimeoutMs ?? PANE_TIMEOUT_MS) : (options.graceMs ?? HEADLESS_GRACE_MS);
	return new Promise<LaunchResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: LaunchResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		let child: any;
		try {
			child = spawn(launcher.argv[0], launcher.argv.slice(1), {
				cwd: launcher.cwd,
				env: { ...process.env, ...env },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({ ok: false, status: null, detail: clipDetail(String(error)) });
			return;
		}
		child.stdout?.on("data", (chunk: unknown) => {
			if (!settled) stdout = (stdout + String(chunk ?? "")).slice(-MAX_CAPTURE);
		});
		child.stderr?.on("data", (chunk: unknown) => {
			if (!settled) stderr = (stderr + String(chunk ?? "")).slice(-MAX_CAPTURE);
		});
		child.on("error", (error: unknown) => {
			finish({ ok: false, status: null, detail: clipDetail(String(error)) });
		});
		child.on("exit", (code: number | null, signal: string | null) => {
			if (!pane) {
				if (code === 0) finish({ ok: true, status: 0 });
				else finish({ ok: false, status: code, detail: clipDetail(stderr || `exit ${signal ?? code}`) });
				return;
			}
			const terminal = paneTerminal(stdout);
			if (code !== 0) finish({ ok: false, status: code, detail: clipDetail(stderr || `agent-pane.sh exited ${signal ?? code}`) });
			else if (!terminal) finish({ ok: false, status: 0, detail: clipDetail(stderr || "exited 0 without a herdr space") });
			else finish({ ok: true, status: 0, detail: terminal });
		});
		timer = setTimeout(() => {
			if (!pane) {
				// Alive past the grace window: it started. Watch no further.
				finish({ ok: true, status: null });
				return;
			}
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
			finish({ ok: false, status: null, detail: clipDetail(`no spawn report after ${timeoutMs}ms ${stderr}`) });
		}, timeoutMs);
		timer.unref?.();
	});
}

export interface SelfLearnDeps {
	/** Start the learner; the default verifies that one actually exists. */
	launch?: (launcher: Launcher, env: NodeJS.ProcessEnv) => LaunchResult | Promise<LaunchResult>;
	/** `/suggest` notes written since `sinceIso`. */
	countNotes?: (sinceIso: string | null) => Promise<number>;
	/** Command availability probe, for the launcher choice. */
	has?: (cmd: string) => boolean;
	/** File existence probe, for the launcher choice. */
	exists?: (path: string) => boolean;
	now?: () => number;
}

export default function selfLearn(pi: ExtensionAPI, deps: SelfLearnDeps = {}) {
	const launch = deps.launch ?? verifyLaunch;
	const has = deps.has ?? ((cmd: string) => existsSync(`/home/mark/.local/bin/${cmd}`));
	const fileExists = deps.exists ?? existsSync;
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
	/** Compaction entries this session has already handled, by id. */
	let seenCompactions = new Set<string>();
	/** False until the first scan, so a resumed session's history is not "new". */
	let compactionsBaselined = false;

	const reset = () => {
		errors = new Map();
		lastCompactIso = null;
		spawns = 0;
		lastSpawnAt = null;
		seenCompactions = new Set<string>();
		compactionsBaselined = false;
	};

	/** Mark every compaction on the branch as handled (cheap, never throws). */
	const seenCompactionsOnBranch = (ctx: any) => {
		try {
			for (const id of compactionEntryIds(ctx?.sessionManager?.getBranch?.())) seenCompactions.add(id);
		} catch {
			// An unreadable branch must not break the session.
		}
		compactionsBaselined = true;
	};

	/**
	 * The newest compaction entry this session has not handled yet, if any. All
	 * fresh ids are marked here, so two signals for one entry fire the gate once.
	 */
	const newCompaction = (ctx: any): string | null => {
		try {
			const ids = compactionEntryIds(ctx?.sessionManager?.getBranch?.());
			if (!compactionsBaselined) {
				for (const id of ids) seenCompactions.add(id);
				compactionsBaselined = true;
				return null;
			}
			let fresh: string | null = null;
			for (const id of ids) {
				if (seenCompactions.has(id)) continue;
				seenCompactions.add(id);
				fresh = id;
			}
			return fresh;
		} catch {
			return null;
		}
	};

	pi.on("session_start", (_event: any, ctx: any) => {
		reset();
		seenCompactionsOnBranch(ctx);
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

	const notify = (ctx: any, message: string, level: "info" | "warning") => {
		try {
			ctx?.ui?.notify(message, level);
		} catch {
			// A notify failing must never break the session.
		}
	};

	/**
	 * Start the learner, verify it exists, fall back to headless, and log which
	 * one actually ran. Runs after `learn()` has returned: agent-pane.sh waits up
	 * to 40 s for pi's banner, and the session that just compacted must not.
	 */
	async function launchLearner(plan: {
		at: number;
		trigger: "compact" | "manual";
		decision: Decision;
		slug: string;
		queuePath: string;
		proposalPath: string;
		ctx: any;
	}): Promise<void> {
		const ts = new Date(plan.at).toISOString();
		const env: NodeJS.ProcessEnv = {
			PI_SELF_LEARN: "1",
			PI_SELF_LEARN_SLUG: plan.slug,
			PI_SELF_LEARN_PROPOSAL: plan.proposalPath,
		};
		const attempt = async (candidate: Launcher) => launch(candidate, env);

		let launcher = withSelfClose(pickLauncher(has, plan.slug, plan.queuePath, fileExists), plan.slug);
		let result = await attempt(launcher);
		if (!result.ok && launcher.kind === "pane") {
			// The pane is what lied: record the exit status and the clipped stderr
			// before trying the launcher that does not need herdr.
			await record({
				ts,
				kind: "spawn-failed",
				slug: plan.slug,
				launcher: "pane",
				status: result.status ?? null,
				stderr: clipDetail(result.detail ?? ""),
				reason: plan.decision.reason,
			});
			launcher = withSelfClose(pickLauncher(has, plan.slug, plan.queuePath, fileExists, REPO, false), plan.slug);
			result = await attempt(launcher);
		}
		if (!result.ok) {
			await record({
				ts,
				kind: "spawn-failed",
				slug: plan.slug,
				launcher: launcher.kind,
				status: result.status ?? null,
				stderr: clipDetail(result.detail ?? ""),
				reason: plan.decision.reason,
			});
			notify(plan.ctx, `learner could not start (${launcher.kind}): ${clipDetail(result.detail ?? "no output")}`, "warning");
			return;
		}

		errors = new Map();
		await record({
			ts,
			kind: "spawned",
			trigger: plan.trigger,
			launcher: launcher.kind,
			slug: plan.slug,
			queue: plan.queuePath,
			proposal: plan.proposalPath,
			reason: plan.decision.reason,
		});
		notify(plan.ctx, `learner started in a separate pi session (${launcher.kind}): ${plan.decision.reason}`, "info");
	}

	async function learn(trigger: "compact" | "manual", ctx: any): Promise<Decision> {
		const at = now();
		const notes = await countNotes(lastCompactIso);
		const machineLast = await lastSpawnAnywhere();
		const candidates = [lastSpawnAt, machineLast].filter((value): value is number => typeof value === "number");
		const lastAnywhere = candidates.length ? Math.max(...candidates) : null;
		const decision = decideLearner({ errors, notes, spawnsThisSession: spawns, lastSpawnAt: lastAnywhere, now: at });
		if (!decision.spawn) return decision;

		const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
		const slug = `learn-${stamp.slice(11, 16)}`;
		const queuePath = join(QUEUE_DIR, `${stamp}.md`);
		const proposalPath = join(PROPOSAL_DIR, `${new Date(at).toISOString().slice(0, 10)}-${stamp.slice(11)}.md`);
		await mkdir(QUEUE_DIR, { recursive: true });
		await writeFile(
			queuePath,
			evidenceMarkdown({ trigger, decision, errors, notes, at, proposalPath, slug }),
			"utf8",
		);

		// Reserve the slot before the launch is verified: two compactions a second
		// apart must not both spawn while the first is still being checked.
		spawns += 1;
		lastSpawnAt = at;
		lastCompactIso = new Date(at).toISOString();

		void launchLearner({ at, trigger, decision, slug, queuePath, proposalPath, ctx }).catch(() => {
			// A launch that fails in a way not foreseen above is still not allowed to
			// reach the host session.
		});
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
		} finally {
			// pi appends the entry before it emits this event, so the boundary scan
			// must not treat the same compaction as new on the next turn.
			seenCompactionsOnBranch(ctx);
		}
	});

	/**
	 * Compaction committed at a turn boundary (om's path): pi never emits
	 * `session_compact`, only the entry appears on the branch. Same gate, same
	 * learn path, no second reflection for an entry another signal already saw.
	 */
	const onBoundary = async (_event: any, ctx: any) => {
		if (disabled) return;
		if (!newCompaction(ctx)) return;
		try {
			await learn("compact", ctx);
		} catch {
			// Same rule as above: detection may never break the host session.
		}
	};

	pi.on("turn_start", onBoundary);
	pi.on("before_agent_start", onBoundary);

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
	slug: string;
}): string {
	const { trigger, decision, errors, notes, at, proposalPath, slug } = input;
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
		"",
		"## Publish and close: do this last, every time",
		"",
		"You publish your own change; nobody else will. Concrete values for this run:",
		"",
		`- slug / herdr space: \`${slug}\``,
		`- repo (never switch this checkout): \`${REPO}\``,
		`- proposal: \`${proposalPath}\``,
		`- big-boss-pi bare agent: \`${BBP_BARE}\``,
		"",
		`1. Cut a worktree: \`git -C ${REPO} worktree add ../selflearn-${slug}-worktree -b learn/${slug}\``,
		"2. Apply your diff there, run the checks it names, commit on that branch.",
		"3. Hand the branch to big-boss-pi:",
		"",
		"```sh",
		`${BBP_BARE} -p "Push branch learn/${slug} (commit <sha>) of ${REPO}, review tier <tier>, proposal ${proposalPath}. Open the PR."`,
		"```",
		"",
		"4. Close your own space, whatever the outcome:",
		"",
		"```sh",
		`${PANE_SCRIPT} close ${slug} || true`,
		"```",
		"",
		"A \"nothing\" proposal skips steps 1-3 and still closes its space.",
	);
	return `${redact(lines.join("\n"))}\n`;
}
