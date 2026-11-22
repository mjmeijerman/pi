// Which `space` the durable mod runs, on a Linux home and on a Windows one.
//
// The reported failure is one line long: `'herdr exec': cannot run ~/.pi/bin/space: %1 is
// not a valid Win32 application. (os error 193)`. The mod resolved the bash wrapper on
// every platform; on Windows the only file that starts is the `.cmd` the installer writes
// beside it. So these assertions pin the rule rather than a path: the `.cmd` on a Windows
// home when it is really there, the wrapper otherwise, and a refusal naming both paths when
// neither is — never a `.cmd` guessed from a platform name.

import assert from "node:assert/strict";
import test from "node:test";

import { programCandidates, toolProgram, windowsHome } from "../../herdr-mods/durable/space-path.mjs";

/** An `exists` that answers for a fixed set of files, and nothing else. */
const there = (...files) => (file) => files.includes(file);

/** The Error a call throws: `assert.throws` hands back nothing, and the sentence is the point. */
const refusal = (fn) => {
	try {
		fn();
	} catch (e) {
		return e;
	}
	assert.fail("no refusal, and there should be one");
};

const LINUX = "/home/someone";
const WINDOWS = "C:\\Users\\mj";

test("a Windows home is a drive letter or a backslash, and a POSIX home is neither", () => {
	assert.equal(windowsHome(WINDOWS), true);
	assert.equal(windowsHome("C:/Users/mj"), true);
	assert.equal(windowsHome(LINUX), false);
	assert.equal(windowsHome("/Users/mj"), false);
	assert.equal(windowsHome(""), false);
});

test("a POSIX home runs the wrapper it always did", () => {
	const program = toolProgram({ home: LINUX, name: "space", exists: there(`${LINUX}/.pi/bin/space`) });
	assert.equal(program, `${LINUX}/.pi/bin/space`);
});

test("a Windows home runs the .cmd the installer writes, not the bash wrapper", () => {
	assert.deepEqual(programCandidates({ home: WINDOWS, name: "space" }), [
		`${WINDOWS}\\.local\\bin\\space.cmd`,
		`${WINDOWS}/.pi/bin/space`,
	]);
	// Both files exist on a real Windows install: the wrapper is a text file to Windows,
	// and the `.cmd` beside it is what starts. The `.cmd` has to win.
	const program = toolProgram({
		home: WINDOWS,
		name: "space",
		exists: there(`${WINDOWS}\\.local\\bin\\space.cmd`, `${WINDOWS}/.pi/bin/space`),
	});
	assert.equal(program, `${WINDOWS}\\.local\\bin\\space.cmd`);
	assert.ok(program.endsWith("space.cmd"));
});

test("a .cmd that is not on disk is not guessed: the wrapper is used, or nothing is", () => {
	// No Git Bash during the install means no shim was written; the mod must not name a
	// file that is not there and turn one clear failure into a mystery.
	assert.equal(
		toolProgram({ home: WINDOWS, name: "space", exists: there(`${WINDOWS}/.pi/bin/space`) }),
		`${WINDOWS}/.pi/bin/space`,
	);
	const missing = refusal(() => toolProgram({ home: WINDOWS, name: "space", exists: there() }));
	assert.match(missing.message, /space\.cmd/);
	assert.match(missing.message, /\.pi\/bin\/space/);
	// One sentence, and it names the fix.
	assert.equal(missing.message.split(" — ").length, 2, missing.message);
	assert.match(missing.message, /re-run the installer/);
});

test("the same rule picks the guard the List view runs", () => {
	assert.equal(
		toolProgram({ home: WINDOWS, name: "guard", exists: there(`${WINDOWS}\\.local\\bin\\guard.cmd`) }),
		`${WINDOWS}\\.local\\bin\\guard.cmd`,
	);
	assert.equal(toolProgram({ home: LINUX, name: "guard", exists: there(`${LINUX}/.pi/bin/guard`) }), `${LINUX}/.pi/bin/guard`);
});

test("an existence check that throws is not evidence that a file is there", () => {
	const program = toolProgram({
		home: WINDOWS,
		name: "space",
		exists: (file) => {
			if (file.endsWith(".cmd")) throw new Error("EACCES");
			return file.endsWith("/space");
		},
	});
	assert.equal(program, `${WINDOWS}/.pi/bin/space`);
});

test("no home, no name, or no existence answer is a refusal, not a guess", () => {
	assert.throws(() => toolProgram({ home: "", name: "space", exists: there() }), /home folder/);
	assert.throws(() => toolProgram({ home: LINUX, name: "", exists: there() }), /program name/);
	assert.throws(() => toolProgram({ home: LINUX, name: "space" }), /exists/);
});
