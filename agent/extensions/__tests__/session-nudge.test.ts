/**
 * session-nudge: one line, once per session, only when it is true.
 *
 * The decision itself is pure (`decideNudge`), so most of this file needs no
 * fake pi at all. The rest proves the wiring: it fires on `session_start`, never
 * twice, and never in a session without a UI.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../session-nudge.ts");
const sessionNudge = mod.default;
const { decideNudge, isNonProjectDir } = mod;

const HOME = process.env.HOME ?? "/home/mark";
const REPO = `${HOME}/worktrees/pi-automation`;
const NEAR = 120_000;

function setup(
	options: {
		cwd?: string;
		reason?: string;
		tokens?: number | null;
		trusted?: boolean;
		compactAt?: number;
		hasUI?: boolean;
	} = {},
) {
	const fake = createFakePi({
		getSettings: () => ({ "observational-memory": { compactAtContextTokens: options.compactAt ?? NEAR } }),
	});
	sessionNudge(fake.pi);
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
