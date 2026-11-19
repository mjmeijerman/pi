// herdr-app: where the vendor installer puts it, and what the step says.
//
// Why this exists: on a real Windows machine the vendor installer did not run
// and the transcript held no `herdr-app` line of any kind, so nothing pointed at
// the step. Two separate faults sat behind that one screen:
//
//   1. detection looked in `%LOCALAPPDATA%\herdr-app`, the vendor script writes
//      `%LOCALAPPDATA%\Programs\herdr-app` — so a working install read as
//      missing, and a missing one could be skipped for good;
//   2. `spawnSync('powershell', …)` returns ENOENT when that name is not on
//      PATH, and the old step turned ENOENT and a non-zero exit into the same
//      silent nothing.
//
// The argv decision is a pure function in scripts/install-lib.mjs and takes the
// facts as arguments, so every combination is pinned with no environment at
// all. The integration case builds its own PATH: a runner ships PowerShell 7 as
// `pwsh` next to `git` in /usr/bin, this laptop does not, and a test whose
// verdict depends on which one runs it has no verdict. So it manufactures the
// shells it talks about — stub `powershell`/`pwsh` scripts in a directory it
// owns — and mounts that PATH by itself, with symlinks to git, node and the two
// shells the engine needs, never the host's PATH. That case runs the engine for
// real: a --dry-run spawns nothing, so a stub could not record the argv that "the
// plumbing reaches herdrInstallCommand" depends on. A real Windows machine is
// still the only place the vendor script itself can be proven, and the report
// says so.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HERDR_INSTALL_PS1, HERDR_INSTALL_SH, herdrAttempt, herdrInstallCommand, planFor } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MANUAL_PS = `powershell -c "irm ${HERDR_INSTALL_PS1} | iex"`;
const PS_ARGS = ['-NoProfile', '-Command', `irm ${HERDR_INSTALL_PS1} | iex`];

function tempDir(t, prefix = 'pi-herdr-') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// which — the absolute, symlink-resolved path of a tool, or null. `command -v`
// is the probe because node ships no `which`.
function which(name) {
	const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
	if (r.status !== 0) return null;
	const found = (r.stdout ?? '').trim().split('\n')[0];
	return found ? fs.realpathSync(found) : null;
}

// enginePath — a bin directory this test owns, holding symlinks to exactly the
// tools the engine needs to reach its herdr-app step, plus the shells the case
// asks for and nothing else.
//
// The host PATH is never used, and that includes "the directory git happens to
// live in": on ubuntu-latest `pwsh` sits in /usr/bin next to git, so a PATH
// built from git's directory carries a PowerShell the case did not create —
// which is this test's bug one level down, not a fix for it.
//
// Returns null when git or node cannot be resolved; the caller skips by name.
function enginePath(dir, shells = []) {
	const tools = {};
	for (const name of ['git', 'node', 'sh', 'bash']) tools[name] = which(name);
	if (!tools.git || !tools.node) return null;
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, resolved] of Object.entries(tools)) if (resolved) fs.symlinkSync(resolved, path.join(dir, name));
	for (const { name, log } of shells) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 0\n`);
		fs.chmodSync(file, 0o755);
	}
	return dir;
}

// Every other case runs --dry-run: what is under test is the plan and the
// lines, not the writes. PI_SKIP_NETWORK is deliberately NOT set — with it, the step says
// "not run" and the printed command (one of the things being pinned) is never
// produced. A dry run executes nothing, so network access is not needed either.
function envFor(home, extra = {}) {
	const env = { ...process.env, HOME: home, PI_SKIP_SYSTEMD: '1', PI_ALLOW_MISSING_PI: '1', ...extra };
	// Inherited from the host that runs the suite: any of them would decide the
	// platform or the paths before the test does.
	for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'PI_DRY_RUN', 'PI_PLATFORM', 'PI_SKIP_NETWORK', 'PI_BOSS_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) delete env[name];
	return { ...env, ...extra };
}

function dryRun(home, extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), '--dry-run'], {
		env: envFor(home, extra),
		encoding: 'utf8',
		cwd: ROOT,
	});
}

// realRun — the same engine, writing into the throwaway HOME. The herdr-app
// case needs it: only a real run hands the chosen shell to spawnSync, and a
// shell that is never spawned cannot record the argv it was given.
function realRun(home, extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], {
		env: envFor(home, { PI_SKIP_PREREQS: '1', ...extra }),
		encoding: 'utf8',
		cwd: ROOT,
	});
}

test('win32 detection looks in %LOCALAPPDATA%\\Programs\\herdr-app, where the vendor script writes', () => {
	const local = 'C:\\Users\\me\\AppData\\Local';
	const plan = planFor('win32', { LOCALAPPDATA: local });
	assert.equal(plan.herdrInstalled, path.join(local, 'Programs', 'herdr-app', 'herdr-app.exe'));
	// The old answer, kept as the assertion it must never be again.
	assert.notEqual(plan.herdrInstalled, path.join(local, 'herdr-app', 'herdr-app.exe'));
	// No LOCALAPPDATA: the Windows default under the user profile.
	assert.equal(
		planFor('win32', { USERPROFILE: 'C:\\Users\\me' }).herdrInstalled,
		path.join('C:\\Users\\me', 'AppData', 'Local', 'Programs', 'herdr-app', 'herdr-app.exe'),
	);
});

test('POSIX detection is absolute, and honours XDG_DATA_HOME like install.sh does', () => {
	const home = path.join(path.sep, 'home', 'me');
	for (const platform of ['linux', 'darwin']) {
		assert.equal(planFor(platform, { HOME: home }).herdrInstalled, path.join(home, '.local', 'share', 'herdr-app', 'herdr-app'), `${platform} path`);
	}
	const xdg = path.join(path.sep, 'data');
	assert.equal(planFor('linux', { HOME: home, XDG_DATA_HOME: xdg }).herdrInstalled, path.join(xdg, 'herdr-app', 'herdr-app'));
});

test('the shell is a function of the facts passed in, not of the machine running the test', () => {
	// win32 with both: pwsh wins, and nothing is reported as a fallback.
	const both = herdrInstallCommand({ platform: 'win32', hasPwsh: true, hasPowershell: true });
	assert.equal(both.shell, 'pwsh');
	assert.deepEqual(both.args, PS_ARGS);
	assert.equal(both.line, `pwsh -NoProfile -Command "irm ${HERDR_INSTALL_PS1} | iex"`);
	assert.equal(both.fellBack, false);
	assert.equal(both.available, true);

	// win32 with only the PowerShell that ships with the OS.
	const onlyPowershell = herdrInstallCommand({ platform: 'win32', hasPwsh: false, hasPowershell: true });
	assert.equal(onlyPowershell.shell, 'powershell');
	assert.deepEqual(onlyPowershell.args, PS_ARGS);
	assert.equal(onlyPowershell.fellBack, true);
	assert.equal(onlyPowershell.preferred, 'pwsh');

	// win32 with neither: nothing to run, so the manual line is the answer. No
	// command string that would let the step print a shell it cannot spawn.
	const neither = herdrInstallCommand({ platform: 'win32', hasPwsh: false, hasPowershell: false });
	assert.equal(neither.available, false);
	assert.equal(neither.shell, null);
	assert.deepEqual(neither.args, []);
	assert.equal(neither.line, null);

	// The paste-able line does not depend on which one this machine happens to
	// have: `powershell` is on every Windows box.
	for (const command of [both, onlyPowershell, neither]) assert.equal(command.manual, MANUAL_PS);

	// POSIX: curl and sh, and the PowerShell facts change nothing.
	for (const platform of ['linux', 'darwin']) {
		const posix = herdrInstallCommand({ platform, hasPwsh: true, hasPowershell: true });
		assert.equal(posix.shell, 'sh');
		assert.deepEqual(posix.args, ['-c', `curl -fsSL ${HERDR_INSTALL_SH} | sh`]);
		assert.equal(posix.manual, posix.line);
		assert.equal(posix.preferred, null);
		assert.equal(herdrInstallCommand({ platform }).shell, 'sh', 'default facts still give a command on POSIX');
	}
});

test('an ENOENT from the spawn is its own message, not a silent nothing', () => {
	const command = herdrInstallCommand({ platform: 'win32', hasPwsh: true, hasPowershell: true });
	const enoent = Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT' });
	const attempt = herdrAttempt({ command, spawn: () => ({ error: enoent, status: null }) });
	assert.equal(attempt.ok, false);
	assert.equal(attempt.ran, true);
	assert.equal(attempt.childCode, 'ENOENT');
	const text = attempt.lines.join('\n');
	assert.match(text, /could not run pwsh \(ENOENT\)/, 'ENOENT must say which shell was missing');
	assert.match(text, /the vendor installer did not run/);
	assert.ok(text.includes(MANUAL_PS), `the manual command must be named verbatim:\n${text}`);

	// A non-zero exit is a different failure: the installer started and refused.
	const refused = herdrAttempt({ command, spawn: () => ({ status: 3 }) });
	assert.equal(refused.ok, false);
	const refusedText = refused.lines.join('\n');
	assert.match(refusedText, /exited 3/);
	assert.ok(refusedText.includes(HERDR_INSTALL_PS1), `the vendor URL is named:\n${refusedText}`);
	assert.ok(refusedText.includes(MANUAL_PS));

	assert.equal(herdrAttempt({ command, spawn: () => ({ status: 0 }) }).ok, true);
	// A dry run must not spawn at all: the throw proves it never reaches one.
	const dry = herdrAttempt({ command, spawn: () => { throw new Error('spawned in a dry run'); }, dry: true });
	assert.deepEqual(dry.lines, []);
	assert.equal(dry.ok, false);
});

test('the step prints the resolved path and the command on this host', (t) => {
	const home = tempDir(t);
	const run = dryRun(home);
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);
	assert.match(out, /== herdr-app/);
	assert.ok(out.includes(`== platform : ${process.platform}`), `the platform is printed:\n${out}`);
	assert.ok(out.includes(path.join(home, '.local', 'share', 'herdr-app', 'herdr-app')), `the resolved path is printed:\n${out}`);
	assert.match(out, /== exists   : no/);
	assert.match(out, /== command  : .*install\.sh/);
	assert.match(out, /not installed — run: curl -fsSL/);
});

test('win32: %LOCALAPPDATA%\\Programs\\herdr-app, and the shell follows the PATH the test builds', (t) => {
	const home = tempDir(t);
	const local = path.join(home, 'AppData', 'Local');
	const binPath = path.join(local, 'Programs', 'herdr-app', 'herdr-app.exe');
	// An existing boss workspace: the step that clones it is then a `note`, so a
	// real run below reaches herdr-app without touching the network.
	const boss = path.join(home, 'big-boss-pi');
	fs.mkdirSync(boss, { recursive: true });

	const winEnv = (stub) => ({
		PI_PLATFORM: 'win32',
		LOCALAPPDATA: local,
		USERPROFILE: home,
		PI_BOSS_DIR: boss,
		PATH: stub,
	});

	// Three states, three PATHs this test owns. `realRun` instead of `dryRun`
	// because the argv has to be seen by the shell itself: a dry run spawns
	// nothing, so a stub that records nothing could prove nothing.
	const states = [
		{ name: 'neither', shells: [] },
		{ name: 'powershell', shells: ['powershell'] },
		{ name: 'pwsh', shells: ['powershell', 'pwsh'] },
	];

	for (const state of states) {
		const stubDir = path.join(home, `stub-${state.name}`);
		const log = path.join(home, `argv-${state.name}.log`);
		if (!enginePath(stubDir, state.shells.map((name) => ({ name, log })))) {
			t.skip('git or node could not be resolved on PATH — the win32 integration case cannot build its own PATH');
			return;
		}

		const run = realRun(home, winEnv(stubDir));
		const out = `${run.stdout}${run.stderr}`;
		assert.equal(run.status, 0, `install.mjs exited ${run.status} (${state.name}):\n${out}`);
		// One assertion for all three states: the path the step resolves is the one
		// the vendor script writes, not a directory next to it.
		assert.ok(out.includes(`== bin      : ${binPath}`), `the Windows path is printed (${state.name}):\n${out}`);

		if (state.shells.length === 0) {
			// Nothing to run: the manual line is the whole answer, and no process
			// was created to find that out.
			assert.match(out, /== command  : not run — neither pwsh nor powershell is on PATH/);
			assert.ok(out.includes(`!! not installed — run: ${MANUAL_PS}`), `the manual command is printed:\n${out}`);
			assert.equal(fs.existsSync(log), false, 'a shell was spawned although PATH had neither pwsh nor powershell');
			continue;
		}

		// The shell that was chosen, exactly — this is the line the failing runner
		// printed as "neither", so it is the line that must be pinned here.
		const chosen = state.name === 'pwsh' ? 'pwsh' : 'powershell';
		assert.ok(
			out.includes(`== command  : ${chosen} -NoProfile -Command "irm ${HERDR_INSTALL_PS1} | iex"`),
			`the command line names ${chosen} (${state.name}):\n${out}`,
		);
		if (chosen === 'powershell') assert.match(out, /== fallback : pwsh is not on PATH/);
		else assert.doesNotMatch(out, /== fallback :/);

		// And the argv reached the shell: the stub wrote down what it was called
		// with, so "the plumbing reaches herdrInstallCommand" is observed, not
		// inferred from a printed string.
		assert.equal(fs.existsSync(log), true, `the ${chosen} stub was never invoked:\n${out}`);
		assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), PS_ARGS, 'the argv the shell received');
		assert.ok(out.includes(`!! not installed — run: ${MANUAL_PS}`), `the manual command is printed:\n${out}`);
	}
});

test('an already-installed binary still prints the path, and the link target is herdr-app.exe on win32', (t) => {
	const home = tempDir(t);
	const installed = path.join(home, '.local', 'share', 'herdr-app', 'herdr-app');
	fs.mkdirSync(path.dirname(installed), { recursive: true });
	fs.writeFileSync(installed, '#!/bin/sh\n');
	fs.chmodSync(installed, 0o755);

	const run = dryRun(home);
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);
	assert.ok(out.includes(installed), `the resolved path is printed even when it is there:\n${out}`);
	assert.match(out, /== exists   : yes/);
	assert.match(out, /== command  : not run — already installed/);
	assert.match(out, /== installed -> /);
	assert.ok(
		out.includes(`== herdr-app -> ${path.join(home, '.local', 'bin', 'herdr-app')} (`),
		`the bin entry line names the link it made:\n${out}`,
	);

	// win32: the same step, and the bin entry it names is herdr-app.exe.
	const winHome = tempDir(t);
	const winInstalled = path.join(winHome, 'AppData', 'Local', 'Programs', 'herdr-app', 'herdr-app.exe');
	fs.mkdirSync(path.dirname(winInstalled), { recursive: true });
	fs.writeFileSync(winInstalled, '');
	const winRun = dryRun(winHome, { PI_PLATFORM: 'win32', USERPROFILE: winHome });
	const winOut = `${winRun.stdout}${winRun.stderr}`;
	assert.equal(winRun.status, 0, `install.mjs exited ${winRun.status}:\n${winOut}`);
	assert.ok(winOut.includes(winInstalled));
	assert.match(winOut, /== exists   : yes/);
	assert.ok(winOut.includes(path.join(winHome, '.local', 'bin', 'herdr-app.exe')), `the win32 link target is herdr-app.exe:\n${winOut}`);
});
