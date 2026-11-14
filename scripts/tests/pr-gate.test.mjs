// Tests for scripts/pr-gate.sh — the gates .github/workflows/pr-tier.yml runs.
//
// The point of these is today's two red runs: a body that said
// `Review tier: medium` over a diff that touched a harness path, and a body
// whose mission was a `## Mission` heading instead of a `Mission:` line. Both
// must be red here, in a second, rather than red in CI minutes later.
//
// Every case runs the real script and the real template; a fixture template
// would let the thing under test drift away from the thing that ships.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/pr-gate.sh");
const TEMPLATE = join(ROOT, ".github/pull_request_template.md");
const WORKFLOW = join(ROOT, ".github/workflows/pr-tier.yml");

const tmp = mkdtempSync(join(tmpdir(), "pr-gate-"));

let n = 0;
// Run the gate exactly the way `make pr-check` and CI do: a body file, plus
// either an explicit changed-path list or the diff.
function gate({ body, paths, gateName }) {
	const bodyFile = join(tmp, `body-${n++}.md`);
	writeFileSync(bodyFile, body);
	const args = [GATE, "--body", bodyFile];
	if (paths) {
		const pathsFile = join(tmp, `paths-${n++}.txt`);
		writeFileSync(pathsFile, `${paths.join("\n")}\n`);
		args.push("--paths", pathsFile);
	}
	if (gateName) args.push("--gate", gateName);
	// A step summary must not leak into the test's own stdout.
	const env = { ...process.env };
	delete env.GITHUB_STEP_SUMMARY;
	const run = spawnSync("bash", args, { encoding: "utf8", env });
	return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const MISSION = "Mission: whoever opens the next PR learns in a second that the body would fail CI.";
const HARNESS_TEST = "agent/extensions/__tests__/secret-guard-branches.test.ts";
const HARNESS_SRC = "agent/extensions/secret-guard.ts";
const PLAIN_TS = "install.sh"; // source, but not a harness path
const DOC = "docs/kent-beck-craft-harness.md";

// --------------------------------------------------------------- the template --

test("the shipped PR template carries every line the gates read", () => {
	const template = readFileSync(TEMPLATE, "utf8");

	// Literal labels, each at the start of its own line: the gates match lines,
	// not prose and not headings.
	assert.match(template, /^Mission:/m, "template has no literal `Mission:` line");
	assert.match(template, /^Review tier:/m, "template has no literal `Review tier:` line");
	assert.match(template, /^Test change:/m, "template has no literal `Test change:` line");
});

test("the template fails on placeholders, never on a missing line", () => {
	// Each gate reads the real template: "no line" would be a template bug,
	// "still the hint" is the author's job.
	const mission = gate({ body: readFileSync(TEMPLATE, "utf8"), gateName: "mission" });
	assert.equal(mission.status, 1);
	assert.doesNotMatch(mission.out, /states no mission/);
	assert.match(mission.out, /placeholder/);

	const template = readFileSync(TEMPLATE, "utf8");
	const tier = gate({ body: template, paths: [DOC], gateName: "tier" });
	assert.equal(tier.status, 0, tier.out);

	// Every template body changes this file, so the test-change gate always runs.
	const testChange = gate({ body: template, paths: [PLAIN_TS, "agent/prompts/x.test.ts"], gateName: "test-change" });
	assert.equal(testChange.status, 1);
	assert.doesNotMatch(testChange.out, /needs a 'Test change: <reason>'/);
	assert.match(testChange.out, /placeholder/);
});

// ------------------------------------------------------------------- mission --

test("mission: a literal `Mission:` line passes", () => {
	const r = gate({ body: `${MISSION}\n`, gateName: "mission" });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /mission stated/);
});

test("mission: a `## Mission` heading is not a Mission line (PR 59)", () => {
	// The exact shape that went red today: the word is right, the markup in
	// front of it is not a line a gate reads.
	const r = gate({
		body: "## Mission: a reviewer sees which gate failed without opening the logs.\n\nReview tier: High\n",
		gateName: "mission",
	});
	assert.equal(r.status, 1);
	assert.match(r.out, /states no mission/);
});

test("mission: bold, spaced and lower-case prefixes still count", () => {
	const r = gate({ body: "**mission :**  a reviewer can tell which gate failed from the body alone\n", gateName: "mission" });
	assert.equal(r.status, 0, r.out);
});

test("mission: one word after the prefix is not a mission", () => {
	const r = gate({ body: "Mission: fix\n", gateName: "mission" });
	assert.equal(r.status, 1);
	assert.match(r.out, /too short|characters after the prefix/);
});

test("mission: the template hint is a placeholder, not a mission", () => {
	const r = gate({ body: "Mission: <one line: who is better off, and the observation that shows the gain>\n", gateName: "mission" });
	assert.equal(r.status, 1);
	assert.match(r.out, /placeholder/);
});

// ---------------------------------------------------------------------- tier --

test("tier: Medium on a harness path is red and names the path (PR 58)", () => {
	const r = gate({
		body: `${MISSION}\n\nReview tier: medium\n`,
		paths: [HARNESS_TEST, HARNESS_SRC],
		gateName: "tier",
	});
	assert.equal(r.status, 1);
	assert.match(r.out, /tier must be High/);
	assert.match(r.out, /secret-guard-branches\.test\.ts/);
	// The corrected body — same diff, tier High — is green.
	const ok = gate({
		body: `${MISSION}\n\nReview tier: High\n`,
		paths: [HARNESS_TEST, HARNESS_SRC],
		gateName: "tier",
	});
	assert.equal(ok.status, 0, ok.out);
});

test("tier: Medium is fine off the harness paths, and every harness path maps", () => {
	const r = gate({ body: `${MISSION}\n\nReview tier: Medium\n`, paths: [PLAIN_TS, DOC], gateName: "tier" });
	assert.equal(r.status, 0, r.out);

	for (const path of ["agent/extensions/x.ts", "agent/AGENTS.md", ".github/workflows/pr-tier.yml", "git-hooks/pre-commit.d/10-x", "sandbox/pi-sandbox.sh"]) {
		const red = gate({ body: `${MISSION}\n\nReview tier: Low\n`, paths: [path], gateName: "tier" });
		assert.equal(red.status, 1, `${path} should force High`);
		assert.match(red.out, /tier must be High/);
	}
});

test("tier: a body with no tier line is red whatever the diff", () => {
	const r = gate({ body: `${MISSION}\n`, paths: [DOC], gateName: "tier" });
	assert.equal(r.status, 1);
	assert.match(r.out, /states no review tier/);
});

test("tier: without a diff the harness rule is reported, not guessed", () => {
	const r = gate({ body: `${MISSION}\n\nReview tier: Medium\n`, gateName: "tier" });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /no diff given/);
});

// --------------------------------------------------------------- test change --

test("test change: a test beside its source needs a reason in the body", () => {
	const red = gate({ body: `${MISSION}\n\nReview tier: High\n`, paths: [PLAIN_TS, "agent/prompts/x.test.ts"], gateName: "test-change" });
	assert.equal(red.status, 1);
	assert.match(red.out, /Test change: <reason>/);

	const ok = gate({
		body: `${MISSION}\n\nReview tier: High\n\nTest change: the assertion moved to the new entry point.\n`,
		paths: [PLAIN_TS, "agent/prompts/x.test.ts"],
		gateName: "test-change",
	});
	assert.equal(ok.status, 0, ok.out);

	// A sentence that mentions the label is not the label: the line has to start
	// with it, or the template's own explanation would satisfy the gate.
	const prose = gate({
		body: `${MISSION}\n\nReview tier: High\n\nAdd a "Test change: <why>" line if a test moved.\n`,
		paths: [PLAIN_TS, "agent/prompts/x.test.ts"],
		gateName: "test-change",
	});
	assert.equal(prose.status, 1);
	assert.match(prose.out, /Test change: <reason>/);

	// A .test.mjs is a test too: the suffix list is a convention, not one repo's
	// habit, and a gate that cannot see a test cannot ask it to justify itself.
	const mjs = gate({ body: `${MISSION}\n\nReview tier: High\n`, paths: ["scripts/pr-gate.sh", "scripts/tests/pr-gate.test.mjs"], gateName: "test-change" });
	assert.equal(mjs.status, 1);
	assert.match(mjs.out, /Test change: <reason>/);

	// A test alone, or source alone, is not this gate.
	const testOnly = gate({ body: `${MISSION}\n`, paths: ["agent/prompts/x.test.ts"], gateName: "test-change" });
	assert.equal(testOnly.status, 0, testOnly.out);
});

// ------------------------------------------------------------------ workflow --

test("the workflow calls the shared script and keeps no copy of the gates", () => {
	const workflow = readFileSync(WORKFLOW, "utf8");

	for (const name of ["tier", "mission", "test-change"]) {
		assert.match(workflow, new RegExp(`--gate ${name}\\b`), `the workflow never runs --gate ${name}`);
	}
	assert.match(workflow, /scripts\/pr-gate\.sh/, "the workflow does not use scripts/pr-gate.sh");

	// The gate logic itself: a regex, an array of offending paths, or a bash
	// match of the body would all be a copy drifting back into the workflow.
	assert.doesNotMatch(workflow, /BASH_REMATCH/, "the workflow still matches the body itself");
	assert.doesNotMatch(workflow, /harness\+=\(/, "the workflow still maps harness paths itself");
	assert.doesNotMatch(workflow, /review\[\[:space:\]\]\+\s*tier/, "the workflow still parses the tier itself");
	assert.doesNotMatch(workflow, /mission\[\[:space:\]\][^\n]*:(.*)/, "the workflow still parses the mission itself");
	assert.doesNotMatch(workflow, /test\[\[:space:\]\]+change/, "the workflow still parses the test-change line itself");
});

test("make pr-check is the documented local caller of the same script", () => {
	const makefile = readFileSync(join(ROOT, "Makefile"), "utf8");
	assert.match(makefile, /^pr-check:/m, "no pr-check target");
	assert.match(makefile, /scripts\/pr-gate\.sh/);
});
