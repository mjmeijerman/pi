/**
 * session-nudge: one line, once per session, only when it is true.
 *
 * The decision itself is pure (`decideNudge`), so most of this file needs no
 * fake pi at all. The rest proves the wiring: it fires on `session_start`, never
 * twice, and never in a session without a UI.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../session-nudge.ts");
const sessionNudge = mod.default;
const {
	decideNudge,
	decideGrillNudge,
	decideRetroNudge,
	loadRetroState,
	parseRetroWindowDays,
	retroAgeDays,
	isNonProjectDir,
	editedPathOf,
	GRILL_FILE_THRESHOLD,
	RETRO_MAX_AGE_DAYS_FALLBACK,
} = mod;

const HOME = process.env.HOME ?? "/home/mark";
const REPO = `${HOME}/worktrees/pi-automation`;
const NEAR = 120_000;

/** Fixed clock, in epoch seconds: every retro test reads the same "now". */
const NOW = 1_800_000_000;
const DAY = 86_400;

function recordAt(ranEpoch: number): string {
	return [
		`ran_at=${new Date(ranEpoch * 1000).toISOString()}`,
		`ran_epoch=${ranEpoch}`,
		"note=12 entries seen, 3 new",
		"digest=agent/retro/2027-01-01.md",
		"",
	].join("\n");
}

/** A record one day old: the default, so the non-retro tests stay silent. */
function freshRetro() {
	return { record: recordAt(NOW - DAY), maxAgeDays: 14, now: NOW };
}

/**
 * The checkout root, found rather than assumed. `make mutate-*` copies only
 * `agent/` into `.stryker-tmp/sandbox-*`, so a fixed `../../../` from this file
 * stops at `.stryker-tmp` and never reaches `scripts/harness-check.sh` — the
 * search climbs to the first ancestor that holds the checker, and returns null
 * when the copy is genuinely detached from the repo (the drift check then skips
 * instead of failing an otherwise healthy run).
 */
function harnessRoot(): string | null {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "scripts", "harness-check.sh"))) return dir;
		const up = resolve(dir, "..");
		if (up === dir) return null;
		dir = up;
	}
}

function setup(
	options: {
		cwd?: string;
		reason?: string;
		tokens?: number | null;
		trusted?: boolean;
		compactAt?: number;
		hasUI?: boolean;
		retro?: { record: string | null; maxAgeDays: number; now: number } | null;
	} = {},
) {
	const fake = createFakePi({
		getSettings: () => ({ "observational-memory": { compactAtContextTokens: options.compactAt ?? NEAR } }),
	});
	sessionNudge(fake.pi, { readRetro: () => options.retro ?? freshRetro() });
	const { ctx, notices } = createFakeCtx({
		cwd: options.cwd ?? REPO,
		hasUI: options.hasUI ?? true,
		getContextUsage: () => ({ tokens: options.tokens ?? 10_000 }),
		isProjectTrusted: () => options.trusted ?? true,
	});
	return { ...fake, ctx, notices };
}

describe("session-nudge: pure decision", () => {
	const base = { cwd: REPO, home: HOME, reason: "startup", trusted: true };

	test("a clean session gets nothing", () => {
		assert.equal(decideNudge({ ...base, contextTokens: 10_000, compactAtContextTokens: NEAR }), null);
	});

	test("$HOME, / and /home are non-project directories", () => {
		assert.equal(isNonProjectDir(HOME, HOME), true);
		assert.equal(isNonProjectDir("/", HOME), true);
		assert.equal(isNonProjectDir("/home", HOME), true);
		assert.equal(isNonProjectDir(`${HOME}/`, HOME), true);
		assert.equal(isNonProjectDir(REPO, HOME), false);
	});

	test("$HOME nudges without the sandbox line when the repo is trusted", () => {
		const nudge = decideNudge({ ...base, cwd: HOME });
		assert.equal(nudge?.kind, "cwd");
		assert.match(nudge.message, /start in the repo, not \$HOME/);
		assert.doesNotMatch(nudge.message, /pisandbox/);
	});

	test("an untrusted repo adds the pisandbox one-liner", () => {
		const nudge = decideNudge({ ...base, cwd: HOME, trusted: false });
		assert.match(nudge?.message ?? "", /pisandbox -- pi/);
	});

	test("a resume at 90% of the threshold nudges", () => {
		const nudge = decideNudge({ ...base, reason: "resume", contextTokens: 108_000, compactAtContextTokens: NEAR });
		assert.equal(nudge?.kind, "compaction");
		assert.match(nudge.message, /restart instead of riding to compaction/);
	});

	test("a resume below the threshold stays silent", () => {
		assert.equal(decideNudge({ ...base, reason: "resume", contextTokens: 60_000, compactAtContextTokens: NEAR }), null);
	});

	test("a long session that was not resumed stays silent", () => {
		assert.equal(decideNudge({ ...base, reason: "new", contextTokens: 118_000, compactAtContextTokens: NEAR }), null);
	});

	test("missing usage data is not a nudge", () => {
		assert.equal(decideNudge({ ...base, reason: "resume", contextTokens: null, compactAtContextTokens: NEAR }), null);
		assert.equal(decideNudge({ ...base, reason: "resume", contextTokens: 118_000, compactAtContextTokens: null }), null);
	});
});

describe("session-nudge: grill nudge (blip 13)", () => {
	/** One successful write/edit tool result for `path`. */
	async function write(fake: ReturnType<typeof setup>, ctx: any, path: string) {
		return fake.emit("tool_result", { toolName: "write", input: { path }, isError: false, content: [] }, ctx);
	}

	test("the threshold is four distinct files", () => {
		assert.equal(GRILL_FILE_THRESHOLD, 4);
		assert.equal(decideGrillNudge({ editedFiles: ["a", "b", "c"], grillUsed: false }), null);
		assert.equal(decideGrillNudge({ editedFiles: ["a", "b", "c", "d"], grillUsed: false })?.kind, "grill");
	});

	test("only write and edit count, and repeats count once", () => {
		assert.equal(editedPathOf({ toolName: "read", input: { path: "a" } }), null);
		assert.equal(editedPathOf({ toolName: "write", input: { path: "a" } }), "a");
		assert.equal(editedPathOf({ toolName: "edit", input: { path: "b" } }), "b");
		assert.equal(editedPathOf({ toolName: "write", input: { path: "a" }, isError: true }), null);
		assert.equal(decideGrillNudge({ editedFiles: ["a", "a", "a", "a"], grillUsed: false }), null);
	});

	test("three files, no grill: silent", async () => {
		const fake = setup();
		await write(fake, fake.ctx, "/repo/a.ts");
		await write(fake, fake.ctx, "/repo/b.ts");
		await write(fake, fake.ctx, "/repo/c.ts");
		assert.equal(fake.notices.length, 0);
	});

	test("four files, no grill: one nudge, never twice", async () => {
		const fake = setup();
		for (const name of ["a", "b", "c", "d"]) await write(fake, fake.ctx, `/repo/${name}.ts`);
		assert.equal(fake.notices.length, 1);
		assert.match(fake.notices[0].message, /\/grill/);

		await write(fake, fake.ctx, "/repo/e.ts");
		await write(fake, fake.ctx, "/repo/f.ts");
		assert.equal(fake.notices.length, 1, "the nudge is once per session");
	});

	test("four files after /grill in the transcript: silent", async () => {
		const fake = setup();
		await fake.emit("input", { text: "/grill rewrite the guardrails", source: "interactive" }, fake.ctx);
		for (const name of ["a", "b", "c", "d"]) await write(fake, fake.ctx, `/repo/${name}.ts`);
		assert.equal(fake.notices.length, 0);
	});

	test("no UI, no grill line", async () => {
		const fake = setup({ hasUI: false });
		for (const name of ["a", "b", "c", "d"]) await write(fake, fake.ctx, `/repo/${name}.ts`);
		assert.equal(fake.notices.length, 0);
	});
});

describe("session-nudge: retro due (blips 11 and 25)", () => {
	test("a missing record is never-run, not zero days", () => {
		const nudge = decideRetroNudge({ retro: { record: null, maxAgeDays: 14, now: NOW } });
		assert.equal(nudge?.kind, "retro");
		assert.match(nudge.message, /never been aggregated here/);
		assert.match(nudge.message, /run: make retro/);
	});

	test("a record without a numeric ran_epoch is due, not silently fresh", () => {
		assert.equal(retroAgeDays("ran_at=whenever\nnote=no epoch\n", NOW), null);
		const nudge = decideRetroNudge({ retro: { record: "ran_epoch=yesterday\n", maxAgeDays: 14, now: NOW } });
		assert.match(nudge?.message ?? "", /no usable ran_epoch/);
	});

	test("fresh and exactly at the window: silent", () => {
		assert.equal(decideRetroNudge({ retro: { record: recordAt(NOW - DAY), maxAgeDays: 14, now: NOW } }), null);
		assert.equal(decideRetroNudge({ retro: { record: recordAt(NOW - 14 * DAY), maxAgeDays: 14, now: NOW } }), null);
	});

	test("one day past the window: the line names the age and the command", () => {
		const nudge = decideRetroNudge({ retro: { record: recordAt(NOW - 15 * DAY), maxAgeDays: 14, now: NOW } });
		assert.equal(nudge?.kind, "retro");
		assert.equal(nudge.message, "retro is due — the suggestion box has not been aggregated in 15 days; run: make retro");
	});

	test("older than a year still names the real age", () => {
		const nudge = decideRetroNudge({ retro: { record: recordAt(NOW - 400 * DAY), maxAgeDays: 14, now: NOW } });
		assert.match(nudge?.message ?? "", /in 400 days/);
	});

	test("the window is read from scripts/harness-check.sh, and the fallback agrees", async (t) => {
		const root = harnessRoot();
		if (root === null) {
			// Nothing to compare against: say why, so a skip is never mistaken for a pass.
			t.skip("scripts/harness-check.sh is not above this file — the mutation sandbox copies only agent/");
			return;
		}
		const script = await readFile(join(root, "scripts", "harness-check.sh"), "utf8");
		assert.equal(parseRetroWindowDays(script), RETRO_MAX_AGE_DAYS_FALLBACK);
		assert.equal(parseRetroWindowDays("RETRO_MAX_AGE_DAYS=21\n"), 21);
		assert.equal(parseRetroWindowDays("# RETRO_MAX_AGE_DAYS=21\n"), null);
	});

	test("with no checker to read, the fallback window is what the extension uses", () => {
		// Literals on purpose: comparing against RETRO_MAX_AGE_DAYS_FALLBACK would let a
		// change to that constant survive, and this case has to bite inside the sandbox,
		// where scripts/harness-check.sh is not on disk at all.
		const dir = mkdtempSync(join(tmpdir(), "session-nudge-"));
		try {
			assert.equal(loadRetroState(dir, NOW * 1000).maxAgeDays, 14, "absent checker: the fallback window");
			mkdirSync(join(dir, "scripts"), { recursive: true });
			writeFileSync(join(dir, "scripts", "harness-check.sh"), "RETRO_MAX_AGE_DAYS=21\n");
			assert.equal(loadRetroState(dir, NOW * 1000).maxAgeDays, 21, "present checker: its own number wins");
			writeFileSync(join(dir, "scripts", "harness-check.sh"), "# no assignment here\n");
			assert.equal(loadRetroState(dir, NOW * 1000).maxAgeDays, 14, "unparseable checker: back to the fallback");
			assert.equal(loadRetroState(dir, NOW * 1000).record, null, "no record here either");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("cwd outranks retro, retro outranks compaction", () => {
		const due = { record: null, maxAgeDays: 14, now: NOW };
		const base = { home: HOME, trusted: true, retro: due, contextTokens: 118_000, compactAtContextTokens: NEAR };
		assert.equal(decideNudge({ ...base, cwd: HOME, reason: "resume" })?.kind, "cwd");
		assert.equal(decideNudge({ ...base, cwd: REPO, reason: "resume" })?.kind, "retro");
		assert.equal(decideNudge({ ...base, cwd: REPO, reason: "startup" })?.kind, "retro");
		assert.equal(
			decideNudge({ ...base, retro: freshRetro(), cwd: REPO, reason: "resume" })?.kind,
			"compaction",
		);
	});

	test("wiring: a due retro renders at session start, once, and not on tool_result", async () => {
		const fake = setup({ retro: { record: recordAt(NOW - 21 * DAY), maxAgeDays: 14, now: NOW } });
		await fake.emit("session_start", { reason: "startup" }, fake.ctx);
		assert.equal(fake.notices.length, 1);
		assert.match(fake.notices[0].message, /in 21 days/);
		assert.match(fake.notices[0].message, /run: make retro/);

		await fake.emit("session_start", { reason: "resume" }, fake.ctx);
		await fake.emit("tool_result", { toolName: "write", input: { path: "/repo/a.ts" }, isError: false }, fake.ctx);
		assert.equal(fake.notices.length, 1, "one line per session");
	});

	test("wiring: the record is read once per session", async () => {
		let reads = 0;
		const fake = createFakePi({ getSettings: () => ({}) });
		sessionNudge(fake.pi, {
			readRetro: () => {
				reads++;
				return freshRetro();
			},
		});
		const { ctx } = createFakeCtx({ cwd: REPO });
		await fake.emit("session_start", { reason: "startup" }, ctx);
		await fake.emit("session_start", { reason: "resume" }, ctx);
		assert.equal(reads, 1);
	});

	test("wiring: an unreadable record does not cost the cwd nudge", async () => {
		const fake = createFakePi({});
		sessionNudge(fake.pi, {
			readRetro: () => {
				throw new Error("no such file");
			},
		});
		const { ctx, notices } = createFakeCtx({ cwd: HOME });
		await assert.doesNotReject(() => fake.emit("session_start", { reason: "startup" }, ctx));
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /start in the repo/);
	});
});

describe("session-nudge: wiring", () => {
	test("starts in $HOME: one notice at session start", async () => {
		const { emit, ctx, notices } = setup({ cwd: HOME });
		await emit("session_start", { reason: "startup" }, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /start in the repo/);
	});

	test("resuming near compaction: one notice", async () => {
		const { emit, ctx, notices } = setup({ reason: "resume", tokens: 116_000 });
		await emit("session_start", { reason: "resume" }, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /compaction/);
	});

	test("a clean session is silent", async () => {
		const { emit, ctx, notices } = setup();
		await emit("session_start", { reason: "startup" }, ctx);
		assert.equal(notices.length, 0);
	});

	test("never twice, even across repeated session_start events", async () => {
		const { emit, ctx, notices } = setup({ cwd: HOME });
		await emit("session_start", { reason: "startup" }, ctx);
		await emit("session_start", { reason: "resume" }, ctx);
		await emit("session_start", { reason: "new" }, ctx);
		assert.equal(notices.length, 1);
	});

	test("no UI, no line", async () => {
		const { emit, ctx, notices } = setup({ cwd: HOME, hasUI: false });
		await emit("session_start", { reason: "startup" }, ctx);
		assert.equal(notices.length, 0);
	});

	test("a session with no settings and no usage API does not throw", async () => {
		const fake = createFakePi({});
		sessionNudge(fake.pi);
		const { ctx, notices } = createFakeCtx({ cwd: HOME });
		await assert.doesNotReject(() => fake.emit("session_start", { reason: "startup" }, ctx));
		assert.equal(notices.length, 1, "the cwd nudge needs no settings or usage data");
	});
});
