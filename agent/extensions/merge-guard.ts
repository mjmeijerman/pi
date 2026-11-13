/**
 * Merge guard — landing changes is the user's decision, not the agent's.
 *
 * Blocked: `gh pr merge`, the REST merge endpoint via `gh api`, and any push
 * whose target is the trunk/main branch. Everything else about git and gh stays
 * available: branching, committing, pushing a feature branch, opening a PR.
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

const TRUNK = /\b(trunk|main|master)\b/;

/** Drop quoted segments so a mention inside `echo "…"` is not a command. */
function unquoted(command: string): string {
	return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
}

/**
 * Reason this command would land a change, or null when it is safe.
 * Pure so it can be unit tested without the pi runtime.
 */
export function mergeReason(command: string): string | null {
	const bare = unquoted(command);
	// `--help` prints usage and exits; it cannot land anything.
	if (/--help\b/.test(bare)) return null;
	if (/\bgh\s+pr\s+merge\b/.test(bare)) return "gh pr merge";
	if (/\bgh\s+api\b[^\n]*\/(merge|merges)\b/.test(bare)) return "the pull-request merge API";
	if (/\bgit\s+push\b/.test(bare) && TRUNK.test(bare) && !/--dry-run\b/.test(bare)) return "a push to the trunk branch";
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
		const reason = mergeReason(event.input.command);
		if (!reason) return;
		if (allowedOnce) {
			allowedOnce = false;
			ctx.ui.notify("merge-guard: allowed once, as you approved", "info");
			return;
		}
		ctx.ui.notify("merge-guard: blocked a merge — ask the user first", "warning");
		return {
			block: true,
			reason: `merge-guard: ${reason} lands a change, which needs the user's explicit go-ahead. Ask them, then run /mergeguard allow and retry.`,
		};
	});

	pi.registerCommand("mergeguard", {
		description: "Show merge-guard state, or allow the next merge: /mergeguard allow",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "allow") {
				allowedOnce = true;
				ctx.ui.notify("merge-guard: the next merge or trunk push will run once", "info");
				return;
			}
			if (arg === "" || arg === "status") {
				ctx.ui.notify(`merge-guard: ${allowedOnce ? "one merge allowed" : "merges blocked"}`, "info");
				return;
			}
			ctx.ui.notify("usage: /mergeguard [status|allow]", "warning");
		},
	});
}
