/**
 * big-boss-pi guard — the workspace is for delegation, not for direct edits.
 *
 * When the session's cwd is inside the delegation workspace, the `write` and `edit`
 * tools are blocked, and so are the obvious shell writes (`echo x > …/state/y`,
 * `rm/mv/cp/tee/sed -i` on a path there). Everywhere else this extension does nothing.
 *
 * A delegated worker is the exception inside the workspace: the runners export
 * `PI_WORKER=1`, and a worker session writes normally. The boss delegates and the worker
 * edits, so the guard enforces the rule on the session that is supposed to delegate, and
 * the runners mark the session that is supposed to work.
 *
 * `reports/` and `specs/` are carved out for every session, worker or boss. The
 * delegation flow owns those two directories — `delegate` writes the spec it hands a
 * worker and reads the report the worker writes back — and the sandbox already mounts
 * them read-write. Blocking them made a worker unable to file its own report. Everything
 * else under the guarded roots, `state/` included, stays blocked for the boss session.
 *
 * During the rename both trees are guarded: `/home/mark/big-boss-pi` (the live workspace)
 * and `/home/mark/pi-master` (the rollback copy, which must not be edited either).
 *
 * This is a rule, not a sandbox: a program the agent runs can still write there. The point
 * is that delegation stays the path of least resistance and a direct edit fails loudly.
 *
 * Radar basis: #20 stateful guardrails (Trial) — a rule nothing checks is a rule that is gone.
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Both trees are delegation-only during the transition. */
export const GUARDED_ROOTS = ["/home/mark/big-boss-pi", "/home/mark/pi-master"];

/** The workspace whose delegation directories are carved out of the rule. */
const DELEGATION_ROOT = "/home/mark/big-boss-pi";

/** The two directories the delegation flow owns: the spec in, the report out. */
export const DELEGATION_DIRS = ["reports", "specs"];

/** Resolve symlinks when the path exists; fall back to a plain absolute path. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** True when `path` is inside one of the guarded workspaces. */
export function insideGuarded(path: string): boolean {
	const target = real(path);
	return GUARDED_ROOTS.some((root) => {
		const base = real(root);
		return target === base || target.startsWith(`${base}/`);
	});
}

/** True when the session's working directory is inside a guarded workspace. */
export function cwdIsGuarded(cwd: string): boolean {
	return insideGuarded(cwd);
}

/**
 * True when `path` is a spec or a report in the live workspace: the one place inside a
 * guarded root that every session may write, because the delegation flow writes it.
 * Replacing a report is allowed too — reports are regenerated, not curated.
 */
export function delegationPath(path: string): boolean {
	if (!path) return false;
	const target = real(path);
	const base = real(DELEGATION_ROOT);
	return DELEGATION_DIRS.some((dir) => target === `${base}/${dir}` || target.startsWith(`${base}/${dir}/`));
}

/** Drop quoted text so a path inside `echo "…"` is still seen, but a mention in prose is not. */
function unquoted(command: string): string {
	return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (match) => match.slice(1, -1));
}

/** Heredoc bodies are data, not commands. */
function stripHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\s*(?=\n|$)/g, " ");
}

function segments(command: string): string[] {
	return stripHeredocs(command)
		.split(/\n/)
		.map(unquoted)
		.join("\n")
		.split(/&&|\|\||[;|\n]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

/** Write verbs that touch a path directly. */
const WRITE_VERB =
	/\b(rm|mv|cp|tee|touch|truncate|mkdir|rmdir|ln|chmod|chown|sed\s+-i|perl\s+-i|dd|install)\b/;

/** `>`/`>>` redirects, and `>|`/`2>`; not `>/dev/null`-style device sinks. */
function redirectsInto(segment: string): string[] {
	const hits: string[] = [];
	const re = /(?:^|[^0-9])\d?>>?\s*([^\s;&|>]+)/g;
	for (const match of segment.matchAll(re)) hits.push(match[1]);
	return hits;
}

/** Resolve one path token against the session cwd, expanding a leading `~`. */
function toPath(token: string, cwd: string): string {
	const cleaned = token.replace(/^[\s(=:'"`]+|[;,)'"`]+$/g, "");
	if (!cleaned) return "";
	const expanded = cleaned.startsWith("~") ? cleaned.replace(/^~/, "/home/mark") : cleaned;
	return expanded.startsWith("/") ? expanded : resolve(cwd, expanded);
}

/** Redirect targets, resolved against the session cwd. */
function redirectTargets(segment: string, cwd: string): string[] {
	return redirectsInto(segment).map((token) => toPath(token, cwd)).filter(Boolean);
}

/**
 * Every token in the segment that could name a path, absolute or relative to `cwd`.
 * With `bare`, plain words count too (a write verb makes `rm specs` a write);
 * without it only redirect targets count, so `echo hi > /tmp/x` is not a hit.
 */
function pathTokens(segment: string, cwd: string, bare: boolean, verb: string | undefined): string[] {
	const targets = redirectTargets(segment, cwd);
	if (!bare) return targets;
	const skip = new Set([segment.split(/\s+/)[0] ?? "", verb?.split(/\s+/)[0] ?? ""]);
	for (const token of segment.split(/\s+/)) {
		if (!token || token.startsWith("-") || /^[<>&|]+$/.test(token) || skip.has(token)) continue;
		const path = toPath(token, cwd);
		if (path) targets.push(path);
	}
	return targets;
}

/**
 * Reason this shell command writes into a guarded workspace, or null.
 * Pure, so it can be unit tested without the pi runtime. `cwd` is the session's cwd,
 * used to resolve relative paths. Specs and reports are not writes for this purpose.
 */
export function shellWriteReason(command: string, cwd: string): string | null {
	for (const segment of segments(command)) {
		const verb = segment.match(WRITE_VERB)?.[0]?.trim();
		const redirected = redirectsInto(segment).length > 0;
		if (!verb && !redirected) continue;
		for (const path of pathTokens(segment, cwd, Boolean(verb), verb)) {
			if (!insideGuarded(path)) continue;
			if (delegationPath(path)) continue;
			return `${verb ? `\`${verb}\`` : "a shell redirect"} into ${path}`;
		}
	}
	return null;
}

/**
 * True when this session is a delegated worker.
 *
 * The boss delegates and the worker edits, so the guard enforces the rule on the session
 * that is supposed to delegate and the runners mark the session that is supposed to work:
 * `bin/pi-bare`, `bin/pi-sandboxed` and `bin/pi-nonet` export `PI_WORKER=1` into the
 * environment the worker's pi process sees.
 *
 * Unset, empty, `0` and `false` all mean the boss session, which stays guarded.
 */
export function workerSession(env: Record<string, string | undefined>): boolean {
	const value = env.PI_WORKER;
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export default function bigBossPiGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// A worker was delegated to work here; the guard is for the session that delegates.
		if (workerSession(process.env)) return;
		if (!cwdIsGuarded(ctx.cwd)) return;

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			// The spec and the report are the delegation flow's own files.
			const target = toPath(String((event.input as { path?: string }).path ?? ""), ctx.cwd);
			if (delegationPath(target)) return;
			ctx.ui.notify("big-boss-pi-guard: this workspace is for delegation, not direct edits", "warning");
			return {
				block: true,
				reason:
					"big-boss-pi-guard: /home/mark/big-boss-pi is delegation-only. Do not write files here yourself — spawn a worker with `delegate spawn`, or write the spec/report through delegate. /home/mark/pi-master is the rollback copy and is also read-only.",
			};
		}

		if (!isToolCallEventType("bash", event)) return;
		const reason = shellWriteReason(event.input.command, ctx.cwd);
		if (!reason) return;
		ctx.ui.notify("big-boss-pi-guard: blocked a shell write into the workspace", "warning");
		return {
			block: true,
			reason: `big-boss-pi-guard: ${reason} is a direct write into a delegation-only workspace (/home/mark/big-boss-pi or its rollback copy /home/mark/pi-master). Delegate the work with \`delegate spawn\`, or ask the user.`,
		};
	});
}
