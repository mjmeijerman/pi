/**
 * Pure number formatting helpers for the usage footer.
 * Extracted from usage-footer.ts so they can be unit-tested without the TUI.
 */

/** Format token counts for compact display (mirrors pi's built-in footer). */
export function fmtTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Adaptive cost formatting: $0.0001 vs $1.234 vs $12.34. */
export function fmtCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0";
	if (n < 1) return `$${n.toFixed(4)}`;
	if (n < 100) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(1)}`;
}

/** Fixed 2-decimal cost part for the breakdown, e.g. 0.12. */
export function fmtCostPart(n: number): string {
	return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "";
}
