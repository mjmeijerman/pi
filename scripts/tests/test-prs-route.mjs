// Which space a PR's repository belongs to — and what the view says when none owns it.
//
// Plain node: no herdr-app, no gpui-*, no home folder. `env -i node --test
// scripts/tests/test-prs-route.mjs` runs it on a machine that never opened the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bossTerminal, liveSpaceFor, noSpaceMessage, routeLabel, spaceForFolder, spaceName } from "../../herdr-mods/prs/route.mjs";

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
	assert.doesNotMatch(SOURCE, /["']harness["']|boss_space/i, "main.js still points at one hardcoded space");
	// And the route it does take is the pure module, not a second copy of the rule.
	assert.match(SOURCE, /spaceForFolder/);
});

// --- The boss terminal: which running terminal a button's message goes into. ---

const bossTab = (terminals, id = "tab-boss") => ({ id, name: "Boss", terminals });
const live = (tabs, id = "id-site", name = "site") => ({ id, name, tabs });
const record = (extra) => ({ name: "site", id: "id-site", project: "/home/someone/projects/site", ...extra });

test("the uberboss_tab tab's terminal wins when the live space has it", () => {
	const space = live([
		bossTab([{ terminal: "t-other", app: "bash" }], "tab-other"),
		{ id: "tab-uber", name: "Boss", terminals: [{ terminal: "t-boss", app: "pi", status: "done" }] },
	]);
	assert.equal(bossTerminal(record({ uberboss_tab: "tab-uber", boss: "Boss" }), space), "t-boss");
});

test("the tab named boss is the fallback when the recorded id is gone", () => {
	const space = live([bossTab([{ terminal: "t-boss", app: "pi" }])]);
	assert.equal(bossTerminal(record({ uberboss_tab: "tab-gone" }), space), "t-boss");
	// A record with no boss name at all still looks for the tab called "Boss".
	assert.equal(bossTerminal(record({}), space), "t-boss");
});

test("inside the tab: a terminal an app reports for beats one that reports nothing", () => {
	const space = live([bossTab([{ terminal: "t-shell", app: "" }, { terminal: "t-pi", app: "pi" }])]);
	assert.equal(bossTerminal(record({}), space), "t-pi");
	// No app anywhere: its first terminal.
	assert.equal(bossTerminal(record({}), live([bossTab([{ terminal: "t-only" }])])), "t-only");
});

test("a Boss tab that lists no terminal falls back to the record's own terminal", () => {
	const space = live([bossTab([])]);
	assert.equal(bossTerminal(record({ terminals: ["t-recorded", "t-second"] }), space), "t-recorded");
});

test("no boss terminal is invented: null for every space that has none", () => {
	// The app does not list the space at all, even though the record has a terminal.
	assert.equal(bossTerminal(record({ terminals: ["t-recorded"], uberboss_tab: "tab-boss" }), null), null);
	// A live space with no tabs.
	assert.equal(bossTerminal(record({ terminals: ["t-recorded"] }), live([])), null);
	// A record with none of the boss fields, and no matching tab.
	assert.equal(bossTerminal({ name: "site", project: "/home/someone/projects/site" }, live([{ id: "t", name: "work", terminals: [{ terminal: "t-1" }] }])), null);
	// Nothing at all.
	assert.equal(bossTerminal(null, live([bossTab([{ terminal: "t-boss" }])])), null);
});

test("the live space is matched by the record's id, then by its name", () => {
	const one = live([bossTab([{ terminal: "t-boss" }])], "id-site", "site");
	const two = live([], "id-other", "other");
	assert.equal(liveSpaceFor({ id: "id-site", name: "site" }, [two, one]), one);
	// A record written without an id is matched by name, never guessed.
	assert.equal(liveSpaceFor({ name: "site" }, [two, one]), one);
	assert.equal(liveSpaceFor({ id: "id-gone", name: "gone" }, [one, two]), null);
	assert.equal(liveSpaceFor({ id: "id-site" }, []), null);
});

test("the mod sends its job to the boss instead of starting an agent", () => {
	// A second agent in a second tab was the bug this pins against, on purpose.
	assert.doesNotMatch(SOURCE, /tab\.new/, "main.js starts a new agent tab again");
	assert.doesNotMatch(SOURCE, /space\.new/, "main.js creates a space again");
	// It sends one message, into the terminal the record resolves — never a new terminal.
	assert.match(SOURCE, /hc\(\["send", terminal, text\]\)/);
	assert.match(SOURCE, /bossTerminal\(/);
	assert.match(SOURCE, /liveSpaceFor\(/);
	// And it says which space it told, or which one has no Boss running.
	assert.match(SOURCE, /told the boss of space/);
	assert.match(SOURCE, /no Boss tab is running in space/);
});
