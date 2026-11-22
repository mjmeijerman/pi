// What a durable New form starts with, when a caller opened it with props.
//
// Plain node: no herdr-app, no gpui-*, no home folder. `env -i node --test
// scripts/tests/test-durable-prefill.test.mjs` runs it on a machine that never opened the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initialForm } from "../../herdr-mods/durable/prefill.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIN = readFileSync(`${HERE}../../herdr-mods/durable/main.js`, "utf8");
const SOURCE = readFileSync(`${HERE}../../herdr-mods/durable/prefill.mjs`, "utf8");

const folder = "/home/someone/projects/jurysystem";
const url = "https://github.com/mjmeijerman/jurysystem";

test("a folder caller: that path in the project field, folder mode", () => {
	const form = initialForm({ name: "jurysystem", project: folder });
	assert.equal(form.view, "new");
	assert.equal(form.name, "jurysystem");
	assert.equal(form.project, folder);
	assert.equal(form.clone, false);
	assert.equal(form.url, "");
});

test("a clone caller: clone on, the URL in the URL field, no folder", () => {
	const form = initialForm({ name: "jurysystem", url });
	assert.equal(form.clone, true);
	assert.equal(form.url, url);
	assert.equal(form.project, "");
	assert.equal(form.name, "jurysystem");
});

test("no props at all: the empty form a person started typing, new view", () => {
	for (const props of [null, undefined, {}]) {
		assert.deepEqual(initialForm(props), { view: "new", name: "", project: "", clone: false, url: "" }, `props ${JSON.stringify(props)}`);
	}
});

test("the view the props ask for, and nothing else", () => {
	assert.equal(initialForm({ view: "list" }).view, "list");
	assert.equal(initialForm({ view: "forget" }).view, "forget");
	// A typo is not a view: the rule the mod already had, unchanged.
	assert.equal(initialForm({ view: "wat" }).view, "new");
	assert.equal(initialForm({ view: 7 }).view, "new");
});

test("whitespace is trimmed, and a URL wins over a folder when both are given", () => {
	const spaced = initialForm({ name: "  jurysystem \n", project: ` ${folder}  ` });
	assert.equal(spaced.name, "jurysystem");
	assert.equal(spaced.project, folder);
	// Both: the URL wins, because a URL is an explicit "clone this" and the folder it lands in
	// is not one the caller could have known.
	const both = initialForm({ name: "jurysystem", project: folder, url: ` ${url} ` });
	assert.equal(both.clone, true);
	assert.equal(both.url, url);
	assert.equal(both.project, "");
});

test("the view applies the form, and a caller's path is not overwritten by the name", () => {
	// The form is only worth reading if init actually reads it.
	assert.match(MAIN, /initialForm\(props\(\)\)/);
	assert.match(MAIN, /pathTouched = Boolean\(given\)/);
	assert.match(MAIN, /this\.clone = start\.clone/);
	// Pure: no app, no bindings, no file read, and no name validation here — the field says why.
	assert.doesNotMatch(SOURCE, /from "herdr"/);
	assert.doesNotMatch(SOURCE, /readTextFile|exec\(/);
	assert.doesNotMatch(SOURCE, /nameProblem/);
});
