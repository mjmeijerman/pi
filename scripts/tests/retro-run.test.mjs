// Tests for scripts/retro.mjs — the headless half of `/retro`.
//
// Why these exist: the whole point of the weekly retro is that nobody types `/retro`
// any more, so the failure to catch is a run that looks scheduled and reports nothing.
// Three cases carry that promise: an empty log writes a record saying so and no empty
// digest, a populated log writes a digest whose count matches the log, and the log
// itself comes back byte-for-byte unchanged (the spec forbids deleting an entry).
// Radar Vol. 35: blip 25 agent suggestion box, blip 11 feedback flywheel, blip 29
// harness quality evaluation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/retro.mjs");

const dirs = [];

function newAgentDir() {
	const dir = mkdtempSync(join(tmpdir(), "retro-run-"));
	dirs.push(dir);
	mkdirSync(join(dir, "retro"), { recursive: true });
	return dir;
}

function run(agentDir, now) {
	return spawnSync(process.execPath, [SCRIPT, "--agent-dir", agentDir, "--now", now], {
		encoding: "utf8",
	});
}

function record(agentDir) {
	const raw = readFileSync(join(agentDir, "retro/last-run.txt"), "utf8");
	const fields = {};
	for (const line of raw.split("\n")) {
		const at = line.indexOf("=");
		if (line.startsWith("#") || at === -1) continue;
		fields[line.slice(0, at)] = line.slice(at + 1);
	}
	return fields;
}

function writeLog(agentDir, entries) {
	const path = join(agentDir, "suggestions.jsonl");
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

test.after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("empty log: record says nothing to aggregate, no digest written", () => {
	const agentDir = newAgentDir();
	const result = run(agentDir, "2026-03-02T06:00:00Z");
	assert.equal(result.status, 0, result.stderr);
	const fields = record(agentDir);
	assert.equal(fields.entries_seen, "0");
	assert.equal(fields.entries_new, "0");
	assert.equal(fields.digest, "none");
	assert.match(fields.note, /nothing to aggregate/);
	assert.equal(fields.ran_at, "2026-03-02T06:00:00.000Z");
	assert.deepEqual(
		readdirSync(join(agentDir, "retro")).filter((file) => file.endsWith(".md")),
		[],
		"an empty log must not leave an empty digest behind",
	);
});

test("populated log: digest written, record counts match, log untouched", () => {
	const agentDir = newAgentDir();
	const logPath = writeLog(agentDir, [
		{ ts: "2026-02-20T09:00:00.000Z", kind: "note", signature: "aaa", message: "sandbox hid the X11 socket" },
		{ ts: "2026-02-21T09:00:00.000Z", kind: "tool-error", signature: "bbb", tool: "bash", message: "ls: nope" },
		{ ts: "2026-02-22T09:00:00.000Z", kind: "note", signature: "aaa", message: "sandbox hid the X11 socket" },
	]);
	const before = readFileSync(logPath, "utf8");

	const result = run(agentDir, "2026-03-02T06:00:00Z");
	assert.equal(result.status, 0, result.stderr);

	const fields = record(agentDir);
	assert.equal(fields.entries_seen, "3");
	assert.equal(fields.entries_new, "3", "a first run counts every entry as new");
	assert.equal(fields.digest, join(agentDir, "retro/2026-03-02.md"));
	assert.match(fields.note, /2 signatures, 3 entries/);

	const digest = readFileSync(fields.digest, "utf8");
	assert.match(digest, /^# Harness retro — 2026-03-02$/m, "digest is dated with the run, not the clock");
	assert.match(digest, /3 recorded problems in 2 distinct signatures/);
	assert.match(digest, /sandbox hid the X11 socket/);

	assert.equal(readFileSync(logPath, "utf8"), before, "the suggestion log must never be rewritten");
});

test("second run counts only entries recorded since the last run", () => {
	const agentDir = newAgentDir();
	writeLog(agentDir, [
		{ ts: "2026-02-20T09:00:00.000Z", kind: "note", signature: "aaa", message: "one" },
	]);
	assert.equal(run(agentDir, "2026-03-02T06:00:00Z").status, 0);

	writeLog(agentDir, [
		{ ts: "2026-02-20T09:00:00.000Z", kind: "note", signature: "aaa", message: "one" },
		{ ts: "2026-03-05T09:00:00.000Z", kind: "note", signature: "ccc", message: "two" },
	]);
	assert.equal(run(agentDir, "2026-03-09T06:00:00Z").status, 0);

	const fields = record(agentDir);
	assert.equal(fields.entries_seen, "2");
	assert.equal(fields.entries_new, "1");
	assert.ok(existsSync(fields.digest), `digest missing: ${fields.digest}`);
});
