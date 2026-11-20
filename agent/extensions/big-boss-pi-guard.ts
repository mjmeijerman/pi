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
 * `.worktrees/` is carved out in the live workspace only: a worker's checkout has its own
 * branch and is not the live trunk the guard protects, so the boss may fix a mechanical
 * rebase conflict in it — the rollback copy's `.worktrees/` stays blocked, it is not the
 * boss's to touch.
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

/**
 * True when `path` is inside a worker checkout under the live workspace's `.worktrees/`.
 *
 * A rebase conflict is resolved by editing files in `<root>/.worktrees/<slug>/`: that
 * subtree has its own branch, nothing in it is the trunk the guard exists to protect.
 * Only the live workspace is carved out — `/home/mark/pi-master` is the rollback copy and
 * a `.worktrees/` under it is not the boss's to touch.
 */
export function worktreePath(path: string): boolean {
	if (!path) return false;
	const target = real(path);
	const base = real(DELEGATION_ROOT);
	return target.startsWith(`${base}/.worktrees/`);
}

/** The paths the guard lets through: the delegation flow's files and worker checkouts. */
function carvedOut(path: string): boolean {
	return delegationPath(path) || worktreePath(path);
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
const WRITE_VERB = /^(rm|mv|cp|tee|touch|truncate|mkdir|rmdir|ln|chmod|chown|dd|install)$/;

/**
 * Words that run the command that follows them, so a verb behind one is still in command
 * position. `eval` takes the command as its next word too.
 */
const COMMAND_WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "xargs", "eval"]);

/** Shells that run their `-c` argument as a command: `bash -c 'rm …'`. */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * The write verb this segment actually runs, or undefined.
 *
 * Only command position counts: the first word, or the word right after a wrapper such as
 * `sudo`, with the wrapper's flags and `KEY=value` assignments stepped over. A verb-shaped
 * argument (`echo install /path`, `rg install`) must not arm the path scan — `install` as
 * an argument is a read-only command, and treating it as a write was a false positive.
 */
function commandVerb(segment: string): string | undefined {
	const words = segment.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (COMMAND_WRAPPERS.has(word)) {
			i += 1;
			continue;
		}
		const next = words[i + 1] ?? "";
		if (SHELL_WRAPPERS.has(word) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(next)) {
			i += 2;
			continue;
		}
		if (i > 0 && (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) {
			i += 1;
			continue;
		}
		break;
	}
	const command = words[i] ?? "";
	// `sed -i`/`perl -i` edit in place, so the flag, not the verb alone, is the write.
	if ((command === "sed" || command === "perl") && words.slice(i + 1).some((word) => /^-[a-zA-Z]*i/.test(word))) {
		return `${command} -i`;
	}
	return WRITE_VERB.test(command) ? command : undefined;
}

/**
 * A greater-than preceded by `=`, `<`, `!` or `-` is code, not a redirect: the `>` in a
 * JavaScript arrow (`(x) => x`), in `->`, in `<>` or in `!>`. Counting it as a redirect
 * made every `node -e` with an arrow function look like a write into the workspace.
 */
const NOT_A_REDIRECT_BEFORE = new Set(["=", "<", "!", "-"]);

/** `>>`/`>` redirects, and `2>`; not `>/dev/null`-style device sinks. */
function redirectsInto(segment: string): string[] {
	const hits: string[] = [];
	const re = />>?\s*([^\s;&|>]+)/g;
	for (const match of segment.matchAll(re)) {
		const at = match.index ?? 0;
		if (at > 0 && NOT_A_REDIRECT_BEFORE.has(segment[at - 1])) continue;
		hits.push(match[1]);
	}
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
 * A flag whose next word is a script — code, not a path: `sed -e 's/a/b/'`, `perl -E …`,
 * and clusters such as `-pe`. `-i` is not one: `perl -i x` carries no script, so `x` stays
 * a write target.
 */
const SCRIPT_FLAG = /^-[a-zA-Z]*[eEf]/;

/**
 * The words in a `sed -i`/`perl -i` segment that are code rather than paths.
 *
 * Only the script is skipped, never the file it edits: `perl -i /path/x` has one argument
 * and it is a write target, so skipping the first non-flag word dropped the only path.
 * Without a script flag, `sed -i 's/a/b/' x` still passes its script positionally.
 */
function scriptWords(words: string[], verb: string): string[] {
	const scripts: string[] = [];
	let positionalScriptSeen = false;
	for (let i = 1; i < words.length; i += 1) {
		const word = words[i];
		if (word.startsWith("-")) {
			if (!SCRIPT_FLAG.test(word)) continue;
			if (words[i + 1] !== undefined) scripts.push(words[i + 1]);
			// the script came from a flag, so no positional script is left to skip
			positionalScriptSeen = true;
			i += 1;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		if (verb === "sed -i" && !positionalScriptSeen) {
			scripts.push(word);
			positionalScriptSeen = true;
		}
	}
	return scripts;
}

/**
 * Every token in the segment that could name a path, absolute or relative to `cwd`.
 * With `bare`, plain words count too (a write verb makes `rm specs` a write);
 * without it only redirect targets count, so `echo hi > /tmp/x` is not a hit.
 */
function pathTokens(segment: string, cwd: string, bare: boolean, verb: string | undefined): string[] {
	const targets = redirectTargets(segment, cwd);
	if (!bare) return targets;
	const words = segment.split(/\s+/).filter(Boolean);
	const skip = new Set([words[0] ?? "", verb?.split(/\s+/)[0] ?? ""]);
	// `sed -i`/`perl -i` take their script as code, not as a path: without this the
	// `s/a/b/` in `sed -i 's/a/b/' x.ts` resolved to `<cwd>/s/a/b` and blocked it.
	if (verb === "sed -i" || verb === "perl -i") for (const word of scriptWords(words, verb)) skip.add(word);
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
		const verb = commandVerb(segment);
		const redirected = redirectsInto(segment).length > 0;
		if (!verb && !redirected) continue;
		for (const path of pathTokens(segment, cwd, Boolean(verb), verb)) {
			if (!insideGuarded(path)) continue;
			if (carvedOut(path)) continue;
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
			// The delegation flow's own files, and a worker's own checkout.
			const target = toPath(String((event.input as { path?: string }).path ?? ""), ctx.cwd);
			if (carvedOut(target)) return;
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
