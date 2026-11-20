/**
 * route.mjs — which space a pull request's repository belongs to.
 *
 * A space is one project (`~/.pi/state/spaces/<slug>/space.json`, written by `bin/space`), and
 * the PR app's buttons act inside the space that owns the repository they land on. This file
 * answers that question and says what to do when there is no answer.
 *
 * Pure on purpose: records in, a record or a null out — no `herdr` import, no `gpui-*`, no file
 * read. `scripts/tests/test-prs-route.mjs` runs it under plain node.
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

/** The one line the view shows: where the buttons will land. */
export function routeLabel(record) {
	return `→ space ${record?.name ?? "?"} (${path(record?.project)})`;
}

/** The repository's own name, which is the name a space for it would be made with. */
export function spaceName(repo) {
	return String(repo ?? "").split("/").filter(Boolean).pop() ?? "";
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
