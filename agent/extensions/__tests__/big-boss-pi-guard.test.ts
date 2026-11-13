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
const { insideGuarded, shellWriteReason, GUARDED_ROOTS, workerSession, delegationPath, DELEGATION_DIRS } =
	mod;

function setup(cwd: string) {
	const fake = createFakePi();
	bigBossPiGuard(fake.pi);
	const { ctx, notices } = createFakeCtx({ cwd });
	return { ...fake, ctx, notices };
}

/** Run `body` with PI_WORKER set, then put the environment back exactly as it was. */
async function asWorker(body: () => Promise<void>): Promise<void> {
	const before = process.env.PI_WORKER;
	process.env.PI_WORKER = "1";
	try {
		await body();
	} finally {
		if (before === undefined) delete process.env.PI_WORKER;
		else process.env.PI_WORKER = before;
	}
}

/** Run `body` with PI_WORKER absent (the boss session), then restore the environment. */
async function asBoss(body: () => Promise<void>): Promise<void> {
	const before = process.env.PI_WORKER;
	delete process.env.PI_WORKER;
	try {
		await body();
	} finally {
		if (before !== undefined) process.env.PI_WORKER = before;
	}
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
		assert.match(shellWriteReason("rm -rf /home/mark/big-boss-pi/state", cwd) ?? "", /rm/);
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

describe("big-boss-pi-guard: worker sessions", () => {
	test("PI_WORKER marks a delegated worker", () => {
		for (const value of ["1", "true", "yes", " 1 ", "TRUE"]) {
			assert.equal(workerSession({ PI_WORKER: value }), true, `PI_WORKER=${JSON.stringify(value)}`);
		}
	});

	test("unset, empty, 0 and false are the boss session", () => {
		assert.equal(workerSession({}), false);
		assert.equal(workerSession({ PI_WORKER: "" }), false);
		assert.equal(workerSession({ PI_WORKER: "0" }), false);
		assert.equal(workerSession({ PI_WORKER: "false" }), false);
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

	test("a worker session writes and redirects inside the workspace, no block, no notice", async () => {
		await asWorker(async () => {
			const { emit, ctx, notices } = setup("/home/mark/big-boss-pi");
			assert.equal((await emit("tool_call", { toolName: "write", input: { path: "x.md" } }, ctx))[0], undefined);
			assert.equal((await emit("tool_call", { toolName: "edit", input: { path: "x.md" } }, ctx))[0], undefined);
			assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "echo x > state/y" } }, ctx))[0], undefined);
			assert.deepEqual(notices, []);
		});
	});

	test("the boss session still blocks write, edit and a redirect", async () => {
		await asBoss(async () => {
			const { emit, ctx } = setup("/home/mark/big-boss-pi");
			const calls: { toolName: string; input: any }[] = [
				{ toolName: "write", input: { path: "x.md" } },
				{ toolName: "edit", input: { path: "x.md" } },
				{ toolName: "bash", input: { command: "echo x > state/y" } },
			];
			for (const call of calls) {
				const [result] = await emit("tool_call", call, ctx);
				assert.equal(result?.block, true, `${call.toolName} should stay blocked for the boss`);
			}
		});
	});
});

/**
 * The second false positive: a worker could not write the report it is started to write,
 * because the guard blocked every write inside the workspace. Reports and specs belong to
 * the delegation flow and are carved out; everything else stays blocked.
 */
describe("big-boss-pi-guard: the delegation directories", () => {
	const cwd = "/home/mark/big-boss-pi";

	test("only reports and specs are carved out", () => {
		assert.deepEqual(DELEGATION_DIRS, ["reports", "specs"]);
		assert.equal(delegationPath("/home/mark/big-boss-pi/reports/guard-x.md"), true);
		assert.equal(delegationPath("/home/mark/big-boss-pi/specs/guard-x.md"), true);
		assert.equal(delegationPath("/home/mark/big-boss-pi/state/decisions.jsonl"), false);
		assert.equal(delegationPath("/home/mark/big-boss-pi/bin/delegate"), false);
		assert.equal(delegationPath("/home/mark/big-boss-pi/reportsevil/x.md"), false);
		// the rollback copy is not the flow's, so it keeps the whole tree read-only
		assert.equal(delegationPath("/home/mark/pi-master/reports/x.md"), false);
		assert.equal(delegationPath(""), false);
	});

	test("the shell write function ignores reports and specs", () => {
		assert.equal(shellWriteReason("echo hi > reports/x.md", cwd), null);
		assert.equal(shellWriteReason("echo hi >> /home/mark/big-boss-pi/specs/x.md", cwd), null);
		assert.match(shellWriteReason("echo hi > state/x.json", cwd) ?? "", /state\/x\.json/);
	});

	test("a write tool into reports is not blocked", async () => {
		await asBoss(async () => {
			const { emit, ctx, notices } = setup(cwd);
			const [result] = await emit(
				"tool_call",
				{ toolName: "write", input: { path: "/home/mark/big-boss-pi/reports/guard-x.md", content: "# report" } },
				ctx,
			);
			assert.equal(result, undefined);
			assert.deepEqual(notices, []);
		});
	});

	test("an edit of an existing report is not blocked", async () => {
		await asBoss(async () => {
			const { emit, ctx } = setup(cwd);
			const [result] = await emit(
				"tool_call",
				{ toolName: "edit", input: { path: "reports/guard-x.md", oldText: "a", newText: "b" } },
				ctx,
			);
			assert.equal(result, undefined);
		});
	});

	test("a redirect into specs is not blocked", async () => {
		await asBoss(async () => {
			const { emit, ctx, notices } = setup(cwd);
			const [result] = await emit("tool_call", { toolName: "bash", input: { command: "echo x > specs/guard-x.md" } }, ctx);
			assert.equal(result, undefined);
			assert.deepEqual(notices, []);
		});
	});

	test("a write into state/ is blocked", async () => {
		await asBoss(async () => {
			const { emit, ctx } = setup(cwd);
			const calls = [
				{ toolName: "write", input: { path: "state/delegations.json" } },
				{ toolName: "bash", input: { command: "echo x > state/y" } },
			];
			for (const call of calls) {
				const [result] = await emit("tool_call", call, ctx);
				assert.equal(result?.block, true, `${call.toolName} into state must stay blocked`);
			}
		});
	});

	test("a write into bin/ is blocked", async () => {
		await asBoss(async () => {
			const { emit, ctx } = setup(cwd);
			const calls = [
				{ toolName: "write", input: { path: "bin/pi-bare" } },
				{ toolName: "edit", input: { path: "/home/mark/big-boss-pi/bin/delegate", oldText: "a", newText: "b" } },
				{ toolName: "bash", input: { command: "cp /tmp/x bin/pi-bare" } },
			];
			for (const call of calls) {
				const [result] = await emit("tool_call", call, ctx);
				assert.equal(result?.block, true, `${call.toolName} into bin must stay blocked`);
			}
		});
	});

	test("a worker still writes everywhere, the carve-out is for the boss too", async () => {
		await asWorker(async () => {
			const { emit, ctx } = setup(cwd);
			assert.equal((await emit("tool_call", { toolName: "write", input: { path: "state/x" } }, ctx))[0], undefined);
			assert.equal((await emit("tool_call", { toolName: "write", input: { path: "reports/x.md" } }, ctx))[0], undefined);
		});
	});
});
