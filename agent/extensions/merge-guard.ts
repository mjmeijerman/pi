/**
 * Merge guard — landing changes is the user's decision, not the agent's.
 *
 * Blocked: `gh pr merge`, the REST merge endpoint via `gh api`, any push whose
 * target is the trunk/main branch or the branch HEAD is already on, and any
 * commit or merge made *while on* the trunk/main branch. Everything else about
 * git and gh stays available: branching, committing on a feature branch,
 * pushing it, opening a PR.
 *
 * A pull is not a landing. `git pull` fetches and fast-forwards; it writes nothing
 * to the remote and merges no reviewed change into trunk, so it stays open on
 * trunk — and the merge refusal says so, because pulling the remote is exactly
 * what a boss waiting on a merge should do instead.
 *
 * Also blocked: `git stash` in its saving and deleting forms. A stash empties a
 * tree another session is still working in, and `delegate` tells the agent to
 * run exactly that when it refuses a spawn on a dirty trunk — the clean trunk it
 * wants is one `git worktree add … origin/trunk` away. `stash list`, `show`,
 * `pop`, `apply` and `branch` stay open, because restoring work must never be
 * blocked.
 *
 * The branch rule judges the repository the command actually targets, not the
 * session's cwd: `git -C /path commit` and `cd /path && git commit` are decided
 * by the branch `/path` is on. A command that names no directory falls back to
 * the session cwd, and a path that is not a repository or sits on a detached
 * HEAD is never reported as a trunk commit.
 *
 * Matching is per command segment, after heredoc bodies are dropped: a commit
 * message or a PR body that happens to mention `gh pr merge` or `--base trunk`
 * is text, not a landing.
 *
 * Unlock for one merge command with `/mergeguard allow` after the user has said
 * yes. The allowance survives unrelated commands and is revoked by a new session.
 * Dry runs and `--help` are not blocked.
 *
 * Radar basis: #17 risk-tiered human oversight, #42 human-in-the-loop theater —
 * an approval that a machine grants itself is not an approval.
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const TRUNK = /\b(trunk|main|master)\b/;

/** Drop quoted segments so a mention inside `echo "…"` is not a command. */
function unquoted(command: string): string {
	return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
}

/**
 * Drop heredoc bodies. A commit message or PR body is stdin, not a command, and
 * scanning it made an ordinary `git push` look like a trunk push.
 */
function stripHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\s*(?=\n|$)/g, " ");
}

/** The command split into the pieces a shell would run one after another. */
function segments(command: string): string[] {
	// Heredocs first: their delimiters are often quoted, and unquoting would eat them.
	return stripHeredocs(command)
		.split(/\n/)
		.map((line) => unquoted(line))
		.join("\n")
		.split(/&&|\|\||[;|\n]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

/** Global git flags that take an argument, so the next token is not the subcommand. */
const GIT_FLAG_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * The git subcommand a segment runs — `commit`, `push`, `log` — or null when the
 * segment is not git at all. Global flags and their arguments are skipped, so
 * `git -C /path commit` and `git -c user.name=x commit` both report `commit`.
 */
function gitSubcommand(segment: string): string | null {
	const after = /\bgit\b(.*)$/.exec(segment)?.[1];
	if (after === undefined) return null;
	const tokens = after.trim().split(/\s+/).filter(Boolean);
	let skipNext = false; // a global flag's argument is not the subcommand
	for (const token of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (GIT_FLAG_WITH_VALUE.has(token)) {
			skipNext = true;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return null;
}

/** True when this `git push` leaves the current branch alone. */
function pushesExplicitBranch(segment: string): boolean {
	const tokens = segment.split(/\s+/);
	const at = tokens.indexOf("push");
	// Positional arguments are the remote first, then the refspecs.
	const positional = tokens.slice(at + 1).filter((token) => token && !token.startsWith("-"));
	const refspecs = positional.slice(1);
	if (refspecs.length === 0) return false; // pushes wherever HEAD points
	return refspecs.every((refspec) => refspec !== "HEAD" && !TRUNK.test(refspec));
}

/** One command segment, paired with the directory its git command runs in. */
export interface GitSegment {
	segment: string;
	/** The directory named by `git -C PATH` or by an earlier `cd PATH`, or null. */
	dir: string | null;
}

/**
 * The command's segments, each with the directory it targets: `git -C PATH`
 * names it inline, and a `cd PATH` earlier in the same command carries over,
 * the way the shell would. A command that names no directory has `dir: null`.
 */
export function gitSegments(command: string): GitSegment[] {
	const out: GitSegment[] = [];
	let dir: string | null = null;
	for (const segment of segments(command)) {
		const cd = /^(?:cd|pushd)\s+(?:--\s+)?(\S+)/.exec(segment);
		if (cd) {
			dir = cd[1];
			continue;
		}
		// `git -C PATH …` puts that one command in PATH; `-c` (lowercase) is a config flag.
		const inline = /\bgit\b[^&;|]*?\s-C\s*(\S+)/.exec(segment);
		out.push({ segment, dir: inline ? inline[1] : dir });
	}
	return out;
}

/** Absolute path for a directory token, expanding a leading `~`. */
function absolutePath(dir: string, cwd: string | undefined): string {
	const expanded = dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir;
	if (expanded.startsWith("/")) return resolve(expanded);
	return cwd ? resolve(cwd, expanded) : expanded;
}

/**
 * How the guard learns the branch of the repository a command targets. Injected so
 * the decision function stays pure, offline and deterministic under test.
 *
 * - a string: the branch of the session's own repository, used when the command
 *   names no directory (a command that names one cannot be judged from it);
 * - a function: resolve per target directory, `null` meaning the session's own;
 * - a map: absolute directory to branch, the offline form the tests use.
 */
export type BranchLookup =
	| string
	| null
	| ((dir: string | null) => string | null)
	| Record<string, string | null>;

/** The branch `lookup` gives for this target directory, or null when it cannot say. */
function branchOf(lookup: BranchLookup, dir: string | null, namesDirectory: boolean): string | null {
	if (typeof lookup === "function") return lookup(dir);
	if (lookup === null || typeof lookup === "string") {
		// A bare branch describes the session repository; it says nothing about `dir`.
		return namesDirectory ? null : lookup;
	}
	const branch = lookup[dir ?? ""];
	return typeof branch === "string" ? branch : null;
}

/**
 * Reason this command would land a change, or null when it is safe.
 * Pure so it can be unit tested without the pi runtime.
 */
export function mergeReason(command: string): string | null {
	// `--help` prints usage and exits; it cannot land anything.
	if (/--help\b/.test(unquoted(command))) return null;
	for (const segment of segments(command)) {
		if (/\bgh\s+pr\s+merge\b/.test(segment)) return "gh pr merge";
		if (/\bgh\s+api\b/.test(segment) && /\/(merge|merges)\b/.test(segment)) return "the pull-request merge API";
		if (gitSubcommand(segment) === "push" && TRUNK.test(segment) && !/--dry-run\b/.test(segment))
			return "a push to the trunk branch";
	}
	return null;
}

/** `git stash` subcommands that read or restore, never park or delete. */
const STASH_SAFE = new Set(["list", "show", "pop", "apply", "branch"]);

/**
 * Reason this command would park or drop uncommitted work, or null.
 *
 * Pure, like the other decisions, so the stashing forms can be enumerated in a
 * test. A bare `git stash` saves, so it counts as `push`.
 */
export function parkReason(command: string): string | null {
	// `--help` prints usage and exits; it cannot park anything.
	if (/--help\b/.test(unquoted(command))) return null;
	for (const segment of segments(command)) {
		if (gitSubcommand(segment) !== "stash") continue;
		const tokens = segment.split(/\s+/);
		const after = tokens.slice(tokens.indexOf("stash") + 1).filter((token) => !token.startsWith("-"));
		const verb = after[0] ?? "push";
		if (STASH_SAFE.has(verb)) continue;
		return verb === "push" ? "a `git stash`" : `a \`git stash ${verb}\``;
	}
	return null;
}

/** The branch HEAD points at, or null outside a repository / detached HEAD. */
export function currentBranch(cwd: string): string | null {
	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return branch && branch !== "HEAD" ? branch : null;
	} catch {
		return null;
	}
}

/**
 * Reason this command would put a commit straight onto trunk/main, or null.
 * `lookup` supplies the branch of the repository each git segment targets — the
 * command text cannot say, and the session cwd is only the fallback. `cwd` is the
 * session's own directory, used when the command names none.
 */
export function trunkCommitReason(
	command: string,
	lookup: BranchLookup,
	cwd?: string,
): string | null {
	// `--help` prints usage and exits; it cannot commit anything.
	if (/--help\b/.test(unquoted(command))) return null;
	for (const { segment, dir } of gitSegments(command)) {
		const sub = gitSubcommand(segment);
		// `pull` is deliberately not here: it fetches and fast-forwards, it lands nothing.
		if (sub !== "commit" && sub !== "merge" && sub !== "push") continue;
		const namesDirectory = dir !== null;
		const target = namesDirectory ? absolutePath(dir, cwd) : cwd ? resolve(cwd) : null;
		const branch = branchOf(lookup, target, namesDirectory);
		if (!branch || !TRUNK.test(branch)) continue;
		if (sub === "commit") return `a commit on ${branch}`;
		if (sub === "merge") return `a merge on ${branch}`;
		// A bare `git push` on trunk pushes trunk, even without the word in it.
		if (!/--dry-run\b/.test(segment) && !pushesExplicitBranch(segment)) return `a push from ${branch}`;
	}
	return null;
}

export default function mergeGuard(pi: ExtensionAPI) {
	/** One-shot permission granted by the user through /mergeguard allow. */
	let allowedOnce = false;

	pi.on("session_start", () => {
		allowedOnce = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		// The branch of the repository this command actually touches, not the session's.
		const park = parkReason(event.input.command);
		if (park) {
			if (allowedOnce) {
				allowedOnce = false;
				ctx.ui.notify("merge-guard: allowed once, as you approved", "info");
				return;
			}
			ctx.ui.notify("merge-guard: blocked a stash — the checkout is in use", "warning");
			return {
				block: true,
				reason:
					`merge-guard: ${park} parks uncommitted work in a checkout another session is still using. ` +
					"For a clean trunk, cut a worktree from origin/trunk instead: " +
					"git -C <repo> worktree add ../<slug>-worktree -b <branch> origin/trunk. " +
					"If the user asked for this stash, run /mergeguard allow and retry.",
			};
		}
		const branches: BranchLookup = (dir) => currentBranch(dir ?? ctx.cwd);
		const reason =
			mergeReason(event.input.command) ?? trunkCommitReason(event.input.command, branches, ctx.cwd);
		if (!reason) return;
		if (allowedOnce) {
			allowedOnce = false;
			ctx.ui.notify("merge-guard: allowed once, as you approved", "info");
			return;
		}
		ctx.ui.notify("merge-guard: blocked a merge — ask the user first", "warning");
		return {
			block: true,
			reason:
				`merge-guard: ${reason} lands a change on a protected branch, which needs the user's explicit go-ahead. ` +
				"Ask them, then run /mergeguard allow and retry — or pull the remote instead: git pull --ff-only.",
		};
	});

	pi.registerCommand("mergeguard", {
		description: "Show merge-guard state, or allow the next merge/trunk commit: /mergeguard allow",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "allow") {
				allowedOnce = true;
				ctx.ui.notify("merge-guard: the next merge, trunk push or trunk commit will run once", "info");
				return;
			}
			if (arg === "" || arg === "status") {
				ctx.ui.notify(`merge-guard: ${allowedOnce ? "one landing allowed" : "landing blocked"}`, "info");
				return;
			}
			ctx.ui.notify("usage: /mergeguard [status|allow]", "warning");
		},
	});
}
