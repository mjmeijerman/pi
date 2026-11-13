/**
 * pi-master-guard: the delegation workspace does not edit files.
 *
 * The decision function is pure and tested directly; the handler is exercised through the
 * fake pi/context so both the block and the "does nothing outside the workspace" property
 * are covered. That second property matters more than the block: this extension is global,
 * and every other project must keep write and edit.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../pi-master-guard.ts");
const piMasterGuard = mod.default;
const { shellWriteReason } = mod;

const WORKSPACE = "/home/mark/pi-master";
const PROJECT = "/home/mark/projects/bakmark";

function setup(cwd: string) {
	const fake = createFakePi();
	piMasterGuard(fake.pi);
	const { ctx, notices } = createFakeCtx({ cwd });
	return { ...fake, ctx, notices };
}

/** Fire a tool call in `cwd`; returns the extension's result (undefined means allowed). */
async function run(toolName: string, input: Record<string, unknown>, cwd = WORKSPACE) {
	const { emit, ctx, notices } = setup(cwd);
	const [result] = await emit("tool_call", { toolName, input }, ctx);
	return { result, notices };
}

describe("pi-master-guard: shell writes", () => {
	const blocked = [
		"echo probe > /home/mark/pi-master/probe.txt",
		"echo probe >> ~/pi-master/reports/x.md",
		"rm -f ~/pi-master/specs/x.md",
		"mv /home/mark/pi-master/a /tmp/b",
		"cp /tmp/a /home/mark/pi-master/specs/b.md",
		"tee /home/mark/pi-master/notes.md < /tmp/x",
		"sed -i 's/a/b/' /home/mark/pi-master/AGENTS.md",
		"chmod -x /home/mark/pi-master/bin/guard",
	];

	for (const command of blocked) {
		test(`blocks \`${command}\``, () => {
			assert.ok(shellWriteReason(command), `expected a reason for: ${command}`);
		});
	}

	const allowed = [
		"cat /home/mark/pi-master/reports/x.md",
		"ls ~/pi-master/state",
		"grep -rn jev ~/pi-master/bin",
		"git -C /home/mark/pi-master status",
		'delegate spawn fix-login --cwd /home/mark/projects/bakmark "fix the login"',
		'jev mode "write /home/mark/pi-master/x"',
		'hc send t3t "rm -rf /home/mark/pi-master"',
		"npm test",
		"echo hello > /tmp/not-the-workspace.txt",
	];

	for (const command of allowed) {
		test(`allows \`${command}\``, () => {
			assert.equal(shellWriteReason(command), null, `unexpected block: ${command}`);
		});
	}
});

describe("pi-master-guard: tool calls", () => {
	const deniedTools = ["write", "edit"];

	for (const toolName of deniedTools) {
		test(`blocks the ${toolName} tool inside the workspace`, async () => {
			const { result, notices } = await run(toolName, { path: `${WORKSPACE}/probe.txt`, content: "x" });
			assert.equal(result?.block, true, `${toolName} should be blocked`);
			assert.match(result.reason, /only delegates/);
			assert.equal(notices.at(-1)?.level, "warning");
		});

		test(`allows the ${toolName} tool outside the workspace`, async () => {
			const { result } = await run(toolName, { path: `${PROJECT}/src/x.ts`, content: "x" }, PROJECT);
			assert.equal(result, undefined, `${toolName} must stay available in project sessions`);
		});
	}

	test("blocks a shell write into the workspace", async () => {
		const { result } = await run("bash", { command: "echo probe > /home/mark/pi-master/probe.txt" });
		assert.equal(result?.block, true);
		assert.match(result.reason, /shell write/);
	});

	test("allows a shell read of the workspace", async () => {
		const { result } = await run("bash", { command: "cat /home/mark/pi-master/reports/x.md" });
		assert.equal(result, undefined);
	});

	test("allows bash entirely outside the workspace", async () => {
		const { result } = await run("bash", { command: "rm -rf build" }, PROJECT);
		assert.equal(result, undefined);
	});

	// A subdirectory of the workspace is still the workspace.
	test("covers a subdirectory of the workspace", async () => {
		const { result } = await run("write", { path: `${WORKSPACE}/specs/x.md`, content: "x" }, `${WORKSPACE}/specs`);
		assert.equal(result?.block, true);
	});

	// /home/mark/pi-master-notes is not the workspace; a prefix check that forgot the
	// separator would block it, and the person's other folders must stay usable.
	test("does not match a sibling with the same prefix", async () => {
		const { result } = await run("write", { path: "/home/mark/pi-master-notes/x.md", content: "x" }, "/home/mark/pi-master-notes");
		assert.equal(result, undefined);
	});
});
