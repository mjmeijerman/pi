/**
 * session-nudge: the two things the harness knows and you forget to check.
 *
 * Radar basis: #1 agent sandboxing (Adopt), #29 harness quality evaluation,
 * #36 agent instruction bloat.
 *
 * At most one line per session, at `session_start`, and only when one of these
 * is true:
 *   - the session started in `$HOME`, `/` or `/home`, where project config
 *     loads nothing and an unfamiliar clone would run with your SSH keys
 *     (blip 1). Untrusted repo: the line carries the `pisandbox` form;
 *   - the session is *resuming* at or near the observational-memory compaction
 *     threshold, so it will compact mid-thought instead of restarting cleanly.
 *
 * Nothing else, ever. Silent when clean: a nudge that fires every session is
 * noise and gets ignored, which is blip 36's failure mode with extra steps.
 *
 * Cost: no network, no file reads. `pi.getSettings()` is already in memory and
 * `ctx.getContextUsage()` is a usage lookup, not a scan.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Directories that are not projects: starting pi there loads no project config. */
const NON_PROJECT_DIRS = ["/", "/home"];

/** "Near the threshold" means this fraction of `compactAtContextTokens` or more. */
const NEAR_COMPACT_RATIO = 0.9;

export type NudgeKind = "cwd" | "compaction";

export interface Nudge {
	kind: NudgeKind;
	message: string;
}

export interface NudgeInput {
	cwd: string;
	home: string;
	/** `session_start` reason: startup | reload | new | resume | fork. */
	reason: string;
	trusted: boolean;
	contextTokens?: number | null;
	compactAtContextTokens?: number | null;
}

function stripTrailingSlash(dir: string): string {
	return dir.length > 1 && dir.endsWith("/") ? dir.replace(/\/+$/, "") : dir;
}

/** True when the cwd is `$HOME`, `/` or `/home`. */
export function isNonProjectDir(cwd: string, home: string): boolean {
	const dir = stripTrailingSlash(cwd);
	if (NON_PROJECT_DIRS.includes(dir)) return true;
	return dir === stripTrailingSlash(home);
}

/**
 * The whole decision, pure: same input, same answer, no side effects. The
 * extension only decides *when* to ask.
 */
export function decideNudge(input: NudgeInput): Nudge | null {
	if (isNonProjectDir(input.cwd, input.home)) {
		const where = stripTrailingSlash(input.cwd) === stripTrailingSlash(input.home) ? "$HOME" : stripTrailingSlash(input.cwd);
		const hint = input.trusted
			? "project config only loads from the repo you start in"
			: "unfamiliar repo: pisandbox -- pi";
		return { kind: "cwd", message: `start in the repo, not ${where} — ${hint}` };
	}

	if (input.reason !== "resume") return null;

	const near = input.compactAtContextTokens;
	const tokens = input.contextTokens;
	if (typeof near !== "number" || near <= 0) return null;
	if (typeof tokens !== "number" || tokens <= 0) return null;
	if (tokens < near * NEAR_COMPACT_RATIO) return null;

	const pct = Math.round((tokens / near) * 100);
	return {
		kind: "compaction",
		message: `resumed at ~${Math.round(tokens / 1000)}k of the ${Math.round(near / 1000)}k compaction threshold (${pct}%) — restart instead of riding to compaction`,
	};
}

interface NudgeSettings {
	"observational-memory"?: { compactAtContextTokens?: number };
}

export default function sessionNudge(pi: ExtensionAPI) {
	// One line per session. A clean first `session_start` does not spend the
	// budget; the first real nudge does.
	let announced = false;

	pi.on("session_start", (event: { reason?: string } | undefined, ctx: any) => {
		if (announced) return;
		if (ctx?.hasUI === false) return;

		let contextTokens: number | null | undefined;
		let compactAtContextTokens: number | null | undefined;
		let trusted = true;
		try {
			contextTokens = ctx?.getContextUsage?.()?.tokens ?? null;
			trusted = ctx?.isProjectTrusted?.() ?? true;
			const settings = (pi.getSettings?.() ?? {}) as NudgeSettings;
			compactAtContextTokens = settings["observational-memory"]?.compactAtContextTokens ?? null;
		} catch {
			// A session without those APIs is not worth a nudge.
			return;
		}

		const nudge = decideNudge({
			cwd: String(ctx?.cwd ?? ""),
			home: String(process.env.HOME ?? ""),
			reason: String(event?.reason ?? "startup"),
			trusted,
			contextTokens,
			compactAtContextTokens,
		});
		if (!nudge) return;

		try {
			ctx.ui.notify(nudge.message, "info");
			announced = true;
		} catch {
			// Notify failing must never break the session.
		}
	});
}
