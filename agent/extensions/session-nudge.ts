/**
 * session-nudge: the things the harness knows and you forget to check.
 *
 * Radar basis: #1 agent sandboxing (Adopt), #11 feedback flywheel, #13 grilling
 * (Trial), #29 harness quality evaluation, #36 agent instruction bloat.
 *
 * At most one line per session, and only when one of these is true. When two
 * are true at once the first one wins, so nothing is said twice:
 *   1. `cwd` — at `session_start`: the session started in `$HOME`, `/` or
 *      `/home`, where project config loads nothing and an unfamiliar clone would
 *      run with your SSH keys (blip 1). Untrusted repo: the line carries the
 *      `pisandbox` form. First because a session started in the wrong directory
 *      invalidates every other hint — the repo it is in is not the repo meant;
 *   2. `retro` — at `session_start`: `agent/retro/last-run.txt` is missing or its
 *      `ran_epoch` is older than `RETRO_MAX_AGE_DAYS`, so the suggestion box has
 *      gone past its window unaggregated (blips 11 and 25). The window is days
 *      long and only the session start can report it, so it outranks the two
 *      below, which are recoverable at any later turn;
 *   3. `compaction` — at `session_start`: the session is *resuming* at or near the
 *      observational-memory compaction threshold, so it will compact mid-thought
 *      instead of restarting cleanly;
 *   4. `grill` — on `tool_result`: the session has edited or written 4 or more
 *      distinct files without a single `/grill`, so the plan was never
 *      interviewed before the code (blip 13). The grill prompt template expands
 *      before the model sees it, so the raw `input` text is the only place a
 *      literal `/grill` survives; that is what the flag listens to.
 *
 * Nothing else, ever. Silent when clean: a nudge that fires every session is
 * noise and gets ignored, which is blip 36's failure mode with extra steps.
 *
 * Cost: no network, no timers. One file read, at most once per session and only
 * at `session_start` — never on `tool_result`: `agent/retro/last-run.txt` (the
 * retro run record) and the `RETRO_MAX_AGE_DAYS=` line of
 * `scripts/harness-check.sh`, so the extension and the checker share one window
 * instead of two that drift. `pi.getSettings()` is already in memory,
 * `ctx.getContextUsage()` is a usage lookup, and the grill rule is a set of paths
 * seen in tool results, not a scan.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Directories that are not projects: starting pi there loads no project config. */
const NON_PROJECT_DIRS = ["/", "/home"];

/** "Near the threshold" means this fraction of `compactAtContextTokens` or more. */
const NEAR_COMPACT_RATIO = 0.9;

/** Distinct edited files that mean the design outran the questions (blip 13). */
export const GRILL_FILE_THRESHOLD = 4;

/**
 * The retro window in days when `scripts/harness-check.sh` cannot be read.
 * The shell assignment is the source; `session-nudge.test.ts` fails when these
 * two disagree, so the copy cannot drift unnoticed.
 */
export const RETRO_MAX_AGE_DAYS_FALLBACK = 14;

const DAY_SECONDS = 86_400;

/** Tools whose `path` is a file the session changed. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** `/grill` typed anywhere in raw user input, before template expansion. */
const GRILL_COMMAND = /(^|\s)\/grill\b/;

export type NudgeKind = "cwd" | "retro" | "compaction" | "grill";

export interface Nudge {
	kind: NudgeKind;
	message: string;
}

/** What the retro record says, read once per session. */
export interface RetroState {
	/** `agent/retro/last-run.txt` contents, or null when the file is absent or unreadable. */
	record: string | null;
	/** The window, in days, shared with `scripts/harness-check.sh`. */
	maxAgeDays: number;
	/** Current time in epoch seconds (the unit `ran_epoch=` uses). */
	now: number;
}

export interface NudgeInput {
	cwd: string;
	home: string;
	/** `session_start` reason: startup | reload | new | resume | fork. */
	reason: string;
	trusted: boolean;
	contextTokens?: number | null;
	compactAtContextTokens?: number | null;
	/** Omitted or null when no retro state could be read: then no retro nudge. */
	retro?: RetroState | null;
}

/**
 * The retro window as `scripts/harness-check.sh` declares it. The checker is the
 * owner of the number (it is a plain top-level assignment); this reads that line
 * rather than keeping a second copy that drifts.
 */
export function parseRetroWindowDays(script: string): number | null {
	const match = /^RETRO_MAX_AGE_DAYS=(\d+)\s*$/m.exec(script);
	if (!match) return null;
	const days = Number(match[1]);
	return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Age of the last retro run in whole days, or null when there is no usable
 * `ran_epoch=` line (missing record or a record that never recorded a number).
 * Floors, so `12.9` days is `12`: the boundary agrees with the checker, which
 * fires only when age is *greater* than the window.
 */
export function retroAgeDays(record: string | null, nowSeconds: number): number | null {
	if (record === null) return null;
	const match = /^ran_epoch=(\d+)\s*$/m.exec(record);
	if (!match) return null;
	const ran = Number(match[1]);
	return Number.isFinite(ran) ? Math.floor((nowSeconds - ran) / DAY_SECONDS) : null;
}

/**
 * The retro rule, pure. A missing record means "never ran", not "zero days"; an
 * unparseable `ran_epoch` means the window cannot be shown to hold, which the
 * checker also reports as a WARN rather than a pass. Both are due.
 */
export function decideRetroNudge(input: { retro: RetroState }): Nudge | null {
	const { record, now, maxAgeDays } = input.retro;
	if (record === null) {
		return { kind: "retro", message: "retro is due — the suggestion box has never been aggregated here; run: make retro" };
	}
	const age = retroAgeDays(record, now);
	if (age === null) {
		return { kind: "retro", message: "retro is due — agent/retro/last-run.txt has no usable ran_epoch; run: make retro" };
	}
	if (age <= maxAgeDays) return null;
	return {
		kind: "retro",
		message: `retro is due — the suggestion box has not been aggregated in ${age} days; run: make retro`,
	};
}

/** Repo root, from this file's location (`agent/extensions/` → the root). */
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXTENSION_DIR, "..", "..");

function readFileOrNull(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		// A missing or unreadable file is data, not an error.
		return null;
	}
}

/**
 * Read the retro record and the shared window once. Tolerates both files being
 * absent: no record reads as "never ran", and a missing checker falls back to
 * `RETRO_MAX_AGE_DAYS_FALLBACK` (which the tests pin against the shell value).
 */
export function loadRetroState(root: string = REPO_ROOT, nowMs: number = Date.now()): RetroState {
	const script = readFileOrNull(path.join(root, "scripts", "harness-check.sh"));
	return {
		record: readFileOrNull(path.join(root, "agent", "retro", "last-run.txt")),
		maxAgeDays: (script === null ? null : parseRetroWindowDays(script)) ?? RETRO_MAX_AGE_DAYS_FALLBACK,
		now: Math.floor(nowMs / 1000),
	};
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
 * extension only decides *when* to ask; the retro record arrives as data in
 * `input.retro`, read by the caller once per session.
 */
export function decideNudge(input: NudgeInput): Nudge | null {
	if (isNonProjectDir(input.cwd, input.home)) {
		const where = stripTrailingSlash(input.cwd) === stripTrailingSlash(input.home) ? "$HOME" : stripTrailingSlash(input.cwd);
		const hint = input.trusted
			? "project config only loads from the repo you start in"
			: "unfamiliar repo: pisandbox -- pi";
		return { kind: "cwd", message: `start in the repo, not ${where} — ${hint}` };
	}

	if (input.retro) {
		const retro = decideRetroNudge({ retro: input.retro });
		if (retro) return retro;
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

export interface SessionNudgeDeps {
	/** Retro state for this session. Read once; injected by the tests. */
	readRetro?: () => RetroState;
}

export default function sessionNudge(pi: ExtensionAPI, deps: SessionNudgeDeps = {}) {
	const readRetro = deps.readRetro ?? (() => loadRetroState());
	/** Loaded lazily, once per session: never on `tool_result`. */
	let retro: RetroState | null = null;
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
		if (retro === null) {
			try {
				retro = readRetro();
			} catch {
				// An unreadable record must not cost the other nudges.
				retro = null;
			}
		}
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
			retro,
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
