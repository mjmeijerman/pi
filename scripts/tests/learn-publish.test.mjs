// Tests for scripts/learn-publish.sh — the learner's publication step.
//
// The behaviour under test is two sentences:
//   1. a branch with no pull request is a failure, not a completion;
//   2. a machine that cannot ask GitHub says so (exit 2) instead of reporting
//      "no PR" — the sandbox has no gh login, so the old version's only possible
//      answer was the wrong one.
//
// The hand-off is a big-boss-pi agent space (`agent-pane.sh spawn <slug>-pr`),
// because that agent runs on the host where gh and the ssh key live. Every case
// runs the real script against a throwaway repo, a stub `gh` and a stub pane
// script; nothing here touches GitHub or spawns pi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * A repo with one commit on trunk and one branch `learn/test-slug`, plus stubs.
 *
 * `prState` decides what the stub `gh` answers:
 *   "always"      — a PR exists before anything runs
 *   "none"        — gh answers, and there is no PR, ever
 *   "after"       — the PR appears once the pane script has run
 *   "unaskable"   — gh cannot answer (exit 4, "hosts.yml missing"), like the sandbox
 */
function fixture(prState) {
	const dir = join(tmp, `case-${++caseId}`);
	mkdirSync(join(dir, "agent", "proposals"), { recursive: true });
	mkdirSync(join(dir, "bbp"), { recursive: true });
	const git = (...args) => {
		const r = spawnSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};
	git("init", "-q", "-b", "trunk", ".");
	git("remote", "add", "origin", "git@github.com:example/pi.git");
	writeFileSync(join(dir, "README.md"), "fixture\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	git("checkout", "-q", "-b", "learn/test-slug");
	writeFileSync(join(dir, "change.txt"), "the fix\n");
	git("add", "-A");
	git("commit", "-q", "-m", "fix: the thing");
	const sha = git("rev-parse", "--short=12", "HEAD").trim();
	git("checkout", "-q", "trunk");

	const marker = join(dir, "spawned-marker");

	const gh = join(dir, "gh-stub.sh");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
# stub gh: only "pr list --head BRANCH --state all --json ..." is expected.
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
	if [ "${prState}" = "unaskable" ]; then
		echo "You are not logged into any GitHub hosts. Run gh auth login (hosts.yml missing)" >&2
		exit 4
	fi
	if [ "${prState}" = "always" ] || [ -f "${marker}" ]; then
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
	// The third word is the spec path, which is what the real pane script reads.
	const pane = join(dir, "pane-stub.sh");
	writeFileSync(
		pane,
		`#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/pane-called"
echo '{"slug":"'"$2"'","terminal":"t7","hidden":true}'
exit 0
`,
	);
	chmodSync(pane, 0o755);

	// The useful pane: the PR appears once the agent space has been started.
	const publishingPane = join(dir, "pane-publishing.sh");
	writeFileSync(
		publishingPane,
		`#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/pane-called"
: > "${marker}"
echo '{"slug":"'"$2"'","terminal":"t7","hidden":true}'
exit 0
`,
	);
	chmodSync(publishingPane, 0o755);

	// hc refuses to run: no space, so nothing was handed over at all.
	const failingPane = join(dir, "pane-fail.sh");
	writeFileSync(
		failingPane,
		`#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/pane-called"
echo "hc run failed: no herdr" >&2
exit 1
`,
	);
	chmodSync(failingPane, 0o755);

	return {
		dir,
		sha,
		gh,
		pane,
		publishingPane,
		failingPane,
		bbp: join(dir, "bbp"),
		log: join(dir, "agent", "proposals", "publish-log.jsonl"),
		paneCalled: () => readFileSync(join(dir, "pane-called"), "utf8").trim().split("\n"),
		specPath: () => join(dir, "agent", "proposals", "publish", "test-slug-pr.md"),
	};
}

function run(f, args, extraEnv = {}) {
	return spawnSync("bash", [SCRIPT, ...args], {
		env: {
			...process.env,
			LEARN_PUBLISH_ROOT: f.dir,
			LEARN_PUBLISH_GH: f.gh,
			LEARN_PUBLISH_PANE: f.pane,
			LEARN_PUBLISH_BBP: f.bbp,
			...extraEnv,
		},
		encoding: "utf8",
	});
}

test("--check passes when the branch already has a PR", () => {
	const f = fixture("always");
	const r = run(f, ["test-slug", "--check"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /PR #42/);
});

test("--check exits 1 when gh answers and there is no PR", () => {
	const f = fixture("none");
	const r = run(f, ["test-slug", "--check"]);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /no PR for learn\/test-slug/);
});

test("--check exits 2, not 1, when gh cannot be asked from here", () => {
	const f = fixture("unaskable");
	const r = run(f, ["test-slug", "--check"]);
	assert.equal(r.status, 2, "an unanswerable gh is 'unverified', never 'no PR'");
	assert.match(r.stderr, /could not ask/);
	assert.match(r.stderr, /hosts\.yml missing/, "the reason gh gave is carried, not swallowed");
	assert.match(r.stderr, /unverified, not unpublished/);
	assert.doesNotMatch(r.stdout, /no PR for/, "must not claim there is no PR");
	// Read-only: no spawn, no log row.
	assert.equal(readdirSync(f.dir).includes("pane-called"), false);
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a run hands the branch to a big-boss-pi agent space and publishes", () => {
	const f = fixture("after");
	f.pane = f.publishingPane;
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(proposal, "# x\n\n**Verdict:** change\n**Risk tier:** High (`agent/extensions/`)\n");
	const r = run(f, ["test-slug", "--proposal", proposal]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /PR #42/);

	const called = f.paneCalled();
	assert.equal(called[0], "spawn", "the hand-off is a pane spawn");
	assert.equal(called[1], "test-slug-pr", "the space is named after the slug's PR");
	assert.equal(called[2], f.specPath(), "the spec file is what the agent reads");
	assert.deepEqual(called.slice(3), ["--cwd", f.bbp], "and it starts in the big-boss-pi workspace");

	const spec = readFileSync(f.specPath(), "utf8");
	assert.match(spec, /learn\/test-slug/, "the spec names the branch");
	assert.match(spec, new RegExp(f.sha), "the spec names the commit sha");
	assert.match(spec, /review tier: High/, "the spec names the review tier");
	assert.match(spec, new RegExp(proposal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the spec names the proposal");
	assert.match(spec, /git -C .* push -u origin learn\/test-slug/, "push the branch");
	assert.match(spec, /gh pr create/, "open the pull request");
	assert.match(spec, /gh pr create --repo example\/pi/, "against the repo this branch belongs to, not the agent's cwd");
	assert.match(spec, /publish-log\.jsonl/, "append the row to the publish log");
	assert.match(spec, /close test-slug-pr/, "close its own space");
	assert.ok(spec.includes(`${f.pane} close test-slug-pr`), "close it with the pane script that started it");
	assert.doesNotMatch(spec, /pi-bare|-p "Push branch/, "no bare pi one-liner: it cannot authenticate either");

	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a run whose agent space never produces a PR exits 1 and records it", () => {
	const f = fixture("none");
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /FAIL/);
	assert.equal(f.paneCalled()[1], "test-slug-pr");
	const log = readFileSync(f.log, "utf8").trim().split("\n");
	assert.equal(log.length, 1);
	const entry = JSON.parse(log[0]);
	assert.equal(entry.branch, "learn/test-slug");
	assert.equal(entry.slug, "test-slug");
	assert.equal(entry.pr, null);
	assert.match(entry.reason, /no PR after test-slug-pr was spawned/);
});

test("a run whose gh is unaskable exits 2 and does not record 'no PR'", () => {
	const f = fixture("unaskable");
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /unverified/);
	assert.doesNotMatch(r.stderr, /FAIL/);
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a pane script that cannot spawn is an error, not an unpublished branch", () => {
	const f = fixture("none");
	f.pane = f.failingPane;
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /could not start test-slug-pr/);
	assert.match(r.stderr, /unverified and unpublished/);
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("--dry-run prints the hand-off and the spec and spawns nothing", () => {
	const f = fixture("none");
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(proposal, "# x\n\n**Verdict:** change\n**Risk tier:** High (`agent/extensions/`)\n");
	const r = run(f, ["test-slug", "--proposal", proposal, "--dry-run"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /would run: .* spawn test-slug-pr .* --cwd /);
	assert.match(r.stdout, /learn\/test-slug/);
	assert.match(r.stdout, /review tier: High/);
	assert.equal(readdirSync(f.dir).includes("pane-called"), false);
	assert.equal(existsSync(f.specPath()), false, "a dry run writes no spec");
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a missing branch is an error, not a silent success", () => {
	const f = fixture("none");
	const r = run(f, ["no-such-slug", "--check"]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /no branch learn\/no-such-slug/);
});
