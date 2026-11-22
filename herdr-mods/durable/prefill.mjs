/**
 * prefill.mjs — the form a durable New copy starts with, from the props it was opened with.
 *
 * A mod can be opened with props (`openOverlay({ mod, props, kind })`), and the caller that
 * does — the prs mod's "create a space for it" — already knows the name and the folder, or the
 * name and the URL. `props()` alone never carries those: the args of a `run("<mod>.<command>")`
 * stay behind, so the form arrived empty and the first press of Create space answered "a space
 * name is a slug … this one is empty".
 *
 * Pure on purpose: props in, a plain object out — no `herdr` import, no `gpui-*`, no file read.
 * The view applies it, so what a fresh copy starts with is testable without opening the window.
 * `scripts/tests/test-durable-prefill.test.mjs` runs it under plain node.
 */

/** The form fields, in the shape the view's InputStates take them. */
const EMPTY = { view: "new", name: "", project: "", clone: false, url: "" };

/**
 * The form a fresh copy starts with: `{ view, name, project, clone, url }`.
 *
 * - `view`: "forget"/"list" when the props say so, else "new" — the rule the view already had.
 * - `name`: trimmed and never validated here; an invalid name is the field's grey rule line,
 *   not a refusal, and the person can still edit it.
 * - a `url` wins over a `project` when both are given: a URL is an explicit "clone this", and
 *   the folder that lands in `~/projects/<name>` is not one the caller could have known.
 * - no props at all (`props()` null: `mod.open`, the key, a person started typing): empty form.
 */
export function initialForm(props) {
	if (!props || typeof props !== "object") return { ...EMPTY };
	const view = props.view === "forget" || props.view === "list" ? props.view : "new";
	const name = String(props.name ?? "").trim();
	const url = String(props.url ?? "").trim();
	if (url) return { view, name, project: "", clone: true, url };
	return { view, name, project: String(props.project ?? "").trim(), clone: false, url: "" };
}
