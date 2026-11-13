/**
 * feedback-flywheel: redaction before write, aggregation, and the two commands.
 *
 * The extension writes to `<agent-dir>/suggestions.jsonl`; PI_CODING_AGENT_DIR
 * points that at a temp directory so the real log is never touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-flywheel-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const mod = await import("../feedback-flywheel.ts");
const feedbackFlywheel = mod.default;
const { aggregate, redact } = mod;

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function setup() {
	const fake = createFakePi();
	feedbackFlywheel(fake.pi);
	const { ctx, notices } = createFakeCtx();
	return { ...fake, ctx, notices };
}

function logPath(): string {
	return join(agentDir, "suggestions.jsonl");
}

describe("feedback-flywheel: redaction", () => {
	test("strips credential-shaped values", () => {
		const key = "AKIA" + "1234567890ABCDEF";
		const token = "ghp_" + "0123456789abcdefghijABCD";
		const out = redact(`aws=${key} token ${token} password: "hunter2hunter2"`);
		assert.ok(!out.includes(key));
		assert.ok(!out.includes(token));
		assert.ok(!out.includes("hunter2hunter2"));
	});

	test("leaves ordinary text alone", () => {
		const text = "npm test failed: 3 assertions in checkout.spec.ts";
		assert.equal(redact(text), text);
	});
});

describe("feedback-flywheel: aggregation", () => {
	test("groups by signature, most frequent first", () => {
		const groups = aggregate([
			{ ts: "2026-11-01T00:00:00.000Z", kind: "tool-error", signature: "aaa", tool: "bash", message: "boom" },
			{ ts: "2026-11-02T00:00:00.000Z", kind: "tool-error", signature: "aaa", tool: "bash", message: "boom" },
			{ ts: "2026-11-03T00:00:00.000Z", kind: "note", signature: "bbb", message: "slow harness" },
		]);
		assert.equal(groups.length, 2);
		assert.equal(groups[0].signature, "aaa");
		assert.equal(groups[0].count, 2);
		assert.equal(groups[0].first, "2026-11-01T00:00:00.000Z");
		assert.equal(groups[0].last, "2026-11-02T00:00:00.000Z");
		assert.equal(groups[1].tool, "-");
	});
});

describe("feedback-flywheel: recording", () => {
	test("a failed tool result is appended, a successful one is not", async () => {
		rmSync(logPath(), { force: true });
		const { emit, ctx } = setup();

		await emit(
			"tool_result",
			{ toolName: "bash", isError: true, input: { command: "ls missing" }, content: [{ type: "text", text: "ls: cannot access" }] },
			ctx,
		);
		await emit(
			"tool_result",
			{ toolName: "bash", isError: false, input: { command: "ls" }, content: [{ type: "text", text: "ok" }] },
			ctx,
		);

		const lines = readFileSync(logPath(), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]);
		assert.equal(entry.kind, "tool-error");
		assert.equal(entry.tool, "bash");
		assert.match(entry.message, /cannot access/);
	});

	test("the same failure inside the dedupe window is recorded once", async () => {
		rmSync(logPath(), { force: true });
		const { emit, ctx } = setup();
		const event = {
			toolName: "read",
			isError: true,
			input: { path: "nope.md" },
			content: [{ type: "text", text: "ENOENT" }],
		};
		await emit("tool_result", event, ctx);
		await emit("tool_result", event, ctx);
		const lines = readFileSync(logPath(), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
	});

	test("/suggest records a note", async () => {
		rmSync(logPath(), { force: true });
		const { commands, ctx } = setup();
		const command = commands.get("suggest");
		assert.ok(command, "/suggest must be registered");
		await command.handler("the sandbox hid the credential store", ctx);
		const entry = JSON.parse(readFileSync(logPath(), "utf8").trim());
		assert.equal(entry.kind, "note");
		assert.match(entry.message, /credential store/);
	});

	test("/retro writes a dated report and refuses an empty log", async () => {
		rmSync(logPath(), { force: true });
		const { commands, ctx, notices } = setup();
		const command = commands.get("retro");

		await command.handler("", ctx);
		assert.match(notices.map((n) => n.message).join("\n"), /No recorded problems yet/);
		assert.equal(existsSync(join(agentDir, "retro")), false);

		await commands.get("suggest").handler("stale dependency broke the build", ctx);
		await command.handler("", ctx);
		const day = new Date().toISOString().slice(0, 10);
		const report = readFileSync(join(agentDir, "retro", `${day}.md`), "utf8");
		assert.match(report, /Harness retro/);
		assert.match(report, /stale dependency broke the build/);
		assert.match(report, /Delete rules/);
	});

	test("/retro --propose asks the agent for diffs", async () => {
		rmSync(logPath(), { force: true });
		const { commands, ctx, sentMessages } = setup();
		await commands.get("suggest").handler("agent ignored the repo conventions", ctx);
		await commands.get("retro").handler("--propose", ctx);
		assert.equal(sentMessages.length, 1);
		assert.match(sentMessages[0].text, /AGENTS\.md/);
		assert.match(sentMessages[0].text, /deleting/);
	});
});
