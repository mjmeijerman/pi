/**
 * pi-master-guard: the cases that separate a surviving mutant from the shipped rule.
 *
 * Each entry below is a command or a tool call on which a generated mutant answers
 * differently from the shipped code — a differential run over 10,228 observations found
 * it. Pinning the shipped answer is what makes the mutant wrong. The survivors that
 * survive *this* file are the ones the differential run could not separate at all; they
 * are recorded as equivalences in docs/mutation-survivors.md.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const { default: piMasterGuard, shellWriteReason } = await import("../pi-master-guard.ts");

type ToolCase = {
	event: { toolName: string; input: Record<string, unknown> };
	cwd: string;
	expected: { result?: { block?: boolean; reason?: string }; notices: { message: string; level: string }[] };
};

/** Fire one tool call in `cwd` and return the block and the notices. */
async function observe(item: ToolCase) {
	const fake = createFakePi();
	piMasterGuard(fake.pi);
	const { ctx, notices } = createFakeCtx({ cwd: item.cwd });
	const [result] = await fake.emit("tool_call", item.event, ctx);
	return result === undefined ? { notices } : { result, notices };
}

const SHELL: [string, string | null][] = [
	["bash -c echo a  > rm /home/mark/pi-master/x", "a shell write into /home/mark/pi-master"],
	["echo 'a' > '/home/mark/pi-master/x'", "a shell write into /home/mark/pi-master"],
	["delegate echo a  >> rm /home/mark/pi-master/x", null],
	["rm /home/mark/big-boss-pi/x", null],
];

const TOOL: ToolCase[] = [
	{ event: { "toolName": "bash", "input": { "command": "rm /home/mark/pi-master/x" } }, cwd: "/home/mark/pi-master", expected: { "result": { "block": true, "reason": "pi-master-guard: a shell write into /home/mark/pi-master is not delegation. pi-master-guard: this workspace only delegates. Spawn a worker with `delegate spawn <slug> --cwd <dir> \"<task>\"` and let it write files. Specs and reports are written by delegate itself." }, "notices": [ { "message": "pi-master: blocked a shell write — delegate instead", "level": "warning" } ] } },
	{ event: { "toolName": "write", "input": { "path": "/home/mark/pi-master/x", "content": "x" } }, cwd: "/home/mark/pi-master", expected: { "result": { "block": true, "reason": "pi-master-guard: this workspace only delegates. Spawn a worker with `delegate spawn <slug> --cwd <dir> \"<task>\"` and let it write files. Specs and reports are written by delegate itself." }, "notices": [ { "message": "pi-master: delegate instead of editing here", "level": "warning" } ] } },
];

describe("pi-master-guard: decisions a mutant gets wrong", () => {
	for (const [command, reason] of SHELL) {
		test(`shellWriteReason(${JSON.stringify(command)})`, () => {
			assert.equal(shellWriteReason(command), reason);
		});
	}

	for (const item of TOOL) {
		test(`${item.event.toolName} in ${item.cwd}`, async () => {
			assert.deepEqual(await observe(item), item.expected);
		});
	}
});
