// The third Windows hole: PATH full of files Windows cannot start.
//
// `pisandbox`, `pi-bare`, `jev`, `delegate` and `local-run` are bash programs,
// and the installer copied them onto PATH under their POSIX names. On Windows a
// file with `#!/usr/bin/env bash` in it is a text file: PowerShell says nothing
// useful, and the `Pi (bare)` Herdr row — which #182 pointed at
// `~/.local/bin/pi-bare.cmd` — launched a file nobody wrote. The fix writes one
// `<name>.cmd` per wrapper, built from one bash resolution, and these tests pin
// the shim's argv, the resolution order, and the fact that the menu row's
// `run` path is the file that is really there.
//
// No Windows host exists here, so the menu and the scheduled task are proven at
// argv level: the bytes of the `.cmd`, the exact path programs.json holds. What
// only a Windows machine can show is that Herdr and Task Scheduler execute it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HARNESS_TOOLS, cmdShim, POSIX_WRAPPERS, resolveGitBash } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// --- the shim ---------------------------------------------------------------

test('cmdShim runs the resolved bash on the wrapper, forwards %* and the exit status', () => {
	const shim = cmdShim({
		bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
		scriptPath: 'C:\\Users\\mj\\.local\\bin\\pi-bare',
	});
	const lines = shim.split('\r\n');

	assert.equal(lines[0], '@echo off');
	// Two spellings on purpose: cmd.exe runs bash.exe, so it keeps backslashes;
	// Git Bash reads the script path, so it gets forward slashes and no question
	// about whether a backslash was an escape.
	assert.equal(lines[2], '"C:\\Program Files\\Git\\bin\\bash.exe" "C:/Users/mj/.local/bin/pi-bare" %*');
	assert.equal(lines[3], 'exit /b %ERRORLEVEL%');
	// CRLF, not LF: a .cmd that cmd.exe parses line by line is the one thing this
	// file cannot get wrong, and it is the reason it is generated here at all.
	assert.ok(shim.includes('\r\n'));
	assert.equal(shim.replace(/\r\n/g, '').includes('\n'), false);

	// A shim that names no interpreter, or no script, is the bug in a new file.
	assert.throws(() => cmdShim({ scriptPath: 'C:\\x\\pi-bare' }), /bash\.exe/);
	assert.throws(() => cmdShim({ bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }), /wrapper/);
});

// --- where bash is ----------------------------------------------------------

const GIT = {
	ProgramFiles: 'C:\\Program Files',
	LOCALAPPDATA: 'C:\\Users\\mj\\AppData\\Local',
};
const onPath = (file) => ({ exists: (p) => p === file });

test('resolveGitBash takes PI_GIT_BASH first, then PATH, then the Git for Windows directories', () => {
	const present = (set) => ({ exists: (p) => set.includes(p) });

	// The override wins over everything else, and is not rewritten.
	assert.equal(
		resolveGitBash({
			platform: 'win32',
			env: { ...GIT, PATH: 'C:\\Users\\mj\\bin', PI_GIT_BASH: 'D:\\Git\\usr\\bin\\bash.exe' },
			...present(['D:\\Git\\usr\\bin\\bash.exe', 'C:\\Users\\mj\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']),
		}),
		'D:\\Git\\usr\\bin\\bash.exe',
	);

	// Each source alone: the answer is that source, not null and not a default.
	assert.equal(resolveGitBash({ platform: 'win32', env: { ...GIT, PATH: 'C:\\Users\\mj\\bin' }, ...onPath('C:\\Users\\mj\\bin\\bash.exe') }), 'C:\\Users\\mj\\bin\\bash.exe');
	for (const file of [
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
		'C:\\Users\\mj\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
	]) {
		assert.equal(resolveGitBash({ platform: 'win32', env: GIT, ...onPath(file) }), file);
	}

	// Nothing there: null, so the caller can say so once instead of writing a
	// shim that points at a file that does not exist.
	assert.equal(resolveGitBash({ platform: 'win32', env: GIT, ...present([]) }), null);

	// The WSL launcher is named bash.exe and is not Git Bash: a shim built on it
	// starts a Linux shell that cannot open `C:\...\pi-bare`. Skipped on PATH.
	assert.equal(
		resolveGitBash({ platform: 'win32', env: { ...GIT, SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }, ...onPath('C:\\Windows\\System32\\bash.exe') }),
		null,
	);
	// The guard task is Windows-only; elsewhere bash has a shebang.
	assert.equal(resolveGitBash({ platform: 'linux', env: GIT, ...onPath('/bin/bash') }), null);
});

// --- the engine, in a throwaway HOME ----------------------------------------

function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-win-cmd-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

function envFor(home, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		PI_PLATFORM: 'win32',
		PI_SKIP_NETWORK: '1',
		PI_SKIP_SYSTEMD: '1',
		PI_ALLOW_MISSING_PI: '1',
		PI_SKIP_PREREQS: '1',
		PI_BOSS_DIR: path.join(home, 'big-boss-pi'),
		...extra,
	};
	// Any of these would decide the answer before the test does.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES']) {
		if (!(name in extra)) delete env[name];
	}
	if (!('PI_GIT_BASH' in extra)) delete env.PI_GIT_BASH;
	return env;
}

function install(home, args = [], extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), ...args], {
		env: envFor(home, extra),
		encoding: 'utf8',
		cwd: ROOT,
	});
}

/**
 * everyWrapper — the two lists that end up on PATH, as { name, source }.
 *
 * POSIX_WRAPPERS says where the bash pair comes from; HARNESS_TOOLS is the rest
 * of `bin/`. Both are read from the engine, so a tool added to either is checked
 * here without touching this file — the thing that made the old hardcoded five
 * go stale the moment a sixth arrived.
 */
function everyWrapper() {
	const seen = new Map();
	for (const wrapper of POSIX_WRAPPERS) seen.set(wrapper.name, path.join(ROOT, wrapper.from, wrapper.name));
	for (const name of HARNESS_TOOLS) if (!seen.has(name)) seen.set(name, path.join(ROOT, 'bin', name));
	return [...seen].map(([name, source]) => ({ name, source }));
}

const bashPath = (home) => path.join(home, 'git', 'bin', 'bash.exe');

/** fakeBash — a real file at the path PI_GIT_BASH will name, so `exists` is not a lie. */
function fakeBash(home) {
	const file = bashPath(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '');
	return file;
}

const cmdFiles = (dir) => {
	try {
		return fs.readdirSync(dir).filter((n) => n.endsWith('.cmd')).sort();
	} catch {
		return [];
	}
};

test('every wrapper the installer puts on PATH gets a .cmd built from the resolved bash', (t) => {
	const home = tempHome(t);
	const bash = fakeBash(home);

	const out = install(home, [], { PI_GIT_BASH: bash });
	assert.equal(out.status, 0, out.stderr);

	const binDir = path.join(home, '.local', 'bin');
	// Driven off the engine's lists, not a second copy of them: a seventh wrapper
	// added to either is checked here without touching this test.
	for (const wrapper of everyWrapper()) {
		// The source is a bash program in this repo, which is why it needs a shim
		// at all; a wrapper that was not would be a wrong entry in the list.
		const source = wrapper.source;
		assert.ok(fs.existsSync(source), `${wrapper.name}: no source at ${source}`);
		assert.match(fs.readFileSync(source, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env bash$/, `${wrapper.name} is not a bash program`);

		const file = path.join(binDir, `${wrapper.name}.cmd`);
		assert.ok(fs.existsSync(file), `${wrapper.name}.cmd missing`);
		const shim = fs.readFileSync(file, 'utf8');
		assert.ok(shim.includes(`"${bash}"`), shim);
		assert.ok(shim.includes(path.join(binDir, wrapper.name).replace(/\\/g, '/')), shim);
		assert.match(shim, / %\*\r\nexit \/b %ERRORLEVEL%\r\n$/);
		// No computed regex: semgrep's detect-non-literal-regexp flagged this line and
		// cost a CI round, and the check does not need a pattern. The reported path
		// is mid-line and the interpreter is the end of it, so exact substrings say
		// the same thing and cannot be wrong about escaping.
		const shimLine = out.stdout.split('\n').find((line) => line.startsWith(`== ${wrapper.name}.cmd -> `));
		assert.ok(shimLine, `no "== ${wrapper.name}.cmd ->" line in:\n${out.stdout}`);
		assert.ok(shimLine.endsWith(`(runs ${bash})`), shimLine);
		// The POSIX file stays beside it: Git Bash and every POSIX consumer runs
		// that one, and #182's `.pi/scripts` copy is not a substitute.
		assert.ok(fs.existsSync(path.join(binDir, wrapper.name)), `${wrapper.name} itself was removed`);
	}
	assert.deepEqual(cmdFiles(binDir), everyWrapper().map((w) => `${w.name}.cmd`).sort());
});

test('the Herdr menu row runs the .cmd that was actually written', (t) => {
	const home = tempHome(t);
	const bash = fakeBash(home);
	assert.equal(install(home, [], { PI_GIT_BASH: bash }).status, 0);

	const programs = JSON.parse(fs.readFileSync(path.join(home, '.config', 'herdr-app', 'programs.json'), 'utf8'));
	const run = programs.programs['pi-bare'].run;
	assert.deepEqual(run, [path.join(home, '.local', 'bin', 'pi-bare.cmd')]);
	// The hole this closes: #182 wrote the row and nothing wrote the file, so the
	// row appeared and launched nothing.
	assert.ok(fs.existsSync(run[0]), `the menu row points at ${run[0]}, which does not exist`);
	assert.ok(fs.readFileSync(run[0], 'utf8').includes(`"${bash}"`));
});

test('sandbox/herdr-programs.json holds a wrapper name, never a path', () => {
	// The file ships to every machine. The absolute path it used to hold was one
	// person's home: every Linux install copied the template verbatim, so the
	// menu row pointed at a file that is not there. The bug was a path in this
	// file, so the test names paths rather than pinning the file byte for byte.
	const template = path.join(ROOT, 'sandbox', 'herdr-programs.json');
	const programs = JSON.parse(fs.readFileSync(template, 'utf8')).programs;
	for (const [key, entry] of Object.entries(programs)) {
		for (const program of entry.run || []) {
			assert.equal(path.isAbsolute(program), false, key + ': run holds the absolute path ' + program);
			assert.doesNotMatch(program, /[\\/]|^[A-Za-z]:/, key + ': run holds a path (' + program + ') — the engine resolves the name');
		}
	}
	// The engine turns this word into binDir/pi-bare on every platform; a second
	// copy of the resolved path in the template is a second thing to forget.
	assert.deepEqual(programs['pi-bare'].run, ['pi-bare']);
});

test('on Linux the menu row names the pi-bare under this HOME, not the source tree', (t) => {
	const home = tempHome(t);
	// PI_PLATFORM=linux is the branch that inherited the template verbatim, so a
	// Linux install wrote a row pointing at whoever committed it. The plan is
	// forced rather than read from the host, so this says the same thing anywhere.
	const out = install(home, [], { PI_PLATFORM: 'linux' });
	assert.equal(out.status, 0, out.stderr);

	const programs = JSON.parse(fs.readFileSync(path.join(home, '.config', 'herdr-app', 'programs.json'), 'utf8'));
	const run = programs.programs['pi-bare'].run;
	assert.deepEqual(run, [path.join(home, '.local', 'bin', 'pi-bare')]);
	// Under the throwaway HOME, and a file that is really there: the row has to
	// launch something on the machine that reads it, not only on the author's.
	assert.ok(fs.existsSync(run[0]), 'the menu row points at ' + run[0] + ', which does not exist');
	assert.equal(run[0].startsWith(ROOT + path.sep), false, 'the row points into the source tree: ' + run[0]);
});

test('no bash: one message naming PI_GIT_BASH, and not a single .cmd written', (t) => {
	const home = tempHome(t);
	// No PI_GIT_BASH, and a PATH with no bash.exe on it: this Linux host has none
	// under any of the Git for Windows directories either.
	const out = install(home, [], { PI_GIT_BASH: '', PATH: path.join(home, 'empty-path') });
	assert.equal(out.status, 0, out.stderr);

	const binDir = path.join(home, '.local', 'bin');
	assert.deepEqual(cmdFiles(binDir), [], 'a shim was written that cannot run');
	// The POSIX copies stay: Git Bash can still run those, and a run that skipped
	// them would leave the machine with no wrapper at all.
	assert.ok(fs.existsSync(path.join(binDir, 'pi-bare')));
	// Said once, not once per wrapper, and the fix is in the sentence.
	assert.equal(out.stderr.match(/no Git Bash found/g)?.length, 1, out.stderr);
	assert.match(out.stderr, /PI_GIT_BASH/);
	assert.doesNotMatch(out.stdout, /\.cmd -> /);
});

test('a second run writes no .cmd again, and one that did is byte-identical', (t) => {
	const home = tempHome(t);
	const bash = fakeBash(home);
	assert.equal(install(home, [], { PI_GIT_BASH: bash }).status, 0);

	const binDir = path.join(home, '.local', 'bin');
	const before = cmdFiles(binDir).map((name) => {
		const file = path.join(binDir, name);
		return { name, text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
	});
	assert.equal(before.length, everyWrapper().length);

	const second = install(home, [], { PI_GIT_BASH: bash });
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stdout, /\.cmd -> /, 'the second run rewrote a shim');
	for (const file of before) {
		assert.equal(fs.readFileSync(path.join(binDir, file.name), 'utf8'), file.text);
		assert.equal(fs.statSync(path.join(binDir, file.name)).mtimeMs, file.mtime, `${file.name} was rewritten`);
	}
});

test('--dry-run prints the shim lines and writes nothing', (t) => {
	const home = tempHome(t);
	const bash = fakeBash(home);
	assert.equal(install(home, [], { PI_GIT_BASH: bash }).status, 0);

	// Removed first, so "would write" is a claim about a file that is not there:
	// a dry run that quietly re-uses the previous run proves nothing.
	const binDir = path.join(home, '.local', 'bin');
	for (const name of cmdFiles(binDir)) fs.rmSync(path.join(binDir, name));

	const out = install(home, ['--dry-run'], { PI_GIT_BASH: bash });
	assert.equal(out.status, 0, out.stderr);
	for (const wrapper of everyWrapper()) {
		assert.ok(out.stdout.includes(`== ${wrapper.name}.cmd -> `), out.stdout);
	}
	assert.deepEqual(cmdFiles(binDir), [], 'a dry run wrote a shim');
	assert.match(out.stdout, /\(dry run: nothing written\)/);
});
