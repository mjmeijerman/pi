/**
 * Turn observational memory on for every session.
 *
 * Radar basis: #44 naive context compression — the compaction here is
 * deliberate and lands at a task boundary, not mid-stream — and #26 context
 * profiling.
 *
 * `pi-observational-memory` gates itself per session: the gate lives in the
 * session ledger and defaults to off, so a new session starts without it unless
 * someone types `/om on`. This dispatches that command at session start, which
 * the input pipeline handles without starting an agent turn.
 *
 * OM then owns compaction: it observes chunks of the conversation and compacts at
 * `observational-memory.compactAtContextTokens` in settings.json. Pi's own
 * built-in threshold (context window minus `compaction.reserveTokens`) stays as
 * the last-resort safety net far above it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function omAutostart(pi: ExtensionAPI) {
	const enable = () => {
		try {
			// expandPromptTemplates makes this run the `/om` extension command
			// instead of sending text to the model.
			pi.sendUserMessage("/om on", { expandPromptTemplates: true });
		} catch {
			// A session without the om command (extension removed or disabled) is fine.
		}
	};

	pi.on("session_start", enable);
}
