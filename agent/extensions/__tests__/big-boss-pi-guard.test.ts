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
		await asBoss(async () => {
			const { emit, ctx, notices } = setup("/home/mark/big-boss-pi");
			for (const toolName of ["write", "edit"]) {
				const [result] = await emit("tool_call", { toolName, input: { path: "x.md" } }, ctx);
				assert.equal(result?.block, true, `${toolName} should be blocked`);
			}
			assert.match(notices[0].message, /delegation/);
		});
	});

	test("a shell write into the rollback copy is blocked too", async () => {
		await asBoss(async () => {
			const { emit, ctx } = setup("/home/mark/big-boss-pi");
			const [result] = await emit("tool_call", { toolName: "bash", input: { command: "rm -rf /home/mark/pi-master/state" } }, ctx);
			assert.equal(result?.block, true);
			assert.match(result.reason, /pi-master/);
		});
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

/**
 * Bug A: the word `install` armed the write scan wherever it appeared, so a read-only
 * command that merely mentioned it (`echo install /path`) was blocked as a write.
 * Bug B: the `>` in a JavaScript arrow function matched the redirect detector, so a
 * `node -e` with an arrow was blocked as a redirect into the session cwd.
 */
describe("big-boss-pi-guard: false positives (bug A: verb in argument position, bug B: arrow as redirect)", () => {
	const cwd = "/home/mark/big-boss-pi";

	test("bug A: install as an argument does not arm the path scan", () => {
		assert.equal(shellWriteReason("echo install /home/mark/big-boss-pi/bin/jev", cwd), null);
		assert.equal(shellWriteReason("rg 'install' /home/mark/big-boss-pi/bin", cwd), null);
		assert.equal(shellWriteReason("grep -rn install /home/mark/big-boss-pi/bin", cwd), null);
		assert.equal(shellWriteReason("ls /home/mark/pi-master/bin | grep install", cwd), null);
		assert.equal(shellWriteReason("echo rm cp mv /home/mark/big-boss-pi/state", cwd), null);
	});

	test("bug A: a write verb in command position still arms the path scan", () => {
		const cases: [string, RegExp][] = [
			["install -m 644 /tmp/x /home/mark/big-boss-pi/bin/y", /install/],
			["sudo -E rm -rf /home/mark/big-boss-pi/state", /rm/],
			["env FOO=1 mkdir /home/mark/big-boss-pi/state/new", /mkdir/],
			["nohup mv a.md /home/mark/big-boss-pi/state/b.md", /mv/],
			["time cp a.md /home/mark/big-boss-pi/state/c.md", /cp/],
			["command tee /home/mark/big-boss-pi/state/x", /tee/],
			["xargs rm -f /home/mark/pi-master/state/x", /rm/],
			["bash -c 'rm -rf /home/mark/big-boss-pi/state'", /rm/],
			["sed -i 's/a/b/' /home/mark/big-boss-pi/state/x", /sed/],
		];
		for (const [command, expected] of cases) {
			assert.match(shellWriteReason(command, cwd) ?? "", expected, command);
		}
	});

	test("bug B: an arrow function is not a shell redirect", () => {
		assert.equal(shellWriteReason("node -e 'const f = (x) => x; console.log(f(1))'", cwd), null);
		assert.equal(shellWriteReason("node -e 'console.log([1,2].map((n) => n * 2))'", cwd), null);
		assert.equal(shellWriteReason("perl -e '$x->{a} = 1'", cwd), null);
	});

	test("bug B: a real redirect is still blocked, even next to an arrow", () => {
		assert.match(shellWriteReason("echo hi > state/x.json", cwd) ?? "", /redirect/);
		assert.match(shellWriteReason("node app.js >> /home/mark/pi-master/state/log", cwd) ?? "", /redirect/);
		assert.match(shellWriteReason("node -e 'const f = (x) => x' > state/y", cwd) ?? "", /redirect/);
		assert.match(shellWriteReason("echo 'a => b' > state/z", cwd) ?? "", /redirect/);
	});

	test("bug A and B: the boss session runs both commands, no block, no notice", async () => {
		await asBoss(async () => {
			const { emit, ctx, notices } = setup(cwd);
			const commands = [
				"echo install /home/mark/big-boss-pi/bin/jev",
				"node -e 'const f = (x) => x; console.log(f(1))'",
			];
			for (const command of commands) {
				const [result] = await emit("tool_call", { toolName: "bash", input: { command } }, ctx);
				assert.equal(result, undefined, `${command} should not be blocked`);
			}
			assert.deepEqual(notices, []);
		});
	});
});
