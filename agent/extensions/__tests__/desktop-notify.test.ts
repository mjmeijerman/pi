/**
 * desktop-notify: the exact gdbus command it builds, and the notification text.
 *
 * `gdbus` is replaced by a shell script on PATH that records its argv, so the
 * real execFile path is exercised without touching D-Bus.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { createFakeCtx, createFakePi, whenChildrenIdle } from "./helpers/fake-pi.ts";

const root = mkdtempSync(join(tmpdir(), "pi-desktop-notify-"));
const binDir = join(root, "bin");
const projectDir = join(root, "myproj");
const logFile = join(root, "calls.log");
mkdirSync(binDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

// One printf, so one write: `$*` joins the argv with U+001F and the newline goes out
// with it. A line in the log is therefore always whole — never argv-then-newline.
const gdbus = join(binDir, "gdbus");
writeFileSync(
	gdbus,
	`#!/bin/sh\nIFS=$(printf '\\037')\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\n`,
);
chmodSync(gdbus, 0o755);

process.env.PATH = binDir;
process.env.PI_NOTIFY_NO_LOG = "1";
process.chdir(projectDir);

const desktopNotify = (await import("../desktop-notify.ts")).default;

after(() => {
	process.chdir(tmpdir());
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	writeFileSync(logFile, "");
	delete process.env.HERDR_PANE_ID;
});

function setup() {
	const fake = createFakePi();
	desktopNotify(fake.pi);
	const { ctx } = createFakeCtx();
	return { ...fake, ctx };
}

/**
 * Recorded gdbus invocations, one array of argv per call.
 *
 * Only newline-terminated lines count. An invocation's last byte is its newline, so
 * a line without one belongs to a call that is still writing — returning early on it
 * leaves the tail of that call to land in the next test's log.
 */
function recordedCalls(): string[][] {
	const log = readFileSync(logFile, "utf8");
	if (!log.endsWith("\n")) return [];
	return log
		.slice(0, -1)
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\u001f"));
}

/**
 * The calls the child made, once it is gone.
 *
 * Waiting for the child is stronger than waiting for the clock, and the clock deadline is
 * the thing that was load-sensitive: a fake `gdbus` is a real fork, and under 96 concurrent
 * suites the fork alone was measured past 3.2 s, so `waitFor`'s 3 s threw on a test whose
 * code was right. `whenChildrenIdle` returns as soon as the child is reaped — on an idle box
 * that is milliseconds — and the budget is only spent when something really is stuck.
 */
async function calls(expected = 1): Promise<string[][]> {
	await whenChildrenIdle(6000);
	const recorded = recordedCalls();
	assert.ok(recorded.length >= expected, `expected ${expected} gdbus call(s), recorded ${recorded.length}`);
	return recorded;
}

describe("agent_settled", () => {
	test("sends the exact freedesktop Notify call", async () => {
		const { emit, ctx } = setup();
		await emit("agent_settled", { aborted: false }, ctx);

		const [call] = await calls();
		assert.deepEqual(call, [
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.Notify",
			"π",
			"0",
			"",
			"π is klaar",
			`${basename(projectDir)} — wacht op je input`,
			"[]",
			"{'urgency': <byte 1>}",
			"8000",
		]);
	});

	test("does not notify when the user pressed Escape", async () => {
		const { emit, ctx } = setup();
		await emit("agent_settled", { aborted: true }, ctx);
		// The handler dispatches synchronously, so anything it started is a live child
		// process by now. Waiting for children to exit is what makes the empty log
		// final: no child, no more bytes.
		await whenChildrenIdle(6000);
		assert.equal(readFileSync(logFile, "utf8"), "");
	});

	test("appends the herdr pane id to the location", async () => {
		process.env.HERDR_PANE_ID = "pane-42";
		const { emit, ctx } = setup();
		await emit("agent_settled", {}, ctx);
		const [call] = await calls();
		assert.equal(call[12], "myproj · pane-42 — wacht op je input");
	});
});

describe("ui_prompt_start", () => {
	test("uses critical urgency and includes kind + title", async () => {
		const { emit, ctx } = setup();
		await emit("ui_prompt_start", { kind: "confirm", title: "Delete file?" }, ctx);
		const [call] = await calls();
		assert.equal(call[11], "π heeft je input nodig");
		assert.equal(call[12], "myproj — confirm: Delete file?");
		assert.equal(call[14], "{'urgency': <byte 2>}");
	});

	test("falls back to a generic kind and no title", async () => {
		const { emit, ctx } = setup();
		await emit("ui_prompt_start", {}, ctx);
		const [call] = await calls();
		assert.equal(call[12], "myproj — prompt");
	});
});
