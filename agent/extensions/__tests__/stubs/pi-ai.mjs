/**
 * Test double for `@earendil-works/pi-ai`.
 *
 * `calculateCost` must match the real implementation, otherwise every cost
 * assertion in usage-footer.test.ts is meaningless. We therefore load the real
 * package from the pnpm store and only fall back to a local copy if it is not
 * on disk. `realLoaded` lets the suite assert which one it got.
 */
import { loadRealPackage } from "./real-packages.mjs";

const real = await loadRealPackage("pi-ai");

export const realLoaded = typeof real?.calculateCost === "function";

/** Fallback copy of pi-ai/dist/models.js:calculateCost (USD per 1M tokens). */
function fallbackCalculateCost(model, usage) {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	usage.cost.totalFromProvider = false;
	return usage.cost;
}

export const calculateCost = realLoaded ? real.calculateCost : fallbackCalculateCost;
