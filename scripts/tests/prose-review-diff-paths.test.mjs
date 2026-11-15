// Tests for the diff step of .github/workflows/prose-review.yml.
//
// The point: PR #93 added one sentence to agent/prompts/grill.md, the job ran,
// and it said "nothing to review" — because the pathspec `:/agent/prompts/**/*.md`
// was used without git's `:(glob)` magic, where `**/` is one ordinary path
// segment and therefore needs at least one directory under agent/prompts.
// A silent no-op on the exact case the job exists for.
//
// So this test does not argue about git semantics: it builds a throwaway repo
// with a direct child and a nested file, reads the pathspecs out of the real
// workflow, and asserts the real git diff shows both. Put the old pathspec
// back and the direct child disappears from the diff — red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = join(ROOT, ".github/workflows/prose-review.yml");
// The same non-glob `**` mistake lived in the mutation job's diff as well.
const MUTATION_WORKFLOW = join(ROOT, ".github/workflows/test.yml");

// A test's own git identity: the host's config must not decide what this diff is.
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "prose-review test",
	GIT_AUTHOR_EMAIL: "prose@example.invalid",
	GIT_COMMITTER_NAME: "prose-review test",
	GIT_COMMITTER_EMAIL: "prose@example.invalid",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd, ...args) {
	const run = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
	assert.equal(run.status, 0, `git ${args.join(" ")} failed: ${run.stderr}`);
	return run.stdout;
}

// The pathspecs exactly as the workflow shell runs them: every quoted argument
// of a `git diff`/`git ls-files` line that looks like a pathspec (`:/...` or
// `:(magic)...`), across the continued command.
function workflowPathspecs(file = WORKFLOW) {
	const lines = readFileSync(file, "utf8").split("\n");
	const start = lines.findIndex((line) => /\bgit (diff|ls-files)\b/.test(line));
	const specs = [];
	for (const line of lines.slice(start)) {
		// A pathspec is the quoted argument that starts with `:` (`:/`, `:(glob)`, ...).
		for (const m of line.matchAll(/'(:[^']*)'/g)) specs.push(m[1]);
		if (!line.trimEnd().endsWith("\\")) break;
	}
	assert.ok(specs.length > 0, `${file}: the git command passes no pathspec`);
	return specs;
}

function filesAt(dir, paths) {
	return paths
		.flatMap((path) => {
			const abs = join(dir, path);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, "old\n");
			return [path];
		})
		.sort();
}

// Files a change to which must be reviewed, and one that must not.
const TOUCHED = [
	"agent/AGENTS.md",
	"agent/prompts/grill.md", // direct child: the case that silently matched nothing
	"agent/prompts/deep/mid.md", // one directory down
	"agent/skills/jev/SKILL.md", // one directory down
	"agent/skills/a/b/c/SKILL.md", // nested
];
const UNTOUCHED = "other/notes.md";

const tmp = mkdtempSync(join(tmpdir(), "prose-diff-paths-"));

function repo() {
	const dir = mkdtempSync(join(tmp, "repo-"));
	git(dir, "init", "-q", "-b", "main");
	for (const path of [...TOUCHED, UNTOUCHED]) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), "old\n");
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	for (const path of [...TOUCHED, UNTOUCHED]) {
		writeFileSync(join(dir, path), "old\nnew sentence\n");
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "change");
	return dir;
}

function diffFiles(dir, specs) {
	const out = git(dir, "diff", "--unified=3", "HEAD~1...HEAD", "--", ...specs);
	return out
		.split("\n")
		.filter((line) => line.startsWith("+++ "))
		.map((line) => line.slice(4).trim().replace(/^b\//, ""))
		.filter((path) => path !== "/dev/null")
		.sort();
}

test("the workflow's pathspecs review a direct child and a nested instruction file", () => {
	const dir = repo();
	const specs = workflowPathspecs();
	assert.deepEqual(diffFiles(dir, specs), [...TOUCHED].sort(), `pathspecs ${specs.join(" ")}`);
});

test("the old non-glob pathspecs fail this test, so restoring them is red", () => {
	const dir = repo();
	const old = [":/agent/AGENTS.md", ":/agent/prompts/**/*.md", ":/agent/skills/**/*.md"];
	const files = diffFiles(dir, old);
	assert.ok(
		!files.includes("agent/prompts/grill.md"),
		"the old pathspec matched agent/prompts/grill.md — this test would no longer catch the regression",
	);
	assert.notDeepEqual(files, [...TOUCHED].sort());
});

test("no `**/` pathspec in a workflow git command is left without the glob magic", () => {
	// The narrow claim: a `**` segment only crosses directory levels under
	// `:(glob)`. A pathspec that spells `**/` without it is the bug this file
	// was written for, whatever the surrounding lines look like.
	for (const file of [WORKFLOW, MUTATION_WORKFLOW]) {
		for (const spec of workflowPathspecs(file)) {
			if (!spec.includes("**")) continue;
			assert.match(spec, /^:\(glob(,[a-z]+)*\)/, `${file}: pathspec ${spec} uses ** without :(glob)`);
		}
	}
});

test("the mutation job's pathspec sees extensions directly under agent/extensions", () => {
	// agent/extensions holds its .ts files directly (merge-guard.ts and friends),
	// so a pathspec that needs one directory level skips the mutation entirely.
	const dir = mkdtempSync(join(tmp, "repos-ext-"));
	git(dir, "init", "-q", "-b", "main");
	const touched = filesAt(dir, [
		"agent/extensions/merge-guard.ts",
		"agent/extensions/nested/deep.ts",
		"agent/extensions/merge-guard.test.ts",
		"agent/other/thing.ts",
	]);
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	git(dir, "ls-files", "-z");

	const specs = workflowPathspecs(MUTATION_WORKFLOW);
	const seen = git(dir, "ls-files", "--", ...specs).split("\n").filter(Boolean).sort();

	// Whatever the pathspec keeps, the two extension sources must be in it, and
	// nothing from outside agent/extensions.
	for (const path of ["agent/extensions/merge-guard.ts", "agent/extensions/nested/deep.ts"]) {
		assert.ok(seen.includes(path), `${MUTATION_WORKFLOW} pathspec ${specs.join(" ")} missed ${path}`);
	}
	assert.ok(!seen.includes("agent/other/thing.ts"), "the mutation pathspec reaches outside agent/extensions");
	assert.ok(touched.length === 4);
});
