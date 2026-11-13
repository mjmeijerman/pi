/**
 * Test double for `@earendil-works/pi-tui`.
 * Delegates to the real package when available (width math must be faithful).
 */
import { loadRealModule, loadRealPackage } from "./real-packages.mjs";

// pi-tui's dist/index.js re-exports "./utils.ts", which plain node cannot load;
// the width helpers live in dist/utils.js.
const real = (await loadRealPackage("pi-tui")) ?? (await loadRealModule("pi-tui", "dist/utils.js"));

export const realLoaded = typeof real?.visibleWidth === "function" && typeof real?.truncateToWidth === "function";

const ANSI = /\u001b\[[0-9;]*m|\u001b\][^\u0007]*\u0007/g;

function fallbackVisibleWidth(text) {
	return [...text.replace(ANSI, "")].length;
}

function fallbackTruncateToWidth(text, width, ellipsis = "") {
	const plain = text.replace(ANSI, "");
	if ([...plain].length <= width) return text;
	const keep = Math.max(0, width - [...ellipsis].length);
	return [...plain].slice(0, keep).join("") + ellipsis;
}

export const visibleWidth = realLoaded ? real.visibleWidth : fallbackVisibleWidth;
export const truncateToWidth = realLoaded ? real.truncateToWidth : fallbackTruncateToWidth;
export const stripTerminalSequences = realLoaded ? real.stripTerminalSequences : (s) => s.replace(ANSI, "");
