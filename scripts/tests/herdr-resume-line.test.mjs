/**
 * herdr-resume: the line it types, per shell.
 *
 * The reboot end-to-end in `herdr-resume-reboot.test.mjs` needs a POSIX host and a scratch hc
 * core, so the one thing that broke on Windows was untestable where it broke. This file asks the
 * line builder alone: no hc, no terminal, the same answer on every host.
 *
 * What it pins: herdr hands a Windows tab back as `powershell.exe`, and PowerShell has no `exec`.
 * The POSIX line was typed there every boot — `hc read t15` on 2026-11-24 shows the same
 * `CommandNotFoundException` twice per pass, twice per boot, and a Boss tab that never came back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resumeLine, shellFamily } from "../herdr-resume.mjs";

const cliJs = "C:\\Users\\markm\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
const sessionFile = "C:\\Users\\markm\\.pi\\agent\\sessions\\--C--Users-markm--\\2026-11-23T17-59-08-737Z_01a2098f.jsonl";
const windowsEntry = { argv: [cliJs], session_path: sessionFile };
const posixEntry = { argv: ["/home/m/.local/bin/pi"], session_path: "/home/m/.pi/agent/sessions/x.jsonl" };

/** A terminal whose recovered shell is that program. */
function shellThatIs(...argv) {
	return { state: "live", foreground: { argv, name: argv[0] } };
}

test("a recovered POSIX shell is told to exec, and the shell is replaced", () => {
	for (const shell of ["/usr/bin/zsh", "/bin/bash", "/usr/bin/fish", "/usr/bin/nu"]) {
		const line = resumeLine(posixEntry, shellThatIs(shell));
		assert.match(line, /^exec /, `${shell} must get exec`);
		assert.match(line, /--session /);
	}
});

test("a recovered PowerShell tab is never told to exec", () => {
	for (const shell of [
		"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	]) {
		const line = resumeLine(windowsEntry, shellThatIs(shell, "-NoExit", "-Command", "$function:prompt"));
		assert.match(line, /^& /, `${shell} must get the call operator`);
		assert.doesNotMatch(line, /\bexec\b/, `${shell} has no exec: that line is CommandNotFoundException`);
		assert.match(line, /--session/);
	}
});

test("a .js argv[0] is run by an interpreter, not by the file association", () => {
	// PowerShell would hand `…\cli.js` to whatever owns `.js` on that machine. The script is
	// already running under an interpreter, so it names it.
	const line = resumeLine(windowsEntry, shellThatIs("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
	assert.ok(line.includes(process.execPath), "the interpreter that runs the resume is named");
	assert.ok(line.includes("'C:\\Users\\markm\\AppData"), "the cli path is there, single-quoted");
	assert.ok(line.indexOf(process.execPath) < line.indexOf("cli.js"), "node comes first, not the script");
});

test("a path with a quote in it survives the quoting", () => {
	const entry = { argv: ["C:\\Program Files\\it's\\cli.js"], session_path: "C:\\a\\b.jsonl" };
	const line = resumeLine(entry, shellThatIs("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
	assert.ok(line.includes("'C:\\Program Files\\it''s\\cli.js'"), `PowerShell escapes a quote by doubling it: ${line}`);
});

test("a recovered cmd.exe gets cmd quoting", () => {
	const line = resumeLine(windowsEntry, shellThatIs("C:\\WINDOWS\\system32\\cmd.exe"));
	assert.doesNotMatch(line, /\bexec\b/);
	assert.match(line, /^"C:\\Program Files\\nodejs\\node\.exe" /, "the interpreter comes first and is quoted");
	assert.match(line, /--session /, "a plain flag is not quoted");
	assert.match(line, / "C:\\Users\\markm\\AppData.*cli\.js" /, "a path with an `@` in it is quoted");
});

test("every shell that herdr hands back is placed in one family", () => {
	assert.equal(shellFamily(["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]), "powershell");
	assert.equal(shellFamily(["powershell.exe"]), "powershell");
	assert.equal(shellFamily(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]), "powershell");
	assert.equal(shellFamily(["C:\\WINDOWS\\system32\\cmd.exe"]), "cmd");
	assert.equal(shellFamily(["/usr/bin/zsh"]), "posix");
	assert.equal(shellFamily(["/bin/bash"]), "posix");
	assert.equal(shellFamily(undefined), "posix");
});
