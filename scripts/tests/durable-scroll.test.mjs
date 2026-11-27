// The durable overlay's tree is built under plain node so its layout can be read: every scroll
// container must sit in a chain of bounded ancestors up to `durable-root`, or it sizes to its
// content and the rows below the fold are unreachable.
//
// The bug this pins: `render()` bounded `durable-root` and `durable-body`, and then `rowsView()`
// returned an unbounded `v_flex` holding an unbounded rows container with
// `.overflow_y_scrollbar()`. A scrollbar in a flex column only scrolls when its height is
// bounded, so with six or more recorded spaces the last rows drew past the overlay's edge. No
// test could tell that apart before; this one reads the chain instead of a screenshot.
//
// Stubbed, not faked: `stubs/durable-loader.mjs` maps `gpui-kit`, `gpui-base` and `herdr` to
// inert modules that record the element chain (see `stubs/durable-tree.mjs`). `render()` itself
// runs unmodified, and `main.js` is imported from its real path.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { ancestors, label, walk } from "./stubs/durable-tree.mjs";

register(new URL("./stubs/durable-loader.mjs", import.meta.url));

const { default: Durable } = await import("../../herdr-mods/durable/main.js");

/** Eight recorded spaces: the count the overlay could not show. */
const rows = Array.from({ length: 8 }, (_, i) => ({
	name: `space-${i}`,
	project: `~/projects/space-${i}`,
	git: true,
	state: i % 2 ? "watched" : "idle",
}));

/** `render()` reads these fields and no others; `init()` (focus handle, inputs, the app) is not
 * needed to build the tree, so it is not run. */
function render(view) {
	const mod = Object.create(Durable.prototype);
	Object.assign(mod, {
		view,
		rows,
		watching: {},
		loading: false,
		error: "",
		notice: "",
		busy: false,
		ran: null,
		confirm: "",
		spacePath: "",
	});
	return mod.render({});
}

const scrolls = (root) => {
	const found = [];
	walk(root, (node) => {
		if ("overflow_y_scrollbar" in node.props) found.push(node);
	});
	return found;
};

/** A node is bounded when it cannot grow to its content: `min_h(0)` is what allows a flex child
 * to shrink below its content in the first place, and `flex_1` is what makes it the part that
 * takes the leftover height. */
const bounded = (node) => node.props.min_h === 0 && ("flex_1" in node.props || "size_full" in node.props);

for (const view of ["list", "forget"]) {
	test(`${view}: every scroll container is bounded, and so is every ancestor`, () => {
		const root = render(view);
		assert.equal(label(root), "durable-root", "render() must still return the overlay root");

		const found = scrolls(root);
		assert.ok(found.length > 0, `the ${view} view no longer has a scroll container — this test has nothing to read`);

		for (const node of found) {
			assert.ok(bounded(node), `${label(node)} scrolls but is not bounded (needs min_h(0) and flex_1)`);

			const chain = ancestors(node);
			assert.equal(label(chain.at(-1)), "durable-root", `${label(node)} must hang off durable-root`);
			for (const above of chain) {
				assert.equal(
					above.props.min_h,
					0,
					`${label(above)} bounds nothing: min_h(0) is missing between ${label(node)} and the root, so the rows grow past the overlay`,
				);
			}
		}
	});
}

test("the header and the tabs stay outside the scrolled area", () => {
	const root = render("list");
	const found = scrolls(root).find((node) => label(node) === "durable-list-rows");
	assert.ok(found, "durable-list-rows is the list's scroll container");

	const chain = new Set([found, ...ancestors(found)].map(label));
	for (const fixed of ["durable-root"]) {
		assert.ok(chain.has(fixed), `${fixed} must still bound the rows`);
	}
	// The title row and the tabs are siblings of the scrolled area: they keep their height, only
	// the rows move. A tab inside the scroll container would scroll away with them.
	walk(root, (node) => {
		if (label(node).startsWith("durable-tab-")) {
			assert.ok(!ancestors(node).includes(found), `${label(node)} scrolls with the rows; the tabs stay fixed`);
		}
	});
});
