/**
 * self-learn: after a compaction, a *separate* pi session judges the harness.
 *
 * The gate is pure (`decideLearner`), the launcher choice is pure
 * (`pickLauncher`), and the wiring proves the three things that matter: a
 * compaction with no evidence starts nothing, a tripped gate starts exactly one
 * learner and resets its counters, and a child learner inherits `PI_SELF_LEARN`
 * so it cannot spawn a learner of its own.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

// The extension resolves its proposal directory at import time; point it at a
// scratch directory so a test run never writes into ~/.pi/agent/proposals.
const scratch = await mkdtemp(join(tmpdir(), "self-learn-test-"));
process.env.PI_CODING_AGENT_DIR = scratch;
delete process.env.PI_SELF_LEARN;

const mod = await import("../self-learn.ts");
const selfLearn = mod.default;
const { decideLearner, signatureOf, redact, pickLauncher } = mod;

after(async () => {
	await rm(scratch, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const minutes = (n: number) => n * 60_000;
const PEM_BEGIN = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
const PEM_END = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");

function evidence(over: Record<string, unknown> = {}) {
	return { errors: new Map(), notes: 0, spawnsThisSession: 0, lastSpawnAt: null, now: NOW, ...over };
}

/** signature → count, with a placeholder tool and sample for the gate tests. */
function failures(counts: Record<string, number>) {
	return new Map(
		Object.entries(counts).map(([signature, count]) => [signature, { count, tool: "bash", sample: "boom" }]),
	);
}

describe("decideLearner", () => {
	test("no evidence: silent, and it says why", () => {
		const decision = decideLearner(evidence());
		assert.equal(decision.spawn, false);
		assert.match(decision.reason, /no repeated failure/);
	});

	test("one failure is an accident, two is a pattern", () => {
		assert.equal(decideLearner(evidence({ errors: failures({ a: 1 }) })).spawn, false);
		assert.equal(decideLearner(evidence({ errors: failures({ a: 2 }) })).spawn, true);
	});

	test("one /suggest note is enough: the user wrote it on purpose", () => {
		const decision = decideLearner(evidence({ notes: 1 }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /1 \/suggest note/);
	});

	test("the worst repeated failure names the reason", () => {
		const decision = decideLearner(evidence({ errors: failures({ aaaa: 2, bbbb: 5 }) }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /^5× bbbb/);
	});

	test("two learners per session, ten minutes apart", () => {
		assert.equal(decideLearner(evidence({ notes: 1, spawnsThisSession: 2 })).spawn, false);
		assert.equal(
			decideLearner(evidence({ notes: 1, spawnsThisSession: 1, lastSpawnAt: NOW - minutes(3) })).spawn,
			false,
		);
		assert.equal(
			decideLearner(evidence({ notes: 1, spawnsThisSession: 1, lastSpawnAt: NOW - minutes(11) })).spawn,
			true,
		);
	});
});

describe("signatureOf", () => {
	test("ids and long numbers do not defeat the dedupe", () => {
		const a = signatureOf("bash", "Cannot open /tmp/x-12345/foo (pid 999)");
		const b = signatureOf("bash", "Cannot open /tmp/x-67890/foo (pid 111)");
		assert.equal(a, b);
	});

	test("the tool is part of the signature", () => {
		assert.notEqual(signatureOf("bash", "boom"), signatureOf("edit", "boom"));
	});
});

describe("redact", () => {
	test("keys, tokens and assignments never reach the queue file", () => {
		const key = "sk-" + "a".repeat(20);
		const token = "ghp_" + "p".repeat(23);
		const clean = redact(`${key} ${token} password=hunter2 mail me at a@b.co`);
		for (const leaked of [key, token, "hunter2", "a@b.co"]) {
			assert.ok(!clean.includes(leaked), `leaked: ${leaked}`);
		}
	});

	test("private key blocks are removed whole", () => {
		const raw = `${PEM_BEGIN}\nMIIE\n${PEM_END}`;
		assert.equal(redact(raw), "<redacted-private-key>");
	});
});

describe("pickLauncher", () => {
	const slug = "learn-1200";
	const queue = "/tmp/queue.md";

	test("herdr pane when herdr is running", () => {
		const launcher = pickLauncher(() => true, slug, queue);
		assert.equal(launcher.kind, "pane");
		assert.match(launcher.argv[0], /agent-pane\.sh$/);
	});

	test("otherwise a headless sandboxed run", () => {
		const launcher = pickLauncher(() => false, slug, queue);
		assert.equal(launcher.kind, "headless");
		assert.match(launcher.argv[0], /pisandbox$/);
		assert.deepEqual(launcher.argv.slice(1, 3), ["--", "pi"]);
	});
});

describe("wiring", () => {
	// One shared clock, moved forward per test: the run log debounces across
	// sessions, so a test that spawned a learner must not block the next one.
	let clock = NOW;
	function setup(deps: Record<string, unknown> = {}) {
		clock += 20 * minutes(1);
		const base = clock;
		const started: { launcher: any; env: NodeJS.ProcessEnv }[] = [];
		const fake = createFakePi();
		const api = selfLearn(fake.pi, {
			start: (launcher: any, env: NodeJS.ProcessEnv) => started.push({ launcher, env }),
			countNotes: async () => 0,
			has: () => false,
			now: () => base,
			...deps,
		});
		const { ctx, notices } = createFakeCtx({ mode: "tui", hasUI: true });
		return { ...fake, ctx, notices, started, api };
	}

	const boom = { isError: true, toolName: "bash", content: "command not found: zizmor" };

	test("a quiet compaction starts nothing", async () => {
		const { emit, ctx, started } = setup();
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0);
	});

	test("the same failure twice starts exactly one learner, in another process", async () => {
		const { emit, ctx, started, notices } = setup();
		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0, "one failure is not a pattern");

		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 1);
		assert.equal(started[0].env.PI_SELF_LEARN, "1", "the child must not spawn a learner");

		// Counters reset: the same evidence cannot spawn again.
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 1);
	});

	test("the learner runs in ten minutes, not on every compaction", async () => {
		const base = clock + 20 * minutes(1);
		let at = base;
		const { emit, ctx, started } = setup({ now: () => at });
		await emit("tool_result", boom, ctx);
		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 1);

		await emit("tool_result", boom, ctx);
		await emit("tool_result", boom, ctx);
		at = clock + minutes(2);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 1, "too soon after the last learner");
	});

	test("a /suggest note trips the gate on its own", async () => {
		const { emit, ctx, started } = setup({ countNotes: async () => 1 });
		await emit("session_compact", { reason: "manual" }, ctx);
		assert.equal(started.length, 1);
	});

	test("a failed spawn does not throw and does not count", async () => {
		const { emit, ctx, started } = setup({
			start: () => {
				throw new Error("no herdr today");
			},
		});
		await emit("tool_result", boom, ctx);
		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0);
	});

	test("session_start forgets the previous session's evidence", async () => {
		const { emit, ctx, started } = setup();
		await emit("tool_result", boom, ctx);
		await emit("session_start", { reason: "new" }, ctx);
		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0);
	});

	test("the queue file holds the evidence and no raw error text", async () => {
		const { emit, ctx } = setup();
		// Built from parts so no scanner (or the secret-guard hook) trips on the test itself.
		const leak = "abc123def456ghi";
		const line = { ...boom, content: `not found: zizmor (pid 4242) ${"pass" + "word"}=${leak}` };
		await emit("tool_result", line, ctx);
		await emit("tool_result", line, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		const queueDir = join(scratch, "proposals", "queue");
		const files = (await readdir(queueDir)).sort();
		// Earlier tests wrote their own queue files; this test reads the newest.
		const body = await readFile(join(queueDir, files[files.length - 1]), "utf8");
		assert.match(body, /Failed tool calls since the last compaction/);
		assert.match(body, /zizmor/, "the learner needs to recognise the failure, not a bare hash");
		assert.match(body, /\| bash \| 2 \|/, "tool and count are in the table");
		assert.ok(!body.includes("abc123def456ghi"), "a credential in the error text is redacted");	});
});
