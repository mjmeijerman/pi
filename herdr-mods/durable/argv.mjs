// The argv the durable mod runs — and the only place an argv is built.
//
// No gpui-* import and no herdr import on purpose: this file is plain JavaScript, so a test
// can call it with nothing installed, and the view can call it without a second opinion about
// what `bin/space` is told. Every refusal is an Error whose message is the sentence the person
// reads: the name rule is stated as a rule, not as a verdict after the fact.
//
// `forget` is positional (`bin/space forget <slug>`), not `--name`: the binary's own usage
// says so, and it refuses `--name` as "no such space".

/** The slug rule, verbatim the one `bin/space` enforces (`space_valid_slug`). */
export const NAME_RULE = "[a-z0-9][a-z0-9-]{0,30}";

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * Why this name is not a space name, or null when it is one. One message, the rule in it:
 * the view shows it next to the field before anything is submitted.
 */
export function nameProblem(name) {
	const slug = String(name ?? "").trim();
	if (!slug) return `a space name is a slug: ${NAME_RULE} — this one is empty`;
	if (!NAME.test(slug)) return `a space name is a slug: ${NAME_RULE} — "${slug}" is not`;
	return null;
}

function checkedName(name) {
	const problem = nameProblem(name);
	if (problem) throw new Error(problem);
	return String(name).trim();
}

/**
 * `space new` for one of the two ways a project gets into a space: a folder already on disk
 * (`mode: "folder"`), or a URL to clone into `~/projects/<name>` (`mode: "clone"`).
 * `noGit` adds `--no-git` in both.
 */
export function newArgv({ name, mode = "folder", path, noGit = false } = {}) {
	const slug = checkedName(name);
	if (mode !== "folder" && mode !== "clone") throw new Error(`mode is "folder" or "clone" — "${mode}" is neither`);
	const where = String(path ?? "").trim();
	if (!where) {
		throw new Error(
			mode === "clone"
				? "the clone needs a URL — turn off \"clone from GitHub\" to give a folder on disk instead"
				: "the project field is empty — type the folder the work happens in, or turn on \"clone from GitHub\"",
		);
	}
	const argv = ["new", "--name", slug, mode === "clone" ? "--clone" : "--project", where];
	if (noGit) argv.push("--no-git");
	return argv;
}

/** `space forget <slug>`: the record only. Nothing on disk is named here, so nothing can go. */
export function forgetArgv({ name } = {}) {
	return ["forget", checkedName(name)];
}
