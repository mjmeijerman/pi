// herdr, headless: the app's API with nothing behind it.
//
// `render()` reads `theme()` and nothing else from here, so the theme is a bag of names — every
// colour in the view is a key on it, and no test asserts a colour. The rest exist because the
// mod imports them at load time; a call that would reach the app throws, so a test that
// accidentally runs one says so instead of quietly passing.
import { element } from "./durable-tree.mjs";

const unreachable = (name) => () => {
	throw new Error(`headless stub: herdr.${name}() was called, and the app is not running`);
};

export const theme = () =>
	Object.fromEntries(
		["foreground", "muted", "dim", "popover", "raised", "selected", "hover", "done", "blocked"].map((name) => [name, name]),
	);
export const props = () => ({});
export const home = () => "/home/someone";
export const exec = unreachable("exec");
export const run = unreachable("run");
export const readTextFile = unreachable("readTextFile");
export const nextCommand = unreachable("nextCommand");
export const closeOverlay = unreachable("closeOverlay");
export const checking = (promise) => promise;
