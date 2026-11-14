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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi, waitFor } from "./helpers/fake-pi.ts";

// The extension resolves its proposal directory at import time; point it at a
// scratch directory so a test run never writes into ~/.pi/agent/proposals.
const scratch = await mkdtemp(join(tmpdir(), "self-learn-test-"));
process.env.PI_CODING_AGENT_DIR = scratch;
delete process.env.PI_SELF_LEARN;

const mod = await import("../self-learn.ts");
const selfLearn = mod.default;
const { decideLearner, signatureOf, redact, pickLauncher, paneTerminal, withSelfClose, clipDetail, turnSession } = mod;
const REPO = join(homedir(), ".pi");

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
		// Injected probes: CI has no ~/.pi, and the choice must not depend on it.
		const launcher = pickLauncher(() => true, slug, queue, () => true);
		assert.equal(launcher.kind, "pane");
		assert.match(launcher.argv[0], /agent-pane\.sh$/);
	});

	test("the learner is started in the repo, never in the queue", () => {
		for (const launcher of [
			pickLauncher(() => true, slug, queue, () => true),
			pickLauncher(() => false, slug, queue, () => true),
			pickLauncher(() => false, slug, queue, () => false),
		]) {
			assert.equal(launcher.cwd, join(homedir(), ".pi"));
		}
		// agent-pane.sh spawns in the spec's directory unless it is told otherwise.
		const pane = pickLauncher(() => true, slug, queue, () => true);
		assert.deepEqual(pane.argv.slice(4), ["--cwd", join(homedir(), ".pi")]);
	});

	test("otherwise a headless sandboxed run", () => {
		const launcher = pickLauncher(() => false, slug, queue, (path) => path.endsWith("pisandbox"));
		assert.equal(launcher.kind, "headless");
		assert.match(launcher.argv[0], /pisandbox$/);
		assert.deepEqual(launcher.argv.slice(1, 3), ["--", "pi"]);
	});

	test("no launcher script at all: plain pi, still headless", () => {
		const launcher = pickLauncher(() => false, slug, queue, () => false);
		assert.equal(launcher.kind, "headless");
		assert.deepEqual(launcher.argv, ["pi", "-p", `Read and execute ${queue}`]);
	});
});

describe("launch verification", () => {
	test("a spawn report with a terminal is a started learner", () => {
		assert.equal(paneTerminal('{"slug":"learn-1200","terminal":"t7","spec":"q"}\n'), "t7");
	});

	test("empty, unparsable or terminal-less output is not a space", () => {
		assert.equal(paneTerminal(""), null);
		assert.equal(paneTerminal("not json at all\n"), null);
		assert.equal(paneTerminal('{"slug":"learn-1200","terminal":""}'), null);
		assert.equal(paneTerminal("{"), null);
	});

	test("stderr is redacted and clipped before it reaches the run log", () => {
		const key = "sk-" + "b".repeat(20);
		const detail = clipDetail(`${key}\n${"x".repeat(1000)}`);
		assert.ok(!detail.includes(key), "a credential in stderr must not be logged");
		assert.ok(detail.length <= 400, "stderr is clipped, the log stays one line");
	});

	test("the learner closes its own space, even if pi dies first", () => {
		const launcher = {
			argv: ["/tmp/pisandbox", "--", "pi", "-p", "Read and execute /tmp/q.md"],
			kind: "headless" as const,
			cwd: join(homedir(), ".pi"),
		};
		const wrapped = withSelfClose(launcher, "learn-1200");
		assert.equal(wrapped.argv[0], "sh");
		const script = wrapped.argv[2];
		assert.match(script, /agent-pane\.sh' 'close' 'learn-1200'/);
		assert.match(script, /; rc=\$\?;/, "the close runs whatever pi's exit status was");
		assert.equal(wrapped.cwd, launcher.cwd);
		// A pane learner closes its own space itself; do not wrap it twice.
		const pane = { argv: ["/tmp/agent-pane.sh", "spawn", "s", "/tmp/q.md"], kind: "pane" as const, cwd: REPO };
		assert.equal(withSelfClose(pane, "learn-1200"), pane);
	});
});

describe("turn confirmation", () => {
	let sessions = 0;

	/** A pi session file as this machine writes one: header, then the first turn. */
	async function sessionFile(root: string, cwd: string, firstTurn: string): Promise<string> {
		const dir = join(root, `--${cwd.replace(/^\/+/, "").replace(/\//g, "-")}--`);
		await mkdir(dir, { recursive: true });
		const path = join(dir, `s${++sessions}.jsonl`);
		const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd };
		const system = { type: "message", message: { role: "system", content: [{ type: "text", text: "be brief" }] } };
		const user = { type: "message", message: { role: "user", content: [{ type: "text", text: firstTurn }] } };
		await writeFile(path, `${[header, system, user].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		return path;
	}

	const cwd = join(tmpdir(), "learner-cwd");
	const queue = join(cwd, "queue", "2026-11-14T19-02-56-300Z.md");

	test("a session whose first turn names the queue file is a learner", async () => {
		const root = await mkdtemp(join(tmpdir(), "self-learn-sessions-"));
		try {
			const path = await sessionFile(root, cwd, `Read ${queue} and do it`);
			assert.equal(await turnSession(root, { cwd, queuePath: queue, since: Date.now() - 60_000 }), path);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a booting pi with no user turn is not a learner", async () => {
		const root = await mkdtemp(join(tmpdir(), "self-learn-sessions-"));
		try {
			// The six-of-seven failure: the process started, the session exists, and the
			// prompt was never consumed.
			const dir = join(root, "--tmp-learner-cwd--");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "boot.jsonl"),
				`${JSON.stringify({ type: "session", version: 3, id: "s2", cwd })}\n`,
				"utf8",
			);
			assert.equal(await turnSession(root, { cwd, queuePath: queue, since: Date.now() - 60_000 }), null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("another prompt in the same cwd, a session from before the launch, or another cwd: no", async () => {
		const root = await mkdtemp(join(tmpdir(), "self-learn-sessions-"));
		try {
			await sessionFile(root, cwd, "Read /tmp/some/other/spec.md and do it");
			const old = await sessionFile(root, cwd, `Read ${queue} and do it`);
			// The launch happened after this session was written.
			assert.equal(await turnSession(root, { cwd, queuePath: queue, since: Date.now() + 60_000 }), null);
			// A worker in a child directory of the repo is not the learner either.
			const elsewhere = await mkdtemp(join(tmpdir(), "self-learn-other-"));
			const other = await sessionFile(elsewhere, join(cwd, "queue"), `Read ${queue} and do it`);
			assert.ok(other.endsWith(".jsonl"));
			assert.equal(await turnSession(root, { cwd, queuePath: queue, since: Date.now() - 60_000 }), old);
			assert.equal(await turnSession(elsewhere, { cwd, queuePath: queue, since: Date.now() - 60_000 }), null);
			await rm(elsewhere, { recursive: true, force: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("wiring", () => {
	// One shared clock, moved forward per test: the run log debounces across
	// sessions, so a test that spawned a learner must not block the next one.
	let clock = NOW;

	/** Every line of the audit trail this test run wrote. */
	async function readRuns(): Promise<any[]> {
		try {
			return (await readFile(join(scratch, "proposals", "runs.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	/** Let a previous test's background launch finish writing its run row. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

	/** Poll the audit trail: the launch is verified in the background. */
	async function waitForRun(predicate: (row: any, index: number) => boolean): Promise<any> {
		for (let i = 0; i < 200; i++) {
			const row = (await readRuns()).find(predicate);
			if (row) return row;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("timed out waiting for a run-log row");
	}

	function setup(deps: Record<string, unknown> = {}) {
		clock += 20 * minutes(1);
		const base = clock;
		const started: { launcher: any; env: NodeJS.ProcessEnv }[] = [];
		// learn() is the only caller of countNotes, so this counts gate evaluations.
		const learn = { calls: 0 };
		const fake = createFakePi();
		const api = selfLearn(fake.pi, {
			launch: (launcher: any, env: NodeJS.ProcessEnv) => {
				started.push({ launcher, env });
				return { ok: true, status: 0 };
			},
			countNotes: async () => {
				learn.calls += 1;
				return 0;
			},
			has: () => false,
			exists: () => true,
			now: () => base,
			// A launch that confirms in a test must not read ~/.pi/agent/sessions, and a
			// failure path must not touch the real agent-panes state file.
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			...deps,
		});
		const { ctx, notices } = createFakeCtx({ mode: "tui", hasUI: true });
		return { ...fake, ctx, notices, started, api, learn };
	}

	const boom = { isError: true, toolName: "bash", content: "command not found: zizmor" };

	/** Two identical failures: the shortest path to a tripped gate. */
	async function trip(emit: (n: string, e?: any, c?: any) => Promise<any[]>, ctx: any) {
		await emit("tool_result", boom, ctx);
		await emit("tool_result", boom, ctx);
	}

	test("a quiet compaction starts nothing", async () => {
		const { emit, ctx, started } = setup();
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0);
	});

	test("the same failure twice starts exactly one learner, in another process", async () => {
		const { emit, ctx, started } = setup();
		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0, "one failure is not a pattern");

		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => started.length === 1);
		assert.equal(started[0].env.PI_SELF_LEARN, "1", "the child must not spawn a learner");

		// Counters reset: the same evidence cannot spawn again.
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 1);
	});

	test("the cwd handed to the launch is the repo, not the queue directory", async () => {
		const { emit, ctx, started } = setup();
		await trip(emit, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => started.length === 1);
		assert.equal(started[0].launcher.cwd, join(homedir(), ".pi"));
		assert.match(started[0].env.PI_SELF_LEARN_SLUG, /^learn-\d{2}-\d{2}$/);
	});

	test("a pane launch that exits 0 without a space fails, and headless takes over", async () => {
		// The reported bug: agent-pane.sh exits 0 without creating a herdr space,
		// and the old code wrote a `spawned` row for a learner that never existed.
		const attempts: string[] = [];
		const { emit, ctx } = setup({
			has: () => true,
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				if (launcher.kind === "pane") return { ok: false, status: 0, detail: "exited 0 without a herdr space" };
				return { ok: true, status: null };
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => attempts.length === 2);
		assert.deepEqual(attempts, ["pane", "headless"], "the pane is tried first, headless is the fallback");

		const runs = (await readRuns()).slice(before);
		const failed = runs.filter((row) => row.kind === "spawn-failed" && row.launcher === "pane");
		assert.equal(failed.length, 1, "a pane that made no space is logged as a failure");
		assert.equal(failed[0].status, 0, "the exit status is recorded, not just the fact of failure");
		assert.match(failed[0].stderr, /without a herdr space/);
		const spawned = runs.filter((row) => row.kind === "spawned");
		assert.equal(spawned.length, 1);
		assert.equal(spawned[0].launcher, "headless", "the log names the launcher that actually ran");
	});

	test("a space whose agent never takes a turn is a failure, not a learner", async () => {
		// The six-of-seven bug: agent-pane.sh exited 0, the space existed, and no pi
		// session ever read the queue file. The space alone was logged as success.
		const attempts: string[] = [];
		const closed: string[] = [];
		const { emit, ctx, notices } = setup({
			has: () => true,
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				// Both launchers report success; neither produces a turn.
				return launcher.kind === "pane" ? { ok: true, status: 0, detail: "t7" } : { ok: true, status: null };
			},
			confirm: async () => ({ ok: false, detail: "no session took the prompt within 90000ms" }),
			closeSpace: async (slug: string) => {
				closed.push(slug);
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => attempts.length === 2);
		const last = await waitForRun((row, index) => index >= before && row.launcher === "headless");
		const written = (await readRuns()).slice(before);
		assert.deepEqual(attempts, ["pane", "headless"], "the pane is tried, then the headless retry");
		assert.equal(written.filter((row) => row.kind === "spawned").length, 0, "no turn, no spawned row");
		const failed = written.filter((row) => row.kind === "spawn-failed");
		assert.deepEqual(failed.map((row) => row.launcher), ["pane", "headless"]);
		assert.equal(failed[0].status, 0, "the pane's own exit status is recorded");
		assert.match(failed[0].stderr, /no session took the prompt/);
		assert.deepEqual(closed, [last.slug, last.slug], "the space that never ran a learner is killed");
		assert.ok(
			notices.some((notice) => notice.level === "warning" && /no learner took the turn/.test(notice.message)),
			"the person is told, in the session, that no learner started",
		);
	});

	test("the headless retry that does take a turn logs spawned, launcher headless", async () => {
		const attempts: string[] = [];
		let confirmations = 0;
		const { emit, ctx } = setup({
			has: () => true,
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				return launcher.kind === "pane" ? { ok: true, status: 0, detail: "t7" } : { ok: true, status: null };
			},
			confirm: async () =>
				++confirmations === 1
					? { ok: false, detail: "no session took the prompt within 90000ms" }
					: { ok: true, source: "session" as const, detail: "/tmp/session.jsonl" },
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const spawned = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const written = (await readRuns()).slice(before);
		assert.deepEqual(attempts, ["pane", "headless"]);
		assert.equal(written.filter((row) => row.kind === "spawn-failed").length, 1, "only the pane lied");
		assert.equal(spawned.launcher, "headless", "the log names the launcher that really ran");
		assert.equal(spawned.confirmed, "session", "and how the turn was proven");
	});

	test("one confirmed launch writes exactly one row", async () => {
		const { emit, ctx, notices } = setup({ has: () => false });
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const spawned = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		await settle();
		const written = (await readRuns()).slice(before);
		assert.equal(written.length, 1, "one learner, one row");
		assert.equal(spawned.launcher, "headless");
		assert.equal(spawned.confirmed, "session");
		assert.ok(
			notices.some((notice) => notice.level === "info" && /learner started/.test(notice.message)),
			"the person is told a learner really started",
		);
	});

	test("the learner is told to hand the PR to big-boss-pi and to close its own space", async () => {
		const { emit, ctx } = setup();
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(body, /big-boss-pi\/bin\/pi-bare/, "the spec names the bare agent that publishes");
		assert.match(body, /agent-pane\.sh close/, "the spec tells the learner to close its own space");
		assert.match(body, /learn-\d{2}-\d{2}/, "the slug it must close is in the file");
		assert.match(body, /worktree add/, "the boss's checkout must not be switched");

		// The prompt file itself, not only the generated queue file.
		const spec = await readFile(new URL("../../prompts/learn.md", import.meta.url), "utf8");
		assert.match(spec, /big-boss-pi\/bin\/pi-bare/);
		assert.match(spec, /agent-pane\.sh close/);
		assert.match(spec, /review tier/i);
	});

	test("the learner runs in ten minutes, not on every compaction", async () => {
		const base = clock + 20 * minutes(1);
		let at = base;
		const { emit, ctx, started } = setup({ now: () => at });
		await trip(emit, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => started.length === 1);

		await trip(emit, ctx);
		at = clock + minutes(2);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 1, "too soon after the last learner");
	});

	test("a /suggest note trips the gate on its own", async () => {
		const { emit, ctx, started } = setup({ countNotes: async () => 1 });
		await emit("session_compact", { reason: "manual" }, ctx);
		await waitFor(() => started.length === 1);
	});

	test("a failed spawn does not throw and does not count as a learner", async () => {
		const attempts: string[] = [];
		const { emit, ctx, notices } = setup({
			has: () => true,
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				return { ok: false, status: 127, detail: "no herdr today" };
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => attempts.length === 2);
		const runs = (await readRuns()).slice(before);
		assert.equal(runs.filter((row) => row.kind === "spawned").length, 0, "no learner, no spawned row");
		assert.equal(runs.filter((row) => row.kind === "spawn-failed").length, 2);
		assert.ok(
			notices.some((notice) => notice.level === "warning" && /no learner took the turn/.test(notice.message)),
			"the person is told, in the session, that no learner started",
		);
	});

	test("session_start forgets the previous session's evidence", async () => {
		const { emit, ctx, started } = setup();
		await emit("tool_result", boom, ctx);
		await emit("session_start", { reason: "new" }, ctx);
		await emit("tool_result", boom, ctx);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.equal(started.length, 0);
	});

	test("a boundary-committed compaction fires the gate, with no session_compact event", async () => {
		const { emit, ctx, started, learn } = setup();
		// om 0.87+ returns its draft from turn_end; pi appends the entry itself and
		// emits only the internal entry_appended event. The branch is the only signal.
		const branch: any[] = [{ type: "message", id: "m1", message: { role: "user", content: "hi" } }];
		ctx.sessionManager = { getBranch: () => branch };
		await emit("session_start", { reason: "startup" }, ctx);
		await trip(emit, ctx);

		branch.push({ type: "compaction", id: "c-om-1", summary: "s", firstKeptEntryId: "m1", tokensBefore: 120_000 });
		await emit("turn_start", { type: "turn_start" }, ctx);
		assert.equal(learn.calls, 1, "the committed entry reached the gate without session_compact");
		await waitFor(() => started.length === 1);

		// The same entry, via the other boundary signal and the next turn: once.
		await emit("before_agent_start", { type: "before_agent_start" }, ctx);
		await emit("turn_start", { type: "turn_start" }, ctx);
		assert.equal(learn.calls, 1, "one compaction entry, one gate evaluation");

		// A new entry is new evidence and reaches the gate again (the ten-minute
		// gap in decideLearner is a separate rule, already tested above).
		branch.push({ type: "compaction", id: "c-om-2", summary: "s", firstKeptEntryId: "m1", tokensBefore: 120_000 });
		await emit("turn_start", { type: "turn_start" }, ctx);
		assert.equal(learn.calls, 2);
	});

	test("a pi-native compaction is not counted twice by the boundary scan", async () => {
		const { emit, ctx, started, learn } = setup();
		const branch: any[] = [];
		ctx.sessionManager = { getBranch: () => branch };
		await emit("session_start", { reason: "startup" }, ctx);
		await trip(emit, ctx);
		// pi appends the entry, then emits session_compact for it.
		branch.push({ type: "compaction", id: "c-pi-1", summary: "s", firstKeptEntryId: "m1", tokensBefore: 90_000 });
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => started.length === 1);

		await emit("turn_start", { type: "turn_start" }, ctx);
		assert.equal(learn.calls, 1, "already handled by session_compact, not re-evaluated");
		assert.equal(started.length, 1);
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
		assert.ok(!body.includes("abc123def456ghi"), "a credential in the error text is redacted");
	});
});
