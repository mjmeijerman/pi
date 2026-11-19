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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/pr-gate.sh");
const TEMPLATE = join(ROOT, ".github/pull_request_template.md");
const WORKFLOW = join(ROOT, ".github/workflows/pr-tier.yml");

const tmp = mkdtempSync(join(tmpdir(), "pr-gate-"));

// A test's own git repo, and its own git identity: the no-PATHS cases need a
// real diff, and the host's git config must not decide what that diff is.
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "pr-gate test",
	GIT_AUTHOR_EMAIL: "gate@example.invalid",
	GIT_COMMITTER_NAME: "pr-gate test",
	GIT_COMMITTER_EMAIL: "gate@example.invalid",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd, ...args) {
	const run = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
	assert.equal(run.status, 0, `git ${args.join(" ")} failed: ${run.stderr}`);
	return run.stdout.trim();
}

// `main`, not `trunk`: a local trunk would make the derivation resolve, and the
// unresolvable case has to be unresolvable.
function makeRepo(name, branch = "main") {
	const dir = join(tmp, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", branch);
	return dir;
}

function commit(cwd, files, message) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	}
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "--no-gpg-sign", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

let n = 0;
// Run the gate exactly the way `make pr-check` and CI do: a body file, plus
// either an explicit changed-path list, the diff, or nothing at all. `cwd`
// defaults to a non-repository so a test that gives no file list cannot pick up
// the diff of the checkout it is running in.
function gate({ body, paths, branch, gateName, cwd = tmp, env: extraEnv = {} }) {
	const bodyFile = join(tmp, `body-${n++}.md`);
	writeFileSync(bodyFile, body);
	const args = [GATE, "--body", bodyFile];
	if (branch) args.push("--branch", branch);
	if (paths) {
		const pathsFile = join(tmp, `paths-${n++}.txt`);
		writeFileSync(pathsFile, `${paths.join("\n")}\n`);
		args.push("--paths", pathsFile);
	}
	if (gateName) args.push("--gate", gateName);
	// A step summary must not leak into the test's own stdout, and CI's shas in
	// the ambient environment would decide a diff this test did not ask for.
	const env = { ...process.env };
	delete env.GITHUB_STEP_SUMMARY;
	delete env.BASE_SHA;
	delete env.HEAD_SHA;
	Object.assign(env, extraEnv);
	const run = spawnSync("bash", args, { encoding: "utf8", cwd, env });
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

test("tier: without a diff the run is red, never green (PR 67)", () => {
	// No --paths, no --base/--head, and no repository: the gate cannot know what
	// changed, so it must not claim the harness-path rule held.
	const r = gate({ body: `${MISSION}\n\nReview tier: Medium\n`, gateName: "tier" });
	assert.notEqual(r.status, 0, r.out);
	assert.match(r.out, /origin\/trunk/);
	assert.doesNotMatch(r.out, /pr-gate: green/);
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

// ------------------------------------------------------- deriving the file list --
// PR 67: `make pr-check BODY=pr.md` with no PATHS was handed zero files, read
// that as "no test changed", and printed `pr-gate: green (all)` for a body the
// same commit failed in CI. These three cases are that bug, its fix, and the
// explicit-list path that has to keep working.

test("no PATHS: the changed files come from git, so a test beside source is red", () => {
	const dir = makeRepo("derive-resolvable");
	const base = commit(dir, { "install.sh": "#!/bin/sh\necho base\n", "agent/prompts/x.test.ts": "export {};\n" }, "base");
	// What a clone has: a remote-tracking trunk to diff the branch against.
	git(dir, "update-ref", "refs/remotes/origin/trunk", base);
	git(dir, "switch", "-q", "-c", "feature");
	commit(dir, { "install.sh": "#!/bin/sh\necho branch\n", "agent/prompts/x.test.ts": "export const x = 1;\n" }, "source and its test move together");

	// No --paths and no --base/--head: the script has to find the diff itself.
	const red = gate({ body: `${MISSION}\n\nReview tier: High\n`, cwd: dir });
	assert.equal(red.status, 1, red.out);
	assert.match(red.out, /tests changed: 1; source changed: 1/, red.out);
	assert.match(red.out, /merge base of origin\/trunk and HEAD/, red.out);
	assert.match(red.out, /Test change: <reason>/, red.out);
	assert.doesNotMatch(red.out, /pr-gate: green/);

	// The same derived diff with the reason in the body is green, so the red
	// above is the rule and not the derivation.
	const ok = gate({
		body: `${MISSION}\n\nReview tier: High\n\nTest change: the assertion moved to the new entry point.\n`,
		cwd: dir,
	});
	assert.equal(ok.status, 0, ok.out);
	assert.match(ok.out, /pr-gate: green/, ok.out);
});

test("no PATHS: a diff that cannot be resolved is a loud error, not a green verdict", () => {
	// No origin/trunk and no local trunk: nothing to diff HEAD against.
	const dir = makeRepo("derive-unresolvable");
	commit(dir, { "install.sh": "#!/bin/sh\necho alone\n" }, "base");

	const r = gate({ body: `${MISSION}\n\nReview tier: High\n\nTest change: a reason that would pass.\n`, cwd: dir });
	assert.notEqual(r.status, 0, r.out);
	assert.match(r.out, /no origin\/trunk/, r.out);
	assert.doesNotMatch(r.out, /pr-gate: green/, r.out);
});

test("an empty paths file is a gate handed nothing: it says what it could not check", () => {
	// The exact shape of the bug: zero files in, "nothing to justify" out.
	const r = gate({ body: `${MISSION}\n\nReview tier: High\n`, paths: [] });
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /lists no files/, r.out);
	assert.match(r.out, /not checked/, r.out);
	assert.doesNotMatch(r.out, /pr-gate: green/);
});

test("an explicit PATHS list still decides the diff, whatever git would say", () => {
	// The repo's own diff touches a harness path; the caller says it does not.
	const dir = makeRepo("explicit-wins");
	const base = commit(dir, { "install.sh": "#!/bin/sh\necho base\n" }, "base");
	git(dir, "update-ref", "refs/remotes/origin/trunk", base);
	commit(dir, { "agent/extensions/secret-guard.ts": "export const x = 2;\n" }, "harness path");

	const r = gate({ body: `${MISSION}\n\nReview tier: Medium\n`, paths: [DOC], cwd: dir, gateName: "tier" });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /paths file .*\(1 changed files\)/, r.out);
});

test("BASE_SHA/HEAD_SHA from the environment decide the diff, as in CI", () => {
	const dir = makeRepo("ci-shas");
	const base = commit(dir, { "install.sh": "#!/bin/sh\necho base\n" }, "base");
	const head = commit(dir, { ".github/workflows/pr-tier.yml": "# changed\n" }, "workflow change");

	// No flags at all: this is the shape CI's jobs take.
	const r = gate({ body: `${MISSION}\n\nReview tier: Low\n`, cwd: dir, gateName: "tier", env: { BASE_SHA: base, HEAD_SHA: head } });
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /tier must be High/, r.out);
	assert.ok(r.out.includes(`diff: ${base}...${head}`), r.out);
});

test("test change: a bash gate test beside its script needs a reason too", () => {
	// This repo's own gate tests are shell, not TypeScript: before the suffix
	// list carried `.test.sh`, a PR like this one was judged "tests changed: 0;
	// source changed: 1 - nothing to justify" and the reason rule checked
	// nothing at all.
	const paths = ["scripts/pr-gate.sh", "scripts/tests/something.test.sh"];

	const red = gate({ body: `${MISSION}\n\nReview tier: High\n`, paths, gateName: "test-change" });
	assert.equal(red.status, 1, red.out);
	assert.match(red.out, /Test change: <reason>/);
	assert.match(red.out, /tests changed: 1; source changed: 1/, red.out);
	assert.match(red.out, /something\.test\.sh/);

	const ok = gate({
		body: `${MISSION}\n\nReview tier: High\n\nTest change: the gate test now covers the bash suffix.\n`,
		paths,
		gateName: "test-change",
	});
	assert.equal(ok.status, 0, ok.out);

	// The suffix is anchored on the `.test.` segment, so a file whose name only
	// ends in `.sh` stays source: a source-only diff asks for no reason line.
	const contest = gate({ body: `${MISSION}\n\nReview tier: High\n`, paths: ["scripts/pr-gate.sh", "scripts/contest.sh"], gateName: "test-change" });
	assert.equal(contest.status, 0, contest.out);
	assert.match(contest.out, /tests changed: 0; source changed: 2/, contest.out);
});

test("an empty diff is unverifiable, never green (PR 88)", () => {
	// The exact shape: the checkout sits on trunk, so the merge base of
	// origin/trunk and HEAD is HEAD itself and `git diff` is empty. Nothing was
	// checked, so the run must not print green — it must name the command that
	// shows the real diff of the branch someone meant to check.
	const dir = makeRepo("empty-diff", "trunk");
	const base = commit(dir, { "install.sh": "#!/bin/sh\necho base\n" }, "base");
	git(dir, "update-ref", "refs/remotes/origin/trunk", base);

	const r = gate({ body: `${MISSION}\n\nReview tier: High\n`, cwd: dir });
	assert.notEqual(r.status, 0, r.out);
	assert.match(r.out, /unverifiable: no changed files between/, r.out);
	assert.match(r.out, /git diff --name-only/, r.out);
	assert.match(r.out, /BRANCH=/, r.out);
	assert.doesNotMatch(r.out, /pr-gate: green/, r.out);

	// The same empty range given explicitly behaves the same way: an explicit
	// diff that resolves to no commits is not a green verdict either.
	const explicit = gate({ body: `${MISSION}\n\nReview tier: High\n`, cwd: dir, branch: "HEAD" });
	assert.notEqual(explicit.status, 0, explicit.out);
	assert.match(explicit.out, /unverifiable: no changed files between/, explicit.out);
	assert.doesNotMatch(explicit.out, /pr-gate: green/, explicit.out);
});

test("--branch checks another branch without switching this checkout", () => {
	// The boss's tree stays on trunk; a worker's branch is checked from it. The
	// case PR 88 needed: the diff CI sees, computed for a branch nobody switched
	// to, and a red verdict the local run would previously have called green.
	const dir = makeRepo("branch-arg", "trunk");
	const base = commit(dir, {
		"install.sh": "#!/bin/sh\necho base\n",
		"agent/prompts/x.test.ts": "export {};\n",
	}, "base");
	git(dir, "update-ref", "refs/remotes/origin/trunk", base);
	git(dir, "switch", "-q", "-c", "worker");
	commit(dir, {
		"install.sh": "#!/bin/sh\necho worker\n",
		"agent/prompts/x.test.ts": "export const x = 1;\n",
	}, "source and its test move together on the worker branch");
	git(dir, "switch", "-q", "trunk");
	assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "trunk");
	assert.equal(git(dir, "rev-parse", "HEAD"), base, "the checkout moved off trunk");

	const red = gate({ body: `${MISSION}\n\nReview tier: High\n`, cwd: dir, branch: "worker" });
	assert.equal(red.status, 1, red.out);
	assert.match(red.out, /merge base of origin\/trunk and worker/, red.out);
	assert.match(red.out, /tests changed: 1; source changed: 1/, red.out);
	assert.match(red.out, /Test change: <reason>/, red.out);

	// Same branch, body carrying the reason: green. The red above is the rule.
	const ok = gate({
		body: `${MISSION}\n\nReview tier: High\n\nTest change: the assertion moved to the new entry point.\n`,
		cwd: dir,
		branch: "worker",
	});
	assert.equal(ok.status, 0, ok.out);
	assert.match(ok.out, /pr-gate: green/, ok.out);

	// The checkout never moved: checking a branch is read-only.
	assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "trunk");

	// A branch that does not exist is a loud usage error, not an empty diff.
	const missing = gate({ body: `${MISSION}\n\nReview tier: High\n`, cwd: dir, branch: "nope" });
	assert.equal(missing.status, 2, missing.out);
	assert.match(missing.out, /no such branch or commit/, missing.out);
});

// ------------------------------------------------------------------ workflow --

test("the workflow calls the shared script and keeps no copy of the gates", () => {
	const workflow = readFileSync(WORKFLOW, "utf8");

	for (const name of ["tier", "mission", "test-change"]) {
		const at = workflow.indexOf(`--gate ${name}`);
		assert.ok(at > -1, `the workflow never runs --gate ${name}`);
		const after = workflow.slice(at + `--gate ${name}`.length, at + `--gate ${name}`.length + 1);
		assert.doesNotMatch(after, /\w/, `--gate ${name} runs as the prefix of another gate name`);
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
	// A branch is checkable from a checkout that stays where it is.
	assert.match(makefile, /--branch "\$\(BRANCH\)"/, "pr-check has no BRANCH= pass-through");
});
