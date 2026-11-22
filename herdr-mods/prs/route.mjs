/**
 * route.mjs — which space a pull request's repository belongs to.
 *
 * A space is one project (`~/.pi/state/spaces/<slug>/space.json`, written by `bin/space`), and
 * the PR app's buttons act inside the space that owns the repository they land on. This file
 * answers that question and says what to do when there is no answer.
 *
 * The buttons do not start an agent: they send their job to the space's own Boss, whose
 * terminal `bossTerminal` resolves the same way — purely, from the record and the app's list.
 *
 * Pure on purpose: records in, a record or a null out — no `herdr` import, no `gpui-*`, no file
 * read. `scripts/tests/test-prs-route.test.mjs` runs it under plain node.
 */

/** A path as it is compared: no surrounding space, no trailing slash (the root keeps its own). */
function path(value) {
	const trimmed = String(value ?? "").trim();
	if (trimmed.length > 1 && trimmed.endsWith("/")) return trimmed.replace(/\/+$/, "");
	return trimmed;
}

/**
 * The space that owns `folder`: the record whose `project` is that folder or its nearest
 * ancestor. A clone three folders down belongs to the project above it, and when two projects
 * both claim it the longer path wins — the nearest owner, not whichever record came first.
 */
export function spaceForFolder(records, folder) {
	const want = path(folder);
	if (!want) return null;
	let best = null;
	let bestLength = -1;
	for (const record of Array.isArray(records) ? records : []) {
		const project = path(record?.project);
		if (!project) continue;
		if (want !== project && !want.startsWith(`${project}/`)) continue;
		if (project.length > bestLength) {
			best = record;
			bestLength = project.length;
		}
	}
	return best;
}

/**
 * The live space for a record: the app's entry whose id is the record's id, else the one whose
 * name is the record's name. `null` when the app does not list the space at all — the buttons
 * then have nothing to type into, and say so instead of starting something.
 */
export function liveSpaceFor(record, spaces) {
	if (!record) return null;
	const id = String(record.id ?? "").trim();
	const name = String(record.name ?? "").trim();
	const list = Array.isArray(spaces) ? spaces : [];
	if (id) {
		const byId = list.find((space) => String(space?.id ?? "").trim() === id);
		if (byId) return byId;
	}
	if (!name) return null;
	return list.find((space) => String(space?.name ?? "").trim() === name) ?? null;
}

/**
 * The terminal the buttons talk to: the space's Boss tab, or `null` when none is running.
 *
 * The record (`~/.pi/state/spaces/<slug>/space.json`) says which tab is the Boss
 * (`uberboss_tab`, by id) and what it is called (`boss`, default "Boss"); the live space says
 * which terminals exist right now. A tab is picked by id first, then by name, and never
 * invented. Inside it the first terminal an app reports status for (pi) wins, then its first
 * terminal, then the record's own first terminal. Nothing matches: `null`, and nothing starts.
 */
export function bossTerminal(record, liveSpace) {
	if (!record) return null;
	const tabId = String(record.uberboss_tab ?? "").trim();
	const bossName = String(record.boss ?? "Boss").trim() || "Boss";
	const tabs = Array.isArray(liveSpace?.tabs) ? liveSpace.tabs : [];
	let tab = tabId ? tabs.find((entry) => String(entry?.id ?? "").trim() === tabId) : null;
	if (!tab) tab = tabs.find((entry) => String(entry?.name ?? "").trim() === bossName) ?? null;
	if (!tab) return null;
	const terminals = Array.isArray(tab.terminals) ? tab.terminals : [];
	const live = terminals.find((entry) => String(entry?.terminal ?? "").trim() && String(entry?.app ?? "").trim());
	if (live) return live.terminal;
	const first = terminals.find((entry) => String(entry?.terminal ?? "").trim());
	if (first) return first.terminal;
	const recorded = (Array.isArray(record.terminals) ? record.terminals : []).map((term) => String(term ?? "").trim()).filter(Boolean);
	return recorded[0] ?? null;
}

/** The one line the view shows: where the buttons will land. */
export function routeLabel(record) {
	return `→ space ${record?.name ?? "?"} (${path(record?.project)})`;
}

/** The repository's own name, which is the name a space for it would be made with. */
export function spaceName(repo) {
	return String(repo ?? "").split("/").filter(Boolean).pop() ?? "";
}

/**
 * The overlay spec the "create a space for it" button hands the app: the durable mod's New form,
 * filled in with the name and either the clone on disk or the URL to clone.
 *
 * Not a `<mod>.<command>`: a command reaches shown copies only and carries no props, so the form
 * arrived empty and the button looked dead. `openOverlay` opens a copy and passes the props —
 * `{ mod, kind: "dialog", props }` — and the mod closes itself with the id it was given.
 *
 * Pure: a pull request, the folder `folderFor` found (or null), and a spec.
 */
export function newSpaceSpec(pr, folder) {
	const name = spaceName(pr?.repo);
	const clone = path(folder);
	if (clone) return { mod: "durable", kind: "dialog", props: { view: "new", name, project: clone } };
	// No clone: the URL is what the form needs, and clone mode is what shows its field.
	return { mod: "durable", kind: "dialog", props: { view: "new", name, project: "", url: `https://github.com/${String(pr?.repo ?? "")}` } };
}

/**
 * What the view says when no space owns the repository: what has none, and the two ways to
 * make one — the form that asks three questions, and the command that skips the form. Three
 * lines, no apology, and nothing is started.
 */
export function noSpaceMessage(repo, folder) {
	const name = spaceName(repo);
	const where = path(folder) || `~/projects/${name}`;
	return [
		`no space owns ${where} — nothing was started for ${repo}`,
		`make one: durable.new, name ${name}, project ${where}`,
		`or: ~/.pi/bin/space new --name ${name} --project ${where}`,
	].join("\n");
}
