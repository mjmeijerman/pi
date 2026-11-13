/**
 * om-autostart: turn observational memory on for every session.
 *
 * `pi-observational-memory` gates itself per session through a ledger entry and
 * defaults to off, so a new session has no memory unless someone types `/om on`.
 * This dispatches that command at session start; with `expandPromptTemplates`
 * the input pipeline runs the extension command instead of sending a user
 * message, so no agent turn starts and no tokens are spent.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const omAutostart = (await import("../om-autostart.ts")).default;

function setup() {
	const fake = createFakePi();
	omAutostart(fake.pi);
	const { ctx } = createFakeCtx();
	return { ...fake, ctx };
}

describe("om-autostart", () => {
	test("asks for /om on when a session starts", async () => {
		const { emit, ctx, sentMessages } = setup();
		await emit("session_start", {}, ctx);
		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0].text, "/om on");
		assert.equal(sentMessages[0].opts?.expandPromptTemplates, true, "must dispatch the command, not send a message");
	});

	test("does not fire before a session starts", async () => {
		const { emit, ctx, sentMessages } = setup();
		await emit("agent_start", {}, ctx);
		assert.equal(sentMessages.length, 0);
	});

	test("a missing om command does not break the session", async () => {
		const fake = createFakePi({
			sendUserMessage() {
				throw new Error("no such command");
			},
		});
		omAutostart(fake.pi);
		const { ctx } = createFakeCtx();
		await assert.doesNotReject(() => fake.emit("session_start", {}, ctx));
	});
});
