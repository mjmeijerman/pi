// Tests for the `test-regex-literal` row in scripts/harness-check.sh.
//
// Radar Vol. 35: blip 38 CI hardening, blip 29 harness quality evaluation.
// Semgrep's detect-non-literal-regexp failed this repo's security scan three
// times in one area — install-win-cmd-shims.test.mjs:186,
// install-herdr.test.mjs:181, install-guard-service.test.mjs:189 — and each time
// the finding arrived after the push, on a five-minute job. The row this file
// drives is the local half of that rule, so what it has to prove is narrow: a
// quoted string passes, a value does not, `RegExp(` without `new` is caught, a
// comment is prose, and the FAIL names file:line and the fix.
//
// Every case runs the real script against a fixture root, so no part of this
// repo's own tests decides a verdict. The offender is assembled from pieces on
// purpose: this file sits inside the tree the row scans, and an offender spelled
// out here would make the check red for its own test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(ROOT, "scripts/harness-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "test-regex-literal-"));
const CALL = "RegExp" + "(";

let n = 0;

/** A fixture checkout with one test file, at the path a real one sits at. */
function fixture(body) {
	const root = join(tmp, `root-${n++}`);
	mkdirSync(join(root, "scripts", "tests"), { recursive: true });
	writeFileSync(join(root, "scripts", "tests", "case.test.mjs"), body);
	return root;
}

function run(root) {
	return spawnSync("bash", [CHECK, "--verify-test-regex", "--root", root], { encoding: "utf8" });
}

test("a quoted string is what the rule asks for, and the row PASSes", () => {
	const { status, stdout } = run(fixture(`assert.match(out.stderr, new ${CALL}'missing');\n`));
	assert.equal(status, 0, stdout);
	assert.match(stdout, /PASS\s+test-regex-literal/, stdout);
	assert.match(stdout, /every RegExp\( takes a quoted string/, stdout);
});

test("new RegExp() over a variable FAILs and names file:line", () => {
	const { status, stdout } = run(fixture(`assert.match(out, new ${CALL}name);\n`));
	assert.equal(status, 1, stdout);
	assert.match(stdout, /FAIL\s+test-regex-literal\s+scripts\/tests\/case\.test\.mjs:1/, stdout);
});

test("the FAIL says what to write instead, not only that the rule was broken", () => {
	const { stdout } = run(fixture(`assert.match(out, new ${CALL}name);\n`));
	assert.match(stdout, /assert on literal pieces with includes\/match/, stdout);
});

test("a template literal is a value even when it looks like one string", () => {
	const { status, stdout } = run(fixture("assert.match(out, new " + CALL + "`a${b}`);\n"));
	assert.equal(status, 1, stdout);
	assert.match(stdout, /case\.test\.mjs:1/, stdout);
});

test("RegExp() without new is caught in the same place", () => {
	const { status, stdout } = run(fixture(`assert.match(out, ${CALL}name);\n`));
	assert.equal(status, 1, stdout);
	assert.match(stdout, /case\.test\.mjs:1/, stdout);
});

test("a comment about the shape is prose: the rule reads code, and semgrep agrees", () => {
	const { status, stdout } = run(fixture(`// never build a new ${CALL} from a path\nassert.match(out, /missing/);\n`));
	assert.equal(status, 0, stdout);
	assert.match(stdout, /PASS\s+test-regex-literal/, stdout);
});

test("an argument on another line is refused by name, so the row cannot read past it", () => {
	const { status, stdout } = run(fixture(`assert.match(out, new ${CALL}\n\t'missing');\n`));
	assert.equal(status, 1, stdout);
	assert.match(stdout, /argument on another line/, stdout);
});
