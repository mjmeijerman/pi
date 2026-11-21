// The key that makes a durable space — and the one place its argv is built.
//
// Why a key at all: `herdr-app commands` lists the app's own actions, and a mod's own
// `<mod>.<command>` is a message handed to an *open* mod. The durable mod is an overlay
// (`"place": "none"`), so when a person wants a space it is almost never open, and
// `durable.new` is not an app command — `herdr-app do durable.new` is an unknown command.
// The palette shows the same list of app commands, so it cannot reach the mod either.
// What is left is an app command that runs the prompt itself: `terminal.open`, place
// "tab", argv `space new`. On a terminal that is the three questions #215 added, and the
// record it writes is the one the guard reopens after a reboot.
//
// No `focus` key: `terminal.open` takes argv, folder, place and name only, and a new tab
// is focused anyway — an unknown argument is a refusal, not a nicety.
//
// No gpui-* and no herdr import, on purpose: plain JavaScript, so install.mjs writes the
// same binding into the person's keys.json that a test can read back without the app.

/** The key. `alt-shift-n` is unbound in the shipped defaults (ctrl-shift-n is `space.new`,
 * and the durable mod's own keys live in `mod:durable`, where `alt-shift-n` means nothing
 * until that overlay is open). */
export const DURABLE_KEY = "alt-shift-n";

/** What the key runs, before the installer resolves `space` for its platform. */
export const SPACE_ARGV = ["space", "new"];

/** The binding as it is written into keys.json, with `space` still to be resolved. */
export const DURABLE_ACTION = { command: "terminal.open", args: { argv: SPACE_ARGV, place: "tab" } };

/**
 * durableBinding — the same binding with argv[0] pointing at the installed program.
 *
 * `binDir` is the installer's own bin directory for this machine (`~/.local/bin`), so the
 * argv carries no home folder anybody typed: the same install on another machine writes
 * its own. Windows runs the `.cmd` the installer writes beside the bash wrapper, which is
 * what a Herdr menu row already does (`programs.json`'s `pi-bare.cmd`).
 */
export function durableBinding({ platform = process.platform, binDir = "" } = {}) {
	const win = platform === "win32";
	const program = binDir ? `${String(binDir).replace(/[\\/]+$/, "")}${win ? "\\" : "/"}${win ? "space.cmd" : "space"}` : SPACE_ARGV[0];
	return { command: "terminal.open", args: { argv: [program, "new"], place: "tab" } };
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
 * `taken`: the person (or another mod) uses that key for something else, and the file is
 * left byte for byte — Herdr's own rule is to ask before replacing a key somebody uses,
 * and an installer has nobody to ask. `unparsable`: not JSON any more, so nothing is
 * touched and the person gets told.
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
	if (key in global) return { text, state: shape(global[key]) === shape(binding) ? "kept" : "taken" };
	global[key] = binding;
	return { text: `${JSON.stringify(parsed, null, 2)}\n`, state: "added" };
}
