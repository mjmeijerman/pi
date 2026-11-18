// Tests for the mise.toml projections in scripts/harness-check.sh (check_mise_pins).
//
// Radar Vol. 35: blip 68 mise (Adopt) and blip 38 CI hardening. `actions/setup-node`
// cannot read mise.toml — `node-version-file` understands .nvmrc, .node-version and
// package.json and nothing else, and a matrix cannot compute a value at all — so the
// pinned major is projected into `.node-version`, into test.yml's matrix and into the
// one global npm install. A projection nobody compares is the five-restatements
// problem with better manners: two files that can disagree quietly. Every case here
// runs the real script against a fixture root, so the verdict is this check's, not
// this repo's own files.
//
// The directions are tested both ways on purpose: 24 pinned with 26 written out and
// 26 pinned with 24 written out are the same bug, and a check that only watches one
// side passes the bump that goes the other way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(ROOT, "scripts/harness-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "mise-ci-"));

let n = 0;

/**
 * A fixture checkout that agrees with itself: mise.toml pins node 24 and npm 11,
 * .node-version says 24, test.yml's matrix starts at 24, and harness-check.yml
 * installs npm@11.21.2. `overrides` replaces any of those files by path; `null`
 * deletes one, which is how the missing-authority cases are written.
 */
function fixture(overrides = {}) {
	const root = join(tmp, `root-${n++}`);
	const files = {
		"mise.toml": '[tools]\nnode = "24"\nnpm = "11"\n',
		".node-version": "24\n",
		// The matrix job takes its version from `node-version: @@MN@@`; the job with
		// no matrix reads the projected file. Both shapes are legitimate, so the
		// fixture carries both.
		".github/workflows/test.yml":
			"jobs:\n  t:\n    strategy:\n      matrix:\n        node: [\"24\", \"26\"]\n" +
			"    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .node-version\n",
		".github/workflows/harness-check.yml":
			"jobs:\n  h:\n    steps:\n      - run: npm install -g npm@11.21.2\n",
		".github/workflows/prose-review.yml": "jobs:\n  p:\n    steps: []\n",
		...overrides,
	};
	for (const [rel, body] of Object.entries(files)) {
		if (body === null) continue;
		const file = join(root, rel);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	}
	return root;
}

/**
 * A PATH that holds only this test's stub plus the system directories bash needs.
 * The user's own ~/.local/bin is excluded on purpose: whether mise happens to be
 * installed on the machine running the suite must not decide what these
 * assertions see, and after ./setup.sh it very well might be.
 */
const SYSTEM_PATH =
	"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * A `mise` stub for the PATH: `broken` is a binary that cannot answer, `node`
 * null is a working mise whose pinned tool was never installed, and a path is
 * the happy case. Shapes copied from the real 2026.11.9 output.
 */
function miseStub({ node = null, broken = false } = {}) {
	const dir = join(tmp, `bin-${n++}`);
	mkdirSync(dir, { recursive: true });
	const body = broken
		? "#!/bin/sh\nexit 1\n"
		: "#!/bin/sh\n" +
			'[ "$1" = "--version" ] && echo "2026.11.9 linux-x64 (2026-11-16)" && exit 0\n' +
			'[ "$1" = "which" ] || exit 0\n' +
			(node
				? `echo "${node}"\n`
				: 'echo "mise ERROR node is not a mise bin. Perhaps you need to install it first." >&2\nexit 1\n') +
			"exit 0\n";
	writeFileSync(join(dir, "mise"), body, { mode: 0o755 });
	return dir;
}

/** The only check this file owns, against one fixture root. */
function check(root, env = {}) {
	const res = spawnSync("bash", [CHECK, "--verify-mise-pins", "--root", root], {
		encoding: "utf8",
		env: { ...process.env, PATH: SYSTEM_PATH, ...env },
	});
	return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const line = (out, checkName) =>
	out.split("\n").find((l) => l.includes(checkName)) ?? "";

test("a tree whose projections agree PASSes every one, naming both numbers", () => {
	const { status, out } = check(fixture());
	assert.equal(status, 0, out);
	for (const name of [
		"mise-pin-node-version",
		"mise-pin-matrix",
		"mise-pin-workflows",
		"mise-pin-npm",
	]) {
		assert.match(line(out, name), /PASS/, `${name} should PASS:\n${out}`);
	}
	const nv = line(out, "mise-pin-node-version");
	assert.match(nv, /node 24/);
	assert.match(nv, /mise\.toml pins 24/);
});

test(".node-version that drifted from mise.toml FAILs and prints the fix", () => {
	// The disagreement this check exists for: someone edits mise.toml and forgets
	// the projection, so CI would install a major the repo no longer targets.
	const { status, out } = check(
		fixture({
			"mise.toml": '[tools]\nnode = "26"\nnpm = "11"\n',
		}),
	);
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-node-version");
	assert.match(row, /FAIL/);
	assert.match(row, /node 24/);
	assert.match(row, /mise\.toml pins 26/);
	assert.match(row, /printf '%s\\n' 26 > \.node-version/);
});

test("the same drift in the other direction FAILs too", () => {
	// 26 pinned, 24 written out: the bump that went one way, not the other.
	const { status, out } = check(
		fixture({
			"mise.toml": '[tools]\nnode = "26"\nnpm = "11"\n',
			".node-version": "26\n",
			".github/workflows/test.yml":
				"jobs:\n  t:\n    strategy:\n      matrix:\n        node: [\"24\", \"26\"]\n",
		}),
	);
	assert.equal(status, 1, out);
	const matrix = line(out, "mise-pin-matrix");
	assert.match(matrix, /FAIL/);
	assert.match(matrix, /first axis 24/);
	assert.match(matrix, /pins 26/);
	assert.match(line(out, "mise-pin-node-version"), /PASS/, out);
});

test("a full version in .node-version is the pinned major, not a mismatch", () => {
	const { status, out } = check(
		fixture({ ".node-version": "v24.11.0\n" }),
	);
	assert.equal(status, 0, out);
	assert.match(line(out, "mise-pin-node-version"), /PASS/);
});

test("no .node-version is a FAIL naming the four jobs and the fix", () => {
	// Missing is not "nothing to compare": four setup-node steps read this file.
	const { status, out } = check(fixture({ ".node-version": null }));
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-node-version");
	assert.match(row, /FAIL/);
	assert.match(row, /missing/);
	assert.match(row, /four jobs/);
	assert.match(row, /printf '%s\\n' 24 > \.node-version/);
});

test("a matrix line that vanished is a FAIL, not a silent pass", () => {
	// The pattern-matching half of this check: if test.yml is reshaped and nothing
	// matches, the old behaviour was "no row, no drift" — the shape of a gate that
	// stopped checking.
	const { status, out } = check(
		fixture({ ".github/workflows/test.yml": "jobs:\n  t:\n    steps: []\n" }),
	);
	assert.equal(status, 1, out);
	assert.match(line(out, "mise-pin-matrix"), /FAIL/);
	assert.match(line(out, "mise-pin-matrix"), /pass in silence/);
});

test("a workflow that pins node with a literal again FAILs and names the file", () => {
	const { status, out } = check(
		fixture({
			".github/workflows/prose-review.yml":
				"jobs:\n  p:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \"24\"\n",
		}),
	);
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-workflows");
	assert.match(row, /FAIL/);
	assert.match(row, /\.github\/workflows\/prose-review\.yml/);
	assert.match(row, /node-version-file/);
});

test("a node-version expression (the matrix) is not a literal and PASSes", () => {
	const { status, out } = check(
		fixture({
			".github/workflows/test.yml":
				"jobs:\n  t:\n    strategy:\n      matrix:\n        node: [\"24\", \"26\"]\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n",
		}),
	);
	assert.equal(status, 0, out);
	assert.match(line(out, "mise-pin-workflows"), /PASS/);
});

test("an npm install whose major disagrees with mise.toml FAILs", () => {
	const { status, out } = check(
		fixture({
			".github/workflows/harness-check.yml":
				"jobs:\n  h:\n    steps:\n      - run: npm install -g npm@10.9.9\n",
		}),
	);
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-npm");
	assert.match(row, /FAIL/);
	assert.match(row, /npm 10\.9\.9/);
	assert.match(row, /pins npm 11/);
});

test("an npm install line that vanished is a FAIL, not a silent pass", () => {
	const { status, out } = check(
		fixture({
			".github/workflows/harness-check.yml": "jobs:\n  h:\n    steps: []\n",
		}),
	);
	assert.equal(status, 1, out);
	assert.match(line(out, "mise-pin-npm"), /pass in silence/);
});

test("no mise.toml is a loud FAIL, never a default", () => {
	// #136: the authority gone must say so. A check that quietly compares against
	// 24 keeps passing while nothing declares 24.
	const { status, out } = check(fixture({ "mise.toml": null }));
	assert.equal(status, 1, out);
	assert.match(line(out, "mise-pin-node"), /FAIL/);
	assert.match(line(out, "mise-pin-node"), /no node major/);
	assert.match(line(out, "mise-pin-node"), /have no source/);
});

test("a mise.toml with no npm line FAILs the npm projection", () => {
	const { status, out } = check(
		fixture({ "mise.toml": '[tools]\nnode = "24"\n' }),
	);
	assert.equal(status, 1, out);
	assert.match(line(out, "mise-pin-npm"), /FAIL/);
	assert.match(line(out, "mise-pin-npm"), /no npm major/);
});


// ------------------------------------------------------- the path, not the key --
// The workflow row (mise-pin-workflows) counts `node-version-file` and stops
// there: a mention is not a resolution. setup-node resolves the value against the
// workspace root and joins it unconditionally, so an absolute value — or
// ${{ github.workspace }} itself — becomes <root>/<root>/.node-version and the job dies in
// seconds before npm runs. These are the cases that were red in CI.

test("an absolute node-version-file FAILs, naming the doubled path", () => {
	const { status, out } = check(
		fixture({
			".github/workflows/test.yml":
				"jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: /home/runner/work/pi/pi/.node-version\n",
		}),
	);
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-node-version-file");
	assert.match(row, /FAIL/);
	assert.match(row, /\.github\/workflows\/test\.yml/);
	assert.match(row, /absolute/);
	assert.match(row, /joins it onto the workspace root/);
});

test("node-version-file built from github.workspace FAILs", () => {
	// The exact form that merged in ci/mise-owns-ci-too: absolute once expanded.
	const { status, out } = check(
		fixture({
			".github/workflows/prose-review.yml":
				"jobs:\n  p:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: ${{ github.workspace }}/.node-version\n",
		}),
	);
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-node-version-file");
	assert.match(row, /FAIL/);
	assert.match(row, /expression/);
});

test("a relative node-version-file that names no file under the root FAILs", () => {
	// Relative is not enough: the file the join lands on has to exist.
	const { status, out } = check(
		fixture({
			".github/workflows/prose-review.yml":
				"jobs:\n  p:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n",
		}),
	);
	assert.equal(status, 1, out);
	const row = line(out, "mise-pin-node-version-file");
	assert.match(row, /FAIL/);
	assert.match(row, /no \.nvmrc under the repo root/);
});

test("a quoted, commented .node-version PASSes — the value is what is read", () => {
	const { status, out } = check(
		fixture({
			".github/workflows/prose-review.yml":
				"jobs:\n  p:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: \".node-version\" # mise.toml's node, projected\n",
		}),
	);
	assert.equal(status, 0, out);
	const row = line(out, "mise-pin-node-version-file");
	assert.match(row, /PASS/);
	assert.match(row, /resolving to a file at the repo root/);
});

test("no node-version-file at all is a WARN that says so, never a quiet pass", () => {
	// A matrix job takes its version from the matrix on purpose, so absence is not
	// a FAIL — but a row that silently compared nothing is how a gate stops
	// checking, so the row says which of the two it did.
	const { status, out } = check(
		fixture({
			".github/workflows/test.yml":
				"jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n",
		}),
	);
	assert.match(line(out, "mise-pin-node-version-file"), /WARN/);
	assert.match(line(out, "mise-pin-node-version-file"), /compared nothing/);
	// The literal above is the FAIL; absence of the file is not a second one.
	assert.equal(status, 1, out);
	assert.match(line(out, "mise-pin-workflows"), /FAIL/);
});

// The check above is only worth what it says about this repo. This is the test that
// would have caught it before the branch merged: every fixture case can pass while this
// checkout still ships an absolute value, which is precisely what happened.
test("this checkout: every node-version-file is relative and resolves", () => {
	const res = spawnSync("bash", [CHECK, "--verify-mise-pins", "--root", ROOT], {
		encoding: "utf8",
	});
	const out = `${res.stdout}${res.stderr}`;
	const row = line(out, "mise-pin-node-version-file");
	assert.match(row, /PASS/, out);
	assert.match(row, /resolving to a file at the repo root/);
	// four setup-node steps read it: harness-check, prose-review and test.yml twice.
	assert.match(out, /\.node-version@\.github\/workflows\/harness-check\.yml/);
	assert.match(out, /\.node-version@\.github\/workflows\/prose-review\.yml/);
	assert.match(out, /\.node-version@\.github\/workflows\/test\.yml/);
	assert.equal(res.status, 0, out);
});
test("an unreadable value is a FAIL, not the fallback literal", () => {
	const { status, out } = check(
		fixture({ "mise.toml": '[tools]\nnode = "twenty-four"\nnpm = "11"\n' }),
	);
	assert.equal(status, 1, out);
	assert.match(line(out, "mise-pin-node"), /no node major/);
});

// The row the other rows assume: is the tool that owns the pin on this machine at
// all. Blip 68 was adopted as a file, and for two released pins `command -v mise`
// answered nothing while five rows compared mise.toml to its projections. Absent
// is a WARN (a fresh clone, and CI, have no mise); present-but-broken is a FAIL,
// and so is the binary without the pinned tool, because the host this row was
// written on does run `mise install`.

test("no mise on PATH is a WARN that says so, and not a broken repo", () => {
	const { status, out } = check(fixture());
	const row = line(out, "mise-installed");
	assert.match(row, /WARN/);
	assert.match(row, /not on PATH/);
	assert.match(row, /mise\.run/);
	// A WARN must not fail the run: a fresh clone is not a violation.
	assert.equal(status, 0, out);
});

test("a mise that answers no --version FAILs and names the reinstall", () => {
	const dir = miseStub({ broken: true });
	const { status, out } = check(fixture(), {
		PATH: `${dir}:${SYSTEM_PATH}`,
	});
	const row = line(out, "mise-installed");
	assert.match(row, /FAIL/);
	assert.match(row, /answers no --version/);
	assert.match(row, /mise\.run/);
	assert.equal(status, 1, out);
});

test("mise installed but the pinned tool not installed FAILs and gives the command", () => {
	// The host installs the pin, so a binary with no tool behind it is a half-done
	// install rather than a laptop that has not got round to it. It was a WARN
	// before `mise install` ran here; the difference is what makes the row honest.
	const dir = miseStub({ node: null });
	const { status, out } = check(fixture(), {
		PATH: `${dir}:${SYSTEM_PATH}`,
	});
	const row = line(out, "mise-installed");
	assert.match(row, /FAIL/);
	assert.match(row, /resolves no node 24/);
	assert.match(row, /mise install/);
	assert.equal(status, 1, out);
});

test("a mise that resolves the pinned node PASSes and prints where it landed", () => {
	const bin = "/tmp/mise-probe/installs/node/24/bin/node";
	const dir = miseStub({ node: bin });
	const { status, out } = check(fixture(), {
		PATH: `${dir}:${SYSTEM_PATH}`,
	});
	const row = line(out, "mise-installed");
	assert.match(row, /PASS/);
	assert.match(row, /2026\.11\.9/);
	assert.match(row, /pinned node 24/);
	assert.match(row, new RegExp(bin.replace(/\./g, "\\.")));
	assert.equal(status, 0, out);
});
