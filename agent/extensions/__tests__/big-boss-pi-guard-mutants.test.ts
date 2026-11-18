/**
 * big-boss-pi-guard: the cases that separate a surviving mutant from the shipped rule.
 *
 * The table is the differential sweep: every command, path and tool call below is an
 * input on which a generated mutant answers differently from the shipped guard across
 * 51,792 observations. `shellWriteReason` cases pin the pure decision; the tool-call
 * cases pin the whole observable answer — block, reason text and notice — which is how
 * the message-string mutants are held. Equivalences that no input separates are in
 * docs/mutation-survivors.md.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../big-boss-pi-guard.ts");
const bigBossPiGuard = mod.default;

type ToolCase = {
	event: { toolName: string; input: Record<string, unknown> };
	cwd: string;
	worker: string | null;
	expected: unknown;
};

/** Run one tool call with the fake pi/context and return what a caller can observe. */
async function observe(item: ToolCase) {
	const fake = createFakePi();
	bigBossPiGuard(fake.pi);
	const { ctx, notices } = createFakeCtx({ cwd: item.cwd });
	const before = process.env.PI_WORKER;
	if (item.worker === null) delete process.env.PI_WORKER;
	else process.env.PI_WORKER = item.worker;
	try {
		const [result] = await fake.emit("tool_call", item.event, ctx);
		// An allowed call returns undefined; an absent key compares, an undefined one does not.
		return result === undefined ? { notices } : { result, notices };
	} finally {
		if (before === undefined) delete process.env.PI_WORKER;
		else process.env.PI_WORKER = before;
	}
}

const SHELL: [string, string, string | null][] = [
	["cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", "/home/mark/big-boss-pi", null],
	["cat <<-EOF\n\trm /home/mark/pi-master/x\nEOF", "/home/mark/big-boss-pi", null],
	["sudo echo a \nrm /home/mark/pi-master/x", "/home/mark/big-boss-pi", "`rm` into /home/mark/pi-master/x"],
	["(echo a  >| sudo rm /home/mark/pi-master/x", "/home/mark/big-boss-pi", "`rm` into /home/mark/pi-master/x"],
	["rmx /home/mark/pi-master/x", "/home/mark/big-boss-pi", null],
	["xrm /home/mark/pi-master/x", "/home/mark/big-boss-pi", null],
	["bash -lc 'rm /home/mark/pi-master/x'", "/home/mark/big-boss-pi", "`rm` into /home/mark/pi-master/x"],
	["X=1 rm /home/mark/pi-master/x", "/home/mark/big-boss-pi", null],
	["bash -c echo a  > sed -i /home/mark/pi-master/x", "/home/mark/big-boss-pi", "a shell redirect into /home/mark/big-boss-pi/sed"],
	["perl -i /home/mark/pi-master/x", "/home/mark/big-boss-pi", "`perl -i` into /home/mark/pi-master/x"],
	["sed -n /home/mark/big-boss-pi/x", "/home/mark/big-boss-pi", null],
	["perl -pi -e 's/a/b/' /home/mark/pi-master/x", "/home/mark/big-boss-pi", "`perl -i` into /home/mark/big-boss-pi/s/a/b"],
	["jev echo a  >rm /home/mark/pi-master/x", "/home/mark/big-boss-pi", "a shell redirect into /home/mark/big-boss-pi/rm"],
	["rm ~/pi-master/x", "/home/mark/big-boss-pi", "`rm` into /home/mark/pi-master/x"],
	["sed -i.bak 's/a/b/' /home/mark/pi-master/x", "/home/mark/big-boss-pi", "`sed -i` into /home/mark/big-boss-pi/s/a/b"],
	["sudo rm /home/mark/pi-master/x", "/home/mark/big-boss-pi", "`rm` into /home/mark/pi-master/x"],
];

const TOOL: ToolCase[] = [
	{ event: { "toolName": "edit", "input": { "path": "", "edits": [] } }, cwd: "/home/mark/big-boss-pi/specs", worker: null, expected: { "result": { "block": true, "reason": "big-boss-pi-guard: /home/mark/big-boss-pi is delegation-only. Do not write files here yourself — spawn a worker with `delegate spawn`, or write the spec/report through delegate. /home/mark/pi-master is the rollback copy and is also read-only." }, "notices": [ { "message": "big-boss-pi-guard: this workspace is for delegation, not direct edits", "level": "warning" } ] } },
	{ event: { "toolName": "bash", "input": { "command": "rm /home/mark/pi-master/x" } }, cwd: "/home/mark/projects/bakmark", worker: null, expected: { "notices": [] } },
	{ event: { "toolName": "write", "input": { "path": "/home/mark/pi-master/x", "content": "x" } }, cwd: "/home/mark/big-boss-pi", worker: null, expected: { "result": { "block": true, "reason": "big-boss-pi-guard: /home/mark/big-boss-pi is delegation-only. Do not write files here yourself — spawn a worker with `delegate spawn`, or write the spec/report through delegate. /home/mark/pi-master is the rollback copy and is also read-only." }, "notices": [ { "message": "big-boss-pi-guard: this workspace is for delegation, not direct edits", "level": "warning" } ] } },
	{ event: { "toolName": "read", "input": { "path": "/home/mark/pi-master/x", "content": "x" } }, cwd: "/home/mark/big-boss-pi", worker: null, expected: { "notices": [] } },
	{ event: { "toolName": "bash", "input": { "command": "rm /home/mark/pi-master/x" } }, cwd: "/home/mark/big-boss-pi", worker: null, expected: { "result": { "block": true, "reason": "big-boss-pi-guard: `rm` into /home/mark/pi-master/x is a direct write into a delegation-only workspace (/home/mark/big-boss-pi or its rollback copy /home/mark/pi-master). Delegate the work with `delegate spawn`, or ask the user." }, "notices": [ { "message": "big-boss-pi-guard: blocked a shell write into the workspace", "level": "warning" } ] } },
];

const PURE: [string, Record<string, string>, boolean][] = [
	["delegationPath", "/home/mark/big-boss-pi/reports", true],
];

describe("big-boss-pi-guard: decisions a mutant gets wrong", () => {
	for (const [command, cwd, reason] of SHELL) {
		test(`shellWriteReason(${JSON.stringify(command)}, ${cwd})`, () => {
			assert.equal(mod.shellWriteReason(command, cwd), reason);
		});
	}

	for (const [name, env, expected] of PURE) {
		test(`${name}(${JSON.stringify(env)})`, () => {
			assert.equal((mod as any)[name](env), expected);
		});
	}

	for (const item of TOOL) {
		test(`${item.event.toolName} in ${item.cwd} (PI_WORKER=${item.worker})`, async () => {
			assert.deepEqual(await observe(item), item.expected);
		});
	}
});
