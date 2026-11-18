/**
 * Pure number formatting helpers for the usage footer.
 * Extracted from usage-footer.ts so they can be unit-tested without the TUI.
 */

/** Magnitude suffixes for token counts (1e3, 1e6, 1e9, 1e12). */
const TOKEN_UNITS = ["", "k", "M", "B", "T"] as const;

/**
 * Format token counts for compact display (mirrors pi's built-in footer).
 *
 * The precision is chosen from the value *after* rounding, so a count that
 * fills its unit moves up one (`999_999` -> `1.0M`, not `1000k`) and a count
 * that rounds up to ten drops the decimal (`9999` -> `10k`, not `10.0k`).
 *
 * Both steps are walk-and-stop, never a counted loop: a value either consumes
 * one of the units below or it does not, so there is no counter a wrong branch
 * can leave standing still (the old fixed-point loop spun forever the moment a
 * mutant made it skip its own progress).
 */
export function fmtTokens(count: number): string {
	if (count < 1000) return `${count}`;

	let unit = 0; // how many units the count was divided by
	let scaled = count; // the count in the unit it lands in
	for (const _suffix of TOKEN_UNITS.slice(1)) {
		if (scaled < 1000) break;
		scaled /= 1000;
		unit++;
	}

	let shown = scaled.toFixed(scaled < 10 ? 1 : 0); // exactly the string that will be printed
	const rounded = Number(shown); // the value the string shows, which is what decides the next step
	if (rounded >= 10 && scaled < 10) {
		shown = scaled.toFixed(0); // 9.999 k would print "10.0k"; print "10k" instead
	} else if (rounded >= 1000 && unit + 1 < TOKEN_UNITS.length) {
		unit++;
		shown = (rounded / 1000).toFixed(1); // 999.999 k would print "1000k"; print "1.0M" instead
	}
	return `${shown}${TOKEN_UNITS[unit] ?? ""}`;
}

/**
 * Adaptive cost formatting: $0.0001 vs $1.234 vs $12.34 vs $1234.6.
 *
 * The tier is chosen from a value the string can actually show, i.e. round
 * before picking the format: 99.999 rounds to 100.00 and therefore renders as
 * `$100.00` in the 100-plus tier instead of `$100.000`, and 999.999 as `$1000.0`
 * instead of `$1000.00`. Sub-dollar keeps 4 decimals until it would print
 * $1.0000; the 100 and 1000 boundaries compare cents because the tier above
 * prints cents.
 */
export function fmtCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0";
	const cents = Number(n.toFixed(2));
	let decimals: number;
	if (Number(n.toFixed(4)) < 1) decimals = 4;
	else if (cents < 100) decimals = 3;
	else if (cents < 1000) decimals = 2;
	else decimals = 1;
	return `$${n.toFixed(decimals)}`;
}

/**
 * Fixed 2-decimal cost part for the breakdown, e.g. 0.12.
 * Rounded to the printed precision before formatting (99.999 -> "100.00").
 */
export function fmtCostPart(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "";
	return Number(n.toFixed(2)).toFixed(2);
}
