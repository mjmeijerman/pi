// Tests for .github/scripts/prose-review.mjs and the workflow that calls it.
//
// The point: the review's prompt and its parsing are the thing under review
// here, not the model's opinion. Everything below runs offline — no secret, no
// endpoint, no network — so a broken prompt is red in a second instead of a
// silently different review on the next instruction PR.
//
// The last test reads the workflow's own `paths:` filter and compares it with
// the script's list: a trigger that fires for different files than the script
// reviews is a review that never sees what it was started for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	INSTRUCTION_PATHS,
	MAX_CHANGED_LINES,
	MAX_OUTPUT_TOKENS,
	QUESTIONS,
	buildRequest,
	changedLineCount,
	diffPaths,
	isInstructionPath,
	parseAnswer,
	renderComment,
} from "../../.github/scripts/prose-review.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, ".github/scripts/prose-review.mjs");
const WORKFLOW = join(ROOT, ".github/workflows/prose-review.yml");

// A real-looking instruction diff: one AGENTS.md rule and one SKILL.md edit.
const DIFF = [
	"diff --git a/agent/AGENTS.md b/agent/AGENTS.md",
	"--- a/agent/AGENTS.md",
	"+++ b/agent/AGENTS.md",
	"@@ -1,3 +1,4 @@",
	" # Global rules",
	" ",
	"-Use `make pr-check` before the PR goes out.",
	"+Use `make pr-review` before the PR goes out.",
	"diff --git a/agent/skills/jev/SKILL.md b/agent/skills/jev/SKILL.md",
	"--- a/agent/skills/jev/SKILL.md",
	"+++ b/agent/skills/jev/SKILL.md",
	"@@ -1,2 +1,3 @@",
	" # jev",
	"+Ask jev before every tool call.",
	"",
].join("\n");

function run(args, input, env = {}) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd: ROOT,
		input,
		encoding: "utf8",
		env: { ...process.env, PROSE_REVIEW_API_KEY: "", ...env },
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A diff with an exact number of changed lines, so the cap can be tested from
// both sides instead of only "some big diff".
function diffWithChangedLines(n) {
	const lines = ["diff --git a/agent/AGENTS.md b/agent/AGENTS.md", "--- a/agent/AGENTS.md", "+++ b/agent/AGENTS.md", "@@ -1 +1 @@"];
	for (let i = 0; i < n; i += 1) lines.push(`+rule ${i}`);
	return `${lines.join("\n")}\n`;
}

test("--dry-run prints the request with all five questions, in order", () => {
	const { status, stdout, stderr } = run(["--dry-run", "--root", ROOT], DIFF);
	assert.equal(status, 0, stderr);
	const request = JSON.parse(stdout);

	assert.equal(request.messages.length, 2);
	const user = request.messages[1].content;
	for (const [i, question] of QUESTIONS.entries()) {
		assert.ok(user.includes(`${i + 1}. ${question}`), `question ${i + 1} missing from the request`);
	}
	assert.equal(QUESTIONS.length, 5);
});

test("the request caps the output tokens and sends temperature 0", () => {
	const request = buildRequest({ diff: DIFF, commands: [], files: [], contents: "" });
	assert.equal(request.max_tokens, MAX_OUTPUT_TOKENS);
	assert.equal(MAX_OUTPUT_TOKENS, 700);
	assert.equal(request.temperature, 0);
	assert.match(request.messages[0].content, /at most 700 output tokens/i);
});

test("the request names the commands that exist, so question 2 is answerable", () => {
	const { stdout } = run(["--dry-run", "--root", ROOT], DIFF);
	const user = JSON.parse(stdout).messages[1].content;
	assert.match(user, /Commands that exist in the tree/);
	assert.ok(user.includes("pr-gate.sh"), "scripts/pr-gate.sh should be in the command inventory");
	assert.ok(user.includes("make pr-check"), "the Makefile target should be in the command inventory");
	assert.ok(user.includes("agent/AGENTS.md"), "the instruction file list should be in the request");
});

test("the current text of the changed instruction files is in the request", () => {
	const request = buildRequest({
		diff: DIFF,
		commands: [],
		files: ["agent/AGENTS.md"],
		contents: "### agent/AGENTS.md\n\n```\nNever merge on trunk.\n```",
	});
	assert.match(request.messages[1].content, /Never merge on trunk/);
});

test(`a diff of exactly ${MAX_CHANGED_LINES} changed lines is reviewed`, () => {
	const { status, stdout, stderr } = run(["--dry-run", "--root", ROOT], diffWithChangedLines(MAX_CHANGED_LINES));
	assert.equal(status, 0, stderr);
	assert.ok(JSON.parse(stdout).messages);
});

test(`a diff of ${MAX_CHANGED_LINES + 1} changed lines is refused before any request`, () => {
	const { status, stdout, stderr } = run(["--dry-run", "--root", ROOT], diffWithChangedLines(MAX_CHANGED_LINES + 1));
	assert.equal(status, 3);
	assert.equal(stdout, "", "a refused review must not print a request");
	assert.match(stderr, /refused/);
	assert.match(stderr, /cap is 400/);
});

test("an empty diff is an error, not an empty review", () => {
	const { status, stderr } = run(["--dry-run", "--root", ROOT], "\n\n");
	assert.equal(status, 2);
	assert.match(stderr, /empty diff/);
});

test("live mode without an API key says not configured and exits 4", () => {
	const { status, stdout, stderr } = run(["--root", ROOT], DIFF);
	assert.equal(status, 4);
	assert.equal(stdout, "");
	assert.match(stderr, /not configured/);
	assert.match(stderr, /PROSE_REVIEW_API_KEY/);
});

test("changed lines count added and removed lines but not the file headers", () => {
	// One removed and one added line in AGENTS.md, one added line in the skill.
	assert.equal(changedLineCount(DIFF), 3);
	assert.equal(changedLineCount(diffWithChangedLines(7)), 7);
	assert.equal(changedLineCount(""), 0);
});

test("only instruction files are reviewed", () => {
	const paths = diffPaths(DIFF);
	assert.deepEqual(paths, ["agent/AGENTS.md", "agent/skills/jev/SKILL.md"]);
	assert.deepEqual(paths.filter(isInstructionPath), paths);
});

test("a parsed answer keeps every citation it was given", () => {
	const answer = JSON.stringify([
		{ question: 1, finding: "agent/AGENTS.md:12 contradicts agent/prompts/grill.md:4" },
		{ question: 2, finding: "agent/AGENTS.md:4 names `make pr-review`, which the Makefile does not have" },
		{ question: 3, finding: "no finding" },
		{ question: 4, finding: "no finding" },
		{ question: 5, finding: "agent/AGENTS.md:4 makes the old pr-check sentence false" },
	]);
	const parsed = parseAnswer(answer);
	assert.equal(parsed.length, 5);
	assert.match(parsed[1].finding, /agent\/AGENTS\.md:4/);
	assert.equal(parsed[2].finding, "no finding");
});

test("a fenced JSON answer is parsed, because models add fences", () => {
	const answers = QUESTIONS.map((_, i) => ({ question: i + 1, finding: "no finding" }));
	const fenced = "Here you go:\n```json\n" + JSON.stringify(answers) + "\n```\n";
	assert.equal(parseAnswer(fenced).length, 5);
});

test("an answer with the wrong number of findings is an error, not a green review", () => {
	assert.throws(() => parseAnswer(JSON.stringify([{ question: 1, finding: "no finding" }])), /expected 5 answers/);
	assert.throws(() => parseAnswer("I could not review this."), /no JSON array/);
	assert.throws(() => parseAnswer(JSON.stringify([{ question: 1, finding: "" }, { question: 2, finding: "x" }, { question: 3, finding: "x" }, { question: 4, finding: "x" }, { question: 5, finding: "x" }])), /has no finding/);
});

test("the comment is one line per question, with no score and no verdict", () => {
	const comment = renderComment(
		QUESTIONS.map((_, i) => ({ question: i + 1, label: `label ${i + 1}`, finding: "no finding" })),
		{ model: "test-model" },
	);
	const numbered = comment.split("\n").filter((line) => /^\d\. /.test(line));
	assert.equal(numbered.length, 5);
	assert.match(comment, /^<!-- prose-review -->$/m);
	assert.doesNotMatch(comment, /looks good|score|grade|approved/i);
});

test("the workflow triggers on exactly the paths the script reviews", () => {
	const workflow = readFileSync(WORKFLOW, "utf8");
	const block = /^ {4}paths:\n((?: {6}- .*\n)+)/m.exec(workflow);
	assert.ok(block, "the workflow has no pull_request paths block");
	const paths = block[1]
		.split("\n")
		.filter(Boolean)
		.map((line) => line.replace(/^ {6}- /, ""));
	assert.deepEqual(paths, INSTRUCTION_PATHS);

	const workflowGlobs = paths.map((p) => p.replace(/\*\*\/\*?/g, "").replace(/\*\*$/g, ""));
	for (const sample of ["agent/AGENTS.md", "agent/prompts/grill.md", "agent/skills/jev/SKILL.md"]) {
		assert.ok(isInstructionPath(sample), `${sample} should be reviewed`);
		assert.ok(
			workflowGlobs.some((glob) => sample.replace(/\/[^/]+$/, "/").startsWith(glob.replace(/\/[^/]+$/, "/"))),
			`${sample} should trigger the workflow`,
		);
	}
	assert.match(workflow, /\.github\/scripts\/prose-review\.mjs/);
	assert.match(workflow, /not configured/);
	assert.match(workflow, /refused/);
});
