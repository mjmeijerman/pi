/**
 * session-nudge: the three things the harness knows and you forget to check.
 *
 * Radar basis: #1 agent sandboxing (Adopt), #13 grilling (Trial), #29 harness
 * quality evaluation, #36 agent instruction bloat.
 *
 * At most one line per session, and only when one of these is true:
 *   - at `session_start`: the session started in `$HOME`, `/` or `/home`, where
 *     project config loads nothing and an unfamiliar clone would run with your
 *     SSH keys (blip 1). Untrusted repo: the line carries the `pisandbox` form;
 *   - at `session_start`: the session is *resuming* at or near the
 *     observational-memory compaction threshold, so it will compact mid-thought
 *     instead of restarting cleanly;
 *   - on `tool_result`: the session has edited or written 4 or more distinct
 *     files without a single `/grill`, so the plan was never interviewed before
 *     the code (blip 13). The grill prompt template expands before the model
 *     sees it, so the raw `input` text is the only place a literal `/grill`
 *     survives; that is what the flag listens to.
 *
 * Nothing else, ever. Silent when clean: a nudge that fires every session is
 * noise and gets ignored, which is blip 36's failure mode with extra steps.
 *
 * Cost: no network, no file reads, no timers. `pi.getSettings()` is already in
 * memory, `ctx.getContextUsage()` is a usage lookup, and the grill rule is a set
 * of paths seen in tool results, not a scan.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Directories that are not projects: starting pi there loads no project config. */
const NON_PROJECT_DIRS = ["/", "/home"];

/** "Near the threshold" means this fraction of `compactAtContextTokens` or more. */
const NEAR_COMPACT_RATIO = 0.9;

/** Distinct edited files that mean the design outran the questions (blip 13). */
export const GRILL_FILE_THRESHOLD = 4;

/** Tools whose `path` is a file the session changed. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** `/grill` typed anywhere in raw user input, before template expansion. */
const GRILL_COMMAND = /(^|\s)\/grill\b/;

export type NudgeKind = "cwd" | "compaction" | "grill";

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

export interface GrillInput {
	/** Distinct paths the session's `write`/`edit` calls touched. */
	editedFiles: Iterable<string>;
	/** True once the raw input contained `/grill`. */
	grillUsed: boolean;
}

/**
 * The grill rule, pure: four distinct files without a single `/grill` is the
 * point where asking about the plan is still cheaper than reading the diff.
 * Returns null once `/grill` was used: the interview happened, so there is
 * nothing left to suggest.
 */
export function decideGrillNudge(input: GrillInput): Nudge | null {
	if (input.grillUsed) return null;
	const count = new Set(input.editedFiles).size;
	if (count < GRILL_FILE_THRESHOLD) return null;
	return {
		kind: "grill",
		message: `${count} files edited without /grill — run /grill before the next one to interview the plan (blip 13)`,
	};
}

/** The file a `write`/`edit` tool result changed, or null for anything else. */
export function editedPathOf(event: any): string | null {
	if (!event || event.isError) return null;
	if (!WRITE_TOOLS.has(String(event.toolName ?? ""))) return null;
	const path = event.input?.path;
	return typeof path === "string" && path.length > 0 ? path : null;
}

interface NudgeSettings {
	"observational-memory"?: { compactAtContextTokens?: number };
}

export default function sessionNudge(pi: ExtensionAPI) {
	// One line per session. A clean first `session_start` does not spend the
	// budget; the first real nudge does.
	let announced = false;
	/** Distinct files this session changed; the budget for blip 13. */
	const editedFiles = new Set<string>();
	/** `/grill` seen in raw input this session. */
	let grillUsed = false;

	pi.on("session_start", (event: { reason?: string } | undefined, ctx: any) => {
		editedFiles.clear();
		grillUsed = false;
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

	// `/grill` is a prompt template: it expands before the model sees it, so the
	// raw input event is the only place the literal command survives.
	pi.on("input", (event: { text?: string } | undefined) => {
		if (typeof event?.text === "string" && GRILL_COMMAND.test(event.text)) grillUsed = true;
	});

	// Count what the session actually wrote, after the write succeeded.
	pi.on("tool_result", (event: any, ctx: any) => {
		if (announced) return;
		const path = editedPathOf(event);
		if (!path) return;
		editedFiles.add(path);

		const nudge = decideGrillNudge({ editedFiles, grillUsed });
		if (!nudge) return;
		if (ctx?.hasUI === false) return;

		try {
			ctx.ui.notify(nudge.message, "info");
			announced = true;
		} catch {
			// Notify failing must never break the session.
		}
	});
}
