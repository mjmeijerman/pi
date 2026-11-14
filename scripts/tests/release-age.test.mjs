// Tests for the npm-min-release-age gate in scripts/harness-check.sh.
//
// The gate failed twice for reasons that had nothing to do with the setting:
// the sandbox masks ~/.npmrc so the read came back empty, and a bare shell
// resolved /usr/bin/npm 10.9.9 while an 11.x npm sat unused in ~/.local/bin.
// Both are environment accidents, so both get a test here: the forwarded
// NPM_CONFIG_MIN_RELEASE_AGE value, the shadowing WARN, and — so the gate stays
// a gate — the FAIL it still has to produce when no npm 11 is reachable.
// Radar Vol. 35: blip 99 Safe Chain, blip 1 agent sandboxing, blip 29 harness
// quality evaluation.
//
// Every case runs the real script against stub npm binaries; nothing here
// touches the machine's own npm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(ROOT, "scripts/harness-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "release-age-"));

let n = 0;

// A stub npm: --version prints the version, `config get min-release-age` prints
// the age (empty when it should look like the sandbox's masked file).
function stubNpm(version, age) {
	const dir = join(tmp, `bin-${n++}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "npm");
	writeFileSync(
		file,
		`#!/bin/sh
case "$1" in
--version) echo ${version} ;;
config) printf '%s' "${age}" ;;
*) exit 1 ;;
esac
`,
	);
	chmodSync(file, 0o755);
	return file;
}

// One release-age-only run, in a scratch HOME and a PATH that holds the stub
// first and the tools the script needs behind it. PI_NPM_CANDIDATES pins the
// other installs the gate may look at, so the machine's /usr/local/bin/npm
// cannot change the verdict of a test.
function check({ pathNpm, candidates = "", age, home = join(tmp, `home-${n++}`) }) {
	const bin = dirname(pathNpm);
	const env = {
		HOME: home,
		PATH: `${bin}:/usr/bin:/bin`,
		PI_NPM_CANDIDATES: candidates,
	};
	if (age !== undefined) env.NPM_CONFIG_MIN_RELEASE_AGE = age;
	const res = spawnSync("bash", [CHECK, "--verify-release-age"], {
		env,
		encoding: "utf8",
	});
	return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const line = (out, checkName) =>
	out.split("\n").find((l) => l.includes(checkName)) ?? "";

test("NPM_CONFIG_MIN_RELEASE_AGE satisfies the gate without reading any config", () => {
	// Exactly the sandbox case: the config file is masked, so the stub prints
	// nothing for `config` and only the forwarded variable can pass.
	const { status, out } = check({ pathNpm: stubNpm("11.20.0", ""), age: "2" });
	assert.equal(status, 0, out);
	assert.match(line(out, "npm-min-release-age"), /PASS/);
	assert.match(line(out, "npm-min-release-age"), /NPM_CONFIG_MIN_RELEASE_AGE/);
});

test("the config file is still read when nothing is forwarded", () => {
	const { status, out } = check({ pathNpm: stubNpm("11.20.0", "3") });
	assert.equal(status, 0, out);
	assert.match(line(out, "npm-min-release-age"), /PASS/);
	assert.match(line(out, "npm-min-release-age"), /from npm config/);
});

test("a forwarded value below the quarantine is a FAIL", () => {
	const { status, out } = check({ pathNpm: stubNpm("11.20.0", "2"), age: "1" });
	assert.equal(status, 1, out);
	assert.match(line(out, "npm-min-release-age"), /FAIL/);
});

test("a shadowed npm 11 passes, with one WARN naming the old PATH npm", () => {
	// The bare-shell case: /usr/bin/npm 10.9.9 first on PATH, an 11.x next to it.
	const newer = stubNpm("11.21.2", "2");
	const { status, out } = check({
		pathNpm: stubNpm("10.9.9", "2"),
		candidates: newer,
	});
	assert.equal(status, 0, out);
	assert.match(line(out, "npm-min-release-age "), /PASS/);
	assert.match(line(out, "npm-min-release-age-path"), /WARN/);
	assert.match(line(out, "npm-min-release-age-path"), /shadows/);
	assert.match(line(out, "npm-min-release-age-path"), /10\.9\.9/);
});

test("no reachable npm 11 is still a FAIL — the gate is not dead", () => {
	const { status, out } = check({ pathNpm: stubNpm("10.9.9", "2") });
	assert.equal(status, 1, out);
	assert.match(line(out, "npm-min-release-age"), /FAIL/);
	assert.match(line(out, "npm-min-release-age"), /needs npm ≥ 11/);
});

test("an unreadable config with no forwarded value is a FAIL, not a pass", () => {
	const { status, out } = check({ pathNpm: stubNpm("11.20.0", "") });
	assert.equal(status, 1, out);
	assert.match(line(out, "npm-min-release-age"), /FAIL/);
});
