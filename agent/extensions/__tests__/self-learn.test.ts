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
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile, chmod, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi, waitFor } from "./helpers/fake-pi.ts";

// The extension resolves its proposal directory at import time; point it at a
// scratch directory so a test run never writes into ~/.pi/agent/proposals.
const scratch = await mkdtemp(join(tmpdir(), "self-learn-test-"));
process.env.PI_CODING_AGENT_DIR = scratch;
delete process.env.PI_SELF_LEARN;
// A developer running `npm test` inside `pisandbox` must see the same wiring as CI.
delete process.env.PI_SANDBOX_MODE;

const mod = await import("../self-learn.ts");
const selfLearn = mod.default;
const {
	decideLearner,
	signatureOf,
	redact,
	pickLauncher,
	sandboxBlocksSpawn,
	parseSpawnRequest,
	spawnQueue,
	SPAWN_SUFFIX,
	SPAWN_REQUEST_TTL_MS,
	paneTerminal,
	paneLaunch,
	verifyLaunch,
	sessionProof,
	SESSION_PROOF_MS,
	clipDetail,
	turnSession,
	ciFailuresFrom,
	failedJobsOf,
	jobSample,
	namesCheckAsFailed,
	workerFailuresFrom,
	decisionRows,
	diedLearnersFrom,
	proposalAliases,
	runPaths,
	runStamp,
	frustrationQuotes,
	watchOutcome,
	proposalSpellings,
	proposalWritten,
	ghCiRuns,
	chunks,
	judgedByCode,
	agedOut,
	supersededOut,
	ghCiSettled,
	CI_FAILURE_WINDOW_MS,
	SPAWN_FAILED_WINDOW_MS,
	noStepRan,
	parseRuns,
	readWorkspace,
	judgeOnce,
	failureLines,
	MAX_FRUSTRATION,
	noteBaseline,
	parsePublishRequest,
	publishQueue,
	publishOnce,
	drainPublishQueue,
	watchPublish,
	PUBLISH_SUFFIX,
	PUBLISH_TIMEOUT_MS,
	PUBLISH_WINDOW_MS,
	PUBLISH_POLL_MS,
	runOnce,
} = mod;
const REPO = join(homedir(), ".pi");

after(async () => {
	await rm(scratch, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const minutes = (n: number) => n * 60_000;
const PEM_BEGIN = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
const PEM_END = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");

function evidence(over: Record<string, unknown> = {}) {
	return {
		errors: new Map(),
		notes: 0,
		ciFailures: [],
		workerFailures: [],
		diedLearners: [],
		frustration: [],
		spawnsThisSession: 0,
		lastSpawnAt: null,
		now: NOW,
		...over,
	};
}

/** A session transcript as the host writes one: one JSON object per line. */
function transcriptOf(entries: { role: string; text: string }[]): string {
	return `${entries
		.map((entry) =>
			JSON.stringify({
				type: "message",
				message: { role: entry.role, content: [{ type: "text", text: entry.text }] },
			}),
		)
		.join("\n")}\n`;
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

describe("sandboxBlocksSpawn", () => {
	test("a bare session is not blocked", () => {
		assert.equal(sandboxBlocksSpawn({}), null);
		assert.equal(sandboxBlocksSpawn({ PI_SANDBOX_MODE: "  " }), null, "an empty marker is not a sandbox");
	});

	test("a sandboxed one is, and says where a learner can be started", () => {
		const why = sandboxBlocksSpawn({ PI_SANDBOX_MODE: "bwrap" }) ?? "";
		assert.match(why, /sandboxed \(bwrap\)/);
		assert.match(why, /never mounts herdr-app/, "the cause is the mount table, not a missing binary");
		assert.match(why, /PI_BARE=1 pi/, "the fix is a command, not a sentence to remember");
	});
});

describe("pickLauncher", () => {
	const slug = "learn-1200";
	const queue = "/tmp/queue.md";

	test("one visible space, and the pi inside it runs sandboxed", () => {
		// Injected probes: CI has no ~/.pi, and the choice must not depend on it.
		const launcher = pickLauncher(() => true, slug, queue, () => true);
		assert.equal(launcher.kind, "pane");
		assert.match(launcher.argv[0], /agent-pane\.sh$/);
		assert.match(launcher.argv[1], /^spawn$/);
		assert.ok(launcher.argv.includes("--visible"), "it must appear in the agents pane");
		assert.ok(launcher.argv.includes("--sandbox"), "the pi inside it must run through the sandbox");
		assert.equal(launcher.missing, undefined);
	});

	test("there is no headless or detached runner left to fall back to", () => {
		// The old fallback was `pisandbox -- pi -p` (or plain `pi -p`), detached, and it
		// looked like a sub-agent of the host session for seven launches in a row.
		for (const has of [() => true, () => false]) {
			for (const exists of [() => true, () => false]) {
				const launcher = pickLauncher(has, slug, queue, exists);
				assert.equal(launcher.kind, "pane");
				const argv = launcher.argv.join(" ");
				assert.ok(!argv.includes(" -p "), "a print-mode pi is not a visible learner");
				assert.ok(!launcher.argv.includes("--", ), "pisandbox is reached through agent-pane.sh --sandbox");
			}
		}
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
		assert.deepEqual(pane.argv.slice(4, 6), ["--cwd", join(homedir(), ".pi")]);
	});

	test("the markers that stop a learner starting a learner are handed over", () => {
		const launcher = pickLauncher(() => true, slug, queue, () => true, join(homedir(), ".pi"), {
			PI_SELF_LEARN: "1",
			PI_SELF_LEARN_SLUG: slug,
		});
		const pairs = launcher.argv.flatMap((word, index) => (word === "--env" ? [launcher.argv[index + 1]] : []));
		assert.ok(pairs.includes("PI_SELF_LEARN=1"), "herdr starts the space from the app's env, not this process's");
		assert.ok(pairs.includes(`PI_SELF_LEARN_SLUG=${slug}`));
	});

	test("no herdr: a named failure, not a hidden learner", () => {
		// The bug this replaces: without herdr the learner ran detached, as a
		// sub-agent of the host session, visible to nobody.
		const launcher = pickLauncher((cmd) => cmd !== "hc", slug, queue, () => true);
		assert.deepEqual(launcher.argv, [], "nothing may be started");
		assert.match(launcher.missing ?? "", /hc.*not on PATH/);
	});

	test("no herdr-app: a space could be made but not seen, so it is a failure too", () => {
		const launcher = pickLauncher((cmd) => cmd !== "herdr-app", slug, queue, () => true);
		assert.deepEqual(launcher.argv, []);
		assert.match(launcher.missing ?? "", /herdr-app.*not on PATH/);
	});

	test("no launcher script: same named failure, not plain pi", () => {
		const launcher = pickLauncher(() => true, slug, queue, () => false);
		assert.deepEqual(launcher.argv, []);
		assert.match(launcher.missing ?? "", /agent-pane\.sh is missing/);
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

	test("the report says whether the worker is visible", () => {
		const visible = paneLaunch(
			'{"slug":"learn-1200","terminal":"t7","space":"s3","hidden":false,"sandboxed":true}\n',
		);
		assert.deepEqual(visible, { terminal: "t7", space: "s3", hidden: false });
		const hidden = paneLaunch('{"slug":"learn-1200","terminal":"t7","hidden":true}');
		assert.equal(hidden?.hidden, true, "a hidden worker is recognisable, so it can be refused");
	});

	test("a launch this machine cannot make fails with its own reason, without spawning", async () => {
		// Nothing is run: the failure is the answer, and the run log carries it.
		const result = await verifyLaunch(
			{ argv: [], kind: "pane", cwd: REPO, missing: "herdr (hc) is not on PATH" },
			{},
		);
		assert.equal(result.ok, false);
		assert.match(result.detail ?? "", /herdr \(hc\) is not on PATH/);
	});

	test("stderr is redacted and clipped before it reaches the run log", () => {
		const key = "sk-" + "b".repeat(20);
		const detail = clipDetail(`${key}\n${"x".repeat(1000)}`);
		assert.ok(!detail.includes(key), "a credential in stderr must not be logged");
		assert.ok(detail.length <= 400, "stderr is clipped, the log stays one line");
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

	test("a session file that lands late is proof; one that never lands is not", async () => {
		const root = await mkdtemp(join(tmpdir(), "self-learn-proof-"));
		try {
			// `learn-10-14`: the pane echoed the prompt and no pi ever wrote a session.
			assert.equal(
				await sessionProof(root, { cwd: join(tmpdir(), "nobody"), queuePath: queue, since: Date.now() - 60_000 }, 40, 5),
				null,
				"an echo with no session file behind it is not a learner",
			);
			// The file this helper writes names no queue file, so it is not proof either.
			await sessionFile(root, cwd, "");
			assert.equal(
				await sessionProof(root, { cwd, queuePath: queue, since: Date.now() - 60_000 }, 40, 5),
				null,
				"a session whose turn names another queue is another learner",
			);
			// And the late one is found: the proof wait polls rather than looking once.
			const late = setTimeout(() => {
				void sessionFile(root, cwd, `Read ${queue} and do it`);
			}, 30);
			// A window that is already closed costs no poll: `>=` and not `>`, or a zero-length
			// wait would sleep one interval before answering.
			const started = Date.now();
			assert.equal(
				await sessionProof(root, { cwd: join(tmpdir(), "nobody"), queuePath: queue, since: 0 }, 0, 5_000),
				null,
				"a zero window is one look and out",
			);
			assert.ok(Date.now() - started < 2_000, "and it did not sit out a poll interval to say so");
			const found = await sessionProof(root, { cwd, queuePath: queue, since: Date.now() - 60_000 }, 5_000, 5);
			clearTimeout(late);
			assert.ok(found !== null, "a session file a few polls late is still proof of life");
			assert.equal(SESSION_PROOF_MS, 600_000, "ten minutes: this machine has made a space fourteen minutes late");
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

	/**
	 * Wait until the audit trail stops moving.
	 *
	 * A previous test's launch is verified in the background (`outcomePollMs` 5,
	 * `outcomeTimeoutMs` 100) and appends its row when it is done. A fixed 50 ms here was a
	 * bet that the write had landed; on a box running 31 stryker workers the bet loses, the
	 * late row arrives inside the *next* test and reads as "a spawned row for a learner that
	 * never existed". Poll the file instead: quiet for two looks means the trail is done.
	 */
	const settle = async (): Promise<void> => {
		// One dwell longer than the verifier's own budget (`outcomePollMs` 5 +
		// `outcomeTimeoutMs` 100) so a launch still being watched cannot be mistaken for a
		// finished one, then two quiet looks at the file. Longer than the old 50 ms, never
		// shorter.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const deadline = Date.now() + 5000;
		let seen = (await readRuns()).length;
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			const now = (await readRuns()).length;
			if (now === seen) return;
			seen = now;
			if (Date.now() > deadline) return;
		}
	};

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
			has: () => true,
			exists: () => true,
			now: () => base,
			// A launch that confirms in a test must not read ~/.pi/agent/sessions, and a
			// failure path must not touch the real agent-panes state file.
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			// The new evidence sources are injected so a test never shells out to gh,
			// reads ~/.pi/agent/proposals/runs.jsonl or opens the real workspace.
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
			transcriptPath: () => null,
			proposalExists: () => true,
			outcomePollMs: 5,
			outcomeTimeoutMs: 100,
			// The session-file proof a terminal-confirmed launch waits for: a test must not
			// sit out the real ten minutes.
			sessionProofMs: 30,
			// The publish watch rides the outcome watch. A window of zero is one look and
			// out: a test must not leave a broker polling behind it.
			publishPollMs: 5,
			publishWindowMs: 0,
			...deps,
		});
		const { ctx, notices } = createFakeCtx({ mode: "tui", hasUI: true });
		return { ...fake, ctx, notices, started, api, learn, now: base };
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

	test("a launch that exits 0 without a space is a failure, and nothing else is tried", async () => {
		// The reported bug: agent-pane.sh exits 0 without creating a herdr space,
		// and the old code wrote a `spawned` row for a learner that never existed.
		const attempts: string[] = [];
		const { emit, ctx } = setup({
			has: () => true,
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				return { ok: false, status: 0, detail: "exited 0 without a herdr space" };
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => attempts.length === 1);
		await settle();
		assert.deepEqual(attempts, ["pane"], "one visible attempt, no hidden retry behind it");

		const runs = (await readRuns()).slice(before);
		const failed = runs.filter((row) => row.kind === "spawn-failed" && row.launcher === "pane");
		assert.equal(failed.length, 1, "a pane that made no space is logged as a failure");
		assert.equal(failed[0].status, 0, "the exit status is recorded, not just the fact of failure");
		assert.match(failed[0].stderr, /without a herdr space/);
		assert.equal(runs.filter((row) => row.kind === "spawned").length, 0, "no space, no learner");
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
				return { ok: true, status: 0, detail: "t7" };
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
		await waitFor(() => attempts.length === 1);
		const failed = await waitForRun((row, index) => index >= before && row.kind === "spawn-failed");
		await settle();
		const written = (await readRuns()).slice(before);
		assert.deepEqual(attempts, ["pane"], "the visible space is the only attempt");
		assert.equal(written.filter((row) => row.kind === "spawned").length, 0, "no turn, no spawned row");
		assert.equal(failed.launcher, "pane");
		assert.equal(failed.status, 0, "the launcher's own exit status is recorded");
		assert.match(failed.stderr, /no session took the prompt/);
		assert.deepEqual(closed, [failed.slug], "the space that never ran a learner is closed, so it cannot linger");
		assert.ok(
			notices.some((notice) => notice.level === "warning" && /no learner took the turn/.test(notice.message)),
			"the person is told, in the session, that no learner started",
		);
	});

	test("a learner that finished has its space closed by the host, not by the sandbox", async () => {
		// The spec asks the learner to close its own space, and a sandboxed learner cannot:
		// herdr-app is outside every sandbox mount, so `agent-pane.sh close` keeps the entry
		// and reports `space_closed:false`. The person kept finding those tabs still open
		// after the run ("why is the ci space still alive?", "I still see it").
		const closed: string[] = [];
		const { emit, ctx, started } = setup({
			closeSpace: async (slug: string) => {
				closed.push(slug);
			},
		});
		await trip(emit, ctx);
		await settle();
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => started.length === 1);
		await waitFor(() => closed.length === 1);
		assert.deepEqual(closed, [started[0].env.PI_SELF_LEARN_SLUG], "the space the host made is the space the host closes");
	});

	test("a learner still working after the window keeps its space", async () => {
		// Outcome `unknown` means the watch window closed with the learner apparently
		// still working. Closing then would kill the run the space exists to show.
		const closed: string[] = [];
		const { emit, ctx, started } = setup({
			proposalExists: () => false,
			outcomeTimeoutMs: 30,
			closeSpace: async (slug: string) => {
				closed.push(slug);
			},
		});
		await trip(emit, ctx);
		await settle();
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => started.length === 1);
		await settle();
		assert.deepEqual(closed, [], "an unfinished learner is left in its space");
	});

	test("a learner that died is closed at once, not after the publish window", async () => {
		// A death has no request to wait for. If the close sat behind the publish watch,
		// the tab outlives the learner by fifteen minutes on a real session — which is the
		// same complaint, just slower.
		const session = join(scratch, `learn-died-${process.pid}-${Date.now()}.json`);
		await writeFile(session, "{}", "utf8");
		const closed: string[] = [];
		const { emit, ctx, started } = setup({
			proposalExists: () => false,
			confirm: async () => ({ ok: true, source: "session", detail: session }),
			outcomePollMs: 5,
			outcomeIdleMs: 10,
			publishWindowMs: 400,
			closeSpace: async (slug: string) => {
				closed.push(slug);
			},
		});
		try {
			await trip(emit, ctx);
			await settle();
			await emit("session_compact", { reason: "threshold" }, ctx);
			await waitFor(() => started.length === 1);
			const at = Date.now();
			await waitFor(() => closed.length === 1);
			assert.ok(Date.now() - at < 250, "the space is closed when the learner is, not when the publish window ends");
		} finally {
			await rm(session, { force: true });
		}
	});

	test("a pane that echoed the prompt and no session is a spawn-failed, not a learner", async () => {
		// `learn-10-14` (2026-11-20): `spawned`, confirmed "terminal", no session file in
		// that cwd at any point. The row claimed a learner, the space stayed open, and the
		// next compaction spent a whole learner on a queue nobody had read.
		const closed: string[] = [];
		const { emit, ctx, notices } = setup({
			launch: () => ({ ok: true, status: 3, detail: "t7" }),
			confirm: async () => ({ ok: true, source: "terminal" as const, detail: "t7" }),
			sessionProofMs: 30,
			closeSpace: async (slug: string) => {
				closed.push(slug);
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const failed = await waitForRun((row, index) => index >= before && row.kind === "spawn-failed");
		await settle();
		assert.match(failed.stderr, /the pane showed the prompt/, "the row says what the proof was");
		assert.match(failed.stderr, /no pi session in .* named .*queue/, "and what was missing");
		assert.match(failed.stderr, /no agent took it/, "and what that means");
		assert.equal(failed.status, 3, "the launcher's own exit status rides the row, as it does for any failed launch");
		const spawned = (await readRuns()).filter((row, index) => index >= before && row.kind === "spawned");
		assert.equal(spawned.length, 0, "a launch with no proof of life is never recorded as one");
		assert.deepEqual(closed, [failed.slug], "and the space it made is closed, not left looking busy");
		assert.ok(
			notices.some((notice: any) => notice.level === "warning" && /no learner took the turn/.test(notice.message)),
			"the person is told in the session, at warning level",
		);
	});

	test("an echo that turns into a session file is recorded as the session proof it became", async () => {
		// The other half of the rule above: the wait is not a rejection. When the session
		// file lands, the row is the ordinary `spawned` one — and it can be watched,
		// which a screen-only confirmation never could.
		const home = join(homedir(), ".pi");
		const { emit, ctx, now: base } = setup({
			launch: () => ({ ok: true, status: 0, detail: "t7" }),
			confirm: async () => ({ ok: true, source: "terminal" as const, detail: "t7" }),
			sessionProofMs: 5_000,
		});
		const { queue: queuePath } = runPaths(base);
		const dir = join(scratch, "sessions", `--${home.replace(/^\/+/, "").replace(/\//g, "-")}--`);
		await mkdir(dir, { recursive: true });
		const file = join(dir, `learn-${process.pid}.jsonl`);
		await writeFile(
			file,
			`${[
				{ type: "session", version: 3, id: "s9", timestamp: new Date(base).toISOString(), cwd: home },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: `Read ${queuePath} and do it` }] } },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
			"utf8",
		);
		try {
			await trip(emit, ctx);
			await settle();
			const before = (await readRuns()).length;
			await emit("session_compact", { reason: "threshold" }, ctx);
			const row = await waitForRun((entry, index) => index >= before && entry.kind === "spawned");
			await settle();
			assert.equal(row.queue, queuePath, "the learner the row names is the one that took the prompt");
			assert.equal(row.confirmed, "session", "a session file behind the echo makes it a session proof");
			const failed = (await readRuns()).filter((entry, index) => index >= before && entry.kind === "spawn-failed");
			assert.deepEqual(failed, [], "nothing failed: the file the wait looked for was there");
		} finally {
			await rm(file, { force: true });
		}
	});

	test("no herdr on this machine: one spawn-failed row that names the reason", async () => {
		// The old behaviour was a detached `pi -p` that looked like a sub-agent of
		// the host session. It is a recorded failure now, with its own line.
		const attempts: string[] = [];
		const { emit, ctx, notices } = setup({
			has: (cmd: string) => cmd !== "hc",
			// The real launch: this machine cannot make a space, so nothing is spawned.
			launch: verifyLaunch,
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const failed = await waitForRun((row, index) => index >= before && row.kind === "spawn-failed");
		await settle();
		assert.match(failed.stderr, /hc.*not on PATH/, "the row names what is missing");
		assert.match(failed.stderr, /you cannot see is not started/, "and why that stops the learner");
		assert.ok(
			notices.some((notice) => notice.level === "warning" && /no learner started/.test(notice.message)),
			"the person is told in the session, not left to read runs.jsonl",
		);
	});

	test("a sandboxed session skips the launch instead of writing a death", async () => {
		// Four of these on 2026-11-18 (learn-10-59, learn-11-03, learn-13-08,
		// learn-15-29) were `spawn-failed` rows for a space the sandbox never mounts:
		// the gate read them as learners that died, and every one of them was a fact
		// about herdr-app not being mounted. A skip is not a death.
		const attempts: string[] = [];
		const { emit, ctx, notices, now } = setup({
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				return { ok: true, status: 0 };
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		process.env.PI_SANDBOX_MODE = "bwrap";
		try {
			await emit("session_compact", { reason: "threshold" }, ctx);
			const skipped = await waitForRun((row, index) => index >= before && row.kind === "spawn-skipped");
			// A second compaction in the same session: one row, not one per event.
			await settle();
			await emit("session_compact", { reason: "threshold" }, ctx);
			await settle();
			const written = (await readRuns()).slice(before);
			assert.deepEqual(attempts, [], "no launcher ran: the space cannot exist");
			assert.equal(written.filter((row) => row.kind === "spawn-skipped").length, 1, "one skip per session");
			assert.equal(written.filter((row) => row.kind === "spawn-failed").length, 0, "a skip is not a death");
			assert.equal(written.filter((row) => row.kind === "spawned").length, 0, "nothing was started");
			assert.match(skipped.stderr, /sandboxed \(bwrap\)/);
			assert.match(skipped.stderr, /PI_BARE=1 pi/, "and says where a learner can be started");
			// The row has to name the run it stands in for: `learn-` plus the same
			// `HH:MM` every other row's slug carries, taken from this row's own stamp
			// so a clock that moved between the row and the assertion cannot fake it.
			assert.match(skipped.slug, /^learn-\d{2}-\d{2}$/, "a slug a reader can match to a run");
			assert.equal(
				skipped.slug,
				`learn-${skipped.ts.slice(11, 16).replace(":", "-")}`,
				"the run's own `HH-MM`, not an empty string and not the whole stamp",
			);
			// No spec for a learner that cannot exist: a queue file nothing will ever
			// read is the garbage the skip is meant to avoid.
			assert.equal(
				existsSync(runPaths(Date.parse(skipped.ts)).queue),
				false,
				"nothing was queued for a learner the sandbox would refuse",
			);
			assert.equal(
				diedLearnersFrom(written, { exists: () => false, now }).length,
				0,
				"the next learner is not told a learner died here",
			);
			const told = notices.filter((notice) => /no learner started/.test(notice.message) && /sandbox/.test(notice.message));
			assert.equal(told.length, 1, "the person is told once, in the session");
			assert.equal(told[0].level, "info", "a skip is information, not a warning about a broken machine");
		} finally {
			delete process.env.PI_SANDBOX_MODE;
		}
	});

	test("a sandboxed skip is returned as a refusal, not as a launch", async () => {
		// The decision is what the caller acts on. `{}` and `spawn: true` both leave
		// the row above intact and then write a queue file and try to launch anyway,
		// so the refusal has to be the shape of the value that comes back.
		const { emit, ctx, api } = setup();
		await trip(emit, ctx);
		const before = (await readRuns()).length;
		process.env.PI_SANDBOX_MODE = "bwrap";
		try {
			const decision = await api.learn("compact", ctx);
			assert.equal(decision.spawn, false, "a sandboxed session is not allowed to claim a launch");
			assert.match(
				decision.reason,
				/sandboxed \(bwrap\)/,
				"the refusal says the sandbox did it, not that the gate was quiet",
			);
			const rows = (await readRuns()).slice(before);
			const skipped = rows.filter((row) => row.kind === "spawn-skipped").at(-1);
			assert.ok(skipped, "the skip is the row the trail carries");
			assert.equal(
				existsSync(runPaths(Date.parse(skipped.ts)).queue),
				false,
				"and the refusal wrote no queue file behind it",
			);
			assert.equal(
				rows.filter((row) => row.kind === "spawned" || row.kind === "spawn-failed").length,
				0,
				"nothing was started and nothing died",
			);
		} finally {
			delete process.env.PI_SANDBOX_MODE;
		}
	});

	test("a launch that never started reaches the next queue file, with its reason", async () => {
		// The failure the reader above used to drop: two `spawn-failed` rows and an
		// evidence file that said "None." — the launch path can break and the loop
		// that judges the launch path is the one thing that would not see it.
		const { emit, ctx, now } = setup();
		const runs = join(scratch, "proposals", "runs.jsonl");
		await mkdir(join(scratch, "proposals"), { recursive: true });
		const row = (slug: string) =>
			JSON.stringify({
				ts: new Date(now).toISOString(),
				kind: "spawn-failed",
				slug,
				launcher: "pane",
				status: null,
				stderr: "herdr-app is not on PATH, so no visible space can be made — a learner you cannot see is not started here",
			});
		await appendFile(runs, `${row("learn-10-59")}\n${row("learn-11-03")}\n`);
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const launched = await waitForRun((entry, index) => index >= before && entry.kind === "spawned");
		const body = await readFile(launched.queue, "utf8");
		assert.match(
			body,
			/## Learners that died without a proposal[\s\S]{0,2000}- `learn-10-59` \(pane\) — herdr-app is not on PATH/,
			"the section names the launch that never started, with its reason",
		);
		assert.ok(!/ — queue ``/.test(body), "a launch that never started cites no queue");
		for (const slug of ["learn-10-59", "learn-11-03"]) {
			assert.ok(launched.judged.includes(slug), `${slug} is named by the spawn, so it trips the gate once`);
		}
	});

	test("a visible launch that does take a turn logs spawned, sandboxed and visible", async () => {
		const attempts: string[] = [];
		const { emit, ctx } = setup({
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				return { ok: true, status: 0, detail: "t7" };
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const spawned = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const written = (await readRuns()).slice(before);
		assert.deepEqual(attempts, ["pane"]);
		assert.equal(written.filter((row) => row.kind === "spawn-failed").length, 0, "nothing failed");
		assert.equal(spawned.launcher, "pane", "the log names the launcher that really ran");
		assert.equal(spawned.sandboxed, true, "and that the pi inside it ran through the sandbox");
		assert.equal(spawned.confirmed, "session", "and how the turn was proven");
	});

	test("one confirmed launch writes exactly one row", async () => {
		const { emit, ctx, notices } = setup();
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const spawned = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		await settle();
		const written = (await readRuns()).slice(before);
		assert.equal(written.length, 1, "one learner, one row");
		assert.equal(spawned.launcher, "pane");
		assert.equal(spawned.confirmed, "session");
		assert.ok(
			notices.some((notice) => notice.level === "info" && /learner started/.test(notice.message)),
			"the person is told a learner really started",
		);
	});

	test("the learner is told how to publish its branch and to close its own space", async () => {
		const { emit, ctx } = setup();
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(
			body,
			/queue\/learn-\d{2}-\d{2}\.publish\.json/,
			"the spec names the one file the learner writes to ask for publication",
		);
		assert.match(
			body,
			/"branch":"learn\/learn-\d{2}-\d{2}"/,
			"the request carries the learner's own branch, which is the only one the broker takes",
		);
		assert.match(body, /Do not run/, "and says the script is not the learner's to run");
		assert.match(body, /\.publish\.json/, "the suffix the broker scans for is in the file");
		assert.match(body, /agent-pane\.sh close/, "the spec tells the learner to close its own space");
		assert.match(body, /learn-\d{2}-\d{2}/, "the slug it must close is in the file");
		assert.match(body, /worktree add/, "the boss's checkout must not be switched");
		assert.match(body, /big-boss-pi agent space/, "the agent that publishes runs on the host");
		assert.match(body, /sandboxed/, "and the learner is told why it cannot push");
		// Both of these were literal mutations that survived: the spec's closing
		// paragraph was never read back, so emptying it changed nothing asserted.
		assert.match(
			body,
			/Warnings rather than reported as "none"/,
			"an unreadable source is a warning, never a silent zero",
		);
		// The "How this was produced" paragraph is the provenance claim: which four
		// sources were read, and what was done to the transcript before counting.
		// Emptied by a mutation the prompt still renders, so like the hand-off
		// paragraph it is read back line for line — three of these lines were
		// survivors on self-learn.ts:2623-2625 in the CI job's own range.
		for (const line of [
			"`agent/extensions/self-learn.ts` counted failed tool results in the session that just",
			"compacted, then read four sources outside it: `gh run list --status failure` for this",
			"repo, the delegation workspace's `reports/` and `state/decisions.jsonl`, the `died`,",
			"proposal-less `spawned` and `spawn-failed` rows of `runs.jsonl`, and the user lines of",
			"the session transcript. Messages are hashed to a signature before they are counted, quotes are",
			'redacted and capped at five, and every source that could not be read is listed under',
			'Warnings rather than reported as "none". A report or decision row written before the',
			"newest proposal is not counted again — one finding, one learner (`judgeOnce`).",
		]) {
			assert.ok(body.includes(line), `the provenance paragraph keeps this line: ${line}`);
		}
		assert.match(
			body,
			/one finding, one learner/,
			"the spec says an already-judged finding is not counted again",
		);
		assert.match(
			body,
			/## Hand the branch over, then close/,
			"and names the hand-off as the last thing the learner does",
		);
		assert.match(
			body,
			/one finding, one learner \(`judgeOnce`\)\.\n\n## Hand the branch over/,
			"the paragraph ends and the next heading starts: no stray line between them",
		);
		// The bug this test guards: a bare pi started from the sandbox has no
		// credentials either, so telling the learner to run one only lost turns.
		assert.doesNotMatch(body, /pi-bare/, "no bare agent: it cannot authenticate from the sandbox");
		// The hand-off paragraph is the part the learner acts on, so every line of
		// it is read back word for word. Emptied by a mutation, the prompt still
		// renders and still starts a learner — a hole a test can only see by
		// naming the text. These are the lines stryker reported as survivors on
		// self-learn.ts:2569-2598 (7 of them in the range the CI job mutates).
		for (const line of [
			"You cannot publish from here, and neither can a bare `pi` started from here.",
			"This session runs sandboxed: there is no `gh` login and no git credential on",
			"this side of the sandbox (`gh auth status` says hosts.yml is missing), so a push",
			"or a `gh pr create` fails no matter which binary runs it. Do not run",
			"`scripts/learn-publish.sh` either: it needs `herdr-app`, which lives outside every",
			"sandbox mount, and it refuses a sandboxed caller. Ask the host instead, with one",
			"JSON object in the publish queue. The host session that started you runs the",
			"broker: it runs `learn-publish.sh` for that file, records the outcome in",
			"`runs.jsonl`, and starts the big-boss-pi agent space that pushes and opens the PR.",
			"Concrete values for this run:",
			"3. Ask the host to publish it — one JSON object, one line, exactly these fields:",
			"```json",
			"   Write that file and stop there. The broker picks it up exactly once and runs",
			"   `learn-publish.sh` on the host, which writes the PR body, gate-checks it, and",
			"   starts the agent space that pushes and opens the pull request. One `publish`",
			"   row lands in `agent/proposals/runs.jsonl`: `published`, `failed` (gh answered,",
			"   no PR) or `unverified` (gh could not be asked). Do not run the script yourself,",
			"   do not push, and do not wait for the outcome: your branch and sha are in the",
			"   proposal, and the row is on the host.",
		]) {
			assert.ok(body.includes(line), `the hand-off paragraph keeps this line: ${line}`);
		}
		// The concrete values are what a learner copies out, so the block is read as
		// a block: the blank lines are part of its layout, and the example has to be
		// a request the broker would accept, not only a string that looks like one.
		assert.match(body, /Concrete values for this run:\n\n- slug \/ herdr space: learn-\d{2}-\d{2}\n/);
		assert.match(body, /- repo \(never switch this checkout\): .+\n/);
		assert.match(body, /- proposal: .+\.md\n/);
		assert.match(body, /- queue file to write: .+\.publish\.json\n\n1\. Cut a worktree: /);
		assert.match(body, /2\. Apply your diff there, run the checks it names, commit on that branch\.\n/);
		assert.match(body, /exactly these fields:\n\n```json\n.+\n```\n\n   Write that file/);
		assert.match(body, /the row is on the host\.\n4\. Close your own space, whatever the outcome:/);
		const example = body.match(/```json\n(.+)\n```/);
		assert.ok(example, "the example request is fenced in the queue file");
		assert.equal(
			parsePublishRequest(example[1]).ok,
			true,
			"and the example a learner copies is a request the broker accepts",
		);

		// The prompt file itself, not only the generated queue file.
		const spec = await readFile(new URL("../../prompts/learn.md", import.meta.url), "utf8");
		// The learner asks the host's broker for publication with a queue file: the
		// script needs herdr-app, which a sandbox cannot see, so telling it to run the
		// script only lost turns (and every branch stayed unpublished at exit 2).
		assert.match(spec, /publish\.json/, "the spec names the queue file it writes");
		assert.match(spec, /PI_SANDBOX_MODE/, "and says why the script refuses a sandboxed caller");
		assert.doesNotMatch(
			spec,
			/learn-publish\.sh <slug> --proposal/,
			"the learner is never told to invoke the publisher itself",
		);
		assert.match(spec, /agent-pane\.sh close/);
		assert.match(spec, /review tier/i);
		assert.doesNotMatch(spec, /pi-bare/, "the prompt never sends the learner to a bare agent");
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

	test("a /suggest note counts only until a proposal is written after it", () => {
		const note = "2026-11-13T09:55:09.787Z";
		const proposal = Date.parse("2026-11-14T19:00:00.000Z");
		assert.equal(noteBaseline(note, proposal), new Date(proposal).toISOString(), "the proposal closes the window");
		assert.equal(noteBaseline(note, null), note, "no proposal: the note still counts");
		assert.equal(noteBaseline(note, Date.parse("2026-11-12T00:00:00.000Z")), note, "an older proposal leaves it open");
		assert.equal(noteBaseline(null, null), null, "nothing known: every note counts");
	});

	test("the notes window starts at the newest proposal on disk", async () => {
		const seen: (string | null)[] = [];
		const { emit, ctx } = setup({
			countNotes: async (since: string | null) => {
				seen.push(since);
				return 0;
			},
		});
		const dir = join(scratch, "proposals");
		await mkdir(dir, { recursive: true });
		const judged = join(dir, "2026-11-14-a-verdict.md");
		await writeFile(judged, "# judged\n", "utf8");
		await utimes(judged, 1_800_000_000, 1_800_000_000);
		await emit("session_compact", { reason: "threshold" }, ctx);
		assert.deepEqual(seen, [new Date(1_800_000_000_000).toISOString()]);
	});

	test("a failed spawn does not throw and does not count as a learner", async () => {
		const attempts: string[] = [];
		const { emit, ctx, notices } = setup({
			launch: (launcher: any) => {
				attempts.push(launcher.kind);
				return { ok: false, status: 127, detail: "no herdr today" };
			},
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitFor(() => attempts.length === 1);
		const failed = await waitForRun((row, index) => index >= before && row.kind === "spawn-failed");
		const runs = (await readRuns()).slice(before);
		assert.equal(runs.filter((row) => row.kind === "spawned").length, 0, "no learner, no spawned row");
		assert.equal(runs.filter((row) => row.kind === "spawn-failed").length, 1);
		assert.match(failed.stderr, /no herdr today/);
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

	// ---- the new evidence signals, through the extension -------------------

	test("an unreadable gh is a WARN in the evidence, not a silent zero", async () => {
		const { emit, ctx } = setup({
			ciRuns: async () => ({ runs: [], warning: "failing CI checks not read: gh is not logged in" }),
			// A second warning that is not about CI: one warning that matches and one
			// that does not is still "unread", which is a question about any of them.
			workspace: async () => ({
				reports: [],
				decisions: [],
				present: true,
				warnings: ["report not read: EACCES reading reports/learn-01.md"],
			}),
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(body, /Not read or not counted \(see Warnings\)/, "an empty table never claims there were no failures");
		assert.match(body, /gh is not logged in/, "the evidence says why it could not look");
	});

	test("a partly counted CI list still prints the rows the gate acted on", async () => {
		// This file's own gate said "22× pr-tier failed" while the section beneath it
		// said "not counted": the warnings were consulted before the rows.
		const { emit, ctx } = setup({
			ciRuns: async () => ({
				runs: [
					{ name: "pr-tier", headBranch: "feat/a", conclusion: "failure" },
					{ name: "pr-tier", headBranch: "feat/b", conclusion: "failure" },
				],
				warning: "failing CI checks: 57 of 100 failing runs ran no step and were not counted, because GitHub never started their jobs",
			}),
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(body, /\| pr-tier \| feat\/a, feat\/b \|/, "the table the gate acted on is printed");
		assert.ok(!body.includes("Not read or not counted"), "a counted list is not reported as uncounted");
		assert.match(body, /57 of 100 failing runs ran no step/, "the runs that were dropped are still named in Warnings");
	});

	test("no check failed and the warning is about something else: the section says None, in those words", async () => {
		// Two things had to be true at once for this branch to be tested: the CI list
		// empty (so the table does not print) and no warning *about CI* (so it is a
		// None and not a "not read"). A warning from another source is what tells the
		// two apart: `unread("")` matches any warning, and `else if (true)` skips the
		// question, so an unrelated warning is the only evidence that the prefix is
		// read and the answer is no.
		const { emit, ctx } = setup({
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({
				reports: [],
				decisions: [],
				present: true,
				warnings: [
					"report not read: EACCES reading reports/learn-01.md",
					"runs.jsonl not read: a torn line ate the rest of the file",
				],
			}),
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(body, /report not read: EACCES/, "the unrelated warning was there to be matched");
		assert.match(
			body,
			/^## Repeated failing CI checks\n\nNone: no check failed on two branches or in two worker reports\.$/m,
			"the section is named, then blank line, then a None, said exactly",
		);
		assert.ok(!body.includes("Not read or not counted"), "no CI warning, so nothing is 'not read'");
	});

	test("a check seen only in worker reports shows a dash where the branches would be", async () => {
		// A run row with no branch: the failure is known from two workers' reports, so
		// there is no branch to name and the cell says so instead of going blank.
		const { emit, ctx } = setup({
			ciRuns: async () => ({ runs: [{ name: "pr-tier", headBranch: "", conclusion: "failure" }], warning: null }),
			workspace: async () => ({
				reports: [
					{ path: "/w/reports/a.md", text: "- pr-tier failed: exit 1" },
					{ path: "/w/reports/b.md", text: "- pr-tier failed: exit 2" },
				],
				decisions: [],
				present: true,
				warnings: [],
			}),
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(body, /^\| pr-tier \| — \| 2 \|/m, "no branch is a dash, and the report count is the count");
	});

	test("a confirmed learner whose session goes quiet without its proposal leaves a died row", async () => {
		// The launcher (agent-pane.sh) exits as soon as the spec is sent, so an exit
		// status says nothing about the learner: silence is the only honest death.
		const session = join(scratch, "died-session.jsonl");
		await writeFile(session, "{\"type\":\"session\"}\n", "utf8");
		const { emit, ctx } = setup({
			launch: () => ({ ok: true, status: 0, detail: "t7" }),
			confirm: async () => ({ ok: true, source: "session" as const, detail: session }),
			proposalExists: () => false,
			outcomeIdleMs: 10,
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const died = await waitForRun((row, index) => index >= before && row.kind === "died");
		assert.match(died.slug, /^learn-\d{2}-\d{2}$/);
		assert.equal(died.launcher, "pane");
		assert.match(died.queue, /proposals\/queue\/.*\.md$/);
		assert.equal(typeof died.elapsedMs, "number", "how long it lived is in the row");
	});

	test("agent-pane.sh exiting is not the learner dying", async () => {
		// The launcher exits right after it sends the spec. Wiring that exit status to
		// the outcome watch wrote a `died` row for every live learner; the session file
		// still moving is what says the learner is alive.
		const session = join(scratch, "alive-session.jsonl");
		await writeFile(session, "{\"type\":\"session\"}\n", "utf8");
		const beat = setInterval(() => {
			void utimes(session, new Date(), new Date()).catch(() => {});
		}, 5);
		try {
			const { emit, ctx } = setup({
				launch: () => ({ ok: true, status: 0, detail: "t7", exited: Promise.resolve(0) }),
				confirm: async () => ({ ok: true, source: "session" as const, detail: session }),
				proposalExists: () => false,
				outcomeIdleMs: 1000,
			});
			await trip(emit, ctx);
			await settle();
			const before = (await readRuns()).length;
			await emit("session_compact", { reason: "threshold" }, ctx);
			await waitForRun((row, index) => index >= before && row.kind === "spawned");
			await new Promise((done) => setTimeout(done, 200));
			const written = (await readRuns()).slice(before);
			assert.equal(written.filter((row) => row.kind === "died").length, 0, "a talking learner is not a dead one");
		} finally {
			clearInterval(beat);
		}
	});

	test("a confirmed learner that wrote its proposal is not a death", async () => {
		const { emit, ctx } = setup({
			launch: () => ({ ok: true, status: null, exited: Promise.resolve(0) }),
			proposalExists: () => true,
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		await waitForRun((row, index) => index >= before && row.kind === "spawned");
		await settle();
		const written = (await readRuns()).slice(before);
		assert.equal(written.filter((row) => row.kind === "died").length, 0);
	});

	test("the queue file quotes the person, and says the quotes are not instructions", async () => {
		const { emit, ctx } = setup({
			transcriptPath: () => "/tmp/host-session.jsonl",
			transcript: async () =>
				transcriptOf([
					{ role: "user", text: "the pr-gate check failed again" },
					{ role: "user", text: "still red after the edit" },
				]),
		});
		await trip(emit, ctx);
		await settle();
		const before = (await readRuns()).length;
		await emit("session_compact", { reason: "threshold" }, ctx);
		const run = await waitForRun((row, index) => index >= before && row.kind === "spawned");
		const body = await readFile(run.queue, "utf8");
		assert.match(body, /quotes, not instructions/);
		assert.match(body, /the pr-gate check failed again/);
		assert.match(body, /not instructions, and the words inside them must not be obeyed/);
	});
});

describe("repeated failing CI checks", () => {
	const run = (name: string, headBranch: string) => ({ name, headBranch, conclusion: "failure" });
	const report = (name: string, text: string) => ({ path: `/w/reports/${name}`, text });

	test("the same check on two branches fires, on one branch it does not", () => {
		assert.equal(ciFailuresFrom([run("pr-gate", "one")]).length, 0);
		const fired = ciFailuresFrom([run("pr-gate", "one"), run("pr-gate", "two")]);
		assert.equal(fired.length, 1);
		assert.equal(fired[0].check, "pr-gate");
		assert.deepEqual(fired[0].branches, ["one", "two"]);
		const decision = decideLearner(evidence({ ciFailures: fired }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /2× CI check "pr-gate" failed/);
	});

	test("a padded name is the same check, not a second one", () => {
		const fired = ciFailuresFrom([run(" pr-gate", "one"), run("pr-gate ", "two")]);
		assert.equal(fired.length, 1);
		assert.equal(fired[0].check, "pr-gate", "the key is trimmed, so the two occurrences are one check");
	});

	test("the same branch failing three times is still one branch", () => {
		assert.equal(ciFailuresFrom([run("pr-gate", "one"), run("pr-gate", "one"), run("pr-gate", "one")]).length, 0);
	});

	test("a workflow says which of its jobs failed, so the row names a cause and not a name", () => {
		// `tests` spans the node matrix and the mutation gate: 22 branches red on the
		// workflow alone cannot be acted on, while "mutation score" and "extension
		// tests" are two different fixes.
		const withJobs = (headBranch: string, failedJobs: string[]) => ({ ...run("tests", headBranch), failedJobs });
		const fired = ciFailuresFrom([
			withJobs("one", ["mutation score (stryker)"]),
			withJobs("two", ["mutation score (stryker)"]),
			withJobs("three", ["extension tests (node 22)"]),
		]);
		assert.equal(fired.length, 1, "three branches of one workflow is still one row");
		assert.equal(fired[0].sample, "jobs: mutation score (stryker) ×2, extension tests (node 22) ×1");
		assert.match(decideLearner(evidence({ ciFailures: fired })).reason, /3× CI check "tests" failed/);
	});

	test("a report that names the cause outranks the job names", () => {
		const fired = ciFailuresFrom(
			[
				{ ...run("tests", "one"), failedJobs: ["mutation score (stryker)"] },
				{ ...run("tests", "two"), failedJobs: ["mutation score (stryker)"] },
			],
			[report("w1.md", "FAIL tests: the stryker run timed out on one mutant")],
		);
		assert.match(fired[0].sample, /timed out on one mutant/, "a worker's own words beat a job name");
	});

	test("no job names, no jobs line: the branches stay the sample", () => {
		const fired = ciFailuresFrom([run("tests", "one"), run("tests", "two")]);
		assert.equal(fired[0].sample, "branches: one, two");
	});

	test("the job names are the failed ones, deduped, and an unnamed job is not a name", () => {
		const jobs = [
			{ name: "extension tests (node 22)", conclusion: "failure" },
			{ name: "extension tests (node 22)", conclusion: "failure" },
			{ name: "mutation score (stryker)", conclusion: "failure" },
			{ name: "extension tests (node 24)", conclusion: "success" },
			{ name: "  ", conclusion: "failure" },
			{ conclusion: "failure" },
		];
		assert.deepEqual(failedJobsOf(jobs), ["extension tests (node 22)", "mutation score (stryker)"]);
		assert.deepEqual(failedJobsOf([]), []);
		// gh can print a row with no object in it; a reader that trusts the type
		// dies on that row instead of naming the ones around it.
		const nullRow = null as unknown as { name?: string; conclusion?: string };
		assert.deepEqual(
			failedJobsOf([nullRow, { name: "mutation score (stryker)", conclusion: "failure" }]),
			["mutation score (stryker)"],
			"a null row is skipped, not a crash",
		);
	});

	test("the jobs line counts down, and a tie is decided by the name, not by gh's order", () => {
		const tied = new Map([
			["zebras", 2],
			["alpacas", 2],
		]);
		assert.equal(jobSample(tied), "jobs: alpacas ×2, zebras ×2");
		assert.equal(jobSample(new Map([["only", 1]])), "jobs: only ×1");
		assert.equal(jobSample(new Map()), "", "no tally is not an empty line");
		assert.equal(jobSample(undefined), "", "a check no probe asked about says nothing about jobs");
	});

	test("a capability note is not a failure, so the job names behind it survive", () => {
		// 2026-11-20T12-28: `tests` was red on 22 branches and the row said only
		// "Now possible: a learner reading \"CI check tests failed\" on 22 branches
		// gets the job names inside it" — a worker announcing #192, read as a verdict
		// on the check itself, with the probe's job names discarded behind it.
		const note = [
			'Now possible: a learner reading "CI check tests failed" on 22 branches gets the job names inside it, and the gate that proves it cannot be skipped.',
			"FAIL prose-review: the body states no Mission line",
		].join("\n");
		assert.deepEqual(failureLines(note), ["FAIL prose-review: the body states no Mission line"]);
		const redJobs = ["mutation score (stryker)", "extension tests (node 22)"];
		const red = (branch: string, failedJobs: string[]) => ({ ...run("tests", branch), failedJobs });
		const fired = ciFailuresFrom([red("one", redJobs), red("two", redJobs), { ...run("prose-review", "three"), failedJobs: ["prose review"] }], [
			report("192-pr.md", note),
		]);
		const tests = fired.find((ci) => ci.check === "tests");
		assert.equal(tests?.reports.length, 0, "no worker reported `tests`; the sentence quoted the evidence");
		assert.equal(tests?.sample, "jobs: extension tests (node 22) ×2, mutation score (stryker) ×2");
		assert.equal(fired.find((ci) => ci.check === "prose-review")?.reports.length, 1, "a real failure line still counts");
	});

	test("a verdict has to be attached to the name, in either of the two shapes", () => {
		const counts: [string, string, boolean][] = [
			["FAIL tests", "tests", true],
			["FAILED tests: one case red", "tests", true],
			["  FAIL   pr-gate red", "pr-gate", true],
			["tests: failed", "tests", true],
			["tests: fail", "tests", true],
			["  FAIL tests: one case red", "tests", true],
			["FAIL   tests: one case red", "tests", true],
			["tests x: failed", "tests", false],
			["testsfailed: one case red", "tests", false],
			['pr-gate" red', "pr-gate", true],
			["tests=failing", "tests", true],
			["x tests: failed", "tests", true],
			["tests not ok", "tests", true],
			["tests failure", "tests", true],
			["tests fails", "tests", true],
			["pr-gate red", "pr-gate", true],
			["tests", "tests", false],
			["ok tests", "tests", false],
			["the tests all passed", "tests", false],
			["we FAIL tests last week", "tests", false],
			["FAIL tests-extra: one case red", "tests", false],
			["pr-gates: red", "pr-gate", false],
			["tests (failed)", "tests", false],
			["", "tests", false],
			["anything", "", false],
		];
		for (const [line, check, expected] of counts) {
			assert.equal(
				namesCheckAsFailed(line, check),
				expected,
				`${JSON.stringify(line)} as ${JSON.stringify(check)}`,
			);
		}
	});

	test("a worker report naming the check is the second occurrence", () => {
		const fired = ciFailuresFrom([run("pr-gate", "one")], [report("w1.md", "make pr-check: pr-gate red on mission")]);
		assert.equal(fired.length, 1);
		assert.equal(fired[0].branches.length, 1);
		assert.equal(fired[0].reports.length, 1);
		assert.match(fired[0].sample, /pr-gate/);
	});

	test("a report that merely mentions the word tests is not a CI verdict on `tests`", () => {
		// 2026-11-17T19-50: this exact line, quoted from an eval report, counted as one of
		// 37 "workers" who saw the `tests` check red. Nobody had.
		const prose = report(
			"evals.md",
			'Case 9 ("leads with the runnable command when asked how to run the tests") failed on 2026-11-14',
		);
		assert.equal(namesCheckAsFailed(prose.text, "tests"), false);
		assert.equal(ciFailuresFrom([run("tests", "trunk")], [prose]).length, 0);
		assert.equal(
			ciFailuresFrom([run("tests", "trunk")], [prose, report("other.md", prose.text)]).length,
			0,
			"two mentions are still not two workers",
		);
		assert.equal(
			ciFailuresFrom([run("tests", "trunk")], [report("a.md", "FAIL tests-extra: one case red")]).length,
			0,
			"a longer name is a different check",
		);
		assert.equal(
			ciFailuresFrom([run("tests", "trunk")], [report("a.md", "mytests failed, said the log")]).length,
			0,
			"the name has to start where the word starts",
		);
	});

	test("a report naming the check and its verdict is the second occurrence", () => {
		for (const line of ["FAIL tests", "fail tests", "`tests` failed: 3 red", "tests: failure in the shell job", "tests red on trunk"]) {
			const fired = ciFailuresFrom([run("tests", "trunk")], [report("w1.md", line)]);
			assert.equal(fired.length, 1, line);
			assert.equal(fired[0].reports.length, 1, line);
			assert.equal(fired[0].sample, line, line);
		}
	});

	test("gh absent is a warning, never a crash and never a silent zero", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-nogh-"));
		try {
			const result = await ghCiRuns(dir, join(dir, "no-such-gh-binary"));
			assert.deepEqual(result.runs, []);
			assert.match(result.warning ?? "", /failing CI checks not read/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// 2026-11-15: every check on trunk and nine branches was red in two seconds with
	// zero steps, because GitHub would not start the jobs (account payments failed).
	// Three of the newest failures are inspected for a step, because a billing block
	// is account-wide and a run that ran nothing judged nothing.
	const FAILED_RUNS = JSON.stringify([
		{ name: "tests", headBranch: "trunk", conclusion: "failure", databaseId: 1 },
		{ name: "pr-tier", headBranch: "trunk", conclusion: "failure", databaseId: 2 },
		{ name: "harness-check", headBranch: "trunk", conclusion: "failure", databaseId: 3 },
	]);

	async function fakeGh(dir: string, view: string): Promise<string> {
		const path = join(dir, "gh");
		await writeFile(
			path,
			`#!/usr/bin/env bash\ncase "$2" in\n  list) printf '%s' '${FAILED_RUNS}' ;;\n  view) ${view} ;;\nesac\n`,
			"utf8",
		);
		await chmod(path, 0o755);
		return path;
	}

	test("a run whose jobs never started is not a repeated CI failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-idle-gh-"));
		try {
			const bin = await fakeGh(dir, `printf '%s' '{"jobs":[{"conclusion":"failure","steps":[]},{"conclusion":"skipped","steps":[]}]}'`);
			const result = await ghCiRuns(dir, bin);
			assert.deepEqual(result.runs, [], "a queue refusal is not evidence about the code");
			assert.match(result.warning ?? "", /all 3 of 3 failing runs ran no step/);
			assert.match(result.warning ?? "", /failing CI checks not counted/);
			assert.match(result.warning ?? "", /Billing & plans/);
			const decision = decideLearner(evidence({ ciFailures: ciFailuresFrom(result.runs) }));
			assert.equal(decision.spawn, false, "no learner is started about runs that judged nothing");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("one job that ran a step keeps the failures, and no warning is written", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-ran-gh-"));
		try {
			const bin = await fakeGh(dir, `printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}'`);
			const result = await ghCiRuns(dir, bin);
			assert.equal(result.runs.length, 3);
			assert.equal(result.warning, null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable job probe keeps the failures instead of hiding them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-probe-gh-"));
		try {
			const bin = await fakeGh(dir, "exit 1");
			const result = await ghCiRuns(dir, bin);
			assert.equal(result.runs.length, 3, "doubt counts normally");
			assert.equal(result.warning, null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a mixed list drops only the runs that never started", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-mixed-gh-"));
		try {
			// 2026-11-17: the three newest runs had started, 76 older ones had not.
			// The old probe looked at the newest three only and kept all 93.
			const bin = await fakeGh(
				dir,
				`case "$3" in 1) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[]}]}' ;; *) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}' ;; esac`,
			);
			const result = await ghCiRuns(dir, bin);
			assert.equal(result.runs.length, 2, "the two runs that executed a step are kept");
			assert.match(result.warning ?? "", /1 of 3 failing runs ran no step/);
			assert.match(result.warning ?? "", /Billing & plans/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("judgedByCode keeps a run it cannot ask about, and counts the doubt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-judged-"));
		try {
			const bin = await fakeGh(dir, "exit 1");
			const runs = [
				{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 },
				{ name: "tests", headBranch: "b", conclusion: "failure" },
			];
			const judged = await judgedByCode(runs, dir, bin);
			assert.equal(judged.runs.length, 2, "an unreadable probe and a missing id both count normally");
			assert.equal(judged.refused, 0);
			assert.equal(judged.unreadable, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the probe runs in batches of eight, and no batch goes missing", () => {
		// The loop bound and its slice were equivalent mutants before the
		// batches were named: an extra empty batch, or a slice wider than the
		// list, changed nothing the caller could see.
		const items = Array.from({ length: 18 }, (_, at) => at);
		assert.deepEqual(chunks(items, 8).map((batch) => batch.length), [8, 8, 2]);
		assert.deepEqual(chunks(items, 8).flat(), items, "every run lands in exactly one batch");
		assert.deepEqual(chunks([], 8), [], "nothing to probe is no batch at all");
		assert.deepEqual(chunks([1], 8), [[1]]);
	});

	test("ten runs cost ten probes, not one per batch", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-batches-"));
		try {
			const seen = join(dir, "asked");
			const bin = await fakeGh(
				dir,
				`printf 'x' >> '${seen}'; printf '%s' '{"jobs":[{"conclusion":"failure","steps":[]}]}'`,
			);
			const runs = Array.from({ length: 10 }, (_, at) => ({
				name: "tests",
				headBranch: `b${at}`,
				conclusion: "failure",
				databaseId: at + 1,
			}));
			const judged = await judgedByCode(runs, dir, bin);
			assert.equal(judged.refused, 10);
			assert.equal(judged.unreadable, 0, "no probe went unanswered: a body lost in the pipe reads as doubt, not as a refusal");
			assert.equal(judged.runs.length, 0);
			const asked = await readFile(seen, "utf8").catch(() => "");
			assert.equal(asked.length, 10, "one probe per run across two batches");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a run with no id is never asked about, and stays a failure", async () => {
		// gh's list can omit databaseId. Such a run cannot be probed, so it is
		// kept without a call: the day the id test inverts, an unprobeable run
		// becomes the only thing probed and a real failure disappears.
		const dir = await mkdtemp(join(tmpdir(), "self-learn-noid-"));
		try {
			const seen = join(dir, "asked");
			const bin = await fakeGh(
				dir,
				`printf 'x' >> '${seen}'; printf '%s' '{"jobs":[{"conclusion":"failure","steps":[]}]}'`,
			);
			const runs = [
				{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 },
				{ name: "tests", headBranch: "b", conclusion: "failure" },
			];
			const judged = await judgedByCode(runs, dir, bin);
			assert.deepEqual(
				judged.runs.map((run) => run.headBranch),
				["b"],
				"the unprobeable run stays; the one that provably ran no step is refused",
			);
			assert.equal(judged.refused, 1, "only the run with an id could be refused");
			assert.equal(judged.unreadable, 0, "no probe went unanswered");
			const asked = await readFile(seen, "utf8").catch(() => "");
			assert.equal(asked, "x", "one probe call, for the run that has an id");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the probe keeps the job names, so the evidence can say what inside a workflow broke", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-jobs-"));
		try {
			const bin = await fakeGh(
				dir,
				`printf '%s' '{"jobs":[{"name":"mutation score (stryker)","conclusion":"failure","steps":[{"name":"stryker run"}]},{"name":"extension tests (node 22)","conclusion":"success","steps":[{"name":"test"}]}]}'`,
			);
			const runs = [
				{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 },
				{ name: "tests", headBranch: "b", conclusion: "failure", databaseId: 2 },
			];
			const judged = await judgedByCode(runs, dir, bin);
			assert.deepEqual(
				judged.runs.map((run) => run.failedJobs),
				[["mutation score (stryker)"], ["mutation score (stryker)"]],
				"a job that succeeded is not a failed job",
			);
			const fired = ciFailuresFrom(judged.runs);
			assert.equal(fired[0].sample, "jobs: mutation score (stryker) ×2", "the row names the job, not the workflow");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a run with no failed job carries no list, rather than an empty one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-nojobs-"));
		try {
			const bin = await fakeGh(dir, `printf '%s' '{"jobs":[{"name":"test","conclusion":"success","steps":[{"name":"test"}]}]}'`);
			const judged = await judgedByCode([{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 }], dir, bin);
			assert.equal(judged.runs.length, 1);
			assert.equal(judged.runs[0].failedJobs, undefined, "no failed job: nothing to name");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a probe that failed is doubt, whatever its stdout held", async () => {
		// gh exits non-zero and still prints a plausible body: the exit code is the
		// verdict, so the body is not one. Reading it would hand the caller job
		// names that no run reported.
		const dir = await mkdtemp(join(tmpdir(), "self-learn-exit-gh-"));
		try {
			const body =
				'{"jobs":[{"name":"mutation score (stryker)","conclusion":"failure","steps":[{"name":"stryker run"}]}]}';
			const bin = await fakeGh(dir, `printf '%s' '${body}'; exit 1`);
			const judged = await judgedByCode([{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 }], dir, bin);
			assert.equal(judged.unreadable, 1, "a failed probe is doubt, not an answer");
			assert.equal(judged.runs.length, 1, "doubt counts normally");
			assert.equal(judged.runs[0].failedJobs, undefined, "the body beside a failed exit named no job");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a body gh cannot read as a job list is doubt, not a green run", async () => {
		// Two shapes that are not a roster: valid JSON with the wrong type, and
		// something that is not JSON at all. Both mean "gh could not say", so the
		// run is kept and counted as doubt — never as a run that judged nothing.
		const dir = await mkdtemp(join(tmpdir(), "self-learn-unreadable-gh-"));
		try {
			for (const body of ['{"jobs":42}', "not json at all"]) {
				const bin = await fakeGh(dir, `printf '%s' '${body}'`);
				const judged = await judgedByCode([{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 }], dir, bin);
				assert.equal(judged.unreadable, 1, `body ${body} is doubt`);
				assert.equal(judged.refused, 0, `body ${body} is not a queue refusal`);
				assert.equal(judged.runs.length, 1, `body ${body} keeps the run`);
				assert.equal(judged.runs[0].failedJobs, undefined, `body ${body} named no job`);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a refusal is counted as a refusal, not as doubt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-tally-"));
		try {
			const bin = await fakeGh(
				dir,
				`case "$3" in 1) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[]}]}' ;; 3) exit 1 ;; *) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}' ;; esac`,
			);
			const runs = [
				{ name: "tests", headBranch: "a", conclusion: "failure", databaseId: 1 },
				{ name: "tests", headBranch: "b", conclusion: "failure", databaseId: 2 },
				{ name: "tests", headBranch: "c", conclusion: "failure", databaseId: 3 },
			];
			const judged = await judgedByCode(runs, dir, bin);
			assert.equal(judged.refused, 1);
			assert.equal(judged.unreadable, 1, "a probe that could not answer is not a refusal");
			assert.equal(judged.runs.length, 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an empty failure list is not a billing block", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-empty-gh-"));
		try {
			const bin = await fakeGh(dir, "exit 1");
			await writeFile(
				bin,
				`#!/usr/bin/env bash\ncase "$2" in\n  list) printf '%s' '[]' ;;\n  view) exit 1 ;;\nesac\n`,
				"utf8",
			);
			const result = await ghCiRuns(dir, bin);
			assert.deepEqual(result.runs, []);
			assert.equal(result.warning, null, "nothing failed, so nothing was refused");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a failing run older than the window is history, not evidence", () => {
		// 2026-11-18: gh holds every failure forever, so the gate read `23× pr-tier`
		// across 23 branches whose newest failure was 18 hours old. The table has to
		// describe now.
		const now = Date.parse("2026-11-18T09:00:00Z");
		const days = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();
		const runs = [
			{ name: "pr-tier", headBranch: "merged-long-ago", conclusion: "failure", createdAt: days(30) },
			{ name: "tests", headBranch: "trunk", conclusion: "failure", createdAt: days(1) },
			{ name: "harness-check", headBranch: "no-date", conclusion: "failure" },
			{ name: "zizmor", headBranch: "garbage", conclusion: "failure", createdAt: "not a date" },
			{ name: "secret scan", headBranch: "boundary", conclusion: "failure", createdAt: days(7) },
		];
		const aged = agedOut(runs, now);
		assert.equal(aged.aged, 1, "the 30-day-old run is the only one past the window");
		assert.deepEqual(
			aged.runs.map((run) => run.headBranch),
			["trunk", "no-date", "garbage", "boundary"],
			"an unreadable or absent date is not an old one, and a week old is still inside",
		);
		assert.deepEqual(agedOut([], now), { runs: [], aged: 0 }, "nothing to age is no window");
		assert.equal(CI_FAILURE_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
	});

	test("an aged-out run leaves the table, and the count of what aged out is written down", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-aged-gh-"));
		try {
			const long = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
			const fresh = new Date(Date.now() - 60_000).toISOString();
			const runs = JSON.stringify([
				{ name: "pr-tier", headBranch: "gone", conclusion: "failure", databaseId: 1, createdAt: long },
				{ name: "tests", headBranch: "one", conclusion: "failure", databaseId: 2, createdAt: fresh },
				{ name: "tests", headBranch: "two", conclusion: "failure", databaseId: 3, createdAt: fresh },
			]);
			const bin = join(dir, "gh");
			await writeFile(
				bin,
				`#!/usr/bin/env bash\ncase "$2" in\n  list) printf '%s' '${runs}' ;;\n  view) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}' ;;\nesac\n`,
				"utf8",
			);
			await chmod(bin, 0o755);
			const result = await ghCiRuns(dir, bin);
			assert.deepEqual(
				result.runs.map((run) => run.headBranch),
				["one", "two"],
				"the 30-day-old pr-tier run is gone, so the check no longer has two branches and cannot fire",
			);
			assert.match(result.warning ?? "", /1 of 3 failing runs are older than 7 days/);
			assert.match(result.warning ?? "", /older CI failures not counted/);
			assert.doesNotMatch(result.warning ?? "", /not read/, "the list was read; only the window changed");
			assert.equal(ciFailuresFrom(result.runs).length, 1, "tests on two fresh branches still fires");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// 2026-11-19: the table read `24× tests` across 24 branches, twenty of which no
	// longer existed on the remote, while `cd agent && npm test` was green here. The
	// query asked for failures only, so the green run that fixed a branch was never
	// in front of the gate and the red it replaced stayed for the rest of the week.
	test("a failure a newer green run answered is dropped, and nothing else answers it", () => {
		const clock = (hours: number) => new Date(Date.parse("2026-11-19T12:00:00Z") + hours * 60 * 60 * 1000).toISOString();
		const failed = (headBranch: string, createdAt: string = clock(0)) => ({ name: "tests", headBranch, conclusion: "failure", createdAt });
		const settled = (headBranch: string, conclusion: string, createdAt?: string, name = "tests") => ({ name, headBranch, conclusion, createdAt });
		const failures = [
			failed("fixed"),
			failed("another-branch"),
			failed("another-check"),
			failed("older-green"),
			failed("same-instant"),
			failed("cancelled-after"),
			failed("undated", ""),
		];
		const greens = [
			settled("fixed", "success", clock(1)),
			settled("a-branch-with-no-failure", "success", clock(1)),
			settled("another-check", "success", clock(1), "pr-tier"),
			settled("older-green", "success", clock(-1)),
			settled("same-instant", "success", clock(0)),
			settled("cancelled-after", "cancelled", clock(1)),
			settled("undated", "success"),
		];
		const live = supersededOut(failures, greens);
		assert.deepEqual(
			live.runs.map((run) => run.headBranch),
			["another-branch", "another-check", "older-green", "same-instant", "cancelled-after", "undated"],
			"only the same check, on the same branch, strictly newer, and actually green supersedes",
		);
		assert.equal(live.superseded, 1);
		assert.deepEqual(supersededOut([], greens), { runs: [], superseded: 0 }, "no failures is nothing to drop");
	});

	test("a branch that was fixed stops counting, and the newest red on the branch still does", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-superseded-gh-"));
		try {
			const hour = 60 * 60 * 1000;
			const clock = (hours: number) => new Date(Date.now() - hours * hour).toISOString();
			const failures = JSON.stringify([
				{ name: "tests", headBranch: "fixed-yesterday", conclusion: "failure", databaseId: 1, createdAt: clock(24) },
				{ name: "tests", headBranch: "still-red", conclusion: "failure", databaseId: 2, createdAt: clock(1) },
			]);
			const greens = JSON.stringify([
				{ name: "tests", headBranch: "fixed-yesterday", conclusion: "success", createdAt: clock(2) },
				{ name: "tests", headBranch: "still-red", conclusion: "success", createdAt: clock(48) },
			]);
			const bin = join(dir, "gh");
			await writeFile(
				bin,
				`#!/usr/bin/env bash\ncase "$2$4" in\n  listsuccess) printf '%s' '${greens}' ;;\n  listfailure) printf '%s' '${failures}' ;;\n  view) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}' ;;\nesac\n`,
				"utf8",
			);
			await chmod(bin, 0o755);
			const result = await ghCiRuns(dir, bin);
			assert.deepEqual(
				result.runs.map((run) => run.headBranch),
				["still-red"],
				"the branch fixed yesterday is history; the branch whose newest run is red is not",
			);
			assert.match(result.warning ?? "", /1 of 2 failing runs were followed by a newer run/);
			assert.match(result.warning ?? "", /CI failures not counted/);
			assert.doesNotMatch(result.warning ?? "", /not read/, "the list was read; only the green was added");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a green list that cannot be read is a note, and every failure is kept", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-nogreen-gh-"));
		try {
			const shapes: [string, RegExp][] = [
				["exit 1", /superseded CI failures not dropped: gh exited 1/],
				["printf '%s' 'not json'", /superseded CI failures not dropped: gh printed something that is not JSON/],
				["printf '%s' '{\"not\":\"a list\"}'", /superseded CI failures not dropped: gh printed something that is not a list/],
			];
			for (const [green, expected] of shapes) {
				const bin = join(dir, "gh");
				await writeFile(
					bin,
					`#!/usr/bin/env bash\ncase "$2$4" in\n  listsuccess) ${green} ;;\n  listfailure) printf '%s' '${FAILED_RUNS}' ;;\n  view) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}' ;;\nesac\n`,
					"utf8",
				);
				await chmod(bin, 0o755);
				const result = await ghCiRuns(dir, bin);
				assert.equal(result.runs.length, 3, `doubt counts normally: ${green}`);
				assert.match(result.warning ?? "", expected, green);
				assert.deepEqual((await ghCiSettled(dir, bin)).runs, [], `nothing was settled: ${green}`);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the green list is asked for exactly one shape of run, and an absent gh is not a crash", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-greenargs-gh-"));
		try {
			const bin = join(dir, "gh");
			const log = join(dir, "args.txt");
			await writeFile(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nprintf '%s' '[]'\n`, "utf8");
			await chmod(bin, 0o755);
			assert.deepEqual(await ghCiSettled(dir, bin), { runs: [], warning: null }, "an empty list settles nothing and is not a warning");
			const asked = (await readFile(log, "utf8")).trim();
			assert.equal(
				asked,
				"run list --status success --limit 100 --json name,headBranch,conclusion,createdAt",
				"the query is the green half of the failure query, so both lists name the same checks",
			);
			const killed = join(dir, "gh-killed");
			await writeFile(killed, `#!/usr/bin/env bash\nkill -KILL $$\n`, "utf8");
			await chmod(killed, 0o755);
			const missing = await ghCiSettled(dir, killed);
			assert.deepEqual(missing.runs, [], "a gh killed before it answered settles nothing");
			assert.match(missing.warning ?? "", /superseded CI failures not dropped: gh exited with no status/);
			const absent = await ghCiSettled(dir, join(dir, "no-such-gh-binary"));
			assert.deepEqual(absent.runs, [], "a binary that does not exist settles nothing either");
			assert.match(absent.warning ?? "", /superseded CI failures not dropped: Error: spawn/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a refused run and an old run are two different notes, in one warning", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-both-gh-"));
		try {
			const long = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
			const fresh = new Date().toISOString();
			// Four runs: 1 never started, 1 is a month old, 2 are live evidence.
			const runs = JSON.stringify([
				{ name: "tests", headBranch: "refused", conclusion: "failure", databaseId: 1, createdAt: fresh },
				{ name: "tests", headBranch: "old", conclusion: "failure", databaseId: 2, createdAt: long },
				{ name: "tests", headBranch: "one", conclusion: "failure", databaseId: 3, createdAt: fresh },
				{ name: "tests", headBranch: "two", conclusion: "failure", databaseId: 4, createdAt: fresh },
			]);
			const bin = join(dir, "gh");
			await writeFile(
				bin,
				`#!/usr/bin/env bash\ncase "$2" in\n  list) printf '%s' '${runs}' ;;\n  view) case "$3" in 1) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[]}]}' ;; *) printf '%s' '{"jobs":[{"conclusion":"failure","steps":[{"name":"Set up job"}]}]}' ;; esac ;;\nesac\n`,
				"utf8",
			);
			await chmod(bin, 0o755);
			const result = await ghCiRuns(dir, bin);
			assert.equal(result.runs.length, 2);
			assert.match(result.warning ?? "", /1 of 4 failing runs ran no step/);
			assert.match(result.warning ?? "", /1 of 4 failing runs are older than 7 days/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("noStepRan reads steps, not conclusions", () => {
		assert.equal(noStepRan([]), false, "no jobs is not proof of anything");
		assert.equal(noStepRan([{ conclusion: "failure", steps: [] }]), true);
		assert.equal(noStepRan([{ conclusion: "failure", steps: [] }, { conclusion: "skipped", steps: [] }]), true);
		assert.equal(noStepRan([{ conclusion: "failure", steps: [{ name: "Set up job" }] }]), false);
	});
});

describe("what workers recorded", () => {
	const report = (name: string, text: string) => ({ path: `/w/reports/${name}`, text });
	const line = "- `scripts/pr-gate.sh mission` failed: no `Mission:` line in the body";

	test("the same failure in two reports fires; one report repeating itself does not", () => {
		assert.equal(workerFailuresFrom([report("a.md", line), report("b.md", line)]).length, 1);
		assert.equal(workerFailuresFrom([report("a.md", `${line}\n${line}`)]).length, 0);
		assert.equal(workerFailuresFrom([report("a.md", line), report("b.md", "- a different gate failed: exit 2")]).length, 0);
		const fired = workerFailuresFrom([report("a.md", line), report("b.md", line)]);
		assert.equal(fired[0].count, 2);
		assert.equal(fired[0].where.length, 2, "distinct files, not repeated lines");
		const decision = decideLearner(evidence({ workerFailures: fired }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /2× workers recorded/);
	});

	test("the same override in two decision rows fires, once does not", () => {
		const raw = [
			JSON.stringify({ slug: "w1", decision: "override", reason: "pr-gate mission is wrong here" }),
			JSON.stringify({ slug: "w2", decision: "override", reason: "pr-gate mission is wrong here" }),
			JSON.stringify({ slug: "w3", decision: "publish" }),
		].join("\n");
		const rows = decisionRows(raw);
		assert.equal(rows.length, 2, "only the override rows are evidence");
		assert.equal(workerFailuresFrom([], rows).length, 1);
		assert.equal(workerFailuresFrom([], rows.slice(0, 1)).length, 0, "one override is one worker's call");
	});

	test("a decision row that records a success is not evidence", () => {
		// Every row of the workspace's file carries `"overridden": false`, so a scan
		// of the whole envelope kept all 1118 rows: the 85 `"decision":"done"` rows
		// became the loudest "worker failure" in the evidence file.
		const raw = [
			JSON.stringify({ timestamp: "2026-11-18T09:00:00.000Z", command: "wipe", decision: "done", reason: null, overridden: false }),
			JSON.stringify({ timestamp: "2026-11-18T09:01:00.000Z", command: "mode", decision: "sandboxed", reason: "needs no host access", overridden: false }),
			JSON.stringify({ timestamp: "2026-11-18T09:02:00.000Z", command: "mode", decision: "remote", reason: "the sandbox refuses systemctl --user", overridden: false }),
		].join("\n");
		const rows = decisionRows(raw);
		assert.deepEqual(rows.map((row) => row.path), ["state/decisions.jsonl:3"], "only the refusal is evidence");
		assert.equal(workerFailuresFrom([], rows).length, 0, "one refusal is one worker's call, not a pattern");
	});

	test("a decision row quotes only its own words, and every word field is read", () => {
		// The row's words are the words: the bare string is the row, each of the five
		// fields is enough on its own, a non-string and a blank are not words, the
		// fields are joined by a space, and the envelope's own `"overridden": false`
		// is never what matched. The last row is the one that used to be 85 workers
		// recording a failure.
		const raw = [
			JSON.stringify("I override the gate"),
			JSON.stringify({ reason: "override" }),
			JSON.stringify({ text: "override" }),
			JSON.stringify({ detail: "override" }),
			JSON.stringify({ decision: "override" }),
			JSON.stringify({ note: "override" }),
			JSON.stringify({ reason: "override", note: "the gate is wrong" }),
			JSON.stringify({ reason: "override", text: 42, note: "   " }),
			JSON.stringify({ slug: "w1", overridden: false, decision: "done" }),
		].join("\n");
		assert.deepEqual(
			decisionRows(raw).map((row) => row.text),
			[
				"I override the gate",
				"override",
				"override",
				"override",
				"override",
				"override",
				"override the gate is wrong",
				"override",
			],
			"the row's words, joined by one space, and nothing else",
		);
	});

	test("a row is stamped by ts, timestamp or at, whichever it has", () => {
		const ts = "2026-11-18T09:00:00.000Z";
		const timestamp = "2026-11-17T09:00:00.000Z";
		const at = "2026-11-16T09:00:00.000Z";
		const raw = [
			JSON.stringify({ ts, reason: "override" }),
			JSON.stringify({ timestamp, reason: "override" }),
			JSON.stringify({ at, reason: "override" }),
			JSON.stringify({ ts, timestamp, reason: "override" }),
			JSON.stringify({ timestamp, at, reason: "override" }),
			JSON.stringify({ reason: "override" }),
		].join("\n");
		assert.deepEqual(
			decisionRows(raw).map((row) => row.at),
			[Date.parse(ts), Date.parse(timestamp), Date.parse(at), Date.parse(ts), Date.parse(timestamp), undefined],
			"the first stamp it has, and no stamp at all when it has none",
		);
	});

	test("a decision row is stamped by `timestamp`, so a week-old one ages out", () => {
		const at = "2026-11-13T16:49:58.589Z";
		const raw = JSON.stringify({ timestamp: at, decision: "mode", reason: "the sandbox refused this", overridden: false });
		const rows = decisionRows(raw);
		assert.equal(rows[0].at, Date.parse(at), "the workspace spells it `timestamp`, not `ts`");
		const judged = judgeOnce({ reports: [], decisions: rows }, Date.parse("2026-11-18T00:00:00.000Z"));
		assert.equal(judged.decisions.length, 0, "a refusal from a week ago is history, not evidence");
		assert.equal(judged.stale, 1);
	});

	test("a line that records a pass is not a failure", () => {
		// The first version of this fired on "30 passed, 0 failed in 10 cases" and on
		// test names that happen to contain "failed". Measured, then fixed.
		const text = [
			"ok 11 - a failed spawn does not throw and does not count as a learner",
			"30 passed, 0 failed in 10 cases",
			"1 passed, 0 warn, 0 failed",
			"$ bash scripts/harness-check.sh | grep -E '^(FAIL|WARN)'",
			"not ok 4 - the gate fires",
			"pr-gate: red (test-change)",
		].join("\n");
		const lines = failureLines(text);
		assert.deepEqual(lines, ["not ok 4 - the gate fires", "pr-gate: red (test-change)"]);
		assert.equal(workerFailuresFrom([{ path: "/w/reports/a.md", text }, { path: "/w/reports/b.md", text }]).length, 2);
	});

	test("a machine without the delegation workspace is tolerated", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-nospace-"));
		try {
			const space = await readWorkspace(dir);
			assert.equal(space.present, false);
			assert.deepEqual(space.reports, []);
			assert.deepEqual(space.decisions, []);
			assert.deepEqual(space.warnings, [], "absence is normal, not a warning");
			assert.equal(judgeOnce(space, NOW).stale, 0, "an empty workspace judges nothing");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("evidence a proposal already judged", () => {
	const npmFail = "FAIL npm-min-release-age - npm 10.9.9 ignores min-release-age (needs npm ≥ 11)";
	const dated = (name: string, at: number) => ({ path: `/w/reports/${name}`, text: npmFail, at });

	test("a report written before the newest proposal is history, not evidence", () => {
		const space = {
			reports: [dated("a.md", NOW - minutes(600)), dated("b.md", NOW - minutes(600)), dated("c.md", NOW - minutes(5))],
			decisions: [{ path: "state/decisions.jsonl:1", text: "override: shipped without review", at: NOW - minutes(600) }],
		};
		const judged = judgeOnce(space, NOW - minutes(60));
		assert.deepEqual(judged.reports.map((row) => row.path), ["/w/reports/c.md"]);
		assert.equal(judged.decisions.length, 0);
		assert.equal(judged.stale, 3);
	});

	test("the same stale pair stops re-firing the gate", () => {
		const reports = [dated("a.md", NOW - minutes(600)), dated("b.md", NOW - minutes(600))];
		assert.equal(workerFailuresFrom(reports).length, 1, "the files really do repeat the same line");
		const judged = judgeOnce({ reports, decisions: [] }, NOW - minutes(60));
		assert.equal(workerFailuresFrom(judged.reports, judged.decisions).length, 0, "and one proposal already judged them");
		assert.equal(decideLearner(evidence({ workerFailures: workerFailuresFrom(judged.reports) })).spawn, false);
	});

	test("a row with no timestamp is evidence, not an old row", () => {
		const judged = judgeOnce({ reports: [{ path: "/w/reports/a.md", text: npmFail }], decisions: [] }, NOW);
		assert.equal(judged.reports.length, 1);
		assert.equal(judged.stale, 0);
	});

	test("no proposal yet judges nothing", () => {
		const judged = judgeOnce(
			{ reports: [dated("a.md", 0)], decisions: [{ path: "state/decisions.jsonl:1", text: "refusal: went ahead anyway", at: 0 }] },
			null,
		);
		assert.equal(judged.stale, 0);
		assert.equal(judged.reports.length, 1);
		assert.equal(judged.decisions.length, 1);
	});

	test("readWorkspace dates a report from its mtime and a decision row from its ts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "self-learn-dated-"));
		try {
			await mkdir(join(dir, "reports"), { recursive: true });
			await mkdir(join(dir, "state"), { recursive: true });
			await writeFile(join(dir, "reports", "a.md"), npmFail, "utf8");
			await writeFile(
				join(dir, "state", "decisions.jsonl"),
				`${JSON.stringify({ ts: new Date(NOW).toISOString(), decision: "override", reason: "shipped red" })}\n`,
				"utf8",
			);
			const space = await readWorkspace(dir);
			assert.equal(typeof space.reports[0]?.at, "number", "a report carries when it was written");
			assert.equal(space.decisions[0]?.at, NOW, "a decision row carries its own ts");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("learners that died", () => {
	const row = (over: Record<string, unknown>) => ({ ts: new Date(NOW - minutes(30)).toISOString(), ...over });

	test("one death is a loss, two is a pattern", () => {
		const one = diedLearnersFrom([row({ kind: "died", slug: "learn-1936", queue: "/q/a.md" })], {
			exists: () => false,
			now: NOW,
		});
		assert.equal(one.length, 1);
		assert.equal(decideLearner(evidence({ diedLearners: one })).spawn, false, "the threshold is two, like every other signal");
		const two = diedLearnersFrom(
			[
				row({ kind: "died", slug: "learn-1936", queue: "/q/a.md" }),
				row({ kind: "died", slug: "learn-2015", queue: "/q/b.md" }),
			],
			{ exists: () => false, now: NOW },
		);
		const decision = decideLearner(evidence({ diedLearners: two }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /2 learners died without a proposal \(learn-1936, learn-2015\)/);
	});

	test("a learner inside the grace window, or one that wrote its proposal, is not dead", () => {
		const young = diedLearnersFrom(
			[row({ kind: "spawned", slug: "s1", proposal: "/p/none.md", ts: new Date(NOW - minutes(2)).toISOString() })],
			{ exists: () => false, now: NOW },
		);
		assert.equal(young.length, 0, "a learner two minutes old has not had time to die");
		const wrote = diedLearnersFrom([row({ kind: "spawned", slug: "s2", proposal: "/p/there.md" })], {
			exists: (path: string) => path === "/p/there.md",
			now: NOW,
		});
		assert.equal(wrote.length, 0);
		const noPath = diedLearnersFrom([row({ kind: "spawned", slug: "s3" })], { exists: () => false, now: NOW });
		assert.equal(noPath.length, 0, "an old row with no proposal path proves nothing either way");
	});

	test("a proposal written under the run's other name is not a death", () => {
		// 2026-11-15T10:07Z: the queue file was `…T10-07-10-876Z.md`, the row
		// expected `…-10-07-10-876Z.md`, and the learner copied the name it could
		// see. A real submission read as a death and started another learner.
		const at = Date.parse("2026-11-15T10:07:10.876Z");
		const dash = join("/p", `${runStamp(at)}.md`);
		assert.equal(dash, "/p/2026-11-15-10-07-10-876Z.md", "one run, one name");
		assert.equal(dash.includes("T"), false, "the queue and the proposal must not differ by a T");
		const paths = runPaths(at, "/p");
		assert.deepEqual(
			paths,
			{ queue: "/p/queue/2026-11-15-10-07-10-876Z.md", proposal: "/p/2026-11-15-10-07-10-876Z.md" },
			"the queue file and the proposal share one stamp, and only the queue is a level down",
		);
		const iso = join("/p", "2026-11-15T10-07-10-876Z.md");
		assert.deepEqual(proposalAliases(dash), [iso]);
		assert.deepEqual(proposalAliases(iso), [dash]);
		assert.deepEqual(proposalAliases("/p/notes.md"), [], "anything else has no twin");
		// The three regex anchors each carry a case: end ($), start (^), and an
		// optional directory. Without them a suffix, a prefix, or a bare name is
		// either read as a run or silently loses its twin.
		assert.deepEqual(proposalAliases("/p/2026-11-15-10-07-10-876Z.mdx"), [], "the suffix is anchored at the end");
		assert.deepEqual(proposalAliases("junk2026-11-15-10-07-10-876Z.md"), [], "the stamp starts the name");
		assert.deepEqual(
			proposalAliases("2026-11-15-10-07-10-876Z.md"),
			["2026-11-15T10-07-10-876Z.md"],
			"a bare name has no directory to require",
		);
		const died = diedLearnersFrom([row({ kind: "spawned", slug: "learn-10-07", proposal: dash })], {
			exists: (path: string) => path === iso,
			now: NOW,
		});
		assert.deepEqual(died, [], "the learner wrote it, under the name it was shown");
	});

	test("a launch that never made a space is evidence, not a silence", () => {
		// 2026-11-18: learn-10-59 and learn-11-03 were recorded `spawn-failed` on
		// `herdr-app is not on PATH`, thirty-two minutes apart. The next evidence file
		// said "None." under this section, because only `died` and `spawned` were read.
		const never = (over: Record<string, unknown>) =>
			row({ kind: "spawn-failed", launcher: "pane", stderr: "herdr-app is not on PATH, so no visible space can be made", ...over });
		const died = diedLearnersFrom([never({ slug: "learn-10-59" }), never({ slug: "learn-11-03" })], {
			exists: () => false,
			now: NOW,
		});
		assert.deepEqual(died.map((learner) => learner.slug), ["learn-10-59", "learn-11-03"]);
		assert.match(died[0].detail ?? "", /herdr-app is not on PATH/, "the launcher's own words are the finding");
		assert.equal(died[0].queue, "", "a launch that never started wrote no queue to cite");
		const decision = decideLearner(evidence({ diedLearners: died }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /learn-10-59/, "the next learner is told which launch failed");
	});

	test("a sandboxed skip is not a death the next learner is told about", () => {
		const skipped = row({
			kind: "spawn-skipped",
			slug: "learn-15-29",
			stderr: "this session is sandboxed (bwrap) and a sandbox never mounts herdr-app",
		});
		assert.deepEqual(
			diedLearnersFrom([skipped], { exists: () => false, now: NOW }),
			[],
			"no learner ever started, so nothing died",
		);
	});

	test("a failed launch ages out on its own window, and a judged one stays judged", () => {
		const failed = (over: Record<string, unknown>) => row({ kind: "spawn-failed", launcher: "pane", slug: "learn-10-59", ...over });
		const stale = failed({ ts: new Date(NOW - SPAWN_FAILED_WINDOW_MS - minutes(1)).toISOString() });
		assert.equal(diedLearnersFrom([stale], { exists: () => false, now: NOW }).length, 0, "last week's launch failure is history");
		const edge = failed({ ts: new Date(NOW - SPAWN_FAILED_WINDOW_MS).toISOString() });
		assert.equal(diedLearnersFrom([edge], { exists: () => false, now: NOW }).length, 1, "a launch exactly a day old is still today's");
		const fresh = failed({ ts: new Date(NOW - minutes(90)).toISOString() });
		assert.equal(
			diedLearnersFrom([fresh], { exists: () => false, now: NOW, since: NOW - minutes(10) }).length,
			1,
			"no learner ever read it, so the judged-before cutoff must not swallow it",
		);
		const judged = row({ kind: "spawned", slug: "learn-1200", proposal: "/p/x.md", judged: ["learn-10-59"] });
		assert.equal(
			diedLearnersFrom([fresh, judged], { exists: (path: string) => path === "/p/x.md", now: NOW }).length,
			0,
			"the spawn that named it silenced it",
		);
	});

	test("a runs.jsonl fixture with a proposal-less launch reads as a death", () => {
		const raw = [
			JSON.stringify({ ts: new Date(NOW - minutes(60)).toISOString(), kind: "spawned", slug: "learn-1936", launcher: "pane", queue: "/q/a.md", proposal: "/p/gone.md" }),
			JSON.stringify({ ts: new Date(NOW - minutes(50)).toISOString(), kind: "spawned", slug: "learn-2015", launcher: "headless", queue: "/q/b.md", proposal: "/p/here.md" }),
			"{ torn line",
		].join("\n");
		const died = diedLearnersFrom(parseRuns(raw), { exists: (path: string) => path === "/p/here.md", now: NOW });
		assert.deepEqual(died.map((learner) => learner.slug), ["learn-1936"]);
		assert.equal(died[0].launcher, "pane");
		assert.equal(died[0].elapsedMs, null);
	});

	test("a proposal written under the queue file's spelling is a proposal, not a death", () => {
		const told = "/p/2026-11-15-10-07-10-876Z.md";
		const wrote = "/p/2026-11-15T10-07-10-876Z.md";
		assert.deepEqual(proposalSpellings(told), [told, wrote]);
		assert.deepEqual(proposalSpellings(wrote), [wrote, told], "and the other way round");
		const exists = (path: string) => path === wrote;
		assert.equal(proposalWritten(told, exists), true);
		assert.equal(proposalWritten("/p/a.md", () => false), false, "a path with no timestamp has one spelling, and it is absent");
		const died = diedLearnersFrom([row({ kind: "spawned", slug: "learn-10-07", proposal: told })], {
			exists: (path: string) => proposalWritten(path, exists),
			now: NOW,
		});
		assert.equal(died.length, 0, "learn-10-07 wrote its proposal one character off and was called dead for it");
	});

	test("a death a later proposal already judged is history, not evidence", () => {
		const death = row({ kind: "died", slug: "learn-2015" });
		const judged = diedLearnersFrom([death], { exists: () => false, now: NOW, since: NOW - minutes(1) });
		assert.equal(judged.length, 0, "two 2026-11-14 deaths cited eight learner sessions running");
		const fresh = diedLearnersFrom([death], { exists: () => false, now: NOW, since: NOW - minutes(90) });
		assert.equal(fresh.length, 1, "a death recorded after the last proposal still counts");
		const noBaseline = diedLearnersFrom([death], { exists: () => false, now: NOW, since: null });
		assert.equal(noBaseline.length, 1, "no proposal on disk means nothing has been judged yet");
	});

	test("the watch writes the row with the slug, the launcher, the queue and the elapsed time", async () => {
		const rows: any[] = [];
		const outcome = await watchOutcome({
			slug: "learn-1936",
			launcher: "pane",
			queue: "/q/1936.md",
			proposal: "/p/1936.md",
			at: NOW,
			exited: Promise.resolve(1),
			exists: () => false,
			onDied: (row: Record<string, unknown>) => {
				rows.push(row);
			},
			pollMs: 5,
			timeoutMs: 200,
		});
		assert.equal(outcome, "died");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].kind, "died");
		assert.equal(rows[0].slug, "learn-1936");
		assert.equal(rows[0].launcher, "pane");
		assert.equal(rows[0].queue, "/q/1936.md");
		assert.equal(rows[0].proposal, "/p/1936.md");
		assert.ok(rows[0].elapsedMs >= 0);
	});

	test("a death its learner already named is judged once, not every 30 minutes", () => {
		const death = row({ kind: "spawned", slug: "learn-2015", launcher: "pane", queue: "/q/b.md", proposal: "/p/gone.md" });
		const fresh = diedLearnersFrom([death], { exists: () => false, now: NOW });
		assert.deepEqual(fresh.map((learner) => learner.slug), ["learn-2015"], "before the learner ran it is evidence");

		const judgedRow = row({ kind: "spawned", slug: "learn-2051", proposal: "/p/2051.md", judged: ["learn-2015"] });
		const after = diedLearnersFrom([death, judgedRow], { exists: () => false, now: NOW });
		assert.deepEqual(after.map((learner) => learner.slug), ["learn-2051"], "the judged death stops counting; the learner that named it is its own case");
		assert.equal(decideLearner(evidence({ diedLearners: after })).spawn, false, "one death alone does not trip the gate a second time");

		const fresh2 = row({ kind: "spawned", slug: "learn-2130", proposal: "/p/2130.md" });
		const again = diedLearnersFrom([death, judgedRow, fresh2], { exists: () => false, now: NOW });
		assert.deepEqual(again.map((learner) => learner.slug), ["learn-2051", "learn-2130"], "a new dead learner still trips it");
	});

	test("the decision carries the slugs it judged, so the spawn row can mark them", () => {
		const two = diedLearnersFrom(
			[
				row({ kind: "died", slug: "learn-1936" }),
				row({ kind: "died", slug: "learn-2015" }),
			],
			{ exists: () => false, now: NOW },
		);
		assert.deepEqual(decideLearner(evidence({ diedLearners: two })).judged, ["learn-1936", "learn-2015"]);
		const silent = decideLearner(evidence({ notes: 1 }));
		assert.equal(silent.spawn, true);
		assert.equal(silent.judged, undefined, "a /suggest note judged nothing");
	});

	test("a written proposal, or a watch window that closes, is not a death", async () => {
		const rows: any[] = [];
		const wrote = await watchOutcome({
			slug: "s", launcher: "headless", queue: "/q", proposal: "/p", at: NOW,
			exited: Promise.resolve(0), exists: () => true,
			onDied: (row: Record<string, unknown>) => void rows.push(row), pollMs: 5,
		});
		assert.equal(wrote, "proposal");
		const running = await watchOutcome({
			slug: "s", launcher: "headless", queue: "/q", proposal: "/p", at: NOW,
			exited: null, exists: () => false,
			onDied: (row: Record<string, unknown>) => void rows.push(row), pollMs: 5, timeoutMs: 50,
		});
		assert.equal(running, "unknown", "the window closing is not a verdict");
		assert.equal(rows.length, 0);
	});
});

describe("what the person said", () => {
	test("only user lines are quotes, and the phrase that matched is named", () => {
		const quotes = frustrationQuotes(
			transcriptOf([
				{ role: "user", text: "the pr-gate check failed again" },
				{ role: "tool", text: "again again again" },
				{ role: "user", text: "still red after the edit" },
			]),
		);
		assert.deepEqual(quotes.map((quote) => quote.phrase), ["again", "still"]);
	});

	test("two lines fire the gate, one does not", () => {
		const one = frustrationQuotes(transcriptOf([{ role: "user", text: "you keep doing this" }]));
		assert.equal(decideLearner(evidence({ frustration: one })).spawn, false, "one sentence is not a pattern");
		const two = frustrationQuotes(
			transcriptOf([
				{ role: "user", text: "you keep doing this" },
				{ role: "user", text: "you keep ignoring the report" },
			]),
		);
		const decision = decideLearner(evidence({ frustration: two }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /2× "you keep" in the session transcript/);
	});

	test("a pasted transcript is not the person's own words", () => {
		// Measured: 141 of 200 transcripts had "again" inside a pasted blob, which
		// would have fired the gate on most sessions.
		const quotes = frustrationQuotes(
			transcriptOf([
				{ role: "user", text: '{"transcript":"[Source entry id: e024] again, still, why did you"}' },
				{ role: "user", text: "[Assistant @ 2026-11-15]: the check failed again" },
				{ role: "user", text: `x ${"still ".repeat(60)}failing` },
				{ role: "user", text: "this is the same failure as the last time" },
			]),
		);
		assert.deepEqual(
			quotes.map((quote) => quote.phrase),
			["same failure"],
			"only the line the person typed becomes a quote",
		);
	});

	test("quotes are capped at five and carry no secrets", () => {
		const lines = Array.from({ length: 8 }, (_, index) => ({ role: "user", text: `again: leak ${index} password=hunter2` }));
		const quotes = frustrationQuotes(transcriptOf(lines));
		assert.equal(quotes.length, MAX_FRUSTRATION);
		assert.ok(quotes.every((quote) => !quote.quote.includes("hunter2")), "quotes are redacted like every other line that leaves the file");
	});
});

describe("the gate stays conservative", () => {
	test("nothing repeats, nothing spawns", () => {
		const decision = decideLearner(evidence());
		assert.equal(decision.spawn, false);
		assert.match(decision.reason, /nothing to learn/);
	});

	test("the reason names every signal that fired and how often it fired", () => {
		const decision = decideLearner(
			evidence({
				errors: failures({ abcdefabcdef: 2 }),
				ciFailures: [{ check: "pr-gate", branches: ["one", "two"], reports: [], sample: "red" }],
				workerFailures: [{ signature: "x", count: 2, where: ["/w/reports/a.md", "/w/reports/b.md"], sample: "pr-gate.sh mission failed" }],
				diedLearners: [
					{ slug: "learn-1", queue: "/q", launcher: "pane", at: NOW, elapsedMs: 10 },
					{ slug: "learn-2", queue: "/q", launcher: "pane", at: NOW, elapsedMs: 20 },
				],
				notes: 1,
			}),
		);
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /2 learners died without a proposal \(learn-1, learn-2\)/);
		assert.match(decision.reason, /2× CI check "pr-gate" failed/);
		assert.match(decision.reason, /2× workers recorded "pr-gate.sh mission failed"/);
		assert.match(decision.reason, /2× abcdefabcdef/);
		assert.match(decision.reason, /1 \/suggest note/);
	});

	test("nine repeated worker failures keep the reason to four names and a count", () => {
		const many = Array.from({ length: 9 }, (_, index) => ({
			signature: `s${index}`,
			count: 2 + index,
			where: ["/w/reports/a.md", "/w/reports/b.md"],
			sample: `gate ${index} failed`,
		}));
		const decision = decideLearner(evidence({ workerFailures: many }));
		assert.equal(decision.spawn, true);
		assert.match(decision.reason, /^2× workers recorded "gate 0 failed"/, "the strongest signal is named first");
		assert.match(decision.reason, /\+5 more signals/);
		assert.ok(decision.reason.length < 400, "a reason is a line, not a report");
	});
});

// The publish broker: the learner writes one JSON file, the host session is the
// only caller of learn-publish.sh. These cases never spawn a publishing agent and
// never touch GitHub — the runner is a recorder.
const PROPOSALS = join(scratch, "proposals");

async function publishFixture(request: Record<string, unknown> = {}) {
	const dir = await mkdtemp(join(scratch, "publish-"));
	await mkdir(PROPOSALS, { recursive: true });
	const proposal = join(PROPOSALS, `broker-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
	await writeFile(proposal, "# a fix\n\n**Risk tier:** Medium\n", "utf8");
	const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
	const rows: Record<string, unknown>[] = [];
	let status: number | null = 0;
	let stderr = "";
	const deps = {
		dir,
		run: async (argv: string[], env: NodeJS.ProcessEnv) => {
			calls.push({ argv, env });
			return { status, stdout: "learn-publish: PR #42 exists for learn/x — published", stderr };
		},
		record: (row: Record<string, unknown>) => {
			rows.push(row);
		},
	};
	const write = (name: string, body: Record<string, unknown> | string) =>
		writeFile(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
	const answers = (code: number | null, text = "") => {
		status = code;
		stderr = text;
	};
	return { dir, proposal, calls, rows, deps, write, answers };
}

const request = (over: Record<string, unknown> = {}) => ({
	slug: "learn-1200",
	branch: "learn/learn-1200",
	reason: "the publish hand-off died at the sandbox wall",
	...over,
});

describe("the publish request a learner writes", () => {
	test("one object with a slug, its own branch and a reason is accepted", () => {
		const parsed = parsePublishRequest(JSON.stringify(request({ proposal: join(PROPOSALS, "p.md") })));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.request.slug, "learn-1200");
		assert.equal(parsed.request.branch, "learn/learn-1200");
		assert.equal(parsed.request.reason, "the publish hand-off died at the sandbox wall");
	});

	test("a learner cannot ask for trunk, or for a branch that is not its own", () => {
		for (const branch of ["trunk", "learn/someone-else", "main"]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ branch })));
			assert.equal(parsed.ok, false, branch);
			if (parsed.ok) continue;
			assert.match(parsed.why, /branch must be learn\/learn-1200/);
		}
	});

	test("a slug that is not a slug, no reason, no JSON and a proposal outside the queue are refused", () => {
		assert.equal(parsePublishRequest(JSON.stringify(request({ slug: "../etc" }))).ok, false);
		assert.equal(parsePublishRequest(JSON.stringify(request({ reason: "  " }))).ok, false);
		assert.equal(parsePublishRequest("not json").ok, false);
		assert.equal(parsePublishRequest("[1,2]").ok, false);
		const outside = parsePublishRequest(JSON.stringify(request({ proposal: "/etc/passwd" })));
		assert.equal(outside.ok, false);
		if (!outside.ok) assert.match(outside.why, /not a file under/);
	});
	test("every refusal says which thing was wrong, in the words the row will carry", () => {
		// One case per branch of the parser. A refusal that cannot name what it refused
		// is a mystery in runs.jsonl at 2 a.m., and the row is the only record.
		const cases: [string, string][] = [
			["not json", "not JSON"],
			["{", "not JSON"],
			['"just a string"', "not one JSON object"],
			["42", "not one JSON object"],
			["null", "not one JSON object"],
			["[]", "not one JSON object"],
			["[1,2]", "not one JSON object"],
		];
		for (const [raw, why] of cases) {
			const parsed = parsePublishRequest(raw);
			assert.equal(parsed.ok, false, raw);
			if (parsed.ok) continue;
			assert.equal(parsed.why, why, raw);
		}
	});

	test("a slug is a slug at both ends, and the refusal quotes what was written", () => {
		for (const slug of ["../etc", "Learn 1200", "!", "-lead", "abc!", "a".repeat(33)]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ slug })));
			assert.equal(parsed.ok, false, slug);
			if (parsed.ok) continue;
			assert.match(parsed.why, /^slug is not 1-32 of a-z 0-9 - _: /, slug);
			assert.ok(parsed.why.includes(JSON.stringify(slug)), `the refused value is named: ${parsed.why}`);
		}
	});

	test("a slug that is not even a string is refused, not coerced", () => {
		for (const slug of [42, null, true]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ slug })));
			assert.equal(parsed.ok, false, String(slug));
			if (parsed.ok) continue;
			assert.match(parsed.why, /slug is not 1-32/, `the refusal is about the slug: ${parsed.why}`);
			assert.ok(
				parsed.why.includes(JSON.stringify(slug)),
				`and shows the value that was there: ${parsed.why}`,
			);
		}
	});

	test("a slug and a branch are trimmed and lowercased, so a learner's own casing is not a refusal", () => {
		const parsed = parsePublishRequest(JSON.stringify({ slug: "  Learn-1200 ", branch: " learn/learn-1200 ", reason: "x" }));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.request.slug, "learn-1200");
		assert.equal(parsed.request.branch, "learn/learn-1200");
	});

	test("a request with no branch asks for learn/<slug>, the only branch the broker takes", () => {
		for (const branch of [undefined, 42]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ branch })));
			assert.equal(parsed.ok, true, String(branch));
			if (!parsed.ok) continue;
			assert.equal(parsed.request.branch, "learn/learn-1200", String(branch));
		}
		// A branch that is there and empty is a mistake, not an omission.
		for (const branch of ["", "   "]) {
			assert.equal(parsePublishRequest(JSON.stringify(request({ branch }))).ok, false, JSON.stringify(branch));
		}
	});

	test("the reason is one line, at most 200 characters", () => {
		const parsed = parsePublishRequest(JSON.stringify(request({ reason: "  two\n\nlines\tand  spaces  " })));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.request.reason, "two lines and spaces");
		const long = parsePublishRequest(JSON.stringify(request({ reason: "x".repeat(500) })));
		assert.equal(long.ok, true, "a long reason is clipped, not refused");
		if (!long.ok) return;
		assert.equal(long.request.reason.length, 200);
	});

	test("a reason that is not a string, or only spaces, is refused in so many words", () => {
		for (const reason of [42, null, "", "   "]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ reason })));
			assert.equal(parsed.ok, false, String(reason));
			if (parsed.ok) continue;
			assert.equal(parsed.why, "reason is empty", String(reason));
		}
	});

	test("a proposal has to be a file under the proposals directory", () => {
		for (const proposal of [join(PROPOSALS, "..", "x.md"), "/etc/passwd", `${PROPOSALS}/a/../b.md`]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ proposal })));
			assert.equal(parsed.ok, false, proposal);
			if (parsed.ok) continue;
			assert.match(parsed.why, /^proposal is not a file under /, proposal);
		}
		const ok = parsePublishRequest(JSON.stringify(request({ proposal: join(PROPOSALS, "p.md") })));
		assert.equal(ok.ok, true);
		if (!ok.ok) return;
		assert.equal(ok.request.proposal, join(PROPOSALS, "p.md"));
	});

	test("a proposal named the way git names it is the same file as the absolute one", () => {
		// The sandboxed learner wrote `agent/proposals/<file>.md` on 2026-11-18 and the
		// refusal was silent, so its branch never reached a PR. Same file, two names.
		const parsed = parsePublishRequest(
			JSON.stringify(request({ proposal: "agent/proposals/2026-11-18-19-12-23-145Z.md" })),
		);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.request.proposal, join(PROPOSALS, "2026-11-18-19-12-23-145Z.md"));
		// Still one directory, still no way out of it.
		for (const proposal of ["agent/proposals/../x.md", "agent/proposals/", "agent/other/x.md"]) {
			const bad = parsePublishRequest(JSON.stringify(request({ proposal })));
			assert.equal(bad.ok, false, proposal);
			if (bad.ok) continue;
			assert.match(bad.why, /^proposal is not a file under /, proposal);
		}
	});

	test("a proposal path is trimmed before it is judged", () => {
		const parsed = parsePublishRequest(JSON.stringify(request({ proposal: `  ${join(PROPOSALS, "p.md")}  ` })));
		assert.equal(parsed.ok, true, "spaces around a path do not make it a path outside the queue");
		if (!parsed.ok) return;
		assert.equal(parsed.request.proposal, join(PROPOSALS, "p.md"));
	});

	test("a proposal that is blank, or not a string, is no proposal at all", () => {
		for (const proposal of ["  ", 42, null]) {
			const parsed = parsePublishRequest(JSON.stringify(request({ proposal })));
			assert.equal(parsed.ok, true, String(proposal));
			if (!parsed.ok) continue;
			assert.equal(parsed.request.proposal, undefined, `${String(proposal)} is not a path`);
		}
	});
});

describe("the publish broker", () => {
	test("a publish is bounded like a spawn, and the poll is cheap", () => {
		// Three literals a reader has to trust otherwise: a hand-off that never
		// returns must not hold the broker (ten minutes), the queue is looked at
		// every five seconds while it waits, and it waits a quarter of an hour.
		assert.equal(PUBLISH_TIMEOUT_MS, 10 * 60 * 1000, "ten minutes for one publish");
		assert.equal(PUBLISH_POLL_MS, 5_000, "a readdir every five seconds");
		assert.equal(PUBLISH_WINDOW_MS, 15 * 60 * 1000, "fifteen minutes of waiting, then it stops");
	});

	test("a queue file is picked up exactly once, even by two brokers at the same moment", async () => {
		const f = await publishFixture();
		await f.write("learn-1200.publish.json", request({ proposal: f.proposal }));

		const [first, second] = await Promise.all([publishOnce(f.deps), publishOnce(f.deps)]);

		assert.equal(f.calls.length, 1, "the rename is the claim: one winner, one publish");
		assert.equal([first, second].filter(Boolean).length, 1);
		assert.equal(f.rows.length, 1);
		assert.equal(f.rows[0].kind, "publish");
		assert.equal(f.rows[0].slug, "learn-1200");
		assert.equal(f.rows[0].branch, "learn/learn-1200");
		assert.equal(f.rows[0].publish, "published");
		assert.deepEqual(await publishQueue(f.dir), [], "and the claim does not linger");
	});

	test("the broker runs learn-publish.sh for that slug, as the broker", async () => {
		const f = await publishFixture();
		await f.write("learn-1200.publish.json", request({ proposal: f.proposal }));
		await publishOnce(f.deps);
		const { argv, env } = f.calls[0];
		assert.equal(argv[0], join(REPO, "scripts", "learn-publish.sh"));
		assert.deepEqual(argv.slice(1), ["learn-1200", "--proposal", f.proposal, "--repo", REPO]);
		assert.equal(env.PI_LEARN_BROKER, "1");
		assert.equal(env.PI_SANDBOX_MODE, undefined, "the host side carries no sandbox marker");
	});

	test("a failed publish is recorded, with the script's own words", async () => {
		const f = await publishFixture();
		f.answers(1, "learn-publish: FAIL — still unpublished");
		await f.write("learn-1200.publish.json", request({ proposal: f.proposal }));
		const row = await publishOnce(f.deps);
		assert.equal(row?.publish, "failed");
		assert.equal(row?.status, 1);
		assert.match(String(row?.stderr), /still unpublished/);
		assert.equal(f.rows.length, 1, "a failure is a row, not a silence");
	});

	test("a machine that cannot ask GitHub records unverified, never failed", async () => {
		const f = await publishFixture();
		f.answers(2, "learn-publish: could not ask gh for a PR — hosts.yml missing");
		await f.write("learn-1200.publish.json", request({ proposal: f.proposal }));
		const row = await publishOnce(f.deps);
		assert.equal(row?.publish, "unverified");
		assert.match(String(row?.stderr), /hosts\.yml missing/);
	});

	test("a refused request is recorded and publishes nothing", async () => {
		const f = await publishFixture();
		await f.write("learn-1200.publish.json", request({ branch: "trunk", proposal: f.proposal }));
		const row = await publishOnce(f.deps);
		assert.equal(row?.publish, "refused");
		assert.match(String(row?.stderr), /branch must be learn\/learn-1200/);
		assert.equal(f.calls.length, 0, "nothing was run for it");
		assert.equal(f.rows.length, 1);
	});

	test("a request that names no proposal still gets the newest one", async () => {
		const f = await publishFixture();
		await f.write("learn-1200.publish.json", request());
		await publishOnce(f.deps);
		const argv = f.calls[0].argv;
		const named = argv[argv.indexOf("--proposal") + 1];
		assert.ok(named?.startsWith(PROPOSALS), `an absolute proposal path: ${named}`);
	});

	test("one drain publishes every file waiting", async () => {
		const f = await publishFixture();
		await f.write(`learn-1201${PUBLISH_SUFFIX}`, request({ slug: "learn-1201", branch: "learn/learn-1201" }));
		await f.write(`learn-1202${PUBLISH_SUFFIX}`, request({ slug: "learn-1202", branch: "learn/learn-1202" }));
		const rows = await drainPublishQueue(f.deps);
		assert.equal(rows.length, 2);
		assert.deepEqual(
			rows.map((row) => row.slug),
			["learn-1201", "learn-1202"],
		);
		assert.equal(f.calls.length, 2);
	});

	test("the watch waits for the file, then publishes it", async () => {
		const f = await publishFixture();
		const pending = watchPublish({ ...f.deps, pollMs: 10, windowMs: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		await f.write("learn-1200.publish.json", request({ proposal: f.proposal }));
		const row = await pending;
		assert.equal(row?.slug, "learn-1200");
		assert.equal(row?.publish, "published");
	});

	test("the watch gives up when no request arrives", async () => {
		const f = await publishFixture();
		const row = await watchPublish({ ...f.deps, pollMs: 10, windowMs: 60 });
		assert.equal(row, null);
		assert.equal(f.calls.length, 0);
	});
	test("a refused request still names the slug and the branch it would have published", async () => {
		const f = await publishFixture();
		await f.write(`learn-1200${PUBLISH_SUFFIX}`, "{not json");
		const row = await publishOnce(f.deps);
		assert.equal(row?.kind, "publish");
		assert.equal(row?.slug, "learn-1200", "the slug is the file name without its suffix, not the whole path");
		assert.equal(row?.branch, "learn/learn-1200");
		assert.equal(row?.publish, "refused");
		assert.equal(row?.status, null);
		assert.equal(row?.queue, join(f.dir, `learn-1200${PUBLISH_SUFFIX}`));
		assert.equal(f.calls.length, 0, "nothing is run for a request that was refused");
		assert.equal(existsSync(join(f.dir, `learn-1200${PUBLISH_SUFFIX}.claimed`)), false);
	});

	test("the host side of the hand-off carries no sandbox marker of its own", async () => {
		const f = await publishFixture();
		const before = { mode: process.env.PI_SANDBOX_MODE, net: process.env.PI_SANDBOX_NET };
		process.env.PI_SANDBOX_MODE = "bwrap";
		process.env.PI_SANDBOX_NET = "on";
		try {
			await f.write(`learn-1200${PUBLISH_SUFFIX}`, request({ proposal: f.proposal }));
			const row = await publishOnce({ ...f.deps, record: () => {
				throw new Error("runs.jsonl is not writable");
			} });
			assert.equal(f.calls[0].env.PI_SANDBOX_MODE, undefined, "the script would refuse a sandboxed caller");
			assert.equal(f.calls[0].env.PI_SANDBOX_NET, undefined);
			assert.equal(f.calls[0].env.PI_LEARN_BROKER, "1", "and says which side is calling it");
			assert.equal(row?.publish, "published", "a log that cannot be written does not undo the publish");
			assert.deepEqual(await publishQueue(f.dir), [], "nor does it keep the claim");
		} finally {
			if (before.mode === undefined) delete process.env.PI_SANDBOX_MODE;
			else process.env.PI_SANDBOX_MODE = before.mode;
			if (before.net === undefined) delete process.env.PI_SANDBOX_NET;
			else process.env.PI_SANDBOX_NET = before.net;
		}
	});

	test("a request that names no proposal gets the newest proposal, and only a .md is one", async () => {
		await mkdir(PROPOSALS, { recursive: true });
		const older = join(PROPOSALS, "pick-older.md");
		const newer = join(PROPOSALS, "pick-newer.md");
		const notAProposal = join(PROPOSALS, "pick-newest.md.bak");
		const aDirectory = join(PROPOSALS, "pick-dir.md");
		const at = new Date("2100-01-01T00:00:00Z").getTime();
		const hour = 60 * 60 * 1000;
		try {
			await writeFile(older, "# older\n", "utf8");
			await writeFile(newer, "# newer\n", "utf8");
			await writeFile(notAProposal, "x", "utf8");
			await mkdir(aDirectory, { recursive: true });
			await utimes(older, new Date(at), new Date(at));
			await utimes(newer, new Date(at + hour), new Date(at + hour));
			await utimes(notAProposal, new Date(at + 2 * hour), new Date(at + 2 * hour));
			await utimes(aDirectory, new Date(at + 3 * hour), new Date(at + 3 * hour));
			const f = await publishFixture();
			await f.write(`learn-1200${PUBLISH_SUFFIX}`, request());
			const row = await publishOnce(f.deps);
			assert.equal(row?.proposal, newer, "the newest .md, not the newest file and not a directory");
			const argv = f.calls[0].argv;
			assert.equal(argv[argv.indexOf("--proposal") + 1], newer);
		} finally {
			await rm(older, { force: true });
			await rm(newer, { force: true });
			await rm(notAProposal, { force: true });
			await rm(aDirectory, { recursive: true, force: true });
		}
	});

	test("two proposals of the same age: the one the directory offers first is the newest", async () => {
		await mkdir(PROPOSALS, { recursive: true });
		for (const entry of await readdir(PROPOSALS)) await rm(join(PROPOSALS, entry), { recursive: true, force: true });
		const at = new Date("2100-02-02T00:00:00Z");
		const names = ["tie-first.md", "tie-second.md"];
		const written: string[] = [];
		try {
			for (const name of names) {
				await writeFile(join(PROPOSALS, name), "# tie\n", "utf8");
				written.push(join(PROPOSALS, name));
			}
			for (const path of written) await utimes(path, at, at);
			// The directory decides which of the two identical ages comes first; the
			// broker takes that one, and a tie broken the other way is a different file.
			const offered = (await readdir(PROPOSALS)).filter((entry) => entry.startsWith("tie-"));
			const f = await publishFixture();
			await f.write(`learn-1200${PUBLISH_SUFFIX}`, request());
			const row = await publishOnce(f.deps);
			assert.equal(row?.proposal, join(PROPOSALS, offered[0]));
		} finally {
			for (const path of written) await rm(path, { force: true });
			for (const path of await readdir(PROPOSALS)) {
				if (path.startsWith("tie-")) await rm(join(PROPOSALS, path), { force: true, recursive: true });
			}
		}
	});

	test("nothing in the queue is no publish and no claim, not a crash", async () => {
		const f = await publishFixture();
		assert.equal(await publishOnce(f.deps), null);
		assert.equal(f.calls.length, 0);
	});

	test("a look that lost the claim race is retried until the window closes", async () => {
		// A rename that cannot happen is a broker that lost to another one. The file is
		// still claimed, so the answer is nothing — but nothing after the window, not
		// nothing on the first look, or a broker that lost a race gives up on the queue.
		const f = await publishFixture();
		const lost = `learn-1210${PUBLISH_SUFFIX}`;
		await f.write(lost, request({ slug: "learn-1210", branch: "learn/learn-1210", proposal: f.proposal }));
		await mkdir(join(f.dir, `${lost}.claimed`));
		const started = Date.now();
		const row = await watchPublish({ ...f.deps, pollMs: 5, windowMs: 400 });
		const elapsed = Date.now() - started;
		assert.equal(row, null, "another broker holds that file, so there is nothing to report");
		assert.ok(elapsed >= 300, `the watch waited out its window (${elapsed}ms), one look at a time`);
	});

	test("with no proposal anywhere, the script is asked for the slug and nothing else", async () => {
		const f = await publishFixture();
		const before = await readdir(PROPOSALS);
		for (const entry of before) await rm(join(PROPOSALS, entry), { recursive: true, force: true });
		try {
			await f.write(`learn-1200${PUBLISH_SUFFIX}`, request());
			const row = await publishOnce(f.deps);
			assert.equal(row?.proposal, null);
			assert.deepEqual(f.calls[0].argv.slice(1), ["learn-1200", "--repo", REPO], "no --proposal to point at");
		} finally {
			await writeFile(join(PROPOSALS, "restored.md"), "# restored\n", "utf8");
		}
	});

	test("one drain publishes five files, not six, so a full queue cannot hold a session", async () => {
		const f = await publishFixture();
		for (let i = 0; i < 6; i += 1) {
			const slug = `learn-12${String(i).padStart(2, "0")}`;
			await f.write(`${slug}${PUBLISH_SUFFIX}`, request({ slug, branch: `learn/${slug}` }));
		}
		const rows = await drainPublishQueue(f.deps);
		assert.equal(rows.length, 5, "the limit is five per drain");
		assert.equal((await publishQueue(f.dir)).length, 1, "the sixth waits for the next drain");
	});

	test("a file already waiting is published on the first look", async () => {
		const f = await publishFixture();
		await f.write(`learn-1200${PUBLISH_SUFFIX}`, request({ proposal: f.proposal }));
		const row = await watchPublish({ ...f.deps, pollMs: 5, windowMs: 100 });
		assert.equal(row?.slug, "learn-1200", "the first look is not a look that is thrown away");
	});

	test("the watch waits five seconds between looks, not one millisecond", async () => {
		// The bound, not a race: an empty queue and a window shorter than the beat means
		// one look, one five-second wait, then out. A poll of a millisecond would spin
		// through the window in a few hundred microseconds and return just as null.
		const f = await publishFixture();
		const started = Date.now();
		const row = await watchPublish({ dir: f.dir, run: f.deps.run, record: f.deps.record, windowMs: 700 });
		const elapsed = Date.now() - started;
		assert.equal(row, null);
		assert.equal(f.calls.length, 0);
		assert.ok(elapsed >= 4_000, `the beat is ${PUBLISH_POLL_MS}ms, and this wait lasted ${elapsed}ms`);
	});
});

describe("a request left by a learner that already finished", () => {
	// The half of the broker that does not ride a launch: the host session looks at
	// the queue on start and once a minute while the person keeps typing, so a
	// learner that took an hour still gets published.
	let published: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];

	function setupWithBroker() {
		published = [];
		const started: any[] = [];
		const fake = createFakePi();
		selfLearn(fake.pi, {
			launch: () => ({ ok: true, status: 0 }),
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			countNotes: async () => 0,
			has: () => true,
			exists: () => true,
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
			transcriptPath: () => null,
			proposalExists: () => true,
			outcomePollMs: 5,
			outcomeTimeoutMs: 100,
			publishWindowMs: 0,
			publishRun: async (argv: string[], env: NodeJS.ProcessEnv) => {
				published.push({ argv, env });
				return { status: 0, stdout: "PR #7 exists", stderr: "" };
			},
			...started,
		});
		return { fake, started };
	}

	test("a queue file waiting at session start is published exactly once", async () => {
		const queue = join(scratch, "proposals", "queue");
		await mkdir(queue, { recursive: true });
		const file = join(queue, `learn-09-09${PUBLISH_SUFFIX}`);
		await writeFile(file, JSON.stringify({ slug: "learn-09-09", branch: "learn/learn-09-09", reason: "x" }), "utf8");

		const { fake } = setupWithBroker();
		const rows: any[] = [];
		const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
		// The extension's own runs.jsonl appender is what records the row here.
		await fake.emit("session_start", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 120));

		assert.equal(published.length, 1, "one claim, one publish");
		assert.equal(published[0].argv[1], "learn-09-09");
		assert.equal(existsSync(file), false, "the claimed file is gone, not retried forever");
		await rm(queue, { recursive: true, force: true });
		void rows;
	});

	test("a learner's own session never claims the queue file", async () => {
		const queue = join(scratch, "proposals", "queue");
		await mkdir(queue, { recursive: true });
		const file = join(queue, `learn-08-08${PUBLISH_SUFFIX}`);
		await writeFile(file, JSON.stringify({ slug: "learn-08-08", branch: "learn/learn-08-08", reason: "x" }), "utf8");
		const before = process.env.PI_SELF_LEARN;
		process.env.PI_SELF_LEARN = "1";
		try {
			const { fake } = setupWithBroker();
			const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
			await fake.emit("session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(published.length, 0, "a sandboxed broker would claim and fail it");
			assert.equal(existsSync(file), true, "the file is left for the host");
		} finally {
			if (before === undefined) delete process.env.PI_SELF_LEARN;
			else process.env.PI_SELF_LEARN = before;
			await rm(queue, { recursive: true, force: true });
		}
	});
});

describe("a request left by a learner that already finished", () => {
	// The half of the broker that does not ride a launch: the host session looks at
	// the queue on start and once a minute while the person keeps typing, so a
	// learner that took an hour still gets published.
	let published: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];

	function setupWithBroker() {
		published = [];
		const started: any[] = [];
		const fake = createFakePi();
		selfLearn(fake.pi, {
			launch: () => ({ ok: true, status: 0 }),
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			countNotes: async () => 0,
			has: () => true,
			exists: () => true,
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
			transcriptPath: () => null,
			proposalExists: () => true,
			outcomePollMs: 5,
			outcomeTimeoutMs: 100,
			publishWindowMs: 0,
			publishRun: async (argv: string[], env: NodeJS.ProcessEnv) => {
				published.push({ argv, env });
				return { status: 0, stdout: "PR #7 exists", stderr: "" };
			},
			...started,
		});
		return { fake, started };
	}

	test("a queue file waiting at session start is published exactly once", async () => {
		const queue = join(scratch, "proposals", "queue");
		await mkdir(queue, { recursive: true });
		const file = join(queue, `learn-09-09${PUBLISH_SUFFIX}`);
		await writeFile(file, JSON.stringify({ slug: "learn-09-09", branch: "learn/learn-09-09", reason: "x" }), "utf8");

		const { fake } = setupWithBroker();
		const rows: any[] = [];
		const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
		// The extension's own runs.jsonl appender is what records the row here.
		await fake.emit("session_start", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 120));

		assert.equal(published.length, 1, "one claim, one publish");
		assert.equal(published[0].argv[1], "learn-09-09");
		assert.equal(existsSync(file), false, "the claimed file is gone, not retried forever");
		await rm(queue, { recursive: true, force: true });
		void rows;
	});

	test("a learner's own session never claims the queue file", async () => {
		const queue = join(scratch, "proposals", "queue");
		await mkdir(queue, { recursive: true });
		const file = join(queue, `learn-08-08${PUBLISH_SUFFIX}`);
		await writeFile(file, JSON.stringify({ slug: "learn-08-08", branch: "learn/learn-08-08", reason: "x" }), "utf8");
		const before = process.env.PI_SELF_LEARN;
		process.env.PI_SELF_LEARN = "1";
		try {
			const { fake } = setupWithBroker();
			const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
			await fake.emit("session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(published.length, 0, "a sandboxed broker would claim and fail it");
			assert.equal(existsSync(file), true, "the file is left for the host");
		} finally {
			if (before === undefined) delete process.env.PI_SELF_LEARN;
			else process.env.PI_SELF_LEARN = before;
			await rm(queue, { recursive: true, force: true });
		}
	});
});

describe("the publish queue on disk", () => {
	test("only the suffix the broker scans for is a queue file, and the list is ordered", async () => {
		const dir = await mkdtemp(join(scratch, "queue-"));
		try {
			// Written in reverse, so a listing that just hands back the directory order
			// is not the same list as the broker's.
			await writeFile(join(dir, `c${PUBLISH_SUFFIX}`), "{}", "utf8");
			await writeFile(join(dir, `b${PUBLISH_SUFFIX}`), "{}", "utf8");
			await writeFile(join(dir, `a${PUBLISH_SUFFIX}`), "{}", "utf8");
			await writeFile(join(dir, "notes.md"), "x", "utf8");
			await writeFile(join(dir, `c${PUBLISH_SUFFIX}.claimed`), "x", "utf8");
			await mkdir(join(dir, `d${PUBLISH_SUFFIX}`));
			assert.deepEqual(await publishQueue(dir), [
				join(dir, `a${PUBLISH_SUFFIX}`),
				join(dir, `b${PUBLISH_SUFFIX}`),
				join(dir, `c${PUBLISH_SUFFIX}`),
			], "the queue files, in name order, whatever order the directory is in");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a queue directory that is not there is empty, not an error", async () => {
		assert.deepEqual(await publishQueue(join(scratch, "no-such-queue")), []);
	});
});

describe("the broker's bounds", () => {
	test("a command is run with its own cwd, both streams captured, and nothing to read on stdin", async () => {
		// The spawn this pins is the one that runs learn-publish.sh: no cwd and no pipes
		// would still exit 0 and report nothing, which reads exactly like a publish.
		const script = [
			"const fs=require('node:fs')",
			"process.stdout.write(process.cwd()+'|'+fs.fstatSync(0).isFIFO())",
			"process.stderr.write('why it failed')",
			"process.exit(3)",
		].join(";");
		const result = await runOnce([process.execPath, "-e", script], scratch, 10_000);
		assert.equal(result.status, 3, "the child's own exit code is the answer");
		assert.equal(result.stdout, `${scratch}|false`, "its cwd is what it was handed, stdout is read, and stdin is /dev/null, not a pipe nobody closes");
		assert.match(result.stderr, /why it failed/, "and stderr is kept, not dropped");
	});

	test("a command gets the environment it was handed, not the session's own", async () => {
		const result = await runOnce(
			[process.execPath, "-e", "process.stdout.write(`${process.env.PI_LEARN_BROKER}|${process.env.HOST_ONLY}`)"],
			scratch,
			10_000,
			{ PI_LEARN_BROKER: "1" },
		);
		assert.equal(result.stdout, "1|undefined", "one variable in, and the host's own environment out");
	});

	test("a command that cannot be started is null, not a crash", async () => {
		const result = await runOnce([join(scratch, "no-such-binary")], scratch, 10_000);
		assert.equal(typeof result.status === "number" ? "number" : "null", "null");
		assert.notEqual(String(result.stderr), "", "and it says why");
	});
});

describe("the host session's half of the broker", () => {
	function hostOnly(over: Record<string, unknown> = {}) {
		const fake = createFakePi();
		selfLearn(fake.pi, {
			launch: () => ({ ok: true, status: 0 }),
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			countNotes: async () => 0,
			has: () => true,
			exists: () => true,
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
			transcriptPath: () => null,
			proposalExists: () => true,
			outcomePollMs: 5,
			outcomeTimeoutMs: 100,
			publishWindowMs: 0,
			...over,
		});
		const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
		return { fake, ctx };
	}

	const queueDir = () => join(scratch, "proposals", "queue");
	const runsLog = () => join(scratch, "proposals", "runs.jsonl");

	/** Every line of the audit trail, or none when it has not been written yet. */
	async function readRows(): Promise<any[]> {
		try {
			return (await readFile(runsLog(), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	/**
	 * Poll for a row instead of reading the log once.
	 *
	 * Claiming a queue file and writing its run row are two steps, so "the file is gone"
	 * does not mean "the row is there". Reading the log straight after the claim is a bet on
	 * the gap between them, and on a box running 31 stryker workers that bet loses.
	 */
	async function waitForRow(predicate: (row: any) => boolean, timeoutMs = 3000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const row = (await readRows()).find(predicate);
			if (row) return row;
			if (Date.now() > deadline) throw new Error(`no run row matched within ${timeoutMs} ms`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async function refusedFile(slug: string): Promise<string> {
		await mkdir(queueDir(), { recursive: true });
		const file = join(queueDir(), `${slug}${PUBLISH_SUFFIX}`);
		await writeFile(file, "{not json", "utf8");
		return file;
	}

	test("the first turn of a host session drains the queue, and the next one does not", async () => {
		const first = await refusedFile("learn-06-06");
		const { fake, ctx } = hostOnly();
		try {
			await fake.emit("before_agent_start", {}, ctx);
			const refused = await waitForRow((row) => row.kind === "publish" && row.slug === "learn-06-06");
			assert.equal(existsSync(first), false, "the refused file was claimed, not left behind");
			const rows = await readRows();
			assert.equal(
				rows.filter((row) => row.kind === "publish" && row.slug === "learn-06-06").length,
				1,
				"the row lands in runs.jsonl, not in the void",
			);
			assert.equal(refused.slug, "learn-06-06");
			assert.equal(refused.publish, "refused");

			const second = await refusedFile("learn-06-07");
			await fake.emit("before_agent_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(existsSync(second), true, "one look a minute is enough; a turn is not a reason to look");
			await rm(second, { force: true });
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("a learner's own session never drains the queue it writes into", async () => {
		const file = await refusedFile("learn-05-05");
		const before = process.env.PI_SELF_LEARN;
		process.env.PI_SELF_LEARN = "1";
		try {
			const { fake, ctx } = hostOnly();
			await fake.emit("before_agent_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(existsSync(file), true, "a sandboxed broker would claim the file and fail it");
		} finally {
			if (before === undefined) delete process.env.PI_SELF_LEARN;
			else process.env.PI_SELF_LEARN = before;
			await rm(queueDir(), { recursive: true, force: true });
		}
	});
});

describe("a launch that ends in a request is published", () => {
	const boom = { isError: true, toolName: "bash", content: "command not found: zizmor" };
	function launching(over: Record<string, unknown> = {}) {
		const clock = NOW + 20 * 60_000;
		const published: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
		const fake = createFakePi();
		selfLearn(fake.pi, {
			launch: () => ({ ok: true, status: 0 }),
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			countNotes: async () => 0,
			has: () => true,
			exists: () => true,
			now: () => clock,
			proposalExists: () => true,
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
			transcriptPath: () => null,
			outcomePollMs: 5,
			outcomeTimeoutMs: 100,
			publishPollMs: 5,
			publishWindowMs: 500,
			publishRun: async (argv: string[], env: NodeJS.ProcessEnv) => {
				published.push({ argv, env });
				return { status: 0, stdout: "PR exists", stderr: "" };
			},
			...over,
		});
		const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
		return { fake, ctx, published };
	}

	async function queueRequest(slug: string): Promise<string> {
		const queue = join(scratch, "proposals", "queue");
		await mkdir(queue, { recursive: true });
		const file = join(queue, `${slug}${PUBLISH_SUFFIX}`);
		await writeFile(file, JSON.stringify({ slug, branch: `learn/${slug}`, reason: "the fix is ready" }), "utf8");
		return file;
	}

	test("a learner that wrote its proposal has its waiting request published", async () => {
		const file = await queueRequest("learn-04-04");
		const { fake, ctx, published } = launching();
		try {
			await fake.emit("tool_result", boom, ctx);
			await fake.emit("tool_result", boom, ctx);
			await fake.emit("session_compact", { reason: "threshold" }, ctx);
			await waitFor(() => published.length === 1);
			assert.equal(published[0].argv[1], "learn-04-04");
			assert.equal(existsSync(file), false, "claimed once, published once");
		} finally {
			await rm(join(scratch, "proposals", "queue"), { recursive: true, force: true });
		}
	});

	test("a learner that died is not a reason to publish the request it never made", async () => {
		// A request on the queue and no proposal is a learner that did not finish; the
		// broker waits for the next run instead of publishing a branch nobody wrote.
		const file = await queueRequest("learn-03-03");
		let launched = 0;
		const { fake, ctx, published } = launching({
			now: () => NOW + 90 * 60_000,
			proposalExists: () => false,
			launch: () => {
				launched += 1;
				return { ok: true, status: 0 };
			},
		});
		try {
			await fake.emit("tool_result", boom, ctx);
			await fake.emit("tool_result", boom, ctx);
			await fake.emit("session_compact", { reason: "threshold" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 700));
			assert.equal(launched, 1, "the learner started, so this is a death and not a missing launch");
			assert.equal(published.length, 0, "the proposal is the learner's product, not the request");
			assert.equal(existsSync(file), true, "so the file stays for the next run");
		} finally {
			await rm(join(scratch, "proposals", "queue"), { recursive: true, force: true });
		}
	});
});

describe("a launch handed to the host session", () => {
	// Last in the file on purpose: these tests write rows to the shared scratch
	// `runs.jsonl`, and `lastSpawnAnywhere` reads that log as a debounce, so a
	// describe after them would see a learner started in its own future (the
	// 2026-11-15 lesson: test order is part of the fixture).
	//
	// A sandbox never mounts `herdr-app`, so a sandboxed session cannot make a
	// space. It writes one `<slug>.spawn.json` request carrying the evidence it
	// measured, and a host session claims it and starts the learner.
	const PROPOSALS = join(scratch, "proposals");
	const queueDir = () => join(PROPOSALS, "queue");
	const runsLog = () => join(PROPOSALS, "runs.jsonl");
	const EVIDENCE = "# Evidence\n\n2× workers recorded \"tests: failed\"\n";
	let launched: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];

	function hostSession(deps: Record<string, unknown> = {}) {
		launched = [];
		const fake = createFakePi();
		selfLearn(fake.pi, {
			launch: (launcher: any, env: NodeJS.ProcessEnv) => {
				launched.push({ argv: launcher.argv, env });
				return { ok: true, status: 0 };
			},
			confirm: async () => ({ ok: true, source: "session" }),
			closeSpace: async () => {},
			countNotes: async () => 0,
			has: () => true,
			exists: () => true,
			ciRuns: async () => ({ runs: [], warning: null }),
			workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
			transcriptPath: () => null,
			proposalExists: () => true,
			outcomePollMs: 5,
			outcomeTimeoutMs: 100,
			publishPollMs: 5,
			publishWindowMs: 0,
			...deps,
		});
		const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
		return { fake, ctx };
	}

	async function readRows(): Promise<any[]> {
		try {
			return (await readFile(runsLog(), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	/** Claiming a file and writing its row are two steps, so poll, never read once. */
	async function waitForRow(predicate: (row: any) => boolean, timeoutMs = 3000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const row = (await readRows()).find(predicate);
			if (row) return row;
			if (Date.now() > deadline) throw new Error(`no run row matched within ${timeoutMs} ms`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	const evidencePath = () => join(queueDir(), "2026-11-18-07-07-00-000Z.md");

	function requestBody(over: Record<string, unknown> = {}) {
		return JSON.stringify({
			slug: "learn-07-07",
			trigger: "compact",
			queue: evidencePath(),
			proposal: join(PROPOSALS, "2026-11-18-07-07-00-000Z.md"),
			reason: "2× workers recorded \"tests: failed\"",
			evidence: EVIDENCE,
			ts: new Date().toISOString(),
			judged: ["learn-10-59"],
			...over,
		});
	}

	async function writeRequest(over: Record<string, unknown> = {}): Promise<string> {
		await mkdir(queueDir(), { recursive: true });
		const file = join(queueDir(), `${over.slug ?? "learn-07-07"}${SPAWN_SUFFIX}`);
		await writeFile(file, requestBody(over), "utf8");
		return file;
	}

	/** The requests waiting on disk, by name: the sandbox's side of the hand-off. */
	async function requestNames(): Promise<string[]> {
		try {
			return (await readdir(queueDir())).filter((name) => name.endsWith(".spawn.json")).sort();
		} catch {
			return [];
		}
	}

	test("the host session writes the evidence and starts the learner the request names", async () => {
		const file = await writeRequest();
		const { fake, ctx } = hostSession();
		try {
			await fake.emit("session_start", {}, ctx);
			await waitFor(() => launched.length === 1, 3000, "the host never started the learner");
			assert.equal(launched[0].argv[1], "spawn");
			assert.equal(launched[0].argv[2], "learn-07-07", "the slug the requesting session chose, not a new one");
			assert.equal(launched[0].env.PI_SELF_LEARN, "1", "a learner cannot start a learner");
			assert.equal(
				await readFile(evidencePath(), "utf8"),
				EVIDENCE,
				"the text the sandbox measured, written where the learner is told to read it",
			);
			assert.equal(existsSync(file), false, "the claimed request is gone, not retried forever");
			assert.equal(existsSync(`${file}.claimed`), false, "and the claim does not linger either");
			// The launch carries the requesting session's own judgement: the host is a
			// courier, not a second judge.
			const spawned = await waitForRow((row) => row.kind === "spawned" && row.slug === "learn-07-07");
			assert.equal(spawned.reason, "2× workers recorded \"tests: failed\"", "the gate's own sentence, from the request");
			assert.deepEqual(spawned.judged, ["learn-10-59"], "and the deaths that sentence named");
			assert.equal(spawned.trigger, "compact");
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("a sandboxed session leaves the request for the host", async () => {
		const file = await writeRequest();
		process.env.PI_SANDBOX_MODE = "bwrap";
		try {
			const { fake, ctx } = hostSession();
			await fake.emit("session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(launched.length, 0, "a sandbox cannot make the space either");
			assert.equal(existsSync(file), true, "the file is left for the session that can");
			assert.equal(existsSync(evidencePath()), false, "and no evidence file is written by the wrong session");
		} finally {
			delete process.env.PI_SANDBOX_MODE;
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("a request inside the window is the host's, one outside it is a row", async () => {
		// 14 minutes is inside the 15-minute window: the text is about a compaction
		// the person still remembers. 16 is not.
		const inside = join(queueDir(), `learn-07-08${SPAWN_SUFFIX}`);
		const outside = join(queueDir(), `learn-07-09${SPAWN_SUFFIX}`);
		await mkdir(queueDir(), { recursive: true });
		try {
			await writeFile(inside, requestBody({ slug: "learn-07-08", ts: new Date(Date.now() - 14 * 60_000).toISOString() }), "utf8");
			const first = hostSession();
			await first.fake.emit("session_start", {}, first.ctx);
			await waitFor(() => launched.length === 1, 3000, "a 14-minute-old request is still worth acting on");

			await writeFile(outside, requestBody({ slug: "learn-07-09", ts: new Date(Date.now() - 16 * 60_000).toISOString() }), "utf8");
			const second = hostSession();
			await second.fake.emit("session_start", {}, second.ctx);
			const stale = await waitForRow((row) => row.kind === "spawn-stale" && row.request === outside);
			assert.equal(launched.length, 0, "evidence about a compaction nobody remembers is not a learner");
			assert.match(stale.stderr, /min old/);
			assert.equal(existsSync(outside), false, "a stale request is retired, not left to age further");
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("a request that points outside the proposals directory is refused", async () => {
		const file = await writeRequest({ slug: "learn-07-11", queue: "/etc/passwd" });
		const { fake, ctx } = hostSession();
		try {
			await fake.emit("session_start", {}, ctx);
			const refused = await waitForRow((row) => row.kind === "spawn-refused" && row.request === file);
			assert.equal(launched.length, 0, "the broker does not write where a request points");
			assert.match(refused.stderr, /queue is not a file under/);
			assert.equal(launched.length, 0, "and no learner is started on a path the broker would not write");
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("an evidence file that cannot be written refuses the launch instead of losing it", async () => {
		// A learner told to read a file that is not there is a launch that fails
		// silently. `blocker` is a file, so the directory below it cannot be made.
		await mkdir(queueDir(), { recursive: true });
		await writeFile(join(queueDir(), "blocker"), "not a directory", "utf8");
		const file = await writeRequest({ slug: "learn-07-12", queue: join(queueDir(), "blocker", "evidence.md") });
		const { fake, ctx } = hostSession();
		try {
			await fake.emit("session_start", {}, ctx);
			const refused = await waitForRow((row) => row.kind === "spawn-refused" && row.request === file);
			assert.match(refused.stderr, /could not be written/);
			assert.equal(launched.length, 0, "no learner is started on evidence nobody can read");
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("a claim another session holds is recorded, not swallowed and not retried", async () => {
		// Two host sessions can look at the same minute. The file is the lock: the
		// session that cannot rename it lost the claim, and the trail says so.
		await mkdir(queueDir(), { recursive: true });
		const file = await writeRequest({ slug: "learn-07-14" });
		await mkdir(`${file}.claimed`, { recursive: true });
		await writeFile(join(`${file}.claimed`, "keeper"), "someone else has it", "utf8");
		const { fake, ctx } = hostSession();
		try {
			await fake.emit("session_start", {}, ctx);
			const row = await waitForRow((entry) => entry.kind === "spawn-refused" && entry.request === file);
			assert.match(row.stderr, /another session held the claim/);
			assert.equal(launched.length, 0, "the session that lost the claim starts nothing");
			assert.equal(existsSync(file), true, "and leaves the request for the session that has it");
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("a request JSON that is not a request is claimed and recorded, not retried", async () => {
		await mkdir(queueDir(), { recursive: true });
		const file = join(queueDir(), `learn-07-13${SPAWN_SUFFIX}`);
		await writeFile(file, "{not json", "utf8");
		const { fake, ctx } = hostSession();
		try {
			await fake.emit("session_start", {}, ctx);
			const refused = await waitForRow((row) => row.kind === "spawn-refused" && row.request === file);
			assert.match(refused.stderr, /not JSON/);
			assert.equal(existsSync(file), false, "a broken request does not sit on the queue forever");
		} finally {
			await rm(queueDir(), { recursive: true, force: true });
		}
	});

	test("the parser refuses a request the broker must not act on", () => {
		const now = Date.parse("2026-11-18T12:00:00.000Z");
		const good = JSON.parse(requestBody({ slug: "learn-12-00", ts: new Date(now - 60_000).toISOString() }));
		const parse = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
			parseSpawnRequest(JSON.stringify({ ...good, ...over }), { now, ...options });
		const ok = parse();
		assert.equal(ok.ok, true, "the request the sandbox writes is one the host accepts");
		if (ok.ok) {
			assert.equal(ok.request.slug, "learn-12-00");
			assert.equal(ok.request.evidence, EVIDENCE, "the evidence travels with the request");
			assert.deepEqual(ok.request.judged, ["learn-10-59"], "and so do the deaths the reason named");
		}
		const trimmed = parse({ slug: "  LEARN-12-00  " });
		assert.equal(trimmed.ok, true);
		if (trimmed.ok) assert.equal(trimmed.request.slug, "learn-12-00", "a slug is case-folded and trimmed");
		assert.equal(parse({ slug: "../trunk" }).ok, false, "a slug names a learner, not a branch");
		assert.equal(parse({ slug: 42 }).ok, false);
		assert.equal(parse({ trigger: "resume" }).ok, false);
		assert.equal(parse({ trigger: "manual" }).ok, true);
		assert.equal(parse({ reason: "   " }).ok, false);
		assert.equal(parse({ reason: null }).ok, false);
		assert.equal(parse({ evidence: "" }).ok, false, "a learner with no evidence is not a learner");
		assert.equal(parse({ evidence: " \n " }).ok, false);
		assert.equal(parse({ evidence: 12 }).ok, false);
		assert.equal(parse({ queue: "/tmp/x.md" }).ok, false, "only the evidence directory");
		assert.equal(parse({ queue: `${queueDir()}/../x.md` }).ok, false, "and not its parent");
		assert.equal(parse({ queue: "" }).ok, false);
		assert.equal(parse({ proposal: "/tmp/x.md" }).ok, false, "only the proposals directory");
		assert.equal(parse({ ts: "yesterday" }).ok, false);
		assert.equal(parse({ ts: undefined }).ok, false);
		assert.equal(parse({ judged: ["a", 3, null] }).ok === true, true, "a non-string in judged is dropped, not fatal");
		const filtered = parse({ judged: ["a", 3] });
		if (filtered.ok) assert.deepEqual(filtered.request.judged, ["a"]);
		const ttl = parse({}, { ttlMs: 60_000 });
		assert.equal(ttl.ok, true, "the window is the caller's to set");
		const stale = parse({ ts: new Date(now - SPAWN_REQUEST_TTL_MS - 1).toISOString() });
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.equal(stale.stale, true, "a stale request is a different row from a broken one");
		for (const raw of ["not json", "[]", "null", '"learn-12-00"']) {
			const parsed = parseSpawnRequest(raw, { now });
			assert.equal(parsed.ok, false, `${raw} is not one JSON object`);
			if (!parsed.ok) assert.equal(parsed.stale, undefined, "and it is not stale: it is broken");
		}
	});

	test("the launch queue lists only its own suffix, in name order", async () => {
		const dir = await mkdtemp(join(scratch, "spawn-queue-"));
		try {
			assert.deepEqual(await spawnQueue(dir), [], "no directory yet is no requests, not a crash");
			await writeFile(join(dir, `b${SPAWN_SUFFIX}`), "{}", "utf8");
			await writeFile(join(dir, `a.spawn.json`), "{}", "utf8");
			await writeFile(join(dir, `a.spawn.json.claimed`), "{}", "utf8");
			await writeFile(join(dir, `a${PUBLISH_SUFFIX}`), "{}", "utf8");
			await mkdir(join(dir, `c${SPAWN_SUFFIX}`));
			assert.deepEqual(
				await spawnQueue(dir),
				[join(dir, "a.spawn.json"), join(dir, `b${SPAWN_SUFFIX}`)],
				"the suffix the sandbox writes, the claim and the publish queue left out",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	describe("the sandbox's side", () => {
		function sandboxed(over: Record<string, unknown> = {}) {
			const fake = createFakePi();
			const api = selfLearn(fake.pi, {
				launch: () => ({ ok: true, status: 0 }),
				confirm: async () => ({ ok: true, source: "session" }),
				closeSpace: async () => {},
				countNotes: async () => 0,
				has: () => true,
				exists: () => true,
				ciRuns: async () => ({ runs: [], warning: null }),
				workspace: async () => ({ reports: [], decisions: [], present: false, warnings: [] }),
				transcriptPath: () => null,
				proposalExists: () => true,
				outcomePollMs: 5,
				outcomeTimeoutMs: 100,
				publishPollMs: 5,
				publishWindowMs: 0,
				...over,
			});
			const { ctx, notices } = createFakeCtx({ mode: "tui", hasUI: true });
			const emit = (name: string, event: any = {}, c: any = ctx) => fake.emit(name, event, c);
			return { emit, ctx, notices, api };
		}

		/** Two identical tool errors: the gate's cheapest way in. */
		const trip = async (emit: (n: string, e?: any, c?: any) => Promise<any[]>, ctx: any) => {
			const boom = { isError: true, toolName: "bash", content: "command not found: zizmor" };
			await emit("tool_result", boom, ctx);
			await emit("tool_result", boom, ctx);
		};

		test("a sandboxed session writes the request instead of a spec, and says so once", async () => {
			// Past the rows the earlier tests left in the shared log, so the gate is
			// open and the sandbox rule is the only thing that can refuse.
			const clock = Date.now() + 60 * 60_000;
			const { emit, ctx, notices, api } = sandboxed({ now: () => clock });
			await trip(emit, ctx);
			process.env.PI_SANDBOX_MODE = "bwrap";
			try {
				const decision = await api.learn("compact", ctx);
				assert.equal(decision.spawn, false, "a sandboxed session is not allowed to claim a launch");
				assert.match(decision.reason, /sandboxed \(bwrap\)/, "the refusal says the sandbox did it");
				const [name] = await requestNames();
				assert.ok(name, "one request, waiting for the host");
				const parsed = parseSpawnRequest(await readFile(join(queueDir(), name), "utf8"), { now: Date.now() });
				assert.equal(parsed.ok, true, `the request the host will read must parse: ${name}`);
				if (parsed.ok) {
					assert.match(parsed.request.evidence, /workers recorded/, "it carries the evidence this session measured");
					assert.equal(parsed.request.trigger, "compact");
					assert.ok(existsSync(parsed.request.proposal) === false, "the proposal is the learner's to write");
				}
				const rows = await readRows();
				const skipped = rows.filter((row) => row.kind === "spawn-skipped").at(-1);
				assert.ok(skipped, "the skip is the row the trail carries");
				assert.match(skipped.stderr, /waits for the host session/, "and the row names the hand-off");
				assert.equal(skipped.slug, name.replace(/\.spawn\.json$/, ""), "the row names the run the request is for");
				assert.equal(
					existsSync(skipped.queue),
					false,
					"the spec is not written here: nothing on this side could read it",
				);
				assert.equal(notices.filter((notice) => /no learner started/.test(notice.message)).length, 1);
				assert.match(notices.at(-1)!.message, /waits for the host session/);
			} finally {
				delete process.env.PI_SANDBOX_MODE;
				await rm(queueDir(), { recursive: true, force: true });
			}
		});

		test("one request per session, however many compactions trip the gate", async () => {
			let tick = Date.now() + 60 * 60_000;
			const { emit, ctx } = sandboxed({ now: () => tick });
			process.env.PI_SANDBOX_MODE = "bwrap";
			// The log is shared with the describes above: judge only these rows.
			const before = (await readRows()).length;
			try {
				await trip(emit, ctx);
				await emit("session_compact", { reason: "threshold" }, ctx);
				const names = await requestNames();
				assert.equal(names.length, 1, "the first compaction asks");
				// Past the gap, and under the per-session cap: the gate lets this one
				// through, so only the once-per-session rule can stop a second request.
				tick += 11 * 60_000;
				await trip(emit, ctx);
				await emit("session_compact", { reason: "threshold" }, ctx);
				assert.equal((await requestNames()).length, 1, "a sandbox does not become a host mid-session");
				const rows = (await readRows()).slice(before);
				assert.equal(rows.filter((row) => row.kind === "spawn-skipped").length, 1, "and the person is told once");
			} finally {
				delete process.env.PI_SANDBOX_MODE;
				await rm(queueDir(), { recursive: true, force: true });
			}
		});
	});
});
