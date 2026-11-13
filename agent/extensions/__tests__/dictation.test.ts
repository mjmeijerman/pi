/**
 * dictation: only the pure parts — path/env resolution, the F8 state machine,
 * and the exact argv handed to arecord / whisper. Audio processes are faked.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFakeChild, createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const home = mkdtempSync(join(tmpdir(), "pi-dictation-home-"));
process.env.HOME = home;

const DICT_DIR = join(home, ".pi", "agent", "dictation");
const EXPECTED_WAV = join(DICT_DIR, "recording.wav");
const EXPECTED_VENV_PY = join(DICT_DIR, "bin", "whisper-py");
const EXPECTED_TRANSCRIBE_PY = join(DICT_DIR, "transcribe.py");

after(() => {
	delete (globalThis as any).__piTestSpawn;
	rmSync(home, { recursive: true, force: true });
});

interface SpawnState {
	calls: { cmd: string; args: string[]; opts: any }[];
	recorder?: any;
	transcript?: string;
	stderr?: string;
	code?: number;
}

/** Replace child_process.spawn for the duration of one test. */
function installFakeSpawn(): SpawnState {
	const state: SpawnState = { calls: [], transcript: "hallo wereld", code: 0 };
	(globalThis as any).__piTestSpawn = (cmd: string, args: string[], opts: any) => {
		state.calls.push({ cmd, args, opts });
		const child = createFakeChild();
		if (cmd === "arecord") {
			state.recorder = child;
			return child;
		}
		setImmediate(() => {
			if (state.stderr) child.emitStderr(state.stderr);
			if (state.transcript) child.emitStdout(state.transcript);
			child.emit("close", state.code ?? 0);
		});
		return child;
	};
	return state;
}

let counter = 0;

async function load(env: Record<string, string> = {}) {
	process.env.DICTATION_DEVICE = env.DICTATION_DEVICE ?? "default";
	process.env.DICTATION_LANG = env.DICTATION_LANG ?? "auto";
	process.env.DICTATION_AUTOSUBMIT = env.DICTATION_AUTOSUBMIT ?? "0";
	const mod = await import(`../dictation.ts?v=${counter++}`);
	const fake = createFakePi();
	mod.default(fake.pi);
	const { ctx, notices, statuses } = createFakeCtx();
	return { ...fake, ctx, notices, statuses, shortcut: fake.shortcuts.get("f8") };
}

function recorderCall(state: SpawnState) {
	return state.calls.find((call) => call.cmd === "arecord");
}

test("registers the F8 shortcut and a shutdown hook", async () => {
	const { shortcuts, handlers } = await load();
	assert.ok(shortcuts.has("f8"));
	assert.match(shortcuts.get("f8").description, /Dictate/);
	assert.ok(handlers.has("session_shutdown"));
});

test("is a no-op outside TUI mode", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut } = await load();
	const fakeCtx = createFakeCtx({ mode: "rpc" });
	await shortcut.handler(fakeCtx.ctx);
	assert.equal(state.calls.length, 0, "must not spawn a recorder");
	assert.equal(fakeCtx.notices.at(-1)!.message, "Dictatie: alleen in TUI-modus beschikbaar");
	assert.equal(fakeCtx.notices.at(-1)!.level, "warn");
	assert.equal(ctx.mode, "tui");
});

test("starts arecord with the resolved device and canonical paths", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut, notices } = await load({ DICTATION_DEVICE: "hw:1,0" });
	await shortcut.handler(ctx);

	const call = recorderCall(state)!;
	assert.equal(call.cmd, "arecord");
	assert.deepEqual(call.args, ["-D", "hw:1,0", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", EXPECTED_WAV]);
	assert.equal(notices.at(-1)!.message, "Dictatie: opnemen... (F8 om te stoppen)");
});

test("DICTATION_DEVICE defaults to `default`", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut } = await load();
	await shortcut.handler(ctx);
	assert.equal(recorderCall(state)!.args[1], "default");
});

test("stopping transcribes with the venv interpreter and DICTATION_LANG", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut } = await load({ DICTATION_LANG: "nl" });
	await shortcut.handler(ctx); // start
	await shortcut.handler(ctx); // stop + transcribe

	const whisper = state.calls.find((call) => call.cmd !== "arecord")!;
	assert.equal(whisper.cmd, EXPECTED_VENV_PY);
	assert.deepEqual(whisper.args, [EXPECTED_TRANSCRIBE_PY, EXPECTED_WAV]);
	assert.equal(whisper.opts.env.DICTATION_LANG, "nl");
	assert.ok(state.recorder.signals.includes("SIGINT"), "arecord must be stopped with SIGINT so the WAV header is written");
	assert.equal(ctx.editorText, "hallo wereld");
});

test("the transcript is appended to existing editor text", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut, notices } = await load();
	ctx.ui.setEditorText("bestaande tekst   ");
	await shortcut.handler(ctx);
	await shortcut.handler(ctx);

	assert.equal(ctx.editorText, "bestaande tekst\nhallo wereld");
	assert.match(notices.at(-1)!.message, /toegevoegd/);
});

test("DICTATION_AUTOSUBMIT=true sends the transcript as a steering message", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut, notices, sentMessages } = await load({ DICTATION_AUTOSUBMIT: "true" });
	await shortcut.handler(ctx);
	await shortcut.handler(ctx);

	// The extension prefixes the transcript so the model can tell transcribed audio
	// from a direct user instruction; the test asserts the marker stays in place.
	assert.equal(sentMessages.length, 1);
	assert.deepEqual(sentMessages[0].opts, { deliverAs: "steer" });
	assert.match(sentMessages[0].text, /hallo wereld$/);
	assert.match(sentMessages[0].text, /transcribed audio, not a direct user command/);
	assert.match(notices.at(-1)!.message, /verzonden/);
	assert.equal(ctx.editorText, "", "nothing is pasted into the editor when autosubmitted");
});

test("autosubmit is skipped when the editor already has text", async () => {
	installFakeSpawn();
	const { ctx, shortcut, sentMessages } = await load({ DICTATION_AUTOSUBMIT: "1" });
	ctx.ui.setEditorText("eerst dit");
	await shortcut.handler(ctx);
	await shortcut.handler(ctx);

	assert.equal(sentMessages.length, 0);
	assert.equal(ctx.editorText, "eerst dit\nhallo wereld");
});

test("an unrecognised DICTATION_AUTOSUBMIT value stays false", async () => {
	installFakeSpawn();
	const { ctx, shortcut, sentMessages } = await load({ DICTATION_AUTOSUBMIT: "yes" });
	await shortcut.handler(ctx);
	await shortcut.handler(ctx);
	assert.equal(sentMessages.length, 0);
});

test("a transcription failure is reported and leaves the editor alone", async () => {
	const state = installFakeSpawn();
	state.stderr = "whisper exploded";
	state.code = 1;
	const { ctx, shortcut, notices } = await load();
	await shortcut.handler(ctx);
	await shortcut.handler(ctx);

	assert.equal(notices.at(-2)!.level, "error");
	assert.match(notices.at(-2)!.message, /transcriptie mislukt: whisper exploded/);
	assert.equal(notices.at(-1)!.message, "Dictatie: geen spraak herkend?");
	assert.equal(ctx.editorText, "");
});

test("an empty transcript warns instead of pasting nothing", async () => {
	const state = installFakeSpawn();
	state.transcript = "";
	const { ctx, shortcut, notices } = await load();
	await shortcut.handler(ctx);
	await shortcut.handler(ctx);

	assert.equal(notices.at(-1)!.message, "Dictatie: geen spraak herkend?");
	assert.equal(notices.at(-1)!.level, "warn");
	assert.equal(ctx.editorText, "");
});

test("session_shutdown stops an open recording", async () => {
	const state = installFakeSpawn();
	const { ctx, shortcut, emit, handlers } = await load();
	await shortcut.handler(ctx);
	const recorder = state.recorder;
	await emit("session_shutdown", {}, ctx);
	assert.ok(recorder.signals.includes("SIGINT"));
	assert.ok(handlers.has("session_shutdown"));
});
