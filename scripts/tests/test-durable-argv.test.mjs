// What the durable mod tells `bin/space` — and nothing else.
//
// Plain node: no herdr-app, no gpui-*, no home folder. `env -i node --test
// scripts/tests/test-durable-argv.test.mjs` runs it on a machine that never opened the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NAME_RULE, forgetArgv, nameProblem, newArgv } from "../../herdr-mods/durable/argv.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = readFileSync(`${HERE}../../herdr-mods/durable/argv.mjs`, "utf8");

const folder = "/home/someone/projects/site";
const url = "https://github.com/example/site.git";

/** The refusal has to carry the rule itself, not a verdict after the fact. */
const saysRule = (e) => e instanceof Error && e.message.includes(NAME_RULE);

test("a folder on disk is --project, in that order", () => {
	assert.deepEqual(newArgv({ name: "site", mode: "folder", path: folder }), ["new", "--name", "site", "--project", folder]);
});

test("a clone is --clone, and the mode is the only difference", () => {
	assert.deepEqual(newArgv({ name: "site", mode: "clone", path: url }), ["new", "--name", "site", "--clone", url]);
});

test("--no-git is appended after the project, for a folder and for a clone", () => {
	assert.deepEqual(newArgv({ name: "site", mode: "folder", path: folder, noGit: true }), [
		"new",
		"--name",
		"site",
		"--project",
		folder,
		"--no-git",
	]);
	assert.deepEqual(newArgv({ name: "site", mode: "clone", path: url, noGit: true }), [
		"new",
		"--name",
		"site",
		"--clone",
		url,
		"--no-git",
	]);
});

test("a mode that is neither folder nor clone is refused, naming both", () => {
	assert.throws(() => newArgv({ name: "site", mode: "folderish", path: folder }), /folder.*clone/i);
});

test("a bad name is refused with the rule in the message", () => {
	for (const bad of ["Site", "site_x", "-site", "site.foo", "a".repeat(32), "x y", ""]) {
		assert.throws(
			() => newArgv({ name: bad, mode: "folder", path: folder }),
			saysRule,
			`${JSON.stringify(bad)} should be refused with ${NAME_RULE}`,
		);
		assert.notEqual(nameProblem(bad), null, `${JSON.stringify(bad)} is not a space name`);
	}
	// The rule is the one bin/space enforces (space_valid_slug), spelled the same way.
	assert.equal(NAME_RULE, "[a-z0-9][a-z0-9-]{0,30}");
});

test("the edges of the rule are accepted", () => {
	assert.equal(nameProblem("a"), null);
	assert.equal(nameProblem("a".repeat(31)), null);
	assert.equal(nameProblem("a-b9"), null);
	assert.deepEqual(newArgv({ name: "a".repeat(31), mode: "folder", path: folder }).slice(0, 3), [
		"new",
		"--name",
		"a".repeat(31),
	]);
	assert.notEqual(nameProblem("a".repeat(32)), null);
});

test("an empty path is refused, in both modes, and says what to do instead", () => {
	assert.throws(() => newArgv({ name: "site", mode: "folder", path: "  " }), /folder|project field/i);
	assert.throws(() => newArgv({ name: "site", mode: "clone", path: "" }), /URL|clone/i);
	assert.throws(() => newArgv({ name: "site", mode: "folder" }), /folder|project field/i);
});

test("forget names the space positionally, the way bin/space takes it, and answers its question", () => {
	// `--yes` is the answer the binary asks for on a terminal: a mod has no terminal, so it says yes
	// up front rather than letting the call hang or be refused.
	assert.deepEqual(forgetArgv({ name: "site" }), ["forget", "site", "--yes"]);
	assert.throws(() => forgetArgv({ name: "Site" }), saysRule);
});

test("no argv carries close or rm, and the source reaches for neither", () => {
	const built = [
		newArgv({ name: "site", mode: "folder", path: folder }),
		newArgv({ name: "site", mode: "clone", path: url }),
		newArgv({ name: "site", mode: "folder", path: folder, noGit: true }),
		newArgv({ name: "site", mode: "clone", path: url, noGit: true }),
		forgetArgv({ name: "site" }),
	];
	for (const argv of built) {
		assert.ok(["new", "forget"].includes(argv[0]), `the verb is new or forget, not ${argv[0]}`);
		for (const arg of argv) {
			assert.ok(!/close/.test(arg), `no close in ${argv.join(" ")}`);
			assert.ok(!/^rm$|^-[rf]{1,2}$/.test(arg), `no rm in ${argv.join(" ")}`);
		}
	}
	for (const word of ["close", "rm ", "'rm'", '"rm"', "unlink", "rimraf"]) {
		assert.ok(!SOURCE.includes(word), `argv.mjs never names ${word}`);
	}
});
