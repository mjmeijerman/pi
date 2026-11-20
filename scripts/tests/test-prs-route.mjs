// Which space a PR's repository belongs to — and what the view says when none owns it.
//
// Plain node: no herdr-app, no gpui-*, no home folder. `env -i node --test
// scripts/tests/test-prs-route.mjs` runs it on a machine that never opened the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { noSpaceMessage, routeLabel, spaceForFolder, spaceName } from "../../herdr-mods/prs/route.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = readFileSync(`${HERE}../../herdr-mods/prs/main.js`, "utf8");

const project = (name, folder) => ({ name, id: `id-${name}`, project: folder, git: true });

const site = project("site", "/home/someone/projects/site");
const monorepo = project("repo", "/home/someone/projects/repo");
const nested = project("inner", "/home/someone/projects/repo/inner");
const other = project("other", "/home/someone/projects/other");

test("a record whose project is the folder itself owns it", () => {
	assert.equal(spaceForFolder([site], "/home/someone/projects/site"), site);
});

test("a folder inside a project belongs to that project", () => {
	assert.equal(spaceForFolder([site], "/home/someone/projects/site/sub/dir"), site);
});

test("two records both claiming the folder: the longer project path wins", () => {
	assert.equal(spaceForFolder([monorepo, nested], "/home/someone/projects/repo/inner/src"), nested);
	// Order does not decide it — the nearest ancestor does.
	assert.equal(spaceForFolder([nested, monorepo], "/home/someone/projects/repo/inner/src"), nested);
	assert.equal(spaceForFolder([nested, monorepo], "/home/someone/projects/repo/elsewhere"), monorepo);
});

test("no record owns the folder: null, never a guess", () => {
	assert.equal(spaceForFolder([], "/home/someone/projects/site"), null);
	assert.equal(spaceForFolder([site, monorepo], "/home/someone/projects/nowhere"), null);
	assert.equal(spaceForFolder([site], null), null);
	assert.equal(spaceForFolder([site], ""), null);
});

test("a record for a different project does not match", () => {
	assert.equal(spaceForFolder([other], "/home/someone/projects/site"), null);
	// A sibling with a shared prefix is a different project, not an ancestor.
	assert.equal(spaceForFolder([site], "/home/someone/projects/site-2"), null);
});

test("a trailing slash on either side is the same folder", () => {
	assert.equal(spaceForFolder([site], "/home/someone/projects/site/"), site);
	// The same record written with a slash is a different object, so the name is the identity.
	assert.equal(spaceForFolder([project("site", "/home/someone/projects/site/")], "/home/someone/projects/site")?.name, "site");
});

test("the route label names the space and its project in one line", () => {
	assert.equal(routeLabel(site), "→ space site (/home/someone/projects/site)");
});

test("the repository basename is the name a space for it would be made with", () => {
	assert.equal(spaceName("owner/repo"), "repo");
	assert.equal(spaceName("repo"), "repo");
});

test("no space: the message names durable.new and the folder, in at most three lines", () => {
	const said = noSpaceMessage("owner/site", "/home/someone/projects/site");
	const lines = said.split("\n");
	assert.ok(lines.length <= 3, `${lines.length} lines: ${said}`);
	assert.match(said, /durable\.new/);
	assert.match(said, /name site/);
	assert.match(said, /\/home\/someone\/projects\/site/);
	assert.match(said, /bin\/space new --name site --project \/home\/someone\/projects\/site/);
	// It says what has no space, and it apologizes for nothing.
	assert.match(lines[0], /no space owns/);
	assert.doesNotMatch(said, /sorry|unfortunately/i);
});

test("no space and no clone: the message still names a folder to make the space for", () => {
	const said = noSpaceMessage("owner/site", null);
	assert.ok(said.split("\n").length <= 3);
	assert.match(said, /~\/projects\/site/);
});

test("the mod never creates a space itself: no space.new, no BOSS_SPACE", () => {
	assert.doesNotMatch(SOURCE, /space\.new/, "main.js calls space.new again");
	assert.doesNotMatch(SOURCE, /BOSS_SPACE/, "main.js still carries the hardcoded boss space");
	assert.doesNotMatch(SOURCE, /big-boss-pi/, "main.js still points at the one old space");
	// And the route it does take is the pure module, not a second copy of the rule.
	assert.match(SOURCE, /spaceForFolder/);
	assert.match(SOURCE, /tab\.new/);
});
