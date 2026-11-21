// The key that makes a durable space: what it runs, and where it is written.
//
// Plain node: no herdr-app, no gpui-*, no home folder. The point of the file is that the
// binding is *data* — the mod's keys.json, the installer and this test all read one
// module — so a key that drifts from its argv is a red test, not a silent dead key.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	DURABLE_ACTION,
	DURABLE_KEY,
	SPACE_ARGV,
	durableBinding,
	mergeDurableKeys,
} from "../../herdr-mods/durable/keys.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const KEYS_FILE = JSON.parse(readFileSync(`${HERE}../../herdr-mods/durable/keys.json`, "utf8"));
const SOURCE = readFileSync(`${HERE}../../herdr-mods/durable/keys.mjs`, "utf8");

const shipped = () => ({ global: { "ctrl-shift-t": "tab.new", "ctrl-shift-p": "app.palette" }, terminal: { "ctrl-shift-c": "terminal.copy" } });

test("the key is alt-shift-n: free in the shipped defaults, and not ctrl-shift-n (space.new)", () => {
	assert.equal(DURABLE_KEY, "alt-shift-n");
	// ctrl-shift-n is already space.new: the command that makes a space with no record.
	assert.notEqual(DURABLE_KEY, "ctrl-shift-n");
	assert.equal(KEYS_FILE.global[DURABLE_KEY].command, "terminal.open");
	assert.equal(KEYS_FILE.global[DURABLE_KEY].args.place, "tab");
	assert.deepEqual(KEYS_FILE.global[DURABLE_KEY].args.argv, SPACE_ARGV);
});

test("the argv runs the prompt itself, in a new tab, and no argument the command does not take", () => {
	assert.deepEqual(DURABLE_ACTION, { command: "terminal.open", args: { argv: ["space", "new"], place: "tab" } });
	assert.deepEqual(SPACE_ARGV, ["space", "new"]);
	// terminal.open takes argv, folder, place and name. `focus` is not one of them, and a
	// new tab is focused anyway — an unknown argument is a refusal in Herdr, not a nicety.
	assert.deepEqual(Object.keys(DURABLE_ACTION.args).sort(), ["argv", "place"]);
	assert.equal(Object.hasOwn(DURABLE_ACTION.args, "focus"), false);
});

test("the mod's own keys.json says the same thing as the module the installer writes", () => {
	// One key, two files: the file a person merges by hand and the module install.mjs uses.
	assert.deepEqual(KEYS_FILE.global[DURABLE_KEY], DURABLE_ACTION);
	// The mod's own scope keeps its alt-shift-n — a global key and a mod key are different tabs.
	assert.equal(KEYS_FILE["mod:durable"][DURABLE_KEY], "durable.new");
});

test("the installer's binding points at the installed program, on both platforms", () => {
	const posix = durableBinding({ platform: "linux", binDir: "/home/someone/.local/bin" });
	assert.equal(posix.command, "terminal.open");
	assert.equal(posix.args.place, "tab");
	assert.deepEqual(posix.args.argv, ["/home/someone/.local/bin/space", "new"]);

	const win = durableBinding({ platform: "win32", binDir: "C:\\Users\\mj\\.local\\bin" });
	assert.deepEqual(win.args.argv, ["C:\\Users\\mj\\.local\\bin\\space.cmd", "new"]);
	// The .cmd is the point: Windows cannot start the bash wrapper, which is why the
	// installer writes a shim beside it for every HARNESS_TOOLS name.
	assert.ok(win.args.argv[0].endsWith("space.cmd"));
});

test("no binding carries the home folder it was written on", () => {
	for (const binding of [
		DURABLE_ACTION,
		durableBinding({ platform: "linux", binDir: "/home/someone/.local/bin" }),
		durableBinding({ platform: "win32", binDir: "C:\\Users\\mj\\.local\\bin" }),
	]) {
		const text = JSON.stringify(binding);
		assert.equal(/\/home\/mark|C:\\\\Users\\\\mark/i.test(text), false, text);
	}
	// The template in the file is the bare name, resolved by whoever installs it.
	assert.equal(DURABLE_ACTION.args.argv[0], "space");
	assert.equal(SOURCE.includes("/home/mark"), false);
});

test("a keys.json without the key gets it, and everything else is left alone", () => {
	const before = JSON.stringify(shipped(), null, 2);
	const { text, state } = mergeDurableKeys(before, DURABLE_ACTION);
	assert.equal(state, "added");
	const after = JSON.parse(text);
	assert.deepEqual(after.global[DURABLE_KEY], DURABLE_ACTION);
	// Herdr keys are one file for the whole window: dropping a section loses shortcuts.
	assert.deepEqual(after.global["ctrl-shift-t"], "tab.new");
	assert.deepEqual(after.global["ctrl-shift-p"], "app.palette");
	assert.deepEqual(after.terminal, { "ctrl-shift-c": "terminal.copy" });
	assert.ok(text.endsWith("\n"));
});

test("a file that already says this is kept byte for byte — a second install writes nothing", () => {
	const first = mergeDurableKeys(JSON.stringify(shipped(), null, 2), DURABLE_ACTION);
	const second = mergeDurableKeys(first.text, DURABLE_ACTION);
	assert.equal(second.state, "kept");
	assert.equal(second.text, first.text);
});

test("a key somebody else uses is left as it is, not replaced", () => {
	const taken = JSON.stringify({ global: { [DURABLE_KEY]: "space.next" } }, null, 2);
	const { text, state } = mergeDurableKeys(taken, DURABLE_ACTION);
	assert.equal(state, "taken");
	assert.equal(text, taken);
});

test("a file with no global section gets one; a file that is not JSON is not touched", () => {
	const empty = mergeDurableKeys("{}", DURABLE_ACTION);
	assert.equal(empty.state, "added");
	assert.deepEqual(JSON.parse(empty.text).global[DURABLE_KEY], DURABLE_ACTION);

	for (const broken of ["", "  ", "null", "[]", "not json", '{"global": 3}']) {
		const { text, state } = mergeDurableKeys(broken, DURABLE_ACTION);
		if (broken === '{"global": 3}') {
			assert.equal(state, "added", broken);
			assert.deepEqual(JSON.parse(text).global[DURABLE_KEY], DURABLE_ACTION);
			continue;
		}
		assert.equal(state, "unparsable", broken);
		assert.equal(text, broken, broken);
	}
});
