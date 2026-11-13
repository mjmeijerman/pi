/**
 * sandbox-badge: "sandbox" in the title when contained, "bare" when it is not.
 *
 * The decision is pure (`readContainment`, `badgeTitle`), so the env matrix
 * needs no fake pi. The wiring proves the two things that matter: the title is
 * set in a TUI session, and it is not set in print/JSON modes or without a UI.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../sandbox-badge.ts");
const sandboxBadge = mod.default;
const {
	readContainment,
	badgeTag,
	badgeTitle,
	baseTitle,
	badgeStatus,
	MODE_ENV,
	NET_ENV,
	SANDBOXED_TAG,
	BARE_TAG,
} = mod;

function setup(options: { mode?: string; env?: Record<string, string | undefined> } = {}) {
	const titles: string[] = [];
	// The extension reads the launcher's marker once, at load: set it first.
	delete process.env[MODE_ENV];
	delete process.env[NET_ENV];
	Object.assign(process.env, options.env ?? { [MODE_ENV]: "bwrap", [NET_ENV]: "on" });
	const fake = createFakePi({ getSessionName: () => "worker" });
	sandboxBadge(fake.pi);
	const { ctx, statuses } = createFakeCtx({
		mode: options.mode ?? "tui",
		hasUI: true,
		ui: { setTitle: (title: string) => titles.push(title) },
	});
	return { ...fake, ctx, titles, statuses };
}

describe("readContainment", () => {
	test("the launcher's marker means sandboxed", () => {
		assert.deepEqual(readContainment({ [MODE_ENV]: "bwrap", [NET_ENV]: "on" }), {
			mode: "bwrap",
			net: "on",
		});
	});

	test("no marker means bare: absence is the signal, not an unknown", () => {
		assert.deepEqual(readContainment({}), { mode: null, net: null });
	});

	test("an empty marker is no marker", () => {
		assert.deepEqual(readContainment({ [MODE_ENV]: "  ", [NET_ENV]: "" }), {
			mode: null,
			net: null,
		});
	});
});

describe("badgeTitle", () => {
	test("sandboxed: word first, base title untouched", () => {
		assert.equal(badgeTitle("π - repo", { mode: "bwrap", net: "on" }), `${SANDBOXED_TAG} π - repo`);
	});

	test("bare: the word says it, no decoration", () => {
		assert.equal(badgeTitle("π - repo", { mode: null, net: null }), `${BARE_TAG} π - repo`);
	});

	test("no network is said out loud", () => {
		assert.equal(badgeTitle("π - repo", { mode: "bwrap", net: "off" }), `${SANDBOXED_TAG} no-net π - repo`);
	});

	test("net=off without a sandbox is not a thing and is not advertised", () => {
		assert.equal(badgeTitle("π - repo", { mode: null, net: "off" }), `${BARE_TAG} π - repo`);
	});

	test("the tag is letters: Herdr strips leading punctuation and symbol fonts fail", () => {
		for (const containment of [
			{ mode: "bwrap", net: "on" },
			{ mode: "bwrap", net: "off" },
			{ mode: null, net: null },
		]) {
			const title = badgeTitle("π - repo", containment);
			// Herdr's agents mod deletes leading non-alphanumerics from a title
			// (`clean()`), so the tag must start with a letter to survive.
			assert.match(title, /^[a-z]/, "a leading letter survives clean()");
			assert.match(badgeTag(containment), /^[a-z]+$/, "ASCII letters only: no glyph the terminal font may lack");
		}
	});

	test("base title keeps the session name pi would have used", () => {
		assert.equal(baseTitle("/home/mark/projects/pi", "worker"), "π - worker - pi");
		assert.equal(baseTitle("/home/mark/projects/pi"), "π - pi");
	});
});

describe("badgeStatus", () => {
	test("says the fact, not the vibe", () => {
		assert.equal(badgeStatus({ mode: "bwrap", net: "on" }), "sandboxed (bwrap)");
		assert.equal(badgeStatus({ mode: "bwrap", net: "off" }), "sandboxed (bwrap) · no net");
		assert.equal(badgeStatus({ mode: null, net: null }), "bare: real home and credentials");
	});
});

describe("wiring", () => {
	test("a TUI session sets a title that carries the shield", async () => {
		const { emit, ctx, titles } = setup();
		await emit("session_start", { reason: "new" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(titles.length, 1);
		assert.match(titles[0], /^sandbox π - worker - /);
	});

	test("the footer status is set per session, not per tab", async () => {
		const { emit, ctx, statuses } = setup();
		await emit("session_start", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(statuses.get("sandbox"), "sandboxed (bwrap)");
	});

	test("a bare session says so in the footer", async () => {
		const { emit, ctx, statuses } = setup({ env: {} });
		await emit("session_start", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(statuses.get("sandbox"), "bare: real home and credentials");
	});

	test("print and JSON modes never touch the title", async () => {
		for (const mode of ["print", "json", "rpc"]) {
			const { emit, ctx, titles, statuses } = setup({ mode });
			await emit("session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.deepEqual(titles, [], `mode ${mode} must stay silent`);
			assert.equal(statuses.get("sandbox"), undefined, `mode ${mode} must not claim a footer`);
		}
	});

	test("a session rename re-applies the badge instead of losing it", async () => {
		const { emit, ctx, titles } = setup();
		await emit("session_info_changed", { name: "worker" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(titles.length, 1);
	});

	test("a missing setTitle is not fatal", async () => {
		const fake = createFakePi({ getSessionName: () => undefined });
		sandboxBadge(fake.pi);
		const { ctx } = createFakeCtx({ mode: "tui", hasUI: true });
		ctx.ui.setTitle = undefined;
		await fake.emit("session_start", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(true);
	});
});
