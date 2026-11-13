/**
 * cost-optimizer: frontmatter stripping, fallback rules, system-prompt injection.
 *
 * SKILL_PATH is read from COST_OPTIMIZER_SKILL at module load, so each case
 * imports a fresh copy of the module with the env var pointing at a fixture.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-cost-optimizer-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;

/** Load the extension against a specific SKILL.md (or a deliberately bad path). */
async function loadWithSkill(skillPath: string | undefined) {
	if (skillPath === undefined) delete process.env.COST_OPTIMIZER_SKILL;
	else process.env.COST_OPTIMIZER_SKILL = skillPath;
	const mod = await import(`../cost-optimizer.ts?v=${counter++}`);
	const fake = createFakePi();
	mod.default(fake.pi);
	const { ctx } = createFakeCtx();
	return { ...fake, ctx };
}

/** Run `before_agent_start` and return the injected system prompt. */
async function promptFor(skillPath: string | undefined, base = "BASE"): Promise<string> {
	const { emit, ctx } = await loadWithSkill(skillPath);
	const [result] = await emit("before_agent_start", { systemPrompt: base }, ctx);
	return result.systemPrompt;
}

function writeSkill(name: string, content: string): string {
	const file = join(dir, name);
	writeFileSync(file, content);
	return file;
}

describe("frontmatter stripping", () => {
	test("strips a leading YAML frontmatter block", async () => {
		const file = writeSkill("with-frontmatter.md", "---\nname: cost-optimizer\ndescription: rules\n---\n\nBody line.\n");
		const prompt = await promptFor(file);
		assert.ok(prompt.includes("Body line."));
		assert.ok(!prompt.includes("name: cost-optimizer"));
		assert.ok(!prompt.includes("---"));
	});

	test("strips CRLF frontmatter", async () => {
		const file = writeSkill("crlf.md", "---\r\nname: cost-optimizer\r\n---\r\nBody CRLF.\r\n");
		const prompt = await promptFor(file);
		assert.ok(prompt.includes("Body CRLF."));
		assert.ok(!prompt.includes("name: cost-optimizer"));
	});

	test("keeps content that has no frontmatter", async () => {
		const file = writeSkill("plain.md", "Just rules.\nNo frontmatter here.\n");
		const prompt = await promptFor(file);
		assert.ok(prompt.includes("Just rules."));
		assert.ok(prompt.includes("No frontmatter here."));
	});

	test("an unterminated frontmatter block is left alone", async () => {
		const file = writeSkill("unterminated.md", "---\nname: cost-optimizer\nBody stays.\n");
		const prompt = await promptFor(file);
		assert.ok(prompt.includes("name: cost-optimizer"));
	});

	test("frontmatter in the middle of the file is not stripped", async () => {
		const file = writeSkill("mid.md", "Intro.\n---\nname: nope\n---\nOutro.\n");
		const prompt = await promptFor(file);
		assert.ok(prompt.includes("Intro."));
		assert.ok(prompt.includes("name: nope"));
	});
});

describe("fallback rules", () => {
	test("uses the built-in fallback when SKILL.md is missing", async () => {
		const prompt = await promptFor(join(dir, "does-not-exist.md"));
		assert.ok(prompt.includes("Goal: same professional result, fewest tokens."));
		assert.ok(prompt.includes("Quality is non-negotiable"));
	});

	test("uses the fallback when SKILL.md is unreadable (a directory)", async () => {
		const badPath = join(dir, "a-directory");
		mkdirSync(badPath, { recursive: true });
		const prompt = await promptFor(badPath);
		assert.ok(prompt.includes("Goal: same professional result, fewest tokens."));
	});

	test("uses the fallback when the skill path is unset and the real skill is absent from HOME", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-cost-home-"));
		process.env.HOME = fakeHome;
		try {
			const prompt = await promptFor(undefined);
			assert.ok(prompt.includes("Goal: same professional result, fewest tokens."));
		} finally {
			process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

describe("system prompt injection", () => {
	test("appends the rules to the existing system prompt", async () => {
		const file = writeSkill("inject.md", "Rule A.\n");
		const prompt = await promptFor(file, "BASE PROMPT");
		assert.ok(prompt.startsWith("BASE PROMPT\n\n# Cost Optimizer (always active)\n\n"));
		assert.ok(prompt.includes("Rule A."));
	});

	test("loads the rules once and caches them", async () => {
		const file = writeSkill("cached.md", "First version.\n");
		const { emit, ctx } = await loadWithSkill(file);
		const [first] = await emit("before_agent_start", { systemPrompt: "B" }, ctx);
		assert.ok(first.systemPrompt.includes("First version."));

		writeFileSync(file, "Second version.\n");
		const [second] = await emit("before_agent_start", { systemPrompt: "B" }, ctx);
		assert.ok(second.systemPrompt.includes("First version."), "rules are cached after the first load");
		assert.ok(!second.systemPrompt.includes("Second version."));
	});

	test("the default skill path is <home>/.pi/agent/skills/cost-optimizer/SKILL.md", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-cost-home2-"));
		const skillDir = join(home, ".pi", "agent", "skills", "cost-optimizer");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: cost-optimizer\n---\nSkill body.\n");
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const prompt = await promptFor(undefined);
			assert.ok(prompt.includes("Skill body."));
			assert.ok(!prompt.includes("name: cost-optimizer"));
		} finally {
			process.env.HOME = realHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});
