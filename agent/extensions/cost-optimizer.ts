/**
 * Cost Optimizer — always active.
 *
 * Injects the cost-optimizer skill rules into the system prompt on every turn,
 * so token-minimal, professional-quality responses are guaranteed rather than
 * relying on the model deciding to load the skill on-demand.
 *
 * The rules live in ~/.pi/agent/skills/cost-optimizer/SKILL.md (single source
 * of truth). If the file is missing, a compact built-in fallback is used.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_PATH =
	process.env.COST_OPTIMIZER_SKILL ??
	join(homedir(), ".pi", "agent", "skills", "cost-optimizer", "SKILL.md");

/** Compact rules used if SKILL.md can't be read. */
const FALLBACK = `
Goal: same professional result, fewest tokens.

- No preamble, outro, greetings, or recap. Never restate the user's request.
- Never echo tool output the user can already see; summarize only when the summary adds a conclusion.
- Answer at the requested depth, no deeper. No filler words, hedging, or disclaimers unless a real limitation exists.
- Minimal markdown: no headers for short answers, backticks for one-liners, no redundant captions.
- Tool use: batch independent calls into one message, prefer grep over full-file reads, never re-read files already in context.
- Quality is non-negotiable: completeness and accuracy are never traded for token savings; only zero-information tokens are cut.`;

function stripFrontmatter(md: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
	return match ? md.slice(match[0].length) : md;
}

export default function costOptimizer(pi: ExtensionAPI) {
	let rules: string | null = null;

	async function loadRules(): Promise<string> {
		if (rules) return rules;
		try {
			rules = stripFrontmatter(await readFile(SKILL_PATH, "utf8")).trim();
		} catch {
			rules = FALLBACK.trim();
		}
		return rules;
	}

	pi.on("before_agent_start", async (event) => {
		const content = await loadRules();
		return {
			systemPrompt: `${event.systemPrompt}

# Cost Optimizer (always active)

${content}`,
		};
	});
}
