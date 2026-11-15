/**
 * config-guard: a broken config file names itself in the first screen line.
 *
 * Radar basis: #102 Varlock (Assess) — validate config, do not hope.
 * #29 harness quality evaluation: the check that ships in scripts/harness-check.sh
 * is the same one that runs here, so a config that passes CI cannot be the one
 * that quietly half-loads in a session.
 *
 * Why at session start: pi reads `settings.json` and `models.json` before any
 * extension is asked anything, and it ignores a key it does not know. The typo
 * therefore surfaces three steps later as "the setting did nothing" — a route
 * that fell back to the provider default, a compaction threshold that never
 * fired. The cheapest place to say it is the first screen line, while the person
 * is still looking at the prompt.
 *
 * Cost: three small file reads and no network, once per session. Silent when the
 * config is clean — a guard that speaks every session is noise (blip 36).
 *
 * Nothing here prints a value: schema.mjs reports paths and types only, so a key
 * in keys.json cannot reach the screen through this file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkConfigDir } from "../config/schema.mjs";

/** pi's own override for the config directory; `~/.pi/agent` otherwise. */
export const CONFIG_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Lines on screen before the rest is summarised: the first screen is not a log. */
export const MAX_LINES = 3;

/** Where the whole list is, once it is too long for the screen. */
export const FIX_COMMAND = "bash scripts/harness-check.sh --verify-config";

/** The directory this session's config was read from. */
export function configDir(env: Record<string, string | undefined> = process.env): string {
	const override = env[CONFIG_DIR_ENV];
	if (override !== undefined && override !== "") return override;
	const home = env.HOME;
	return join(home === undefined || home === "" ? homedir() : home, ".pi", "agent");
}

export interface ConfigGuardResult {
	/** One line per broken file, path and expectation included. */
	messages: string[];
	/** How long the validation took; the session-start budget is 50 ms. */
	ms: number;
}

/**
 * Validate, time it, and return only what is broken. It reads three files and
 * nothing else, so a test can point it at a fixture without touching the session.
 */
export function inspectConfig(dir: string): ConfigGuardResult {
	const started = performance.now();
	const lines = checkConfigDir(dir);
	const ms = performance.now() - started;
	const messages = [];
	for (const line of lines) {
		if (line.status === "FAIL") messages.push(`${line.where} — ${line.message}`);
	}
	return { messages, ms };
}

/** The exact lines to show, capped so a badly broken file still fits one screen. */
export function guardLines(messages: string[]): string[] {
	const shown = messages.slice(0, MAX_LINES);
	const lines = shown.map((message) => `config: ${message}`);
	if (messages.length > MAX_LINES) {
		lines.push(`config: ${messages.length - MAX_LINES} more — run: ${FIX_COMMAND}`);
	}
	return lines;
}

export default function configGuard(pi: ExtensionAPI) {
	pi.on("session_start", (_event: unknown, ctx: any) => {
		// No UI, no first screen line to write on.
		if (ctx.hasUI === false) return;
		const lines = guardLines(inspectConfig(configDir()).messages);
		try {
			for (const line of lines) ctx.ui.notify(line, "warning");
		} catch {
			// A guard that breaks the session is worse than the typo it reports.
		}
	});
}
