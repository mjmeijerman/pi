/**
 * open-work: the prompt says what is unfinished, every turn.
 *
 * The provider boundary is not what is tested here — the line builder is, because it is the thing
 * that must print exactly one line for a reported worker and nothing at all for a clean space. The
 * handler is exercised once through the fake pi, to prove a clean space changes no prompt.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../open-work.ts");
const openWork = mod.default;
const { openLines, workersWithReports, rollupWord, mergeableWord } = mod;

const dirs: string[] = [];
function tmp(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-open-work-${name}-`));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Built {
	state: string;
	probe: any;
	calls: string[][];
}

/** A root with one space record, the worker's report, and a stubbed `delegate status`. */
function built(options: {
	slug?: string;
	report?: boolean;
	decisions?: any[];
	prs?: Record<number, any>;
	worker?: boolean;
} = {}): Built {
	const root = tmp(options.slug ?? "space");
	const state = join(root, "state");
	const space = join(state, "spaces", "demo");
	mkdirSync(join(space, "reports"), { recursive: true });
	mkdirSync(join(space, "state"), { recursive: true });
	const calls: string[][] = [];
	const slug = options.slug ?? "w1";
	const report = join(space, "reports", `${slug}.md`);
	if (options.report !== false) writeFileSync(report, "# Report\n\nMission: fixture\n");
	writeFileSync(
		join(space, "delegations.json"),
		options.worker === false ? "{}\n" : `${JSON.stringify({ [slug]: { slug, report, cwd: space } })}\n`,
	);
	if (options.decisions) {
		writeFileSync(
			join(space, "state", "decisions.jsonl"),
			`${options.decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}
	const probe = {
		state,
		delegate: join(root, "bin", "delegate"),
		run(cmd: string, args: string[]) {
			calls.push([cmd, ...args]);
			if (cmd === "gh") {
				const pr = Number(args[2]);
				const fact = options.prs?.[pr];
				if (!fact) throw new Error("no such pull request");
				return JSON.stringify(fact);
			}
			return `${JSON.stringify({ slug: args[1], status: "reported", decided: "report", report })}\n`;
		},
	};
	return { state, probe, calls };
}

describe("open-work: the lines", () => {
	test("a reported worker produces exactly one line", () => {
		const { probe, calls, state } = built({ slug: "w1" });
		const lines = openLines(probe);
		assert.equal(lines.length, 1);
		assert.equal(
			lines[0],
			`worker w1: reported, report at ${join(state, "spaces", "demo", "reports", "w1.md")} — next: bin/delegate finish w1`,
		);
		// One subprocess, and it is the tool that decides the word — no second opinion here.
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].slice(1), ["status", "w1", "--json"]);
	});

	test("a clean space produces none, and no subprocess at all", () => {
		const root = tmp("clean");
		mkdirSync(join(root, "state", "spaces"), { recursive: true });
		const calls: string[][] = [];
		const lines = openLines({
			state: join(root, "state"),
			delegate: join(root, "bin", "delegate"),
			run: (cmd, args) => {
				calls.push([cmd, ...args]);
				throw new Error("no call should happen for an empty record");
			},
		});
		assert.deepEqual(lines, []);
		assert.deepEqual(calls, []);
	});

	test("a worker the tool does not call reported produces no line", () => {
		const { probe } = built({ slug: "w1" });
		probe.run = () => `${JSON.stringify({ status: "working", decided: "no-report" })}\n`;
		assert.deepEqual(openLines(probe), []);
	});

	test("a worker with no report file is not even asked about", () => {
		const root = tmp("no-report");
		const state = join(root, "state");
		const space = join(state, "spaces", "demo");
		mkdirSync(space, { recursive: true });
		writeFileSync(join(space, "delegations.json"), `${JSON.stringify({ w9: { slug: "w9" } })}\n`);
		assert.deepEqual(workersWithReports(state), []);
	});

	test("an open PR produces one line; a merged one produces none", () => {
		const decision = { timestamp: "2026-01-01T00:00:00.000Z", command: "publish", pr: 42, slug: "w1" };
		const { probe, calls } = built({
			decisions: [decision],
			prs: { 42: { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] } },
		});
		const lines = openLines(probe);
		assert.ok(lines.includes("PR #42: green, mergeable — next: gh pr view 42"), lines.join("\n"));
		assert.ok(calls.some((c) => c[0] === "gh"));

		const merged = built({
			worker: false,
			decisions: [decision],
			prs: { 42: { state: "MERGED", mergeable: "UNKNOWN", statusCheckRollup: [] } },
		});
		assert.deepEqual(openLines(merged.probe), []);
	});
});

describe("open-work: the words", () => {
	test("rollup collapses to red, pending, green or no checks", () => {
		assert.equal(rollupWord([]), "no checks");
		assert.equal(rollupWord(undefined), "no checks");
		assert.equal(rollupWord([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "green");
		assert.equal(rollupWord([{ status: "IN_PROGRESS" }]), "pending");
		assert.equal(
			rollupWord([
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "FAILURE" },
			]),
			"red",
		);
	});

	test("mergeable is mergeable, conflicts or unknown", () => {
		assert.equal(mergeableWord("MERGEABLE"), "mergeable");
		assert.equal(mergeableWord("CONFLICTING"), "conflicts");
		assert.equal(mergeableWord("UNKNOWN"), "unknown");
	});
});

describe("open-work: the hook", () => {
	test("a clean space leaves the prompt untouched", async () => {
		const root = tmp("hook-clean");
		process.env.PI_BOSS_ROOT = root;
		mkdirSync(join(root, "state", "spaces"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "delegate"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
		const fake = createFakePi();
		openWork(fake.pi);
		const { ctx } = createFakeCtx();
		const [out] = await fake.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.equal(out, undefined);
		delete process.env.PI_BOSS_ROOT;
	});

	test("a reported worker adds its one line to the prompt", async () => {
		const root = tmp("hook-reported");
		const state = join(root, "state");
		const space = join(state, "spaces", "demo");
		mkdirSync(join(space, "reports"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		const report = join(space, "reports", "w1.md");
		writeFileSync(report, "# Report\n\nMission: fixture\n");
		writeFileSync(join(space, "delegations.json"), `${JSON.stringify({ w1: { slug: "w1", report } })}\n`);
		writeFileSync(
			join(root, "bin", "delegate"),
			`#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify({ slug: "w1", status: "reported", report })}'\n`,
			{ mode: 0o755 },
		);
		process.env.PI_BOSS_ROOT = root;
		const fake = createFakePi();
		openWork(fake.pi);
		const { ctx } = createFakeCtx();
		const [out] = await fake.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
		delete process.env.PI_BOSS_ROOT;
		assert.ok(out && typeof out.systemPrompt === "string");
		const added = out.systemPrompt.slice("BASE".length).trim().split("\n");
		assert.equal(added.length, 1);
		assert.ok(added[0].startsWith("worker w1: reported, report at "), added[0]);
		assert.ok(added[0].endsWith("next: bin/delegate finish w1"), added[0]);
	});
});
