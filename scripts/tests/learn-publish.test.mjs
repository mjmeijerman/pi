// Tests for scripts/learn-publish.sh — the learner's publication step.
//
// The behaviour under test is two sentences:
//   1. a branch with no pull request is a failure, not a completion;
//   2. a machine that cannot ask GitHub says so (exit 2) instead of reporting
//      "no PR" — the sandbox has no gh login, so the old version's only possible
//      answer was the wrong one.
//
// The hand-off is a pi agent space (`agent-pane.sh spawn <slug>-pr`),
// because that agent runs on the host where gh and the ssh key live. Every case
// runs the real script against a throwaway repo, a stub `gh` and a stub pane
// script; nothing here touches GitHub or spawns pi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 *   "merged"      — only a MERGED PR for this head, from an earlier run of the same
 *                   `learn/<slug>` name: gh answers it for `--state all`, nothing for
 *                   `--state open`
 *   "unaskable"   — gh cannot answer (exit 4, "hosts.yml missing"), like the sandbox
 */
function fixture(prState) {
	const dir = join(tmp, `case-${++caseId}`);
	mkdirSync(join(dir, "agent", "proposals"), { recursive: true });
	mkdirSync(join(dir, "pane-cwd"), { recursive: true });
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
# stub gh: only "pr list --head BRANCH --state <state> --json ..." is expected.
# What it answers for --state all is what GitHub keeps forever: a merged PR whose
# head branch was this same name. Only --state open means "someone can review it".
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
	if [ "${prState}" = "unaskable" ]; then
		echo "You are not logged into any GitHub hosts. Run gh auth login (hosts.yml missing)" >&2
		exit 4
	fi
	if [ "${prState}" = "merged" ]; then
		case " $* " in
			*" --state open "*) echo '[]' ;;
			*) echo '[{"number":135,"url":"https://example.invalid/pull/135","state":"MERGED"}]' ;;
		esac
		exit 0
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

	// What a real publishing agent does: `spawn` returns with pi's banner up and
	// the agent then pushes and opens the PR, which takes seconds. The PR here
	// appears two seconds after the spawn has returned — the case that used to be
	// recorded as a failure for every publish on 2026-11-18.
	const slowPane = join(dir, "pane-slow.sh");
	writeFileSync(
		slowPane,
		`#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/pane-called"
( sleep 2; : > "${marker}" ) >/dev/null 2>&1 &
echo '{"slug":"'"$2"'","terminal":"t7","hidden":true}'
exit 0
`,
	);
	chmodSync(slowPane, 0o755);

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
		slowPane,
		failingPane,
		cwd: join(dir, "pane-cwd"),
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
			LEARN_PUBLISH_CWD: f.cwd,
			// A caller's sandbox marker must not leak in: one case sets it on purpose.
			PI_SANDBOX_MODE: "",
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

test("a merged PR from an earlier run of the same slug is not a PR for this branch", () => {
	// `learn/<slug>` is `learn-<HH>-<MM>`, so 2026-11-18's learn-10-10 and 2026-11-21's
	// are the same branch name, and `gh pr list --head … --state all` answers with the
	// merged PR the earlier run left behind. A merged PR is nobody's to review: on
	// 2026-11-21 10:19 the broker read PR #135 as "published" for commit a258e80, which
	// `git ls-remote` says never reached the remote. The lesson died unlanded.
	const f = fixture("merged");
	const r = run(f, ["test-slug", "--check"]);
	assert.equal(r.status, 1, "a merged PR is not a PR anyone can review");
	assert.match(r.stdout, /no PR for learn\/test-slug/);
	assert.doesNotMatch(r.stdout, /published/);
});

test("a publish that finds only that merged PR records no PR, instead of claiming a publish", () => {
	const f = fixture("merged");
	const proposal = join(f.dir, "agent", "proposals", "x.md");
	writeFileSync(proposal, "# x\n\n**Verdict:** change\n**Risk tier:** High (`agent/extensions/`)\n");
	const r = run(f, ["test-slug", "--proposal", proposal], { LEARN_PUBLISH_WAIT: "0" });
	assert.equal(r.status, 1, "the branch is still unpublished, so the run failed");
	assert.match(r.stderr, /FAIL/);
	assert.doesNotMatch(r.stdout, /PR #135 exists for/, "a merged PR must not be reported as this branch's publication");
	const entry = JSON.parse(readFileSync(f.log, "utf8").trim().split("\n").at(-1));
	assert.equal(entry.pr, null, "no PR number: #135's head branch was another run's");
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

test("a run hands the branch to a pi agent space and publishes", () => {
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
	assert.deepEqual(called.slice(3), ["--cwd", f.cwd], "and it starts in the checkout it hands the branch to");

	const spec = readFileSync(f.specPath(), "utf8");
	assert.match(spec, /learn\/test-slug/, "the spec names the branch");
	assert.ok(spec.includes(f.sha), "the spec names the commit sha");
	assert.match(spec, /review tier: High/, "the spec names the review tier");
	assert.ok(spec.includes(proposal), "the spec names the proposal");
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
	// The window is the script's default 180 s in production; here it is closed at
	// once so the case stays fast. `LEARN_PUBLISH_WAIT=0` is exactly the old
	// behaviour: one ask, then the failure row.
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")], {
		LEARN_PUBLISH_WAIT: "0",
	});
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
	assert.match(entry.reason, /waited 0s/, "the row says how long the window was, so a short one is visible");
});

test("a PR that lands seconds after the spawn is a publish, not a failure", () => {
	const f = fixture("none");
	f.pane = f.slowPane;
	const r = run(f, ["test-slug", "--proposal", join(f.dir, "agent", "proposals", "x.md")], {
		LEARN_PUBLISH_WAIT: "20",
		LEARN_PUBLISH_POLL: "1",
	});
	assert.equal(r.status, 0, `a publish reported as a failure:\n${r.stdout}${r.stderr}`);
	assert.match(r.stdout, /PR #42/);
	assert.doesNotMatch(r.stderr, /FAIL/, "nothing failed: the agent was still working");
	assert.equal(
		existsSync(f.log),
		false,
		"a publish writes no failure row — four of those per day is what the log had",
	);
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

// ---------------------------------------------------------------- PR body --
// The spec used to hand the publishing agent a one-line literal,
// `--body 'Tier: Medium. Proposal: …'`, and `scripts/pr-gate.sh` rejects that
// three ways. Every learner PR therefore opened with a red `pr-tier` (34 runs
// across 31 branches), and the reviewer had to ask for a body the gate already
// knew was wrong. These cases pin the body against the real gate: the one that
// was published, and the one that must not be.

const PR_BODY = (f) => join(f.dir, "agent", "proposals", "publish", "test-slug-pr.pr.md");

/** The paths the fixture branch changes, as the gate would list them. */
function pathsFile(f) {
	const p = join(f.dir, "changed.txt");
	const diff = spawnSync("git", ["diff", "--name-only", "origin/trunk...learn/test-slug"], {
		cwd: f.dir,
		encoding: "utf8",
	});
	writeFileSync(p, diff.stdout);
	return p;
}

function gate(f, bodyFile, paths) {
	return spawnSync("bash", [join(ROOT, "scripts/pr-gate.sh"), "--body", bodyFile, "--paths", paths], {
		encoding: "utf8",
	});
}

test("the body the spec hands to gh passes the repo's own pr-gate", () => {
	const f = fixture("after");
	f.pane = f.publishingPane;
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(
		proposal,
		"# Publish the fix a dead learner wrote, so the same FAIL stops being re-learned\n\n**Verdict:** change\n**Risk tier:** Medium (`scripts/`)\n**Radar:** blip 11 — the diagnosed failure reaches trunk as a reviewed pull request, checked by the learner's own test\n",
	);
	// A learner's branch moves a script and its test together, and a learner's
	// checkout has the origin/trunk ref the diff is read against. That pair is
	// exactly what pr-tier asked for a `Test change:` reason on, and what the
	// old body did not carry.
	const trunk = spawnSync("git", ["rev-parse", "trunk"], { cwd: f.dir, encoding: "utf8" }).stdout.trim();
	spawnSync("git", ["update-ref", "refs/remotes/origin/trunk", trunk], { cwd: f.dir, encoding: "utf8" });
	spawnSync("git", ["checkout", "-q", "learn/test-slug"], { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });
	mkdirSync(join(f.dir, "scripts", "tests"), { recursive: true });
	writeFileSync(join(f.dir, "scripts", "learn-publish.sh"), "#!/usr/bin/env bash\n# the fix\n");
	writeFileSync(join(f.dir, "scripts", "tests", "learn-publish.test.mjs"), "// the test that pins it\n");
	spawnSync("git", ["add", "scripts/learn-publish.sh", "scripts/tests/learn-publish.test.mjs"], {
		cwd: f.dir,
		env: GIT_ENV,
		encoding: "utf8",
	});
	spawnSync("git", ["commit", "-q", "-m", "fix: the thing, with its test"], {
		cwd: f.dir,
		env: GIT_ENV,
		encoding: "utf8",
	});
	spawnSync("git", ["checkout", "-q", "trunk"], { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });
	const r = run(f, ["test-slug", "--proposal", proposal]);
	assert.equal(r.status, 0, r.stderr);

	const body = readFileSync(PR_BODY(f), "utf8");
	assert.match(body, /^Mission: Publish the fix a dead learner wrote/, "the proposal's H1 becomes the mission");
	assert.match(body, /^Review tier: Medium$/m, "the gate's spelling, not `Tier:`");
	assert.match(body, /^Test change: /m, "a test moved beside its source, so the reason is stated");
	assert.match(body, /^Radar: blip 11 /m, "a code diff cites the blip it answers, and how it is measured");
	assert.doesNotMatch(body, /^Tier:/m, "the old literal is not the body");

	const verdict = gate(f, PR_BODY(f), pathsFile(f));
	assert.equal(verdict.status, 0, `pr-gate rejects the published body:\n${verdict.stdout}${verdict.stderr}`);
	assert.match(verdict.stdout + verdict.stderr, /green/);
});

test("the old one-line body is what pr-tier was failing on", () => {
	const f = fixture("none");
	const old = join(f.dir, "old-body.md");
	writeFileSync(old, "Tier: Medium. Proposal: agent/proposals/x.md. Written by a self-learn learner; published by a pi agent space.\n");
	// A script and its test, the pair every learner branch changes: the gate then
	// asks for all three lines the literal has none of.
	const changed = join(f.dir, "changed-static.txt");
	writeFileSync(changed, "scripts/learn-publish.sh\nscripts/tests/learn-publish.test.mjs\n");
	const verdict = gate(f, old, changed);
	assert.equal(verdict.status, 1, "the literal is red — this is the defect, kept as a case");
	const said = verdict.stdout + verdict.stderr;
	assert.match(said, /no review tier/);
	assert.match(said, /no mission/);
	assert.match(said, /Test change/);
});

test("a body the gate calls red stops the publication instead of opening a PR", () => {
	const f = fixture("none");
	f.pane = f.publishingPane;
	// The gate needs a base to diff against, and the hand-off must not reach the
	// pane when the body is red.
	mkdirSync(join(f.dir, "scripts"), { recursive: true });
	copyFileSync(join(ROOT, "scripts", "pr-gate.sh"), join(f.dir, "scripts", "pr-gate.sh"));
	const trunk = spawnSync("git", ["rev-parse", "trunk"], { cwd: f.dir, encoding: "utf8" }).stdout.trim();
	spawnSync("git", ["update-ref", "refs/remotes/origin/trunk", trunk], { cwd: f.dir, encoding: "utf8" });
	// A harness path in the diff: High is the only tier the gate accepts.
	spawnSync("git", ["checkout", "-q", "learn/test-slug"], { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });
	mkdirSync(join(f.dir, "agent", "extensions"), { recursive: true });
	writeFileSync(join(f.dir, "agent", "extensions", "x.ts"), "// harness\n");
	spawnSync("git", ["add", "agent/extensions/x.ts"], { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });
	spawnSync("git", ["commit", "-q", "-m", "feat: harness change"], { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });
	spawnSync("git", ["checkout", "-q", "trunk"], { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });

	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(
		proposal,
		"# A learner change that touches a harness path but says Medium\n\n**Verdict:** change\n**Risk tier:** Medium (`scripts/`)\n",
	);
	const r = run(f, ["test-slug", "--proposal", proposal]);
	assert.equal(r.status, 2, `a red body must not spawn a publisher:\n${r.stdout}${r.stderr}`);
	assert.match(r.stderr, /fail pr-tier/);
	assert.match(r.stderr, /tier must be High/);
	assert.equal(existsSync(join(f.dir, "pane-called")), false, "nothing was handed over");
	assert.equal(readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"), false);
});

test("a sandboxed caller is refused and told to write the broker's queue file", () => {
	// The learner runs sandboxed: it cannot see herdr-app, so the hand-off is the
	// host's job. A learner that reaches for this script instead of the queue file
	// must get one sentence that names the file, not an empty space and no PR.
	const f = fixture("after");
	f.pane = f.publishingPane;
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(proposal, "# x\n\n**Risk tier:** High\n");

	const r = run(f, ["test-slug", "--proposal", proposal], { PI_SANDBOX_MODE: "bwrap" });

	assert.equal(r.status, 2, "a refusal, not a spawn and not a 'no PR'");
	assert.match(r.stderr, /sandboxed \(bwrap\)/);
	assert.match(r.stderr, /agent\/proposals\/queue\/<slug>\.publish\.json/, "it names the file to write instead");
	assert.match(r.stderr, /broker/, "and who runs it");
	assert.equal(existsSync(join(f.dir, "pane-called")), false, "nothing was handed over");
	assert.equal(
		readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"),
		false,
		"a refused caller is not a publish attempt",
	);
});

// ------------------------------------------- the test a source change owes --
// The PR gate mutates exactly the lines the diff adds and breaks at 100 (CI run
// 44377745621 on PR 159: 16 mutants on the added lines, 5 survived, score 68.75),
// so a learner branch that moves a source file and ships no test is a red build
// handed to a reviewer. The prompt asks for the test; this refuses the publish
// so the learner pays for it, instead of a second worker after the fact.

/** Commit files onto the fixture's branch, with origin/trunk set so a base exists. */
function commitOnBranch(f, files, message = "fix: the thing") {
	const git = (...args) => {
		const r = spawnSync("git", args, { cwd: f.dir, env: GIT_ENV, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};
	git("update-ref", "refs/remotes/origin/trunk", git("rev-parse", "trunk").trim());
	git("checkout", "-q", "learn/test-slug");
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(f.dir, path)), { recursive: true });
		writeFileSync(join(f.dir, path), body);
	}
	git("add", "--", ...Object.keys(files));
	git("commit", "-q", "-m", message);
	git("checkout", "-q", "trunk");
}

const PROPOSAL = (extra = "") =>
	`# Refuse a learner branch that changes source and ships no test\n\n**Verdict:** change\n**Risk tier:** Medium (\`scripts/\`)\n${extra}`;

test("a source change with no test is refused before any space is spawned", () => {
	const f = fixture("after");
	f.pane = f.publishingPane;
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(proposal, PROPOSAL());
	commitOnBranch(f, { "scripts/learn-publish.sh": "#!/usr/bin/env bash\n# the fix\n" });

	const r = run(f, ["test-slug", "--proposal", proposal]);

	assert.equal(r.status, 2, "a refusal, not a publish and not a 'no PR'");
	assert.match(r.stderr, /changes source files with no test in the diff: scripts\/learn-publish\.sh/);
	assert.match(r.stderr, /add the test that pins scripts\/learn-publish\.sh/);
	assert.match(r.stderr, /\*\*No test:\*\*/, "it names the escape hatch, so the learner is not stuck");
	assert.equal(existsSync(join(f.dir, "pane-called")), false, "nothing was handed over");
	assert.equal(
		readdirSync(join(f.dir, "agent", "proposals")).includes("publish-log.jsonl"),
		false,
		"a refused branch is not a publish attempt",
	);
});

test("the same source change with its test publishes", () => {
	const f = fixture("after");
	f.pane = f.publishingPane;
	const proposal = join(f.dir, "agent", "proposals", "p.md");
	writeFileSync(proposal, PROPOSAL());
	commitOnBranch(f, {
		"scripts/learn-publish.sh": "#!/usr/bin/env bash\n# the fix\n",
		"scripts/tests/learn-publish.test.mjs": "// the test that pins it\n",
	});

	const r = run(f, ["test-slug", "--proposal", proposal]);

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /PR #42/);
	assert.equal(f.paneCalled()[1], "test-slug-pr", "handed to the host's agent space");
});

test("a differential proof stands in for the test, and its absence does not", () => {
	const f = fixture("after");
	f.pane = f.publishingPane;
	commitOnBranch(f, { "scripts/learn-publish.sh": "#!/usr/bin/env bash\n# unreachable line\n" });

	// A count without the domain is not a proof; a survivor's row needs both.
	const vague = join(f.dir, "agent", "proposals", "vague.md");
	writeFileSync(vague, PROPOSAL("**No test:** no test can distinguish it: some inputs\n"));
	const refused = run(f, ["test-slug", "--proposal", vague]);
	assert.equal(refused.status, 2, "a proof with no domain and no count is refused");
	assert.match(refused.stderr, /no test in the diff/);

	const proved = join(f.dir, "agent", "proposals", "proved.md");
	writeFileSync(
		proved,
		PROPOSAL("**No test:** no test can distinguish it: every queue file in agent/proposals/queue/, 2,431 cases, 0 differing verdicts\n"),
	);
	const published = run(f, ["test-slug", "--proposal", proved]);
	assert.equal(published.status, 0, published.stderr);
	assert.match(published.stderr, /No test: line is the proof taken instead/);
	assert.match(published.stdout, /PR #42/);

	// The proof the gate was told to take is the proof the body carries: a branch
	// accepted on a differential run and then published with a source-only diff
	// and no reason is the reviewer reading an unexplained change. The label is the
	// gate's spelling, not the proposal's markdown, and the domain and count survive.
	const body = readFileSync(PR_BODY(f), "utf8");
	assert.match(
		body,
		/^No test: no test can distinguish it: every queue file in agent\/proposals\/queue\/, 2,431 cases, 0 differing verdicts$/m,
		"the accepted proof reaches the pull request body",
	);
	assert.doesNotMatch(body, /\*\*No test:\*\*/, "the body carries the label the gate reads, not the proposal's emphasis");
});
