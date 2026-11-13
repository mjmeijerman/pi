/**
 * big-boss-pi-guard: the delegation workspace is not for direct edits.
 *
 * Both guarded roots are exercised: the live tree and the rollback copy. The
 * decision functions are pure and tested directly; the handler is fired through
 * the fake pi/context so the block and the cwd gate are covered too.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../big-boss-pi-guard.ts");
const bigBossPiGuard = mod.default;
const { insideGuarded, shellWriteReason, GUARDED_ROOTS } = mod;

function setup(cwd: string) {
	const fake = createFakePi();
	bigBossPiGuard(fake.pi);
	const { ctx, notices } = createFakeCtx({ cwd });
	return { ...fake, ctx, notices };
}

describe("big-boss-pi-guard: which paths are guarded", () => {
	test("both trees, and everything inside them", () => {
		assert.deepEqual(GUARDED_ROOTS, ["/home/mark/big-boss-pi", "/home/mark/pi-master"]);
		assert.equal(insideGuarded("/home/mark/big-boss-pi"), true);
		assert.equal(insideGuarded("/home/mark/big-boss-pi/state/delegations.json"), true);
		assert.equal(insideGuarded("/home/mark/pi-master/bin/delegate"), true);
	});

	test("a sibling with the same prefix is not guarded", () => {
		assert.equal(insideGuarded("/home/mark/big-boss-pi-evil/x"), false);
		assert.equal(insideGuarded("/home/mark/pi-master2/x"), false);
		assert.equal(insideGuarded("/home/mark/projects/app"), false);
	});
});

describe("big-boss-pi-guard: shell writes", () => {
	const cwd = "/home/mark/big-boss-pi";

	test("a redirect into either tree is a write", () => {
		assert.match(shellWriteReason("echo hi > state/x.json", cwd) ?? "", /redirect/);
		assert.match(shellWriteReason("echo hi >> /home/mark/pi-master/state/x", cwd) ?? "", /redirect/);
		assert.match(shellWriteReason("echo hi > ~/big-boss-pi/state/x", cwd) ?? "", /redirect/);
	});

	test("write verbs on a path there are writes", () => {
		assert.match(shellWriteReason("rm -rf /home/mark/big-boss-pi/specs", cwd) ?? "", /rm/);
		assert.match(shellWriteReason("cp a.md /home/mark/pi-master/reports/b.md", cwd) ?? "", /cp/);
		assert.match(shellWriteReason("sed -i 's/a/b/' state/decisions.jsonl", cwd) ?? "", /sed/);
		assert.match(shellWriteReason("chmod +x bin/finish-rename.sh", cwd) ?? "", /chmod/);
	});

	test("reading is not a write", () => {
		assert.equal(shellWriteReason("grep -rn pi-master bin", cwd), null);
		assert.equal(shellWriteReason("cat /home/mark/pi-master/README.md", cwd), null);
		assert.equal(shellWriteReason("delegate list", cwd), null);
		assert.equal(shellWriteReason("herdr-app ls", cwd), null);
	});

	test("writes elsewhere are none of its business", () => {
		assert.equal(shellWriteReason("rm -rf /tmp/scratch", cwd), null);
		assert.equal(shellWriteReason("echo hi > /tmp/x", cwd), null);
	});
});

describe("big-boss-pi-guard: the handler", () => {
	test("write and edit are blocked inside the workspace", async () => {
		const { emit, ctx, notices } = setup("/home/mark/big-boss-pi");
		for (const toolName of ["write", "edit"]) {
			const [result] = await emit("tool_call", { toolName, input: { path: "x.md" } }, ctx);
			assert.equal(result?.block, true, `${toolName} should be blocked`);
		}
		assert.match(notices[0].message, /delegation/);
	});

	test("a shell write into the rollback copy is blocked too", async () => {
		const { emit, ctx } = setup("/home/mark/big-boss-pi");
		const [result] = await emit("tool_call", { toolName: "bash", input: { command: "rm -rf /home/mark/pi-master/state" } }, ctx);
		assert.equal(result?.block, true);
		assert.match(result.reason, /pi-master/);
	});

	test("nothing is blocked when the cwd is outside the workspace", async () => {
		const { emit, ctx } = setup("/home/mark/projects/app");
		assert.equal((await emit("tool_call", { toolName: "write", input: { path: "x.md" } }, ctx))[0], undefined);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "echo x > state/y" } }, ctx))[0], undefined);
	});

	test("reading tools and read-only commands pass inside the workspace", async () => {
		const { emit, ctx } = setup("/home/mark/big-boss-pi");
		assert.equal((await emit("tool_call", { toolName: "read", input: { path: "AGENTS.md" } }, ctx))[0], undefined);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "delegate list" } }, ctx))[0], undefined);
	});
});
