// A headless stand-in for gpui-kit/gpui-base's element chain.
//
// The durable mod builds its view tree with `v_flex().id(...).flex_1()...`, and whether a
// scroll container scrolls is decided by the props on that chain, not by anything the app
// returns. So the stub records the chain instead of drawing: every call is kept in `props`,
// children keep a `parent` pointer, and `walk` hands the real tree to a test.
//
// Nothing here renders. `durable-scroll.test.mjs` is the one reader.

/** One element: tag, recorded props, children, parent. `child`, `children`, `when` and `id`
 * behave; every other builder call is recorded and returns the element, so a chain of any
 * length stays walkable. */
export function element(tag) {
	const self = { tag, props: {}, kids: [], parent: null };
	const add = (list) => {
		for (const kid of list) {
			if (kid && typeof kid === "object" && kid.kids) {
				kid.parent = self;
				self.kids.push(kid);
			}
		}
	};
	const proxy = new Proxy(self, {
		get(target, prop) {
			if (typeof prop === "symbol") return target[prop];
			if (prop === "then" || prop === "constructor" || prop === "toJSON") return undefined;
			if (prop === "kids" || prop === "props" || prop === "parent" || prop === "tag") {
				return target[prop];
			}
			return (...args) => {
				if (prop === "child" || prop === "children") {
					add(prop === "child" ? args.slice(0, 1) : args[0] || []);
					return proxy;
				}
				if (prop === "when") {
					if (args[0]) args[1](proxy);
					return proxy;
				}
				target.props[prop] = args.length === 1 ? args[0] : args;
				return proxy;
			};
		},
	});
	return proxy;
}

/** The label a failure prints: the element's `.id()`, or its tag when it has none. */
export const label = (node) => node.props.id || node.tag;

/** Depth-first, in draw order. */
export function walk(root, visit) {
	visit(root);
	for (const kid of root.kids) walk(kid, visit);
}

/** The element's chain up to the root, nearest ancestor first. */
export function ancestors(node) {
	const chain = [];
	for (let p = node.parent; p; p = p.parent) chain.push(p);
	return chain;
}
