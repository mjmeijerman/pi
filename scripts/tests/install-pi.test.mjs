// Tests for "installing pi is part of the install".
//
// Why these exist: a person could run the whole interactive install, answer
// every question, and watch it end with `'pi' not found on PATH` and exit 1 —
// because stepPi only installed pi when `--install-pi` was passed and setup.mjs
// never asked. The five cases below are the four ways that can go now, plus the
// ordering that makes the failure cheap:
//
//   a  no flags            -> npm installs pi, the run continues
//   b  --no-install-pi     -> no npm call, no pi, the run continues
//   c  PI_ALLOW_MISSING_PI -> the CI skip line, no npm call
//   d  no pi and no npm    -> non-zero exit, and NOTHING written (empty HOME)
//   e  the ordering: the pi decision is in the preflight, before the first file
//
// The npm call is driven by a fake `npm` on PATH that records its argv, so what
// is asserted is the command line the engine really runs — not a string that
// happens to appear in the source. A real `npm install -g` of the pi package is
// not something a test can do (network, a global install on the runner's node),
// so it is never attempted.
//
// Run: node --test scripts/tests/install-pi.test.mjs  (or make scripts-test)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PI_PACKAGE, nodePrereqHint, piDiskCandidates, piInstallArgv, piInstallCommand, piPreflight, planFor } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const POSIX = process.platform !== 'win32';
const INSTALL_ARGS = ['install', '-g', '--ignore-scripts', PI_PACKAGE];

// --- the decision, as data ---------------------------------------------------

test('piPreflight: pi on PATH is nothing to do; on disk is a PATH entry', () => {
	assert.equal(piPreflight({ onPath: true }).action, 'present');
	// pnpm keeps its bin directory out of PATH, so a pi that is installed is
	// "missing" to a shell that never sourced the wrapper.
	const found = piPreflight({ onDisk: '/home/me/.local/share/pnpm/bin/pi' });
	assert.equal(found.action, 'path');
	assert.equal(found.message, 'pi found on disk, added to PATH: /home/me/.local/share/pnpm/bin/pi');
	// A pi on disk never falls through to a second install.
	assert.equal(piPreflight({ onDisk: '/x/pi', npm: true, install: true }).action, 'path');
});

test('piPreflight: default on, one escape hatch each, and a stop when npm is missing', () => {
	// The default: pi missing, npm present, nothing passed -> install.
	const install = piPreflight({ npm: true, npmBin: 'npm' });
	assert.equal(install.action, 'install', 'pi was not installed by default');
	assert.deepEqual(install.argv, ['npm', ...INSTALL_ARGS], 'the argv is the documented command');
	assert.ok(install.message.includes(piInstallCommand('npm')), 'the line printed is the line run');

	// --no-install-pi: a person saying no in advance. No npm call, no failure.
	assert.equal(piPreflight({ npm: true, install: false }).action, 'skip');
	// PI_ALLOW_MISSING_PI=1: the CI path. Skips even when npm could install.
	assert.equal(piPreflight({ npm: true, allowMissing: true }).action, 'skip');
	assert.equal(piPreflight({ npm: true, allowMissing: true }).message, 'PI_ALLOW_MISSING_PI=1 — config only');

	// No pi and no npm is a stop, not a skip: a half-installed tree is the
	// failure nobody wants, so the run has to die before the first write.
	const stop = piPreflight({ npm: false, plan: planFor('linux') });
	assert.equal(stop.action, 'stop');
	assert.match(stop.message, /no pi on PATH and no npm/);
	assert.ok(stop.fix.join('\n').includes('apt-get install -y nodejs npm'), 'the fix names the command for this OS');
	assert.ok(stop.fix.join('\n').includes(piInstallCommand('npm')), 'and the line to re-run');
	// The escape hatches still win over the stop, in this order.
	assert.equal(piPreflight({ npm: false, allowMissing: true }).action, 'skip');
	assert.equal(piPreflight({ npm: false, install: false }).action, 'skip');
});

test('piPreflight: the npm name is read off the per-OS plan, never spelled by hand', () => {
	// On Windows a bare `npm` is `npm.ps1`, which the default execution policy
	// refuses; the plan carries `npm.cmd` and every call site reads it.
	const win = piPreflight({ npm: true, npmBin: planFor('win32').npmBin, plan: planFor('win32') });
	assert.equal(win.argv[0], 'npm.cmd');
	assert.ok(win.message.includes('npm.cmd install -g'), 'the printed line has to be the runnable one');
	assert.ok(!win.message.includes('npm.ps1'));
	for (const platform of ['linux', 'darwin']) {
		assert.equal(piPreflight({ npm: true, npmBin: planFor(platform).npmBin }).argv[0], 'npm');
	}
	// The stop message names that OS's way of getting Node, not a generic hint.
	assert.match(nodePrereqHint(planFor('win32')), /^winget install --id OpenJS\.NodeJS\.LTS/);
	assert.match(nodePrereqHint(planFor('darwin')), /^brew install node@24/);
	assert.match(nodePrereqHint(planFor('linux')), /^sudo apt-get install -y nodejs npm/);
});

test('piDiskCandidates: the directories pnpm and npm install into, per OS', () => {
	const linux = piDiskCandidates({ home: '/home/me', plan: planFor('linux'), env: {} });
	assert.deepEqual(linux, ['/home/me/.local/share/pnpm/bin/pi', '/home/me/.local/bin/pi']);
	// PNPM_HOME moves the first one, and the engine reads it.
	assert.equal(piDiskCandidates({ home: '/home/me', plan: planFor('linux'), env: { PNPM_HOME: '/opt/pnpm' } })[0], '/opt/pnpm/bin/pi');
	// Windows ships the binary as a .cmd shim (and .exe when it is packaged).
	const win = piDiskCandidates({ home: 'C:\\Users\\me', plan: planFor('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), env: {} });
	assert.equal(win.length, 4);
	for (const candidate of win) assert.match(candidate, /pi\.(cmd|exe)$/);
});

// --- the runs ----------------------------------------------------------------

/** scratch — a throwaway HOME plus a fake `npm` and the PATH that finds it. */
function scratch({ npm = true } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-install-pi-'));
	const home = path.join(dir, 'home');
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(home);
	fs.mkdirSync(bin);
	const log = path.join(dir, 'npm.log');
	if (npm) {
		// Records argv and exits 0: what a real `npm install -g` would do is not
		// testable here, but the command line it would receive is.
		fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
		fs.chmodSync(path.join(bin, 'npm'), 0o755);
	}
	// Only what the engine itself needs, so the machine's real `pi` is invisible:
	// PATH is the sandbox here, not a mock of the engine.
	for (const tool of ['sh', 'git', 'bash', 'node']) {
		const real = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
		if (real) fs.symlinkSync(real, path.join(bin, tool));
	}
	return { dir, home, bin, log };
}

function runEngine(which, { home, bin }, args = [], extraEnv = {}) {
	const env = { ...process.env };
	// These would decide the answer for us: the CI escape hatch, the pnpm prefix
	// that points at the developer's real pi, and a platform override.
	for (const key of ['PI_ALLOW_MISSING_PI', 'PNPM_HOME', 'PI_PLATFORM', 'PI_AGENT_DIR', 'PI_SKILLS', 'PI_EXTENSIONS', 'PI_DRY_RUN']) delete env[key];
	Object.assign(env, {
		HOME: home,
		USERPROFILE: home,
		PATH: bin,
		PI_SKIP_NETWORK: '1',
		PI_SKIP_SYSTEMD: '1',
		...extraEnv,
	});
	const r = spawnSync(process.execPath, [path.join(ROOT, `${which}.mjs`), ...args], { encoding: 'utf8', env });
	return { ...r, out: `${r.stdout}${r.stderr}`, npmLog: readLog(home) };
}

function readLog(home) {
	const log = path.join(path.dirname(home), 'npm.log');
	try {
		return fs.readFileSync(log, 'utf8').trim();
	} catch {
		return '';
	}
}

test('a missing pi is installed with npm by default, and the run continues', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: true });
	const r = runEngine('install', box);
	assert.equal(r.status, 0, `install.mjs exited ${r.status}: ${r.out}`);
	assert.equal(r.npmLog, INSTALL_ARGS.join(' '), 'the npm call is the documented one, once');
	assert.ok(r.stdout.includes(`installing pi with npm (global): npm ${INSTALL_ARGS.join(' ')}`), 'the line says what it is about to run');
	// "Continues" is a file that landed after the pi decision, not a sentence.
	assert.ok(fs.existsSync(path.join(box.home, '.pi', 'agent', 'settings.json')), 'the install did not reach the config');
	assert.ok(r.stdout.includes('== done'), 'the run did not finish');
});

test('--no-install-pi: no npm call, pi stays missing, the install still runs', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: true });
	const r = runEngine('install', box, ['--no-install-pi']);
	assert.equal(r.status, 0, `install.mjs exited ${r.status}: ${r.out}`);
	assert.equal(r.npmLog, '', 'npm was called despite --no-install-pi');
	assert.ok(r.stdout.includes('--no-install-pi'), 'the skip is not announced anywhere');
	assert.ok(fs.existsSync(path.join(box.home, '.pi', 'agent', 'settings.json')), 'the opt-out stopped the install instead of the pi step');
	assert.ok(!fs.existsSync(path.join(box.home, '.local', 'bin', 'pi')), 'something installed a pi anyway');
});

test('PI_ALLOW_MISSING_PI=1: the CI skip line, and no npm call', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: true });
	const r = runEngine('install', box, [], { PI_ALLOW_MISSING_PI: '1' });
	assert.equal(r.status, 0, `install.mjs exited ${r.status}: ${r.out}`);
	assert.equal(r.npmLog, '', 'the CI path called npm');
	assert.ok(r.stdout.includes('pi binary: PI_ALLOW_MISSING_PI=1 — config only'), 'the skip line is missing');
	assert.ok(fs.existsSync(path.join(box.home, '.pi', 'agent', 'settings.json')));
});

test('no pi and no npm: non-zero exit, and the throwaway HOME is still empty', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: false });
	const r = runEngine('install', box);
	assert.notEqual(r.status, 0, 'the run should have stopped, not half-installed a tree');
	assert.match(r.out, /no pi on PATH and no npm/, 'the stop does not name the missing prerequisite');
	assert.match(r.out, /apt-get install -y nodejs npm/, 'the stop does not give the command for this OS');
	// The assertion that matters: not the exit code, the empty tree.
	assert.deepEqual(fs.readdirSync(box.home), [], 'a file was written before the prerequisite was checked');
});

test('the pi decision is in the preflight, before the first file is written', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: true });
	const r = runEngine('install', box);
	const preflight = r.stdout.indexOf('== preflight');
	const pi = r.stdout.indexOf('installing pi with npm');
	const firstWrite = r.stdout.indexOf('copied skills/extensions/settings');
	assert.equal(preflight, 0, 'the preflight is not the first thing the engine prints');
	assert.ok(pi > preflight, 'the pi decision is not in the preflight');
	// Before the copy, not after every step: that is what makes the stop cheap.
	assert.ok(pi < firstWrite, 'pi is still decided after the config was written');
	// And the preflight prints its facts in one block, in this order.
	const order = ['   source :', '   agent  :', '   system :', 'installing pi with npm'];
	let at = -1;
	for (const line of order) {
		const next = r.stdout.indexOf(line);
		assert.ok(next > at, `the preflight prints "${line}" out of order`);
		at = next;
	}
});

test('setup asks "install pi with npm?" and passes the answer to the engine', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	// -y takes the default, and the sub-line is the exact command.
	const yes = runEngine('setup', scratch({ npm: true }), ['-y', '--no-keys', '--no-apt', '--no-verify', '--dry-run']);
	assert.equal(yes.status, 0, `setup.mjs exited ${yes.status}: ${yes.out}`);
	assert.ok(yes.stdout.includes(`the command: npm ${INSTALL_ARGS.join(' ')}`), 'the question does not show the command it will run');
	assert.ok(yes.stdout.includes(`install pi with npm? -> yes (-y)`), 'the question is missing, or -y did not answer it');
	assert.ok(yes.stdout.includes(`[dry-run] npm ${INSTALL_ARGS.join(' ')}`), 'the engine was not handed the answer (dry-run prints the call)');

	// The CI escape hatch asks nothing.
	const ci = runEngine('setup', scratch({ npm: true }), ['-y', '--no-keys', '--no-apt', '--no-verify', '--dry-run'], { PI_ALLOW_MISSING_PI: '1' });
	assert.ok(!ci.stdout.includes('install pi with npm?'), 'the CI path was asked a question nobody can answer');
	assert.ok(ci.stdout.includes('pi: PI_ALLOW_MISSING_PI=1 — config only'));

	// --no-install-pi answers it in advance, and the engine is told.
	const no = runEngine('setup', scratch({ npm: true }), ['-y', '--no-keys', '--no-apt', '--no-verify', '--dry-run', '--no-install-pi']);
	assert.equal(no.status, 0, `setup.mjs exited ${no.status}: ${no.out}`);
	assert.ok(!no.stdout.includes('install pi with npm?'), '--no-install-pi still asked');
	assert.ok(!no.stdout.includes(`[dry-run] npm ${INSTALL_ARGS.join(' ')}`), 'a --no-install-pi run still planned the npm call');
});

test('setup stops on the missing prerequisite before it writes the state file', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: false });
	const r = runEngine('setup', box, ['-y', '--no-keys', '--no-apt', '--no-verify']);
	assert.notEqual(r.status, 0, 'setup.mjs wrote a config around a missing pi');
	assert.match(r.out, /no pi on PATH and no npm/);
	assert.deepEqual(fs.readdirSync(box.home), [], 'setup.mjs wrote its answers before checking the prerequisite');
});

test('a pi installed but off PATH is found, not reinstalled, and not asked about', { skip: !POSIX && 'PATH shims are POSIX-only' }, () => {
	const box = scratch({ npm: true });
	// pnpm keeps its bin directory out of PATH: this is what "installed but
	// missing" looks like, and it is not something to ask a person about.
	const disk = path.join(box.home, '.local', 'share', 'pnpm', 'bin', 'pi');
	fs.mkdirSync(path.dirname(disk), { recursive: true });
	fs.writeFileSync(disk, '#!/bin/sh\n');
	fs.chmodSync(disk, 0o755);

	const install = runEngine('install', box);
	assert.equal(install.status, 0, `install.mjs exited ${install.status}: ${install.out}`);
	assert.equal(install.npmLog, '', 'it reinstalled a pi that was already on disk');
	assert.ok(install.stdout.includes(`pi found on disk, added to PATH: ${disk}`));

	const setup = runEngine('setup', box, ['-y', '--no-keys', '--no-apt', '--no-verify', '--dry-run']);
	assert.ok(!setup.stdout.includes('install pi with npm?'), 'setup asked about a pi that is already installed');
	assert.ok(setup.stdout.includes(`pi found on disk, added to PATH: ${disk}`));
});

// The one place this change could turn the CI matrix red: `-y` takes the default
// of the pi question, and the default is now "install it" on a runner with no
// pi. The matrix rides PI_ALLOW_MISSING_PI=1 instead, which is the documented
// CI path — read off the workflow file, so turning it off is visible.
test('the install matrix goes through the CI escape hatch, not a silent flag-off', () => {
	const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'install-matrix.yml'), 'utf8');
	assert.match(yml, /PI_ALLOW_MISSING_PI: "1"/, 'the matrix lost its CI escape hatch');
	assert.match(yml, /node setup\.mjs -y/, 'the matrix no longer drives the -y path this test protects');
	assert.ok(!/--install-pi\b|--no-install-pi/.test(yml), 'the matrix re-states a pi flag the default already covers');
});
