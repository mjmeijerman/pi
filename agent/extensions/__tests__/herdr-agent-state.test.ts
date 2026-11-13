/**
 * herdr-agent-state: state machine + wire protocol.
 *
 * A real unix socket server stands in for herdr, so every JSON request the
 * extension sends is captured and asserted verbatim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFakePi, tick, waitFor } from "./helpers/fake-pi.ts";

const root = mkdtempSync(join(tmpdir(), "pi-herdr-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;

interface Harness {
	messages: any[];
	fake: ReturnType<typeof createFakePi>;
	close(): Promise<void>;
	stateMessages(): any[];
}

async function startHarness(options: { enabled?: boolean } = {}): Promise<Harness> {
	const { enabled = true } = options;
	const socketPath = join(root, `sock-${counter++}`);
	const messages: any[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			for (const line of String(chunk).split("\n")) {
				if (!line.trim()) continue;
				messages.push(JSON.parse(line));
			}
			socket.write('{"ok":true}\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	if (enabled) {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "pane-1";
	} else {
		delete process.env.HERDR_ENV;
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "pane-1";
	}

	const mod = await import(`${new URL("../herdr-agent-state.ts", import.meta.url).href}?v=${counter++}`);
	const fake = createFakePi();
	mod.default(fake.pi);
	await tick();

	return {
		messages,
		fake,
		stateMessages: () => messages.filter((m) => m.method === "pane.report_agent"),
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function makeCtx(options: { idle?: boolean; sessionFile?: string; sessionId?: string; mode?: string } = {}) {
	const { idle = true, sessionFile = "/tmp/sessions/abc.jsonl", sessionId = "sess-1", mode = "tui" } = options;
	return {
		mode,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
		isIdle: () => idle,
	};
}

async function waitForStates(harness: Harness, count: number) {
	await waitFor(() => harness.stateMessages().length >= count);
}

test("disables itself completely unless HERDR_ENV/SOCKET/PANE are all set", async () => {
	const harness = await startHarness({ enabled: false });
	try {
		assert.equal(harness.fake.handlers.size, 0);
		assert.equal(harness.fake.busListeners.size, 0);
	} finally {
		await harness.close();
	}
});

test("session_start outside TUI mode is ignored", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", { reason: "startup" }, makeCtx({ mode: "rpc" }));
		await tick(3);
		assert.equal(harness.messages.length, 0);
	} finally {
		await harness.close();
	}
});

test("session_start reports the session and the idle state", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", { reason: "startup" }, makeCtx());
		await waitForStates(harness, 1);

		const [session, state] = harness.messages;
		assert.equal(session.method, "pane.report_agent_session");
		assert.deepEqual(session.params, {
			pane_id: "pane-1",
			source: "herdr:pi",
			agent: "pi",
			seq: session.params.seq,
			session_start_source: "startup",
			agent_session_path: "/tmp/sessions/abc.jsonl",
		});
		assert.match(session.id, /^herdr:pi:session:\d+:[a-z0-9]+$/);

		assert.deepEqual(state.params, {
			pane_id: "pane-1",
			source: "herdr:pi",
			agent: "pi",
			state: "idle",
			seq: state.params.seq,
			agent_session_path: "/tmp/sessions/abc.jsonl",
		});
	} finally {
		await harness.close();
	}
});

test("a non-absolute session file falls back to the session id", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", {}, makeCtx({ sessionFile: "relative/session.jsonl" }));
		await waitForStates(harness, 1);
		assert.equal(harness.messages[0].params.agent_session_id, "sess-1");
		assert.equal(harness.messages[0].params.agent_session_path, undefined);
	} finally {
		await harness.close();
	}
});

test("a reload mid-run starts in the working state when the agent is busy", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", {}, makeCtx({ idle: false }));
		await waitForStates(harness, 1);
		assert.equal(harness.stateMessages()[0].params.state, "working");
	} finally {
		await harness.close();
	}
});

test("agent_start reports working once, no matter how often it fires", async () => {
	const harness = await startHarness();
	try {
		const ctx = makeCtx();
		await harness.fake.emit("session_start", {}, ctx);
		await harness.fake.emit("agent_start", {}, ctx);
		await harness.fake.emit("agent_start", {}, ctx);
		await waitForStates(harness, 2);

		const states = harness.stateMessages().map((m) => m.params.state);
		assert.deepEqual(states, ["idle", "working"]);
	} finally {
		await harness.close();
	}
});

test("agent_settled only reports idle when the session really is idle", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", {}, makeCtx());
		await harness.fake.emit("agent_start", {}, makeCtx());
		await waitForStates(harness, 2);

		await harness.fake.emit("agent_settled", {}, makeCtx({ idle: false }));
		await tick(3);
		assert.equal(harness.stateMessages().length, 2, "not idle yet -> no state change");

		await harness.fake.emit("agent_settled", {}, makeCtx({ idle: true }));
		await waitForStates(harness, 3);
		assert.equal(harness.stateMessages()[2].params.state, "idle");
	} finally {
		await harness.close();
	}
});

test("blocked events are counted, labelled and released one at a time", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", {}, makeCtx());
		await waitForStates(harness, 1);

		harness.fake.emitBus("herdr:blocked", { active: true, label: "perm" });
		await waitForStates(harness, 2);
		assert.equal(harness.stateMessages()[1].params.state, "blocked");
		assert.equal(harness.stateMessages()[1].params.message, "perm");

		harness.fake.emitBus("herdr:blocked", { active: true, label: "select" });
		await waitForStates(harness, 3);
		assert.equal(harness.stateMessages()[2].params.message, "select");

		harness.fake.emitBus("herdr:blocked", { active: false });
		await tick(3);
		assert.equal(harness.stateMessages().length, 3, "one prompt still blocked -> no change");

		harness.fake.emitBus("herdr:blocked", { active: false });
		await waitForStates(harness, 4);
		assert.equal(harness.stateMessages()[3].params.state, "idle");
	} finally {
		await harness.close();
	}
});

test("blocked events are ignored until a root TUI session started", async () => {
	const harness = await startHarness();
	try {
		harness.fake.emitBus("herdr:blocked", { active: true, label: "perm" });
		await tick(3);
		assert.equal(harness.messages.length, 0);
	} finally {
		await harness.close();
	}
});

test("report sequence numbers strictly increase", async () => {
	const harness = await startHarness();
	try {
		await harness.fake.emit("session_start", {}, makeCtx());
		await harness.fake.emit("agent_start", {}, makeCtx());
		await waitForStates(harness, 2); // the state queue coalesces, so let "working" land first
		harness.fake.emitBus("herdr:blocked", { active: true, label: "perm" });
		await waitForStates(harness, 3);

		const seqs = harness.messages.map((m) => m.params.seq);
		for (let i = 1; i < seqs.length; i++) {
			assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} must be greater than ${seqs[i - 1]}`);
		}
	} finally {
		await harness.close();
	}
});
