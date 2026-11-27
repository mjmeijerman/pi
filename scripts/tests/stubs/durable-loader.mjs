// A resolve hook that swaps the app's three bare imports for inert stubs.
//
// `herdr-mods/durable/main.js` imports `gpui-kit`, `gpui-base` and `herdr`, none of which exist
// under plain node — they are the running app. Mapping the specifiers (and nothing else) lets
// `render()` build its real tree in a test; relative imports inside the mod resolve as usual.
const stubs = new Map([
	["gpui-kit", new URL("./durable-gpui-kit.mjs", import.meta.url).href],
	["gpui-base", new URL("./durable-gpui-base.mjs", import.meta.url).href],
	["herdr", new URL("./durable-herdr.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, next) {
	const stub = stubs.get(specifier);
	if (stub) return { url: stub, format: "module", shortCircuit: true };
	return next(specifier, context);
}
