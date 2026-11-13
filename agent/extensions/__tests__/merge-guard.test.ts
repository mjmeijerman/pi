/**
 * merge-guard: an agent may not land a change on its own.
 *
 * The decision function is pure and tested directly; the handler is exercised
 * through the fake pi/context so the block, the one-shot allowance and the
 * session reset are all covered.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../merge-guard.ts");
const mergeGuard = mod.default;
const { mergeReason } = mod;

function setup() {
	const fake = createFakePi();
	mergeGuard(fake.pi);
	const { ctx, notices } = createFakeCtx();
	return { ...fake, ctx, notices };
}

async function run(command: string) {
	const { emit, ctx } = setup();
	const [result] = await emit("tool_call", { toolName: "bash", input: { command } }, ctx);
	return result;
}

describe("merge-guard: decision", () => {
	const blocked = [
		["gh pr merge 4 --squash --delete-branch", "gh pr merge"],
		["gh pr merge --admin", "gh pr merge"],
		["gh  pr   merge 4", "gh pr merge"],
		["git push origin trunk", "trunk"],
		["git push -u origin HEAD:main", "trunk"],
		["git push --force-with-lease origin master", "trunk"],
		["gh api -X PUT repos/o/r/pulls/4/merge", "merge API"],
		["gh api repos/o/r/pulls/4/merges -X POST", "merge API"],
	];

	for (const [command, why] of blocked) {
		test(`blocks \`${command}\` (${why})`, () => {
			assert.ok(mergeReason(command), `expected a reason for: ${command}`);
		});
	}

	const allowed = [
		"gh pr create --base trunk --title t",
		"gh pr view 4",
		"gh pr checks 4",
		"gh pr diff 4",
		"git status",
		"git switch -c feat/x",
		"git commit -m 'feat: x'",
		"git push -u origin feat/x",
		"git push origin HEAD:feat/x",
		"git log --oneline trunk..HEAD",
		"git fetch origin trunk",
		"git push --dry-run origin trunk",
		"gh pr merge --help",
		`echo "gh pr merge 4"`,
		`git commit -m 'never git push origin trunk'`,
		"npm test",
	];

	for (const command of allowed) {
		test(`allows \`${command}\``, () => {
			assert.equal(mergeReason(command), null, `unexpected block: ${command}`);
		});
	}
});

describe("merge-guard: handler", () => {
	test("a merge command is blocked, not run", async () => {
		const result = await run("gh pr merge 1 --squash");
		assert.equal(result?.block, true);
		assert.match(result.reason, /user's explicit go-ahead/);
	});

	test("an ordinary command passes through untouched", async () => {
		assert.equal(await run("git push -u origin feat/x"), undefined);
	});

	test("/mergeguard allow unlocks exactly one merge", async () => {
		const { emit, ctx, commands, notices } = setup();
		const command = commands.get("mergeguard");
		assert.ok(command, "/mergeguard must be registered");

		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);

		await command.handler("allow", ctx);
		assert.match(notices.at(-1).message, /will run once/);

		assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx)[0], undefined);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("the allowance survives unrelated commands and is spent by the merge", async () => {
		const { emit, ctx, commands } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		await emit("tool_call", { toolName: "bash", input: { command: "git status" } }, ctx);
		await emit("tool_call", { toolName: "bash", input: { command: "git push -u origin feat/x" } }, ctx);
		// still allowed: the approval was for the merge, not for these
		assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "git push origin trunk" } }, ctx)[0], undefined);
		// and now it is gone
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("a new session revokes the allowance", async () => {
		const { emit, ctx, commands } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		await emit("session_start", {}, ctx);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("/mergeguard status reports the state", async () => {
		const { ctx, commands, notices } = setup();
		await commands.get("mergeguard").handler("", ctx);
		assert.match(notices.at(-1).message, /merges blocked/);
		await commands.get("mergeguard").handler("allow", ctx);
		await commands.get("mergeguard").handler("status", ctx);
		assert.match(notices.at(-1).message, /one merge allowed/);
	});

	test("non-bash tools are ignored", async () => {
		const { emit, ctx } = setup();
		const [result] = await emit("tool_call", { toolName: "write", input: { path: "notes.md", content: "gh pr merge 1" } }, ctx);
		assert.equal(result, undefined);
	});
});
