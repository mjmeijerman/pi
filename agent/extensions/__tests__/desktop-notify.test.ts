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
import { createFakeCtx, createFakePi, waitFor } from "./helpers/fake-pi.ts";

const root = mkdtempSync(join(tmpdir(), "pi-desktop-notify-"));
const binDir = join(root, "bin");
const projectDir = join(root, "myproj");
const logFile = join(root, "calls.log");
mkdirSync(binDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

const gdbus = join(binDir, "gdbus");
writeFileSync(gdbus, `#!/bin/sh\nprintf '%s\\037' "$@" >> ${JSON.stringify(logFile)}\nprintf '\\n' >> ${JSON.stringify(logFile)}\n`);
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

/** Recorded gdbus invocations, one array of argv per call. */
async function calls(expected = 1): Promise<string[][]> {
	await waitFor(() => readFileSync(logFile, "utf8").split("\n").filter(Boolean).length >= expected);
	return readFileSync(logFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\u001f").filter((_, index, all) => index < all.length - 1));
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
		await new Promise((resolve) => setTimeout(resolve, 150));
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
