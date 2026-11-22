// The key that makes a durable space — and the one place its binding is built.
//
// `alt-shift-n` is `mod.open` with `{ "name": "durable" }`: the mod's own New form — the
// fields, the inline refusals, the clone toggle — on every OS, and the same action
// `alt-shift-d` already had. It used to be `terminal.open` with argv `space new`, which
// asked the three questions in a terminal; the argv had to name the installed program, so
// the binding carried a path each platform resolved differently, and on Windows that path
// was a bash script Windows cannot exec (os error 193). `mod.open` takes a mod name and no
// argv: nothing is resolved, so the same line is right on Linux, macOS and Windows.
//
// No `focus` key: `mod.open` takes `name` only, and an unknown argument is a refusal, not
// a nicety.
//
// `keys.json`'s `mod:durable` scope keeps its own `alt-shift-n` = `durable.new`. That entry
// is the one that must stay: pressed inside the open overlay the mod's scope wins, so the
// key means "the New form" and not "open the overlay I am already in" — a second press
// would reopen it and drop a half-typed name. The global key opens the form; the mod key
// fills it.
//
// No gpui-* and no herdr import, on purpose: plain JavaScript, so install.mjs writes the
// same binding into the person's keys.json that a test can read back without the app.

/** The key. `alt-shift-n` is unbound in the shipped defaults (ctrl-shift-n is `space.new`,
 * the command that makes a space with no record). */
export const DURABLE_KEY = "alt-shift-n";

/** The mod the key opens. */
export const DURABLE_MOD = "durable";

/** The binding, verbatim, on all three platforms: no argv, no path, nothing to resolve. */
export const DURABLE_ACTION = { command: "mod.open", args: { name: DURABLE_MOD } };

/**
 * oldDurableBinding — is this value what an earlier install wrote for this key?
 *
 * The previous binding was `terminal.open` with argv `[<program>, "new"]` and place "tab",
 * where `<program>` was whatever `space` the installer resolved (a bare `space`, the
 * installed path, or `space.cmd` on Windows). Recognising it is what lets an install that
 * already carries it move the person to the form instead of refusing the key as somebody
 * else's, which would leave them on `terminal.open` forever.
 */
export function oldDurableBinding(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (value.command !== "terminal.open") return false;
	const args = value.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	if (args.place !== "tab") return false;
	if (!Array.isArray(args.argv) || args.argv.length !== 2 || args.argv[1] !== "new") return false;
	return /(^|[\\/])space(\.cmd)?$/i.test(String(args.argv[0] ?? ""));
}

/** Stable shape, so a binding read back from a file compares equal to the one built. */
function shape(value) {
	if (Array.isArray(value)) return `[${value.map(shape).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${shape(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * mergeDurableKeys — the person's keys.json with this key added, or the reason it was not.
 *
 * `added`: the key was free and is now bound. `kept`: it already says exactly this.
 * `migrated`: it said what an earlier install wrote (`terminal.open` running `space new`),
 * so it is the person's own key and it is moved to the form — the tab the old binding
 * opened is the thing this change replaces. `taken`: the person (or another mod) uses that
 * key for something else, and the file is left byte for byte — Herdr's own rule is to ask
 * before replacing a key somebody uses, and an installer has nobody to ask. `unparsable`:
 * not JSON any more, so nothing is touched and the person gets told.
 */
export function mergeDurableKeys(text, binding = DURABLE_ACTION, key = DURABLE_KEY) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { text, state: "unparsable" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text, state: "unparsable" };
	const global =
		parsed.global && typeof parsed.global === "object" && !Array.isArray(parsed.global)
			? parsed.global
			: (parsed.global = {});
	if (key in global) {
		if (shape(global[key]) === shape(binding)) return { text, state: "kept" };
		if (!oldDurableBinding(global[key])) return { text, state: "taken" };
		global[key] = binding;
		return { text: `${JSON.stringify(parsed, null, 2)}\n`, state: "migrated" };
	}
	global[key] = binding;
	return { text: `${JSON.stringify(parsed, null, 2)}\n`, state: "added" };
}
