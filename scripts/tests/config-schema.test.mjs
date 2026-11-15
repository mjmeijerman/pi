// Tests for agent/config/schema.mjs — the shape check on the files pi reads.
//
// Radar basis: #102 Varlock (Assess) — validate config, do not hope. A misspelled
// key in settings.json/models.json is not an error to pi, it is a key that is
// silently ignored, so the failure this test guards against is a validator that
// says PASS on a typo. Every case runs the real schema and the real
// scripts/harness-check.sh; a fixture schema would let the shipped one drift.
//
// The last group proves the two callers print the same line: the extension's
// session-start notice must carry the exact text harness-check FAILs with, or the
// screen and the gate disagree about what is broken.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkConfigDir, didYouMean, editDistance, keysSchema, validateValue } from "../../agent/config/schema.mjs";
import { createFakeCtx, createFakePi } from "../../agent/extensions/__tests__/helpers/fake-pi.ts";
import configGuard from "../../agent/extensions/config-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA = join(ROOT, "agent/config/schema.mjs");
const CHECK = join(ROOT, "scripts/harness-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "config-schema-"));

/** A settings document that names a route and nothing else. */
const VALID_SETTINGS = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "medium",
	hideThinkingBlock: true,
	"observational-memory": {
		compactAtContextTokens: 120000,
		models: { observer: { provider: "deepseek", id: "deepseek-v4-flash", thinking: "medium" } },
	},
};

const VALID_MODELS = {
	providers: {
		deepseek: {
			baseUrl: "https://api.deepseek.com/v1",
			api: "openai-completions",
			apiKey: "placeholder-env-var",
			models: [{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 }],
		},
		ollama: {
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			models: [{ id: "qwen3.8:27b", contextWindow: 131072, maxTokens: 16384 }],
		},
	},
};

/** A stand-in key value. No output line may ever carry it. */
const FIXTURE_VALUE = "marker-value-must-never-be-printed";

let n = 0;

/** Write a config dir under the test's temp root and return it (`<root>/agent`). */
function fixture({ settings, models, keys } = {}) {
	const dir = join(tmp, `root-${n++}`, "agent");
	mkdirSync(dir, { recursive: true });
	const write = (name, value) => {
		if (value !== undefined) writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
	};
	write("settings.json", settings ?? VALID_SETTINGS);
	write("models.json", models ?? VALID_MODELS);
	write("keys.json", keys);
	return dir;
}

/** Run the schema CLI against the parent of a config dir (it appends `agent/`). */
function cli(configDir) {
	const run = spawnSync(process.execPath, [SCHEMA, "--root", dirname(configDir)], { encoding: "utf8" });
	const lines = (run.stdout ?? "")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, where, ...rest] = line.split("\t");
			return { status, where, message: rest.join("\t") };
		});
	return { code: run.status, lines, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function harnessCheck(configDir, ...args) {
	return spawnSync("bash", [CHECK, "--verify-config", "--root", dirname(configDir), ...args], {
		encoding: "utf8",
		env: { ...process.env, HOME: join(tmp, "home") },
	});
}

describe("config schema: a valid set passes", () => {
	test("the three files this repo ships validate", () => {
		const lines = checkConfigDir(join(ROOT, "agent"));
		const failed = lines.filter((line) => line.status === "FAIL");
		assert.deepEqual(failed, [], `shipped config must validate: ${JSON.stringify(failed)}`);
		assert.ok(lines.some((line) => line.where === "agent/settings.json" && line.status === "PASS"));
		assert.ok(lines.some((line) => line.where === "agent/models.json" && line.status === "PASS"));
	});

	test("a fixture set passes and exits 0", () => {
		const result = cli(fixture({ keys: { deepseek: FIXTURE_VALUE } }));
		assert.equal(result.code, 0, result.stdout);
		assert.equal(result.lines.filter((line) => line.status === "FAIL").length, 0);
	});

	test("keys.json is optional: absent is not an error", () => {
		const result = cli(fixture());
		assert.equal(result.code, 0, result.stdout);
		assert.match(result.stdout, /agent\/keys\.json\tabsent/);
	});
});

describe("config schema: a misspelled key fails with the suggestion", () => {
	test("top level: defaultProvder → defaultProvider", () => {
		const { defaultProvider, ...rest } = VALID_SETTINGS;
		const result = cli(fixture({ settings: { ...rest, defaultProvder: defaultProvider } }));
		assert.equal(result.code, 1);
		const fail = result.lines.find((line) => line.status === "FAIL");
		assert.equal(fail.where, "agent/settings.json: defaultProvder");
		assert.match(fail.message, /unknown top-level key/);
		assert.match(fail.message, /did you mean "defaultProvider"\?/);
	});

	test("inside a provider: maxTokns → maxTokens", () => {
		const models = structuredClone(VALID_MODELS);
		const model = models.providers.ollama.models[0];
		model.maxTokns = model.maxTokens;
		delete model.maxTokens;
		const result = cli(fixture({ models }));
		assert.equal(result.code, 1);
		const fail = result.lines.find((line) => line.status === "FAIL");
		assert.equal(fail.where, "agent/models.json: providers.ollama.models[0].maxTokns");
		assert.match(fail.message, /did you mean "maxTokens"\?/);
	});

	test("the suggestion only fires for a key one edit away", () => {
		assert.equal(didYouMean("defaultProvder", ["defaultProvider", "theme"]), "defaultProvider");
		assert.equal(didYouMean("directoryOfEverything", ["defaultModel", "theme"]), null);
		assert.equal(editDistance("modle", "model"), 1, "a swapped pair is one edit");
	});
});

describe("config schema: a wrong-typed value fails", () => {
	test('hideThinkingBlock: "yes" is not a boolean', () => {
		const result = cli(fixture({ settings: { ...VALID_SETTINGS, hideThinkingBlock: "yes" } }));
		assert.equal(result.code, 1);
		const fail = result.lines.find((line) => line.status === "FAIL");
		assert.equal(fail.where, "agent/settings.json: hideThinkingBlock");
		assert.match(fail.message, /expected boolean, found string/);
	});

	test("a route without a provider is not a route", () => {
		const settings = structuredClone(VALID_SETTINGS);
		delete settings["observational-memory"].models.observer.provider;
		const result = cli(fixture({ settings }));
		assert.equal(result.code, 1);
		const fail = result.lines.find((line) => line.status === "FAIL");
		assert.equal(fail.where, "agent/settings.json: observational-memory.models.observer.provider");
		assert.match(fail.message, /missing required key: expected string/);
	});

	test('maxTokens must be a number, not the string "384000"', () => {
		const models = structuredClone(VALID_MODELS);
		models.providers.ollama.models[0].maxTokens = "384000";
		const result = cli(fixture({ models }));
		assert.equal(result.code, 1);
		const fail = result.lines.find((line) => line.status === "FAIL");
		assert.equal(fail.where, "agent/models.json: providers.ollama.models[0].maxTokens");
		assert.match(fail.message, /expected number, found string/);
	});
});

describe("config schema: keys.json is validated without reading a value out loud", () => {
	test("a key value never reaches the output", () => {
		const dir = fixture({ keys: { deepseek: FIXTURE_VALUE } });
		const result = cli(dir);
		assert.equal(result.stdout.includes(FIXTURE_VALUE), false, "the value must not be printed");
		const check = harnessCheck(dir);
		assert.equal(check.stdout.includes(FIXTURE_VALUE), false, "harness-check must not print it either");
	});

	test("a non-string key value fails on the shape, not the content", () => {
		const dir = fixture({ keys: { deepseek: 42 } });
		const result = cli(dir);
		assert.equal(result.code, 1);
		const fail = result.lines.find((line) => line.status === "FAIL");
		assert.equal(fail.where, "agent/keys.json: deepseek");
		assert.equal(fail.message.includes("42"), false, "the value stays out of the message");
		assert.match(fail.message, /expected string, found integer/);
	});

	test("the keys schema refuses an empty key", () => {
		const issues = validateValue({ deepseek: "" }, keysSchema);
		assert.equal(issues.length, 1);
		assert.match(issues[0].message, /expected 1 or more characters/);
	});
});

describe("config schema: harness-check --verify-config", () => {
	test("a valid fixture passes with exit 0", () => {
		const run = harnessCheck(fixture());
		assert.equal(run.status, 0, run.stdout);
		assert.match(run.stdout, /PASS config-schema\s+agent\/settings\.json\s+shape ok/);
	});

	test("a broken fixture FAILs with file, path and expectation, exit 1", () => {
		const { defaultProvider, ...rest } = VALID_SETTINGS;
		const run = harnessCheck(fixture({ settings: { ...rest, defaultProvder: defaultProvider } }));
		assert.equal(run.status, 1, run.stdout);
		assert.match(
			run.stdout,
			/FAIL config-schema\s+agent\/settings\.json: defaultProvder\s+unknown top-level key; did you mean "defaultProvider"\?/,
		);
	});

	test("the normal run carries the check too", () => {
		const file = readFileSync(CHECK, "utf8");
		const tail = file.slice(file.indexOf('section "config — things an install step sets"'));
		assert.match(tail, /check_config_schema/, "the check must run outside --verify-config as well");
	});
});

describe("config schema: the guard and the gate print one sentence", () => {
	test("the session-start notice is the line harness-check FAILs with", async () => {
		const { defaultProvider, ...rest } = VALID_SETTINGS;
		const dir = fixture({ settings: { ...rest, defaultProvder: defaultProvider } });
		const fail = cli(dir).lines.find((line) => line.status === "FAIL");

		const fake = createFakePi();
		configGuard(fake.pi);
		const { ctx, notices } = createFakeCtx({ hasUI: true });
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await fake.emit("session_start", { reason: "startup" }, ctx);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}

		assert.equal(notices.length, 1, JSON.stringify(notices));
		assert.equal(notices[0].message, `config: ${fail.where} — ${fail.message}`);
	});
});
