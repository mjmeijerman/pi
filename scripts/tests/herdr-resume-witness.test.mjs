/**
 * herdr-resume: which answer `startedWitness` gives, per platform.
 *
 * Windows needs a second witness. herdr launches a tab as `powershell.exe -NoExit -Command "&
 * '<program>'"`, and hc keeps answering that launch program as the foreground after `exec` has
 * replaced the shell: measured 2026-11-24, a bash tab running node answered
 * `foreground {name: "bash.exe", pid: 5940}` from the first poll to the last (the live Boss of that
 * day answered `status {app: "pi"}` in the same shape). So on Windows pi's own report is the
 * witness; without it every resume read as "nothing started" and the exec line was typed twice.
 *
 * Off Windows that widening must not apply. There hc answers the real foreground, so a tab that
 * came back as a shell whose status *still* claims `app: pi` has not started at all: counting it as
 * started leaves the exec line untyped and the tab a plain shell — the failure this service exists
 * to end. The two hosts must therefore answer the same facts differently, and that pair is what
 * this file pins.
 *
 * Both answers are asked of the real module: the platform is an injected parameter, not an
 * environment knob, so neither half has to be reasoned about. The import is done in a scratch
 * child process because importing the script also runs its CLI pass, which appends one
 * "nothing to restore" line when its entries folder is empty.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const script = join(import.meta.dirname, "..", "herdr-resume.mjs");
const root = mkdtempSync(join(tmpdir(), "herdr-witness-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** The terminal's shape, and the two answers to it: this host's, Linux's, and Windows'. */
function witness(facts) {
	const source = `import { startedWitness } from ${JSON.stringify(pathToFileURL(script).href)};
const facts = ${JSON.stringify(facts)};
console.log(JSON.stringify({
	host: startedWitness(facts),
	linux: startedWitness(facts, false),
	windows: startedWitness(facts, true),
}));`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
		encoding: "utf8",
		// An empty entries folder: the import's CLI pass has nothing to restore and stops there.
		env: { ...process.env, PI_HERDR_RESUME_DIR: join(root, "empty"), PI_HERDR_RESUME_WAIT_MS: "0" },
	});
	return JSON.parse(out.trim().split("\n").pop());
}

/** Windows after `exec`: hc still calls the shell the foreground, and pi says who it is. */
function shellWithPiStatus(foreground) {
	return {
		state: "live",
		argv: ["bash"],
		foreground,
		status: { app: "pi", state: "working" },
	};
}

test("a shell that still says app: pi is a start on Windows, and not on Linux", () => {
	// The pair is the point: Linux must type the exec line into this tab, Windows must not.
	const answers = witness(shellWithPiStatus({ argv: ["bash.exe"], name: "bash.exe", pid: process.pid }));
	assert.equal(answers.linux, false, "on Linux a shell in the foreground has not started, so the line is typed");
	assert.equal(answers.windows, true, "on Windows pi answering for itself is the start");
	// And the default branch is this host's, so nothing can drift from `IS_WIN`.
	assert.equal(answers.host, process.platform === "win32");
});

test("the measured Windows shape — no foreground argv at all — is the same pair", () => {
	// `hc get` answered exactly this for the live Boss of 2026-11-24: a foreground with a name and
	// a pid and no argv, and pi's own status. Nothing in the argv says "pi", so only the status can.
	const answers = witness(shellWithPiStatus({ name: "bash.exe", pid: process.pid }));
	assert.equal(answers.linux, false);
	assert.equal(answers.windows, true);
	assert.equal(answers.host, process.platform === "win32");
});

test("a real program in the foreground is a start on both platforms", () => {
	// The original witness, untouched: `exec` replaced the shell and that process is alive. Linux
	// must keep answering this, or the service would stop recording its own successes.
	const answers = witness({
		state: "live",
		argv: ["node"],
		foreground: { argv: ["/usr/bin/node", "--session", "/home/mark/.pi/sessions/a.jsonl"], name: "node", pid: process.pid },
		status: {},
	});
	assert.equal(answers.linux, true);
	assert.equal(answers.windows, true);
});
