// Tests for the spec-delta rule in scripts/harness-check.sh.
//
// Radar Vol. 35: blip 82 OpenSpec (Trial) — a change is a delta against the spec it
// amends, so the one thing a script can check is that the area spec the delta names
// is there. A rule that passes on a delta naming nothing would keep passing while
// every delta pointed at a file nobody wrote, which is the shape of a gate that
// checked nothing (blip 29).
//
// Every case runs the real script against a fixture root; no part of this repo's own
// specs/ directory decides the verdict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(ROOT, "scripts/harness-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "spec-deltas-"));

let n = 0;

/** A fixture checkout: an area spec, and the deltas the case asks for. */
function fixture(areas, deltas) {
	const root = join(tmp, `root-${n++}`);
	mkdirSync(join(root, "specs", "areas"), { recursive: true });
	mkdirSync(join(root, "specs", "changes"), { recursive: true });
	for (const area of areas) writeFileSync(join(root, "specs", "areas", `${area}.md`), `# ${area}\n`);
	for (const [file, body] of Object.entries(deltas)) {
		writeFileSync(join(root, "specs", "changes", file), body);
	}
	return root;
}

/** git, in a fixture, with an identity of its own so no global config decides a verdict. */
function git(root, ...args) {
	const res = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
	assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stdout}${res.stderr}`);
	return res.stdout;
}

/**
 * A checkout with real history, because `spec-delta-folded` reads trunk's tree and nothing else:
 * a delta on trunk is a delta that landed, a delta on a branch is one that has not.
 * `onBranch` commits the delta on `feat/x` instead of on `trunk`.
 */
function landedFixture({ areas, deltas, onBranch = false }) {
	const root = fixture(areas, {});
	git(root, "init", "-q", "-b", "trunk");
	// trunk needs a commit before a branch can be cut from it, and the area specs are the
	// honest first commit: they are what a delta amends.
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "docs(specs): the area specs");
	if (onBranch) git(root, "checkout", "-q", "-b", "feat/x");
	for (const [file, body] of Object.entries(deltas)) {
		writeFileSync(join(root, "specs", "changes", file), body);
	}
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "feat: the change, delta and all");
	return root;
}

/** One run of the only check this file owns. */
function check(root) {
	const res = spawnSync("bash", [CHECK, "--verify-spec-deltas", "--root", root], {
		encoding: "utf8",
	});
	return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

// One row, by file and by rule: `spec-delta-area` and `spec-delta-folded` both name a delta,
// so a case that wants the fold verdict has to ask for it by name.
const line = (out, path, check) =>
	out.split("\n").find((l) => l.includes(path) && (!check || l.includes(check))) ?? "";

const DELTA = "# feat/merge-guard-allow-twice\n\nArea: merge-guard\n\nA second/mergeguard allow runs.\n";

test("a delta naming an existing area spec PASSes and names both files", () => {
	const root = fixture(["merge-guard"], { "feat-merge-guard-allow-twice.md": DELTA });
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	const row = line(out, "feat-merge-guard-allow-twice.md");
	assert.match(row, /PASS/);
	assert.match(row, /specs\/areas\/merge-guard\.md/);
});

test("a delta naming a missing area spec FAILs and names both files", () => {
	const root = fixture(["merge-guard"], {
		"feat-ghost.md": "# feat/ghost\n\nArea: no-such-area\n\nA change against a spec nobody wrote.\n",
	});
	const { status, out } = check(root);
	assert.equal(status, 1, out);
	const row = line(out, "feat-ghost.md");
	assert.match(row, /FAIL/);
	assert.match(row, /no-such-area/);
	assert.match(row, /specs\/areas\/no-such-area\.md does not exist/);
});

test("a delta with no Area: line FAILs instead of passing quietly", () => {
	const root = fixture(["merge-guard"], { "feat-unspecified.md": "# feat/unspecified\n\nNo link at all.\n" });
	const { status, out } = check(root);
	assert.equal(status, 1, out);
	const row = line(out, "feat-unspecified.md");
	assert.match(row, /FAIL/);
	assert.match(row, /no 'Area:' line/);
});

test("the full path form and a backticked name resolve to the same area spec", () => {
	const root = fixture(["sandbox"], {
		"feat-path-form.md": "# feat/path-form\n\nArea: specs/areas/sandbox.md\n",
		"feat-backticked.md": "# feat/backticked\n\nArea: `sandbox`\n",
	});
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	assert.match(line(out, "feat-path-form.md"), /PASS/);
	assert.match(line(out, "feat-backticked.md"), /PASS/);
});

test("README.md is an explanation, not a delta, and gets no row", () => {
	const root = fixture(["pr-gates"], { "README.md": "# specs/changes\n\nArea: nothing\n" });
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	assert.doesNotMatch(out, /spec-delta-area\s+specs\/changes\/README\.md/);
});

test("no deltas at all is a PASS with a reason, not an empty silence", () => {
	const root = fixture(["secret-guard"], {});
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	assert.match(out, /no change deltas yet/);
});

// --- folded: a delta that landed is a delta nobody folded --------------------
// specs/changes/README.md: merging folds the delta into its area spec and deletes the file.
// A delta in trunk's tree is therefore one whose merge skipped the fold, and the row says so
// instead of letting the area spec go stale in silence (blip 82, blip 29).

test("a delta committed on trunk FAILs as unfolded and names the area spec to fold it into", () => {
	const root = landedFixture({ areas: ["merge-guard"], deltas: { "feat-unfolded.md": DELTA } });
	const { status, out } = check(root);
	assert.equal(status, 1, out);
	const row = line(out, "feat-unfolded.md", "spec-delta-folded");
	assert.match(row, /FAIL/);
	assert.match(row, /landed on trunk and still here/);
	assert.match(row, /specs\/areas\/merge-guard\.md/);
	// Refuses to guess: no command that would append the body somewhere it may not belong.
	assert.doesNotMatch(row, />>/);
});

test("the same delta on its branch, not on trunk, PASSes: the fold is due at the merge", () => {
	const root = landedFixture({ areas: ["merge-guard"], deltas: { "feat-parked.md": DELTA }, onBranch: true });
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	const row = line(out, "feat-parked.md", "spec-delta-folded");
	assert.match(row, /PASS/);
	assert.match(row, /not on trunk yet/);
	assert.match(row, /specs\/areas\/merge-guard\.md/);
});

test("folding and deleting the delta in one commit clears the row", () => {
	const root = landedFixture({ areas: ["merge-guard"], deltas: { "feat-folded.md": DELTA } });
	assert.equal(check(root).status, 1, "the fixture starts unfolded, or the case proves nothing");
	writeFileSync(join(root, "specs", "areas", "merge-guard.md"), `# merge-guard\n\nA second allow runs.\n`);
	unlinkSync(join(root, "specs", "changes", "feat-folded.md"));
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "docs(specs): fold feat-folded into merge-guard");
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	assert.doesNotMatch(out, /feat-folded\.md/);
	assert.match(out, /no change deltas yet/);
});

test("a delta on trunk naming a missing area spec gets one FAIL, not a second guess", () => {
	const root = landedFixture({
		areas: ["merge-guard"],
		deltas: { "feat-ghost.md": "# feat/ghost\n\nArea: no-such-area\n\nA change against a spec nobody wrote.\n" },
	});
	const { status, out } = check(root);
	assert.equal(status, 1, out);
	assert.match(line(out, "feat-ghost.md"), /spec-delta-area/);
	assert.doesNotMatch(out, /spec-delta-folded\s+specs\/changes\/feat-ghost\.md/);
});

test("no trunk ref to compare with is a WARN, never a quiet PASS", () => {
	const root = fixture(["merge-guard"], { "feat-historyless.md": DELTA });
	const { status, out } = check(root);
	assert.equal(status, 0, out);
	const row = line(out, "feat-historyless.md", "spec-delta-folded");
	assert.match(row, /WARN/);
	assert.match(row, /no trunk ref/);
});

test("the rule reads trunk's tree, not the working copy: an untracked delta is still parked", () => {
	const root = landedFixture({ areas: ["merge-guard"], deltas: { "feat-landed.md": DELTA } });
	writeFileSync(
		join(root, "specs", "changes", "feat-new.md"),
		"# feat/new\n\nArea: merge-guard\n\nWritten, not yet committed.\n",
	);
	const { status, out } = check(root);
	assert.equal(status, 1, out);
	assert.match(line(out, "feat-landed.md", "spec-delta-folded"), /landed on trunk and still here/);
	assert.match(line(out, "feat-new.md", "spec-delta-folded"), /not on trunk yet/);
});
