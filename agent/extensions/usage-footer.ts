/**
 * Usage footer — a rich, multi-line footer with live session usage stats.
 *
 * Replaces pi's default footer in interactive (TUI) sessions with a layout
 * that uses the available width:
 *
 *   line 1  ~/cwd (git branch) • session name             model • thinking
 *   line 2  input 1.2k · output 4.5k · cache read 2.1k · cache write 3.4k
 *           · cache hit 87.3% · context 45% (90.1k/200k) · cost $1.234
 *           (input 0.12 / output 0.30 / cache read 0.01)
 *   line 3  messages 24 · tool calls 156 · compactions 1  extension statuses
 *
 * Usage is aggregated the same way pi's built-in footer does it: assistant
 * messages, tool results (nested model usage), and compaction/branch
 * summaries all count toward the totals.
 *
 * Enabled automatically on session start. Toggle with /usage-footer.
 */

import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Format token counts for compact display (mirrors pi's built-in footer). */
function fmtTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Adaptive cost formatting: $0.0001 vs $1.234 vs $12.34. */
function fmtCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0";
	if (n < 1) return `$${n.toFixed(4)}`;
	if (n < 100) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(1)}`;
}

/** Fixed 2-decimal cost part for the breakdown, e.g. 0.12. */
function fmtCostPart(n: number): string {
	return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "";
}

/** Replace $HOME with ~ in a path (mirrors pi's footer formatting). */
function fmtCwd(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!isInsideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** Left-justify `left` and right-align `right` within `width` (min 2-space gap). */
function padBetween(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + 2 + rw <= width) return left + " ".repeat(width - lw - rw) + right;
	const avail = width - lw - 2;
	if (avail > 0) return left + "  " + truncateToWidth(right, avail, "");
	return truncateToWidth(left, width, "...");
}

interface RateSet {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** DeepSeek flash pricing, USD per 1M tokens (off-peak / peak). Peak hours: 01–04 and 06–10 UTC. */
const DEEPSEEK_OFFPEAK: RateSet = { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 };
const DEEPSEEK_PEAK: RateSet = { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 };

function isPeakHour(timestampMs: number): boolean {
	const h = new Date(timestampMs).getUTCHours();
	return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	compactions: number;
	/** Cache hit rate of the most recent message that reported usage. */
	latestCacheHitRate: number | undefined;
}

function createTotals(): Totals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolResults: 0,
		compactions: 0,
		latestCacheHitRate: undefined,
	};
}

function addUsage(totals: Totals, usage: Usage | undefined, model?: Model<any> | null, timestampMs?: number): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;

	// openai-completions-compatible APIs (e.g. DeepSeek) report zero cost.
	// When the provider didn't price the request, compute the cost from the
	// token usage: DeepSeek is priced per request timestamp (peak/off-peak),
	// other models use their configured static rates.
	let cost = usage.cost;
	const reported =
		cost && (cost.total || cost.input || cost.output || cost.cacheRead || cost.cacheWrite);

	let effectiveModel = model;
	let priced = false;
	if (model?.id?.toLowerCase().startsWith("deepseek")) {
		effectiveModel = { ...model, cost: isPeakHour(timestampMs ?? Date.now()) ? DEEPSEEK_PEAK : DEEPSEEK_OFFPEAK };
		priced = true;
	} else {
		const rates = model?.cost;
		priced =
			!!rates &&
			(rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0);
	}

	if (!reported && priced && effectiveModel) {
		try {
			if (!usage.cost) usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			cost = calculateCost(effectiveModel, usage);
		} catch {
			cost = usage.cost;
		}
	}
	totals.cost += cost?.total ?? 0;
	totals.costInput += cost?.input ?? 0;
	totals.costOutput += cost?.output ?? 0;
	totals.costCacheRead += cost?.cacheRead ?? 0;
	totals.costCacheWrite += cost?.cacheWrite ?? 0;
	const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (promptTokens > 0) {
		totals.latestCacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let tuiRef: { requestRender(): void } | undefined;
	let activeCtx: ExtensionContext | undefined;

	const rerender = () => tuiRef?.requestRender();

	function enableFooter(ctx: ExtensionContext) {
		if (enabled) return;
		enabled = true;
		activeCtx = ctx;

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => unsub(),
				invalidate() {},
				render(width: number): string[] {
					const context = activeCtx;
					if (!context) return [""];

					// ---- Aggregate usage & message counts over the current branch ----
					const totals = createTotals();
					for (const e of context.sessionManager.getBranch()) {
						if (e.type === "message") {
							const m = e.message;
							if (m.role === "assistant") {
								totals.assistantMessages++;
								addUsage(totals, (m as AssistantMessage).usage, context.model, (m as AssistantMessage).timestamp);
							} else if (m.role === "user") {
								totals.userMessages++;
							} else if (m.role === "toolResult") {
								totals.toolResults++;
								addUsage(totals, (m as { usage?: Usage }).usage, context.model, (m as { timestamp?: number }).timestamp);
							}
						} else if (e.type === "compaction" || e.type === "branch_summary") {
							if (e.type === "compaction") totals.compactions++;
							addUsage(totals, e.usage, context.model, (e as { timestamp?: number }).timestamp ?? Date.now());
						}
					}

					const dim = (s: string) => theme.fg("dim", s);

					// ---- Line 1: location + session (left), model + thinking (right) ----
					const leftParts: string[] = [fmtCwd(context.sessionManager.getCwd())];
					const branch = footerData.getGitBranch();
					if (branch) leftParts.push(`(${branch})`);
					const sessionName = context.sessionManager.getSessionName();
					if (sessionName) leftParts.push(`• ${sessionName}`);

					const model = context.model;
					let modelLabel = model ? model.id : "no-model";
					if (model?.reasoning) modelLabel += ` • ${context.thinkingLevel ?? "off"}`;

					const line1 = padBetween(dim(leftParts.join(" ")), dim(modelLabel), width);

					// ---- Line 2: usage stats ----
					const seg = (label: string, value: string) => dim(label) + value;
					const stats: string[] = [];
					if (totals.input > 0 || totals.output > 0) {
						stats.push(seg("input ", fmtTokens(totals.input)));
						stats.push(seg("output ", fmtTokens(totals.output)));
					}
					if (totals.cacheRead > 0) stats.push(seg("cache read ", fmtTokens(totals.cacheRead)));
					if (totals.cacheWrite > 0) stats.push(seg("cache write ", fmtTokens(totals.cacheWrite)));
					if (totals.latestCacheHitRate !== undefined) {
						const hit = totals.latestCacheHitRate;
						const color = hit >= 80 ? "success" : hit >= 50 ? "warning" : "error";
						stats.push(seg("cache hit ", theme.fg(color, `${hit.toFixed(1)}%`)));
					}

					const cu = context.getContextUsage();
					const contextWindow = cu?.contextWindow ?? context.model?.contextWindow ?? 0;
					if (contextWindow > 0) {
						const unknown = cu == null || cu.percent === null;
						const pct = unknown ? "?" : `${cu.percent!.toFixed(1)}%`;
						const colored = unknown
							? pct
							: cu.percent! > 90
								? theme.fg("error", pct)
								: cu.percent! > 70
									? theme.fg("warning", pct)
									: pct;
						const tokens =
							cu == null || cu.tokens == null ? "?" : fmtTokens(cu.tokens);
						stats.push(seg("context ", `${colored} (${tokens}/${fmtTokens(contextWindow)})`));
					}

					stats.push(seg("cost ", theme.bold(fmtCost(totals.cost))));
					const costBreakdown: string[] = [];
					if (totals.costInput > 0) costBreakdown.push(`input ${fmtCostPart(totals.costInput)}`);
					if (totals.costOutput > 0) costBreakdown.push(`output ${fmtCostPart(totals.costOutput)}`);
					if (totals.costCacheRead > 0) costBreakdown.push(`cache read ${fmtCostPart(totals.costCacheRead)}`);
					if (totals.costCacheWrite > 0) costBreakdown.push(`cache write ${fmtCostPart(totals.costCacheWrite)}`);
					if (costBreakdown.length > 0) stats.push(dim(`(${costBreakdown.join(" / ")})`));

					const line2 = stats.length > 0 ? truncateToWidth(stats.join("  "), width, "...") : "";

					// ---- Line 3: counts (left) + extension statuses (right) ----
					const meta: string[] = [];
					const totalMessages = totals.userMessages + totals.assistantMessages;
					if (totalMessages > 0) meta.push(dim("messages ") + `${totalMessages}`);
					if (totals.toolResults > 0) meta.push(dim("tool calls ") + `${totals.toolResults}`);
					if (totals.compactions > 0) meta.push(dim("compactions ") + `${totals.compactions}`);

					const statuses = Array.from(footerData.getExtensionStatuses().values());
					let line3 = "";
					if (meta.length > 0 && statuses.length > 0) {
						line3 = padBetween(meta.join("  "), dim(statuses.join("  ")), width);
					} else if (meta.length > 0) {
						line3 = meta.join("  ");
					} else if (statuses.length > 0) {
						line3 = truncateToWidth(dim(statuses.join("  ")), width, "...");
					}

					const lines = [line1, line2];
					if (line3) lines.push(line3);
					return lines;
				},
			};
		});
	}

	// Enabled by default in interactive sessions. Deferred briefly so the
	// TUI is fully initialized before the footer is installed.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		setTimeout(() => enableFooter(ctx), 0);
	});

	// Keep the footer fresh as usage, model, or context change.
	pi.on("message_end", () => rerender());
	pi.on("agent_end", () => rerender());
	pi.on("model_select", () => rerender());

	pi.registerCommand("usage-footer", {
		description: "Toggle the custom usage footer",
		handler: async (_args, ctx) => {
			if (enabled) {
				ctx.ui.setFooter(undefined);
				enabled = false;
				ctx.ui.notify("Usage footer disabled", "info");
			} else {
				enableFooter(ctx);
				ctx.ui.notify("Usage footer enabled", "info");
			}
		},
	});
}
