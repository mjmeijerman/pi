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
// `pwsh`, this laptop does not, and a test whose verdict depends on which one
// runs it has no verdict. The engine is driven with --dry-run and a throwaway
// HOME; a real Windows machine is the only place the vendor script itself can be
// proven, and the report says so.

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

// A PATH this test builds itself: the host's, minus every directory that
// carries a `pwsh` or a `powershell`. Whatever the machine has, the case below
// sees exactly the shells it creates.
function pathWithoutPowerShell() {
	const kept = (process.env.PATH ?? '')
		.split(path.delimiter)
		.filter(Boolean)
		.filter((dir) => !['pwsh', 'powershell'].some((name) => fs.existsSync(path.join(dir, name))));
	assert.ok(kept.length > 0, 'every PATH entry carried a PowerShell — the case could not run');
	return kept;
}

// stubShell — an executable named `name` that does nothing, so `command -v`
// finds it and the step's choice is the only thing under test.
function stubShell(dir, name) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
	fs.chmodSync(file, 0o755);
	return file;
}

// Every case runs --dry-run: what is under test is the plan and the lines, not
// the writes. PI_SKIP_NETWORK is deliberately NOT set — with it, the step says
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
	const base = pathWithoutPowerShell().join(path.delimiter);

	// (a) Neither shell on PATH: the manual line, and nothing spawned.
	const neither = dryRun(home, { PI_PLATFORM: 'win32', USERPROFILE: home, PATH: base });
	const neitherOut = `${neither.stdout}${neither.stderr}`;
	assert.equal(neither.status, 0, `install.mjs exited ${neither.status}:\n${neitherOut}`);
	assert.ok(neitherOut.includes(path.join(local, 'Programs', 'herdr-app', 'herdr-app.exe')), `the Windows path is printed:\n${neitherOut}`);
	assert.match(neitherOut, /== command  : not run — neither pwsh nor powershell is on PATH/);
	assert.ok(neitherOut.includes(`!! not installed — run: ${MANUAL_PS}`), `the manual command is printed:\n${neitherOut}`);

	// (b) The PowerShell that ships with Windows, and only that one.
	const legacy = stubShell(path.join(home, 'legacy-bin'), 'powershell');
	const withLegacy = dryRun(home, {
		PI_PLATFORM: 'win32',
		USERPROFILE: home,
		PATH: `${path.dirname(legacy)}${path.delimiter}${base}`,
	});
	const legacyOut = `${withLegacy.stdout}${withLegacy.stderr}`;
	assert.equal(withLegacy.status, 0, `install.mjs exited ${withLegacy.status}:\n${legacyOut}`);
	assert.match(legacyOut, /== command  : powershell -NoProfile -Command "irm https:\/\/releases\.herdr\.dev\/app\/install\.ps1 \| iex"/);
	assert.match(legacyOut, /== fallback : pwsh is not on PATH/);

	// (c) A `pwsh` on PATH must be the one chosen, or "pwsh preferred" is a claim
	// nothing tests — and this is the shape of the runner that failed.
	const modern = stubShell(path.join(home, 'modern-bin'), 'pwsh');
	const withPwsh = dryRun(home, {
		PI_PLATFORM: 'win32',
		USERPROFILE: home,
		PATH: `${path.dirname(modern)}${path.delimiter}${base}`,
	});
	const pwshOut = `${withPwsh.stdout}${withPwsh.stderr}`;
	assert.equal(withPwsh.status, 0, `install.mjs exited ${withPwsh.status}:\n${pwshOut}`);
	assert.match(pwshOut, /== command  : pwsh -NoProfile -Command "irm https:\/\/releases\.herdr\.dev\/app\/install\.ps1 \| iex"/);
	assert.doesNotMatch(pwshOut, /== fallback :/);
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
