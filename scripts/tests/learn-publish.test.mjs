// Tests for scripts/learn-publish.sh — the learner's publication step.
//
// The behaviour under test is one sentence: a branch with no pull request is a
// failure, not a completion. Before this script, "hand the branch to
// big-boss-pi" was prose in agent/prompts/learn.md, and three `learn/*` branches
// sat on the repo with zero PRs while the fix they carried was re-derived by the
// next learner session.
//
// Every case runs the real script against a throwaway repo, a stub `gh` and a
// stub publishing agent; nothing here touches GitHub or spawns pi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/learn-publish.sh");

const tmp = mkdtempSync(join(tmpdir(), "learn-publish-"));
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "learn-publish test",
	GIT_AUTHOR_EMAIL: "learn-publish@example.invalid",
	GIT_COMMITTER_NAME: "learn-publish test",
	GIT_COMMITTER_EMAIL: "learn-publish@example.invalid",
};

let caseId = 0;

/**
 * A repo with one commit on trunk and one branch `learn/<slug>`.
 * `prAfterAgent` decides what the stub `gh` reports: "none" forever, "always",
 * or "after" — the PR appears only once the stub agent has run.
 */
function fixture(prAfterAgent) {
	const dir = join(tmp, `case-${++caseId}`);
	mkdirSync(join(dir, "agent", "proposals"), { recursive: true });
	const git = (...args) => {
		const r = spawnSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};
	git("init", "-q", "-b", "trunk", ".");
	writeFileSync(join(dir, "README.md"), "fixture\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	git("checkout", "-q", "-b", "learn/test-slug");
	writeFileSync(join(dir, "change.txt"), "the fix\n");
	git("add", "-A");
	git("commit", "-q", "-m", "fix: the thing");
	git("checkout", "-q", "trunk");

	const state = join(dir, "gh-state");
	writeFileSync(state, prAfterAgent === "always" ? "pr" : "none");

	const gh = join(dir, "gh-stub.sh");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
# stub gh: "pr list --head BRANCH --state all --json ..." answers from gh-state
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
	if [ -f "${state}.after" ] || [ "$(cat "${state}")" = "pr" ]; then
		echo '[{"number":42,"url":"https://example.invalid/pull/42","state":"OPEN"}]'
	else
		echo '[]'
	fi
	exit 0
fi
echo "gh-stub: unexpected args: $*" >&2
exit 1
`,
	);
	chmodSync(gh, 0o755);

	// Records the call and nothing else: "handed to an agent" is not "published".
	const agent = join(dir, "agent-stub.sh");
	writeFileSync(
		agent,
		`#!/usr/bin/env bash
echo "$@" > "${dir}/agent-called"
exit 0
`,
	);
	chmodSync(agent, 0o755);

	// The useful agent: the PR appears once it has run.
	const publishingAgent = join(dir, "agent-publishing.sh");
	writeFileSync(
		publishingAgent,
		`#!/usr/bin/env bash
echo "$@" > "${dir}/agent-called"
echo "pr" > "${state}.after"
exit 0
`,
	);
	chmodSync(publishingAgent, 0o755);

	const failingAgent = join(dir, "agent-fail.sh");
	writeFileSync(
		failingAgent,
		`#!/usr/bin/env bash
echo "$@" > "${dir}/agent-called"
echo "could not push" >&2
exit 1
`,
	);
	chmodSync(failingAgent, 0o755);

	return { dir, gh, agent, publishingAgent, failingAgent, log: join(dir, "agent", "proposals", "publish-log.jsonl") };
}

function run(f, args) {
	return spawnSync("bash", [SCRIPT, ...args], {
		env: { ...process.env, LEARN_PUBLISH_ROOT: f.dir, LEARN_PUBLISH_GH: f.gh, LEARN_PUBLISH_AGENT: f.agent },
		encoding: "utf8",
	});
}

test("--check passes when the branch already has a PR", () => {
	const f = fixture("always");
	const r = run(f, ["test-slug", "--check"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /PR #42/);
});

test("--check fails when the branch has no PR", () => {
	const f = fixture("none");
	const r = run(f, ["test-slug", "--check"]);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /no PR for learn\/test-slug/);
});

test("a run publishes, then exits 0 because the PR exists", () => {
	const f = fixture("after");
	f.agent = f.publishingAgent;
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /PR #42/);
	assert.match(readFileSync(join(f.dir, "agent-called"), "utf8"), /Push branch learn\/test-slug/);
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a run that produces no PR exits 1 and records it", () => {
	const f = fixture("none");
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /FAIL/);
	const log = readFileSync(f.log, "utf8").trim().split("\n");
	assert.equal(log.length, 1);
	const entry = JSON.parse(log[0]);
	assert.equal(entry.branch, "learn/test-slug");
	assert.equal(entry.slug, "test-slug");
	assert.equal(entry.pr, null);
	assert.match(entry.reason, /no PR after the publishing agent ran/);
});

test("an agent that exits non-zero is reported, and the no-PR verdict still wins", () => {
	const f = fixture("none");
	f.agent = f.failingAgent;
	const r = run(f, ["test-slug"]);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /exited non-zero/);
	assert.match(r.stderr, /FAIL/);
});

test("--dry-run names the agent, branch and tier and spawns nothing", () => {
	const f = fixture("none");
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(proposal, "# x\n\n**Verdict:** change\n**Risk tier:** High (`agent/extensions/`)\n");
	const r = run(f, ["test-slug", "--proposal", proposal, "--dry-run"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /learn\/test-slug/);
	assert.match(r.stdout, /review tier High/);
	assert.equal(readdirSync(f.dir).includes("agent-called"), false);
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a missing branch is an error, not a silent success", () => {
	const f = fixture("none");
	const r = run(f, ["no-such-slug", "--check"]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /no branch learn\/no-such-slug/);
});
