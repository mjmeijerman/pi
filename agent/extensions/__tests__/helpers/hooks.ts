/**
 * Module resolution hooks for the extension tests.
 *
 * The extensions import `@earendil-works/pi-*`, which is not resolvable from
 * ~/.pi/agent (they live in the pnpm store). Import this module *first* in a
 * test file; it maps those bare specifiers — plus `node:child_process` — to
 * the stubs in ./stubs/.
 */
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "stubs");

const MAP: Record<string, string> = {
	"@earendil-works/pi-coding-agent": join(stubsDir, "pi-coding-agent.mjs"),
	"@earendil-works/pi-ai": join(stubsDir, "pi-ai.mjs"),
	"@earendil-works/pi-tui": join(stubsDir, "pi-tui.mjs"),
	"node:child_process": join(stubsDir, "child-process.mjs"),
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		const target = MAP[specifier];
		// Never remap an import made by a stub itself (that would self-import).
		const fromStub = context.parentURL?.startsWith(pathToFileURL(stubsDir).href);
		if (target && !fromStub) return { url: pathToFileURL(target).href, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
