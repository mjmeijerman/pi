/**
 * usage-footer: number formatting + usage aggregation / cost-total math.
 *
 * The footer is exercised end-to-end: a fake session branch is rendered and the
 * resulting lines are asserted. calculateCost comes from the real pi-ai package
 * (see stubs/pi-ai.mjs), so the cost expectations below are pi's own math.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createFakeCtx, createFakePi, tick } from "./helpers/fake-pi.ts";
import { fmtCost, fmtCostPart, fmtTokens } from "../lib/usage-format.ts";

const usageFooter = (await import("../usage-footer.ts")).default;
const piAi = await import("@earendil-works/pi-ai");
const piTui = await import("@earendil-works/pi-tui");

const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const MARKED_THEME = {
	fg: (color: string, text: string) => `<${color}>${text}</>`,
	bold: (text: string) => `<b>${text}</>`,
};

function zeroCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost = zeroCost()) {
	return { input, output, cacheRead, cacheWrite, cost };
}

interface RenderOptions {
	branch: any[];
	model?: any;
	theme?: { fg(c: string, s: string): string; bold(s: string): string };
	branchName?: string | null;
	sessionName?: string | null;
	statuses?: [string, string][];
	contextUsage?: any;
	cwd?: string;
	width?: number;
}

/** Install the footer through the extension and render it once. */
async function renderFooter(options: RenderOptions): Promise<string[]> {
	const {
		branch,
		model = { id: "test-model", reasoning: false, contextWindow: 1_000_000, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } },
		theme = PLAIN_THEME,
		branchName = "main",
		sessionName = "demo-sess",
		statuses = [],
		contextUsage = { contextWindow: 1_000_000, percent: 12.5, tokens: 125_000 },
		cwd = join(homedir(), "project"),
		width = 200,
	} = options;

	const fake = createFakePi();
	usageFooter(fake.pi);

	const { ctx, setFooterCalls } = createFakeCtx({
		mode: "tui",
		model,
		thinkingLevel: "off",
		sessionManager: {
			getBranch: () => branch,
			getCwd: () => cwd,
			getSessionName: () => sessionName,
		},
		getContextUsage: () => contextUsage,
	});

	await fake.emit("session_start", {}, ctx);
	await tick(); // enableFooter is deferred with setTimeout(0)

	const factory = setFooterCalls.at(-1);
	assert.equal(typeof factory, "function", "footer should be installed on session_start");

	const footer = factory({ requestRender() {} }, theme, {
		onBranchChange: () => () => {},
		getGitBranch: () => branchName,
		getExtensionStatuses: () => new Map(statuses),
	});
	return footer.render(width);
}

describe("fmtTokens", () => {
	const cases: [number, string][] = [
		[0, "0"],
		[999, "999"],
		[1000, "1.0k"],
		[1500, "1.5k"],
		[9999, "10k"],
		[10_000, "10k"],
		[125_000, "125k"],
		[999_999, "1.0M"],
		[1_000_000, "1.0M"],
		[1_250_000, "1.3M"],
		[9_999_999, "10M"],
		[10_000_000, "10M"],
		[123_456_789, "123M"],
		[999_999_999, "1.0B"],
		[1_000_000_000, "1.0B"],
	];

	for (const [input, expected] of cases) {
		test(`${input} -> ${expected}`, () => assert.equal(fmtTokens(input), expected));
	}

	// The bug class these all share: the precision was chosen from the raw value,
	// so the rounded string filled its unit (1000k, 10.0k) or showed a decimal the
	// next tier does not use.
	test("no boundary value prints a full unit (1000x) or a trailing .0 below ten", () => {
		for (const n of [999, 9999, 10_000, 999_999, 1_000_000, 9_999_999, 10_000_000, 999_999_999]) {
			const out = fmtTokens(n);
			assert.ok(!out.startsWith("1000"), `${n} -> ${out} should have been promoted`);
			if (/[kMBT]$/.test(out)) {
				assert.ok(!/^10\.0[kMBT]$/.test(out), `${n} -> ${out} should drop the decimal`);
			}
		}
	});
});

describe("fmtCost", () => {
	const cases: [number, string][] = [
		[0, "$0"],
		[-5, "$0"],
		[Number.NaN, "$0"],
		[Number.POSITIVE_INFINITY, "$0"],
		[0.00005, "$0.0001"],
		[0.25, "$0.2500"],
		[0.9999, "$0.9999"],
		[0.99999, "$1.000"],
		[1, "$1.000"],
		[1.2345, "$1.234"],
		[12.3456, "$12.346"],
		[99.999, "$100.00"],
		[100, "$100.00"],
		[999.4, "$999.40"],
		[999.999, "$1000.0"],
		[1234.56, "$1234.6"],
	];

	for (const [input, expected] of cases) {
		test(`${input} -> ${expected}`, () => assert.equal(fmtCost(input), expected));
	}
});

describe("fmtCostPart", () => {
	test("two decimals for positive finite values", () => assert.equal(fmtCostPart(1.234), "1.23"));
	test("boundary values round before formatting", () => {
		assert.equal(fmtCostPart(0.9999), "1.00");
		assert.equal(fmtCostPart(99.999), "100.00");
		assert.equal(fmtCostPart(999.999), "1000.00");
	});
	test("empty string for zero/negative/non-finite", () => {
		assert.equal(fmtCostPart(0), "");
		assert.equal(fmtCostPart(-1), "");
		assert.equal(fmtCostPart(Number.NaN), "");
	});
});

describe("usage aggregation", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{
			type: "message",
			message: { role: "assistant", usage: usage(1_000_000, 500_000, 2_000_000, 1_000_000), timestamp: 0 },
		},
		{ type: "message", message: { role: "toolResult", usage: usage(2_000_000, 0, 0, 0), timestamp: 0 } },
		{ type: "compaction", usage: usage(2_000_000, 0, 2_000_000, 0), timestamp: 0 },
	];

	test("totals tokens, counts and cost the same way pi's footer does", async () => {
		const [line1, line2, line3] = await renderFooter({ branch });

		assert.match(line1, /~\/project \(main\) • demo-sess/);
		assert.match(line1, /test-model$/);

		assert.match(line2, /input 5\.0M/);
		assert.match(line2, /output 500k/);
		assert.match(line2, /cache read 4\.0M/);
		assert.match(line2, /cache write 1\.0M/);
		assert.match(line2, /cache hit 50\.0%/);
		assert.match(line2, /context 12\.5% \(125k\/1\.0M\)/);
		assert.match(line2, /cost \$9\.000/);
		assert.match(line2, /\(input 5\.00 \/ output 1\.00 \/ cache read 2\.00 \/ cache write 1\.00\)/);

		assert.match(line3, /messages 2/);
		assert.match(line3, /tool calls 1/);
		assert.match(line3, /compactions 1/);
	});

	test("cache hit rate is coloured by threshold", async () => {
		const [, line2] = await renderFooter({ branch, theme: MARKED_THEME });
		assert.match(line2, /<warning>50\.0%<\/>/);
	});

	test("extension statuses land on line 3", async () => {
		const [, , line3] = await renderFooter({ branch, statuses: [["dictation", "● REC"]] });
		assert.match(line3, /● REC/);
	});

	test("an empty branch renders no token stats and no counts line", async () => {
		const lines = await renderFooter({ branch: [], statuses: [], sessionName: null });
		assert.equal(lines.length, 2, "no third line without messages or statuses");
		assert.ok(!/input|output|cache read/.test(lines[1]));
		assert.match(lines[1], /cost \$0/);
	});

	test("branch summary usage is counted but not counted as a compaction", async () => {
		const [, line2, line3] = await renderFooter({
			branch: [{ type: "branch_summary", usage: usage(1_000_000, 0, 0, 0), timestamp: 0 }],
		});
		assert.match(line2, /input 1\.0M/);
		assert.match(line2, /cost \$1\.000/);
		assert.ok(!/compactions/.test(line3 ?? ""));
	});
});

describe("cost math", () => {
	const assistant = (u: any, timestamp = 0) => [
		{ type: "message", message: { role: "assistant", usage: u, timestamp } },
	];

	test("trusts a provider-reported cost", async () => {
		const reported = { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1.5 };
		const [, line2] = await renderFooter({ branch: assistant(usage(10, 10, 0, 0, reported)) });
		assert.match(line2, /cost \$1\.500/);
		assert.match(line2, /\(input 1\.00 \/ output 0\.50\)/);
	});

	test("computes cost from static rates when the provider reports zero", async () => {
		const [, line2] = await renderFooter({ branch: assistant(usage(1_000_000, 1_000_000, 0, 0)) });
		// 1M input @ $1/M + 1M output @ $2/M
		assert.match(line2, /cost \$3\.000/);
	});

	test("shows $0 when the model has no pricing and the provider reports none", async () => {
		const [, line2] = await renderFooter({
			branch: assistant(usage(1000, 1000, 0, 0)),
			model: { id: "unpriced", reasoning: false, contextWindow: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		});
		assert.match(line2, /cost \$0/);
	});

	test("DeepSeek is always recomputed with peak rates at 02:00 UTC", async () => {
		const timestamp = Date.UTC(2026, 0, 15, 2, 0, 0);
		const reported = { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 };
		const [, line2] = await renderFooter({
			branch: assistant(usage(1_000_000, 0, 0, 0, reported), timestamp),
			model: { id: "deepseek-v4-flash", reasoning: false, contextWindow: 0, cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 } },
		});
		assert.match(line2, /cost \$0\.440/, "peak input rate is $0.44/M");
	});

	test("DeepSeek uses off-peak rates at 12:00 UTC", async () => {
		const timestamp = Date.UTC(2026, 0, 15, 12, 0, 0);
		const [, line2] = await renderFooter({
			branch: assistant(usage(1_000_000, 0, 0, 0), timestamp),
			model: { id: "deepseek-v4-flash", reasoning: false, contextWindow: 0, cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 } },
		});
		assert.match(line2, /cost \$0\.220/, "off-peak input rate is $0.22/M");
	});
});

describe("installation and toggle", () => {
	test("does not install the footer outside TUI mode", async () => {
		const fake = createFakePi();
		usageFooter(fake.pi);
		const { ctx, setFooterCalls } = createFakeCtx({ mode: "rpc" });
		await fake.emit("session_start", {}, ctx);
		await tick();
		assert.equal(setFooterCalls.length, 0);
	});

	test("/usage-footer toggles the custom footer", async () => {
		const fake = createFakePi();
		usageFooter(fake.pi);
		const { ctx, setFooterCalls, notices } = createFakeCtx({ mode: "tui" });
		const command = fake.commands.get("usage-footer");
		assert.ok(command, "the /usage-footer command must be registered");

		await command.handler("", ctx);
		assert.equal(setFooterCalls.length, 1);
		assert.match(notices.at(-1)!.message, /enabled/);

		await command.handler("", ctx);
		assert.equal(setFooterCalls.at(-1), undefined, "disabling passes undefined to setFooter");
		assert.match(notices.at(-1)!.message, /disabled/);
	});
});

describe("stub fidelity", () => {
	// Locally the real packages come from the pnpm store; in CI they are installed
	// into agent/node_modules. When neither is present the suite still runs, with
	// the fallback implementations, and these two checks report a skip.
	const missing = "real @earendil-works package not found (set PI_REAL_PACKAGES_DIR)";
	test("pi-ai calculateCost comes from the real package", { skip: piAi.realLoaded ? false : missing }, () => {
		assert.equal(piAi.realLoaded, true);
	});
	test("pi-tui width helpers come from the real package", { skip: piTui.realLoaded ? false : missing }, () => {
		assert.equal(piTui.realLoaded, true);
	});
});
