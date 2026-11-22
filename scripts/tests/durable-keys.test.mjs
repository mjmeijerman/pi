// The key that makes a durable space: what it opens, and where it is written.
//
// Plain node: no herdr-app, no gpui-*, no home folder. The point of the file is that the
// binding is *data* — the mod's keys.json, the installer and this test all read one
// module — so a key that drifts from its action is a red test, not a silent dead key.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	DURABLE_ACTION,
	DURABLE_KEY,
	DURABLE_MOD,
	mergeDurableKeys,
	oldDurableBinding,
} from "../../herdr-mods/durable/keys.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const KEYS_FILE = JSON.parse(readFileSync(`${HERE}../../herdr-mods/durable/keys.json`, "utf8"));
const SOURCE = readFileSync(`${HERE}../../herdr-mods/durable/keys.mjs`, "utf8");

const shipped = () => ({ global: { "ctrl-shift-t": "tab.new", "ctrl-shift-p": "app.palette" }, terminal: { "ctrl-shift-c": "terminal.copy" } });

/** What every install before this one wrote: the tab, with the program it resolved. */
const oldBinding = (program) => ({ command: "terminal.open", args: { argv: [program, "new"], place: "tab" } });

test("the key is alt-shift-n, and it opens the durable mod's own New form", () => {
	assert.equal(DURABLE_KEY, "alt-shift-n");
	// ctrl-shift-n is already space.new: the command that makes a space with no record.
	assert.notEqual(DURABLE_KEY, "ctrl-shift-n");
	assert.equal(DURABLE_MOD, "durable");
	assert.deepEqual(DURABLE_ACTION, { command: "mod.open", args: { name: "durable" } });
});

test("the binding carries no argv and no path, so there is nothing to resolve per platform", () => {
	// The old binding was `terminal.open` with `[<program>, new]`; the program is what
	// Windows could not start (os error 193). `mod.open` names a mod and nothing else.
	assert.deepEqual(Object.keys(DURABLE_ACTION.args), ["name"]);
	assert.equal(Object.hasOwn(DURABLE_ACTION, "argv"), false);
	assert.equal(JSON.stringify(DURABLE_ACTION).includes("space"), false);
	assert.equal(/\/home\/mark/.test(SOURCE), false);
});

test("the mod's own keys.json says the same thing as the module the installer writes", () => {
	// One key, two files: the file a person merges by hand and the module install.mjs uses.
	assert.deepEqual(KEYS_FILE.global[DURABLE_KEY], DURABLE_ACTION);
	assert.deepEqual(KEYS_FILE.global["alt-shift-d"], DURABLE_ACTION);
	// The mod's own scope keeps its alt-shift-n: a global key and a mod key are different
	// scopes, and inside the open overlay this one is what stops the key re-opening it.
	assert.equal(KEYS_FILE["mod:durable"][DURABLE_KEY], "durable.new");
});

test("the binding an earlier install wrote is recognised, so it can be moved rather than refused", () => {
	// Every spelling of the program that install ever resolved, from a bare name to the
	// Windows shim: they are all this key, not somebody else's.
	for (const program of ["space", "/home/someone/.local/bin/space", "C:\\Users\\mj\\.local\\bin\\space.cmd"]) {
		assert.equal(oldDurableBinding(oldBinding(program)), true, program);
	}
	// A different command, a different argv, a different place, or a plain string is
	// somebody else's key and is left alone.
	for (const value of [
		{ command: "space.new" },
		{ command: "terminal.open", args: { argv: ["space", "list"], place: "tab" } },
		{ command: "terminal.open", args: { argv: ["space", "new"], place: "overlay" } },
		{ command: "terminal.open", args: { argv: ["gh", "new"], place: "tab" } },
		{ command: "mod.open", args: { name: "durable" } },
		"space.next",
		null,
		[],
	]) {
		assert.equal(oldDurableBinding(value), false, JSON.stringify(value));
	}
});

test("a keys.json holding the old binding is moved to the form, and everything else survives", () => {
	const before = JSON.stringify({ ...shipped(), global: { ...shipped().global, [DURABLE_KEY]: oldBinding("/home/someone/.local/bin/space") } }, null, 2);
	const { text, state } = mergeDurableKeys(before, DURABLE_ACTION);
	assert.equal(state, "migrated");
	const after = JSON.parse(text);
	assert.deepEqual(after.global[DURABLE_KEY], DURABLE_ACTION);
	assert.deepEqual(after.global["ctrl-shift-t"], "tab.new");
	assert.deepEqual(after.terminal, { "ctrl-shift-c": "terminal.copy" });
	// Moved once: the second install finds the form and keeps the bytes.
	const again = mergeDurableKeys(text, DURABLE_ACTION);
	assert.equal(again.state, "kept");
	assert.equal(again.text, text);
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
