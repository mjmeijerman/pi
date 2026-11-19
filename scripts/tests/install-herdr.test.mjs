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
// The argv decision is a pure function in scripts/install-lib.mjs, so pwsh-first
// and the manual command are pinned here. The engine is driven with --dry-run
// and a throwaway HOME for the lines; a real Windows machine is the only place
// the vendor script itself can be proven, and the report says so.

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

function tempDir(t, prefix = 'pi-herdr-') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
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

test('pwsh runs first on win32, powershell is the fallback, and the manual line always names powershell', () => {
	const pwsh = herdrInstallCommand({ platform: 'win32', hasPwsh: true });
	assert.equal(pwsh.shell, 'pwsh');
	assert.deepEqual(pwsh.args, ['-NoProfile', '-Command', `irm ${HERDR_INSTALL_PS1} | iex`]);
	assert.equal(pwsh.line, `pwsh -NoProfile -Command "irm ${HERDR_INSTALL_PS1} | iex"`);
	assert.equal(pwsh.fellBack, false);

	const winPs = herdrInstallCommand({ platform: 'win32', hasPwsh: false });
	assert.equal(winPs.shell, 'powershell');
	assert.equal(winPs.fellBack, true);
	assert.equal(winPs.preferred, 'pwsh');
	// The paste-able line does not depend on which one this machine happens to
	// have: `powershell` is on every Windows box.
	assert.equal(winPs.manual, MANUAL_PS);
	assert.equal(pwsh.manual, MANUAL_PS);

	const posix = herdrInstallCommand({ platform: 'linux', hasPwsh: true });
	assert.equal(posix.shell, 'sh');
	assert.deepEqual(posix.args, ['-c', `curl -fsSL ${HERDR_INSTALL_SH} | sh`]);
	assert.equal(posix.manual, posix.line);
});

test('an ENOENT from the spawn is its own message, not a silent nothing', () => {
	const command = herdrInstallCommand({ platform: 'win32', hasPwsh: true });
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
	assert.match(refused.lines.join('\n'), /exited 3/);
	assert.match(refused.lines.join('\n'), new RegExp(HERDR_INSTALL_PS1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.ok(refused.lines.join('\n').includes(MANUAL_PS));

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
	assert.match(out, new RegExp(`== platform : ${process.platform}`));
	assert.ok(out.includes(path.join(home, '.local', 'share', 'herdr-app', 'herdr-app')), `the resolved path is printed:\n${out}`);
	assert.match(out, /== exists   : no/);
	assert.match(out, /== command  : .*install\.sh/);
	assert.match(out, /not installed — run: curl -fsSL/);
});

test('win32: %LOCALAPPDATA%\\Programs\\herdr-app, pwsh when a pwsh exists, powershell when it does not', (t) => {
	const home = tempDir(t);
	const local = path.join(home, 'AppData', 'Local');

	const plain = dryRun(home, { PI_PLATFORM: 'win32', USERPROFILE: home });
	const plainOut = `${plain.stdout}${plain.stderr}`;
	assert.equal(plain.status, 0, `install.mjs exited ${plain.status}:\n${plainOut}`);
	assert.ok(plainOut.includes(path.join(local, 'Programs', 'herdr-app', 'herdr-app.exe')), `the Windows path is printed:\n${plainOut}`);
	assert.match(plainOut, /== command  : powershell -NoProfile -Command "irm https:\/\/releases\.herdr\.dev\/app\/install\.ps1 \| iex"/);
	assert.match(plainOut, /== fallback : pwsh is not on PATH/);
	assert.ok(plainOut.includes(`not installed — run: ${MANUAL_PS}`), `the manual command is printed:\n${plainOut}`);

	// A `pwsh` on PATH must be the one chosen, or "pwsh preferred" is a claim
	// nothing tests.
	const bin = path.join(home, 'stub-bin');
	fs.mkdirSync(bin, { recursive: true });
	const pwsh = path.join(bin, 'pwsh');
	fs.writeFileSync(pwsh, '#!/bin/sh\nexit 0\n');
	fs.chmodSync(pwsh, 0o755);
	const withPwsh = dryRun(home, { PI_PLATFORM: 'win32', USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
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
	assert.match(out, new RegExp(`== herdr-app -> ${path.join(home, '.local', 'bin', 'herdr-app').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`));

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
