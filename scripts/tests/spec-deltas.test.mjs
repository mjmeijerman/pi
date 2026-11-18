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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/** One run of the only check this file owns. */
function check(root) {
	const res = spawnSync("bash", [CHECK, "--verify-spec-deltas", "--root", root], {
		encoding: "utf8",
	});
	return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const line = (out, path) => out.split("\n").find((l) => l.includes(path)) ?? "";

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
