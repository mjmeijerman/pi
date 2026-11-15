/**
 * config-guard: the session-start line that names a broken config file.
 *
 * Radar basis: #102 Varlock (Assess) — validate config, do not hope. #29 harness
 * quality evaluation: the notice has to be the same sentence the gate prints, or
 * the screen and the check disagree about what is broken (scripts/tests/
 * config-schema.test.mjs pins that equality from the other side).
 *
 * The decision itself lives in agent/config/schema.mjs and is tested there; this
 * file proves the wiring: it fires on `session_start`, stays quiet when the
 * config is clean, caps a long list, and never takes the session down when the
 * screen is missing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkConfigDir } from "../../config/schema.mjs";
import configGuard, { configDir, guardLines, inspectConfig, MAX_LINES } from "../config-guard.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = mkdtempSync(join(tmpdir(), "config-guard-"));

const VALID_SETTINGS = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-flash",
	hideThinkingBlock: true,
};

let n = 0;

/** A config dir with a settings file; `typo` adds defaultProvder alongside. */
function fixture(settings = VALID_SETTINGS, dirName) {
	const dir = join(tmp, dirName ?? `agent-${n++}`, "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({ providers: { deepseek: { baseUrl: "https://example.invalid/v1", models: [{ id: "m" }] } } }),
	);
	return dir;
}

/** Run the guard against `dir` with a fake pi and a fake screen. */
async function session(settings, options: { hasUI?: boolean; notify?: (message: string) => void } = {}) {
	const dir = fixture(settings);
	const fake = createFakePi();
	configGuard(fake.pi);
	const { ctx, notices } = createFakeCtx({ hasUI: options.hasUI ?? true, ui: options.notify ? { notify: options.notify } : {} });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		await fake.emit("session_start", { reason: "startup" }, ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	return { notices, dir };
}

describe("config-guard: the config directory", () => {
	test("pi's own override wins, an empty one falls through", () => {
		assert.equal(configDir({ PI_CODING_AGENT_DIR: "/tmp/elsewhere", HOME: "/home/x" }), "/tmp/elsewhere");
		assert.equal(configDir({ PI_CODING_AGENT_DIR: "", HOME: "/home/x" }), "/home/x/.pi/agent");
	});

	test("without the override it is $HOME/.pi/agent, and homedir when HOME is unset", () => {
		assert.equal(configDir({ HOME: "/home/x" }), "/home/x/.pi/agent");
		assert.equal(configDir({}), join(homedir(), ".pi", "agent"));
		assert.equal(configDir({ HOME: "" }), join(homedir(), ".pi", "agent"));
		assert.equal(configDir({ HOME: "" }), join(homedir(), ".pi", "agent"));
	});
});

describe("config-guard: the lines it shows", () => {
	test("one line per failure, capped, with the rest pointed at the whole list", () => {
		assert.deepEqual(guardLines(["only"]), ["config: only"]);
		assert.deepEqual(guardLines(["a", "b", "c"]), ["config: a", "config: b", "config: c"]);
		assert.deepEqual(guardLines(["one", "two", "three", "four", "five"]), [
			"config: one",
			"config: two",
			"config: three",
			`config: 2 more — run: bash scripts/harness-check.sh --verify-config`,
		]);
		assert.equal(MAX_LINES, 3);
	});

	test("a clean config produces no lines at all", () => {
		assert.deepEqual(guardLines(inspectConfig(fixture()).messages), []);
	});
});

describe("config-guard: at session start", () => {
	test("a clean config is silent", async () => {
		const { notices } = await session(VALID_SETTINGS);
		assert.deepEqual(notices, []);
	});

	test("a broken config names the file, the path and what was expected", async () => {
		const { notices } = await session({ ...VALID_SETTINGS, defaultProvder: "deepseek" });
		assert.equal(notices.length, 1, JSON.stringify(notices));
		assert.equal(notices[0].level, "warning");
		assert.equal(
			notices[0].message,
			'config: agent/settings.json: defaultProvder — unknown top-level key; did you mean "defaultProvider"?',
		);
	});

	test("the notice carries the same sentence the gate FAILs with", async () => {
		const { notices } = await session({ ...VALID_SETTINGS, hideThinkingBlock: "yes" });
		const failures = checkConfigDir(fixture({ ...VALID_SETTINGS, hideThinkingBlock: "yes" })).filter(
			(line) => line.status === "FAIL",
		);
		assert.equal(notices.length, failures.length);
		for (const [index, failure] of failures.entries()) {
			assert.equal(notices[index].message, `config: ${failure.where} — ${failure.message}`);
		}
	});

	test("a session without a UI gets nothing", async () => {
		const { notices } = await session({ ...VALID_SETTINGS, defaultProvder: "deepseek" }, { hasUI: false });
		assert.deepEqual(notices, []);
	});

	test("a notify that throws does not break the session", async () => {
		let calls = 0;
		const { notices } = await session(
			{ ...VALID_SETTINGS, defaultProvder: "deepseek" },
			{
				notify() {
					calls++;
					throw new Error("no screen");
				},
			},
		);
		assert.equal(notices.length, 0);
		assert.equal(calls, 1, "the first failure is attempted, then the guard stops");
	});

	test("a missing config directory is not a crash", async () => {
		const fake = createFakePi();
		configGuard(fake.pi);
		const { ctx, notices } = createFakeCtx({ hasUI: true });
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tmp, "does-not-exist");
		try {
			await fake.emit("session_start", { reason: "startup" }, ctx);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
		assert.deepEqual(notices, []);
	});

	test("validation stays inside the 50 ms session-start budget", () => {
		const result = inspectConfig(join(ROOT, "config", ".."));
		const elapsed = performance.now();
		assert.ok(result.ms < 50, `inspectConfig reported ${result.ms.toFixed(1)} ms, budget is 50 ms`);
		assert.ok(elapsed > 0);
	});
});
