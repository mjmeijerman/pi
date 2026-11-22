// The four things a real Windows install (winget, setup.ps1, no Developer Mode) got wrong.
//
// The box came up with no harness space, then with `space-lib.sh: No such file or
// directory` when the space was made by hand, then with "not recognized" for
// every bare name, and a record whose Boss argv was an extensionless bash script
// Herdr cannot start. One cause per line: `bin/space` was exec'd instead of run
// through bash, copy mode copied a program without its library, nothing put the
// bin directory on `PATH`, and `space new` recorded the POSIX path.
//
// No Windows host exists here, so the platform is forced (`PI_PLATFORM=win32`,
// the knob the engine and the other Windows suites already read) and the claims
// are argv- and file-level: which command the step started, which files landed,
// which line the summary printed, what the record holds. What only a Windows
// machine can show is that Herdr starts the `.cmd`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SOURCE_LIBS, userPathLine } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN_DIR = (home) => path.join(home, '.local', 'bin');
const RECORD = (home) => path.join(home, '.pi', 'state', 'spaces', 'harness', 'space.json');

function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-win-space-'));
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
		PI_SKIP_PREREQS: '1',
		PI_ALLOW_MISSING_PI: '1',
		...extra,
	};
	// Any of these would decide an answer before the test does.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES', 'PI_GIT_BASH']) {
		if (!(name in extra)) delete env[name];
	}
	return env;
}

function install(home, extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], {
		cwd: ROOT,
		env: envFor(home, extra),
		encoding: 'utf8',
	});
}

/**
 * stubHerdrApp — a PATH directory with one `herdr-app` that answers `do
 * space.new` and `ls` and nothing else, so the space step has an app to talk to
 * without the desktop app on this machine.
 */
function stubHerdrApp(t, home) {
	const dir = path.join(home, 'stub-bin');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'herdr-app'),
		[
			'#!/bin/sh',
			'case "$1 $2" in',
			'  "do space.new") printf \'{"space":"sp-test","tab":"tab-boss","terminal":"term-1"}\\n\' ;;',
			'  "ls ") printf \'{"spaces":[{"id":"sp-test","name":"harness"}]}\\n\' ;;',
			'  *) exit 1 ;;',
			'esac',
			'',
		].join('\n'),
		{ mode: 0o755 },
	);
	return dir;
}

/**
 * realBash — a `bash.exe` that exists, records the argv it was given and then
 * runs it, so the step's choice of interpreter is visible in a file and the
 * command it chose still does its work.
 */
function realBash(t, home) {
	const dir = path.join(home, 'git', 'bin');
	fs.mkdirSync(dir, { recursive: true });
	const log = path.join(home, 'bash.argv');
	const file = path.join(dir, 'bash.exe');
	fs.writeFileSync(file, ['#!/bin/bash', `printf '%s\\n' "$*" >> "${log}"`, 'exec bash "$@"', ''].join('\n'), { mode: 0o755 });
	return { file, log };
}

test('with no Git Bash the space step is skipped and names the .cmd a person can run', (t) => {
	const home = tempHome(t);
	const stub = stubHerdrApp(t, home);
	const run = install(home, { PATH: `${stub}${path.delimiter}${process.env.PATH || ''}` });
	const out = `${run.stdout}${run.stderr}`;

	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);
	// The step says why, and the by-hand command is a file Windows starts. It used
	// to be the extensionless `bin/space`, which opened the "select an app" dialog
	// and left the box with no space and a green transcript.
	assert.match(
		out,
		/^== space harness: no Git Bash found and bin\/space is a bash program — .*make it by hand: ".*\.local.bin.space\.cmd" new --name harness --project .* --kind harness$/m,
		`the skip does not name the .cmd by hand command:\n${out}`,
	);
	assert.doesNotMatch(out, /make it by hand: "[^"]*bin\/space"/, `the by-hand command is the extensionless script again:\n${out}`);
	assert.equal(fs.existsSync(RECORD(home)), false, 'a record was written with nothing to open the space');
});

test('with Git Bash the space step runs bin/space through it, and the record names pi-bare.cmd', (t) => {
	const home = tempHome(t);
	const stub = stubHerdrApp(t, home);
	const bash = realBash(t, home);
	const run = install(home, { PATH: `${stub}${path.delimiter}${process.env.PATH || ''}`, PI_GIT_BASH: bash.file });
	const out = `${run.stdout}${run.stderr}`;

	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);
	// The interpreter is the proof: exec'ing the script itself is the bug.
	assert.ok(fs.existsSync(bash.log), `the step never ran ${bash.file}:\n${out}`);
	const logged = fs.readFileSync(bash.log, 'utf8');
	// Literal pieces, not a built pattern: semgrep refuses a RegExp made from a
	// value, and the claim is "bash was handed space new" either way.
	assert.ok(logged.includes('bin/space new --name harness --project '), `bash was not handed \`space new\`: ${logged}`);
	assert.ok(logged.includes('--kind harness'), `the arguments the step passed lost --kind: ${logged}`);

	// And the record Herdr reopens after a reboot names the `.cmd`, never the
	// extensionless script: Windows starts a program, not a shebang.
	assert.ok(fs.existsSync(RECORD(home)), `no space record:\n${out}`);
	const record = JSON.parse(fs.readFileSync(RECORD(home), 'utf8'));
	assert.deepEqual(record.boss_argv, [path.join(BIN_DIR(home), 'pi-bare.cmd')], `the Boss argv is not the .cmd on PATH: ${JSON.stringify(record.boss_argv)}`);
	assert.ok(fs.existsSync(record.boss_argv[0]), `the recorded Boss argv does not exist: ${record.boss_argv[0]}`);
});

test('copy mode copies the libraries the tools source beside the entries; symlink mode copies none', (t) => {
	const win = tempHome(t);
	assert.equal(install(win).status, 0);
	const binDir = BIN_DIR(win);

	// The entry is a copy, which is why its library has to be one too: a copy of
	// `space` at %USERPROFILE%\.local\bin sourced $here/space-lib.sh and died.
	assert.equal(fs.lstatSync(path.join(binDir, 'space')).isSymbolicLink(), false, 'copy mode wrote a symlink');
	for (const name of SOURCE_LIBS) {
		const dest = path.join(binDir, name);
		assert.ok(fs.existsSync(dest), `${name} was not copied beside the entries`);
		assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(ROOT, 'bin', name)), `${name} landed with other contents`);
	}

	// A symlink install reads the libraries through the link, so it copies nothing:
	// the second half of the same rule, and the reason this is not "always copy".
	const posix = tempHome(t);
	assert.equal(install(posix, { PI_PLATFORM: 'linux' }).status, 0);
	const posixBin = BIN_DIR(posix);
	assert.equal(fs.lstatSync(path.join(posixBin, 'space')).isSymbolicLink(), true, 'symlink mode wrote a copy');
	for (const name of SOURCE_LIBS) {
		assert.equal(fs.existsSync(path.join(posixBin, name)), false, `${name} was copied in symlink mode, where the link already reads it`);
	}
});

test('the summary prints the one PowerShell line for the bin directory, and never writes PATH', (t) => {
	const home = tempHome(t);
	const out = `${install(home).stdout}`;

	// The line is data the test can compare, not prose: the same function the
	// summary calls, over the same directory.
	const expected = userPathLine({ platform: 'win32', binDir: BIN_DIR(home), pathEnv: '' });
	assert.ok(expected, 'userPathLine said nothing for a bin directory that is not on PATH');
	assert.ok(out.includes(expected), `the summary did not print the PATH line:\n${out}`);
	assert.match(out, /not on your user PATH — nothing there is found by its bare name/, `the summary does not say why:\n${out}`);

	// Already on PATH is a line nobody needs, so it is not printed.
	const home2 = tempHome(t);
	const onPath = `${BIN_DIR(home2)};C:\\Windows`;
	assert.equal(install(home2, { PATH: onPath }).stdout.includes('SetEnvironmentVariable'), false, 'the PATH line was printed for a directory that is already on PATH');
});

test('userPathLine appends to the user PATH, and says nothing where it does not apply', () => {
	const line = userPathLine({ platform: 'win32', binDir: 'C:\\Users\\mj\\.local\\bin', pathEnv: '' });
	assert.equal(typeof line, 'string');
	// Append, never overwrite: the user PATH is somebody's own list.
	assert.ok(line.includes(`[Environment]::GetEnvironmentVariable('Path','User') + ';'`), line);
	assert.ok(line.includes(`'C:\\Users\\mj\\.local\\bin'`), line);
	assert.ok(line.includes(`'User')`), line);

	// Nothing to say on the two POSIX systems, or with no directory named.
	assert.equal(userPathLine({ platform: 'linux', binDir: '/home/mj/.local/bin', pathEnv: '' }), null);
	assert.equal(userPathLine({ platform: 'darwin', binDir: '/Users/mj/.local/bin', pathEnv: '' }), null);
	assert.equal(userPathLine({ platform: 'win32', binDir: '', pathEnv: '' }), null);
	// Already there, in either case and with a trailing separator: same directory,
	// and a second copy on PATH is the doubled entry nobody can find later.
	assert.equal(userPathLine({ platform: 'win32', binDir: 'C:\\Users\\MJ\\.local\\bin', pathEnv: 'C:\\windows;c:\\users\\mj\\.local\\bin\\' }), null);
});
