// Tests for the `learn-branch-published` check in scripts/harness-check.sh.
//
// The behaviour under test is one sentence from `agent/prompts/learn.md`:
//   "A branch with no PR is an unfinished run."
// It was prose until 2026-11-15, when three `learn/*` branches sat with one
// commit each and no pull request while every learner reported a green harness
// check. The check reads two things: the age of the branch tip, and
// `agent/proposals/publish-log.jsonl` (a row with a PR number means published; a
// row with `"pr":null` means a recorded attempt that still has no PR).
//
// Every case runs the real harness-check script against a throwaway git repo and
// reads the `learn-branch-published` items out of its `--json` document. Nothing
// here touches the real repo, the network, or a learner branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(ROOT, "scripts/harness-check.sh");
const CHECK_NAME = "learn-branch-published";
const MINUTE = 60 * 1000;

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "harness-check test",
	GIT_AUTHOR_EMAIL: "harness-check@example.invalid",
	GIT_COMMITTER_NAME: "harness-check test",
	GIT_COMMITTER_EMAIL: "harness-check@example.invalid",
};

let caseId = 0;

/** A git repo on `trunk`, plus a `learn/<slug>` branch committed `ageMin` ago. */
function fixture({ slug = "learn-13-22", ageMin = 180, body = "learn: a lesson" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), `learn-branch-${++caseId}-`));
	mkdirSync(join(dir, "agent", "proposals"), { recursive: true });
	const git = (...args) => {
		const r = spawnSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};
	const commitAt = (ageMinutes, message) => {
		const at = new Date(Date.now() - ageMinutes * MINUTE).toISOString();
		git("add", "-A");
		const r = spawnSync("git", ["commit", "-q", "-m", message], {
			cwd: dir,
			env: { ...GIT_ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
			encoding: "utf8",
		});
		assert.equal(r.status, 0, `git commit: ${r.stderr}`);
	};
	git("init", "-q", "-b", "trunk", ".");
	writeFileSync(join(dir, "README.md"), "fixture\n");
	commitAt(600, "init");
	if (slug) {
		git("checkout", "-q", "-b", `learn/${slug}`);
		writeFileSync(join(dir, "change.txt"), "the fix\n");
		commitAt(ageMin, body);
		git("checkout", "-q", "trunk");
	}
	return { dir, git, commitAt };
}

/** The `learn-branch-published` items from a read-only harness-check run. */
function check(dir, env = {}) {
	const r = spawnSync("bash", [CHECK, "--root", dir, "--json"], {
		env: { ...GIT_ENV, ...env },
		encoding: "utf8",
	});
	assert.ok(r.stdout, `no JSON from harness-check: ${r.stderr}`);
	const doc = JSON.parse(r.stdout);
	return doc.results.filter((item) => item.check === CHECK_NAME);
}

function pw(dir, rows) {
	writeFileSync(join(dir, "agent", "proposals", "publish-log.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("an hour-old learn branch with no publish-log row is a failure that names the command", () => {
	const { dir } = fixture();
	const items = check(dir);
	assert.equal(items.length, 1, `expected one item, got ${JSON.stringify(items)}`);
	assert.equal(items[0].status, "FAIL");
	assert.equal(items[0].path, "learn/learn-13-22");
	assert.match(items[0].message, /publish it: scripts\/learn-publish\.sh learn-13-22/);
});

test("a publish-log row carrying a PR number makes the branch published", () => {
	const { dir } = fixture();
	pw(dir, [{ ts: "2026-11-15T13:00:00Z", slug: "learn-13-22", branch: "learn/learn-13-22", sha: "abc123", pr: 97, reason: "published" }]);
	const items = check(dir);
	assert.deepEqual(items.filter((item) => item.status === "FAIL"), [], "a published branch does not fail");
	assert.equal(items.length, 1);
	assert.equal(items[0].status, "PASS");
});

test("a recorded attempt with no PR is named as an attempt, with the re-ask command", () => {
	const { dir } = fixture();
	pw(dir, [{ ts: "2026-11-15T13:00:00Z", slug: "learn-13-22", branch: "learn/learn-13-22", sha: "abc123", pr: null, reason: "no PR after learn-13-22-pr was spawned" }]);
	const items = check(dir);
	assert.equal(items.length, 1);
	assert.equal(items[0].status, "FAIL");
	assert.match(items[0].message, /has an attempt for it with no PR/);
	assert.match(items[0].message, /scripts\/learn-publish\.sh learn-13-22 --check/);
});

test("a branch the learner committed minutes ago is not an unfinished run", () => {
	const { dir } = fixture({ ageMin: 3 });
	const items = check(dir);
	assert.deepEqual(items.filter((item) => item.status === "FAIL"), [], "a fresh branch is still being worked on");
	assert.equal(items.at(-1).status, "PASS");
});

test("a learn branch already merged into trunk is litter, not an unfinished run", () => {
	const { dir, git } = fixture({ ageMin: 300 });
	git("merge", "-q", "--no-ff", "-m", "merge the lesson", "learn/learn-13-22");
	const items = check(dir);
	assert.deepEqual(items.filter((item) => item.status === "FAIL"), [], "a landed lesson needs no pull request");
});

test("the commit body's proposal path is put in the repair command", () => {
	const { dir } = fixture({
		body: "learn: judge a death once\n\nProposal: agent/proposals/2026-11-15-11-51-43-805Z.md\n",
	});
	const items = check(dir);
	assert.match(items[0].message, /--proposal agent\/proposals\/2026-11-15-11-51-43-805Z\.md/);
});

test("no learn/* branches at all is a pass, not a silent skip", () => {
	const { dir } = fixture({ slug: "" });
	const items = check(dir);
	assert.equal(items.length, 1);
	assert.equal(items[0].status, "PASS");
});
