/**
 * usage — the one place a model call gets recorded.
 *
 * Both decision paths write here: bin/jev.mjs (the TypeSafe decision model, kind "jev") and
 * bin/local-run.mjs (the local worker on ollama, kind "local-run"). It is the file that answers
 * "is the model actually used, and how fast does it answer" without inferring it from the absence
 * of something else.
 *
 * One JSON object per call, appended to state/usage.jsonl:
 *
 *   ts          ISO timestamp of when the call started
 *   kind        "jev" | "local-run"
 *   command     jev's subcommand (ask, permit, route, mode, count, thinking, plan) or "run"
 *   model       the model id that actually answered (jev: from bin/jev-model.mjs and the
 *               response; local-run: from bin/local-model.mjs)
 *   latency_ms  wall time from before the request to after the answer (or the failure)
 *   ok          did the model answer at all
 *   error       one class word when ok is false: unreachable, http, auth, no-key, empty,
 *               non-json, malformed, usage
 *   context     the caller's slug or context when it has one (PI_BOSS_CONTEXT), else null
 *   task        the task text, clipped to 200 characters and redacted
 *
 * What is deliberately not logged: environment variables, credentials, endpoints with user
 * info, and the full task text. A task can be long and can contain anything a person typed,
 * so only the first 200 characters survive, after the cheap redaction below. Recording must
 * never break the call it records: a failed write is swallowed.
 *
 * logDecision is the second, smaller writer: jev's permit answers go into state/decisions.jsonl in
 * the same row shape `delegate` writes, because a sandbox permission is a decision with a
 * consequence and a decision that is answered but never logged has no scorecard row at all. It
 * lives here so the decisions path is resolved in one place, and it swallows its own failures for
 * the same reason logUsage does.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const TASK_LIMIT = 200;

const ROOT =
	process.env.PI_BOSS_ROOT ||
	process.env.PI_MASTER_ROOT ||
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const USAGE_FILE = path.join(ROOT, "state", "usage.jsonl");
export const DECISIONS_FILE = path.join(ROOT, "state", "decisions.jsonl");

// Cheap redaction: key-shaped tokens and Authorization headers go, everything else stays. It
// is a guard against the obvious accident, not a classification of what is secret.
const REDACTIONS = [
	/\b(sk|rk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*\S+/gi,
];

/** clipTask — one line, at most TASK_LIMIT characters, key-shaped values redacted. */
export function clipTask(text) {
	let out = String(text || "").replace(/\s+/g, " ").trim();
	for (const re of REDACTIONS) out = out.replace(re, "[redacted]");
	if (out.length > TASK_LIMIT) out = `${out.slice(0, TASK_LIMIT - 1)}…`;
	return out;
}

/**
 * logUsage — append one call record. Never throws: a logging failure must not fail the call
 * it was recording, and a workspace without a writable state/ directory is not an error worth
 * stopping the model for.
 */
export function logUsage({ kind, command, model, started, latency_ms, ok, error, context, task }) {
	const line = {
		ts: new Date(started ?? Date.now()).toISOString(),
		kind: String(kind || "unknown"),
		command: String(command || ""),
		model: String(model || ""),
		latency_ms: Math.max(0, Math.round(Number(latency_ms) || 0)),
		ok: Boolean(ok),
		error: ok ? null : String(error || "unknown"),
		context: context ? clipTask(context) : null,
		task: clipTask(task),
	};
	try {
		fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
		fs.appendFileSync(USAGE_FILE, `${JSON.stringify(line)}\n`);
	} catch {
		// Deliberate no-op; see the docstring.
	}
	return line;
}

/** context — the caller's slug or context, passed down the environment, never invented. */
export function context() {
	return process.env.PI_BOSS_CONTEXT || "";
}

/**
 * logDecision — append one decision row, in the shape `delegate spawn` writes: the answer, the
 * reason, whether a person overruled jev, the slug, and jev's own answer. `extra` is merged last
 * for a row that carries evidence of its own (a confidence, a sha). Never throws.
 */
export function logDecision({ command, task, decision, reason, overridden = false, slug, jev, extra }) {
	const line = {
		timestamp: new Date().toISOString(),
		command: String(command || ""),
		task: clipTask(task),
		decision: decision === undefined || decision === null ? null : String(decision),
		reason: reason ? clipTask(reason) : null,
		overridden: overridden === true,
		slug: slug || "",
	};
	if (jev !== undefined && jev !== null && jev !== "") line.jev = String(jev);
	if (extra && typeof extra === "object") Object.assign(line, extra);
	try {
		fs.mkdirSync(path.dirname(DECISIONS_FILE), { recursive: true });
		fs.appendFileSync(DECISIONS_FILE, `${JSON.stringify(line)}\n`);
	} catch {
		// Deliberate no-op; see the docstring.
	}
	return line;
}
