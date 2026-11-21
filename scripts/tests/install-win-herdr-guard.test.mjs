// Two Windows holes the first real Windows install found, pinned here.
//
//   1. `mods/` and `programs.json` were installed only when `~/.config/herdr-app`
//      already existed — and that directory is made by herdr-app's first launch,
//      which is section 5 of the engine, after both steps. So on a fresh machine
//      they took the skip branch silently, twice. The fix creates the directory
//      at section 1c; these tests run the engine for real in a throwaway HOME
//      (dry and not) and read the disk, because "it prints the line" is not the
//      claim — "the mod is on disk before the app has ever run" is.
//
//   2. the Task Scheduler entry registered `bin/guard` itself, and that file
//      starts `#!/usr/bin/env bash`. Task Scheduler has no shebang: the task
//      started nothing, so the `harness` space never appeared on Windows.
//      `guardTaskCommand` is pure (argv in, argv out), so the exact `/TR` value
//      — both paths quoted, the interpreter named — is pinned without Windows,
//      and `gitBashCandidates` pins where that interpreter is looked for.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GUARD_TASK_NAME, gitBashCandidates, guardTaskCommand, hiddenLauncher, schtasksExe, spawnPlan } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// --- the guard command -------------------------------------------------------

test('guardTaskCommand runs the hidden launcher through wscript.exe, and quotes both paths', () => {
	const launcherPath = 'C:\\Users\\mj\\.pi\\state\\guard-hidden.vbs';
	const wscriptPath = 'C:\\Windows\\System32\\wscript.exe';
	const task = guardTaskCommand({ launcherPath, wscriptPath });

	// One argv element, both paths quoted inside it: an unquoted program path with
	// a space in it is a scheduled task that starts nothing.
	assert.deepEqual(task.args, [
		'/Create',
		'/F',
		'/SC',
		'ONLOGON',
		'/TN',
		GUARD_TASK_NAME,
		'/TR',
		`"${wscriptPath}" "${launcherPath}"`,
	]);
	assert.equal(task.program, 'schtasks');
	// The pasteable form: the whole /TR value quoted once more for cmd.exe, with
	// the inner quotes escaped the way MSVCRT expects — not doubled.
	assert.equal(
		task.registered,
		`schtasks /Create /F /SC ONLOGON /TN ${GUARD_TASK_NAME} /TR "\\"C:\\Windows\\System32\\wscript.exe\\" \\"C:\\Users\\mj\\.pi\\state\\guard-hidden.vbs\\""`,
	);
	assert.equal(task.remove, `schtasks /Delete /TN ${GUARD_TASK_NAME} /F`);
	// Never bash.exe directly: bash is a console program, so a task naming it opened
	// a console window at logon and again on the installer's `/Run`, and the guard
	// loops — the window never closed. This is the whole change.
	assert.doesNotMatch(task.tr, /bash\.exe/i);
	assert.match(task.tr, /wscript\.exe/i);
});

test('the task is registered through schtasks.exe, so cmd.exe never re-quotes /TR', () => {
	const task = guardTaskCommand({ launcherPath: 'C:\\Program Files\\Users\\.pi\\state\\guard-hidden.vbs' });
	const exe = schtasksExe({ systemRoot: 'C:\\Windows' });
	assert.equal(exe, 'C:\\Windows\\System32\\schtasks.exe');
	// The trap: a bare name is wrapped in cmd.exe by spawnPlan (it cannot know the
	// name is not a .cmd shim), and cmd.exe doubles every `"` inside /TR — the
	// registered command line would not be the one printed. A .exe path is spawned
	// directly, argv untouched.
	assert.equal(spawnPlan('schtasks', task.args, { platform: 'win32' }).file, 'cmd.exe');
	assert.deepEqual(spawnPlan(exe, task.args, { platform: 'win32' }), { file: exe, args: task.args, windowsVerbatimArguments: false });
});

test('nothing is registered or written that would start nothing', () => {
	// No launcher is "register a task that does nothing at logon"; no interpreter or
	// no guard path is a launcher that starts nothing. Say so instead.
	assert.throws(() => guardTaskCommand({}), /hidden launcher/);
	assert.throws(() => hiddenLauncher({ guardPath: 'C:\\x\\bin\\guard', pidPath: 'C:\\x\\pid' }), /bash\.exe/);
	assert.throws(() => hiddenLauncher({ bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', pidPath: 'C:\\x\\pid' }), /bin\/guard/);
	assert.throws(() => hiddenLauncher({ bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', guardPath: 'C:\\x\\bin\\guard' }), /pid/);
});

test('gitBashCandidates finds bash from git --exec-path, and only on win32', () => {
	const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\mj\\AppData\\Local' };
	const win = gitBashCandidates({ platform: 'win32', env, execPath: 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core' });
	// The root is an ancestor of git --exec-path however the install lays it out
	// (mingw64/libexec/git-core, or libexec/git-core on a 64-bit-only build), so
	// walking up is the lookup that does not encode a layout.
	assert.ok(win.includes('C:\\Program Files\\Git\\bin\\bash.exe'), win.join('\n'));
	assert.ok(win.includes('C:\\Program Files\\Git\\mingw64\\bin\\bash.exe'), win.join('\n'));
	assert.ok(win.includes('C:\\Users\\mj\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'), win.join('\n'));
	// PI_GIT_BASH replaces the search instead of joining it, and is not rewritten:
	// a wrong override has to fail loudly, not quietly pick another bash.
	assert.deepEqual(gitBashCandidates({ platform: 'win32', env: { ...env, PI_GIT_BASH: 'D:\\Git\\usr\\bin\\bash.exe' }, execPath: '' }), [
		'D:\\Git\\usr\\bin\\bash.exe',
	]);
	// The guard task is a Windows-only step; bash has a shebang on the others.
	assert.deepEqual(gitBashCandidates({ platform: 'linux', env }), []);
	assert.deepEqual(gitBashCandidates({ platform: 'darwin', env }), []);
});

// --- the engine, in a throwaway HOME ----------------------------------------

function tempHome(t, prefix = 'pi-win-herdr-') {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

		...extra,
	};
	// Either of these would decide the answer before the test does: the host's
	// platform, and a HOME that is not the throwaway one.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES', 'PI_GIT_BASH']) delete env[name];
	return { ...env, ...extra };
}

function install(home, args = [], extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), ...args], {
		env: envFor(home, extra),
		encoding: 'utf8',
		cwd: ROOT,
	});
}

const MOD = path.join('prs', 'mod.json');

test('a fresh HOME gets herdr mods and the menu row before herdr-app has ever run', (t) => {
	const home = tempHome(t);
	const configDir = path.join(home, '.config', 'herdr-app');

	// Nothing of the app exists yet: this is the state a first install is in.
	assert.equal(fs.existsSync(configDir), false);

	const first = install(home);
	assert.equal(first.status, 0, first.stderr);

	// The directory that used to arrive only with herdr-app's first launch.
	assert.ok(fs.existsSync(configDir), 'herdr config dir was not created');
	assert.ok(fs.existsSync(path.join(configDir, 'mods', MOD)), 'herdr mod not installed');
	assert.match(first.stdout, /^== herdr config dir created: /m);
	assert.match(first.stdout, /^== installed herdr mod: prs -> /m);

	const programs = JSON.parse(fs.readFileSync(path.join(configDir, 'programs.json'), 'utf8'));
	const entry = programs.programs['pi-bare'];
	assert.equal(entry.name, 'Pi (bare)');
	// On Windows the menu row points at the .cmd entry, not the extensionless one.
	assert.deepEqual(entry.run, [path.join(home, '.local', 'bin', 'pi-bare.cmd')]);
	assert.match(first.stdout, /^== herdr menu: "Pi \(bare\)" entry installed -> /m);
});

test('a second run keeps the mods and never overwrites programs.json', (t) => {
	const home = tempHome(t);
	const configDir = path.join(home, '.config', 'herdr-app');
	assert.equal(install(home).status, 0);

	// A file the person edited: the promise is that it is left alone, and the
	// line says what to add by hand.
	const programs = path.join(configDir, 'programs.json');
	fs.writeFileSync(programs, JSON.stringify({ programs: { mine: { name: 'Mine', run: ['x'] } } }, null, 2));
	const before = fs.statSync(programs).mtimeMs;
	const modFile = path.join(configDir, 'mods', MOD);
	const modBefore = fs.statSync(modFile).mtimeMs;

	const second = install(home);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /^== herdr config dir found: /m);
	assert.match(second.stdout, /^== kept existing herdr mod: prs$/m);
	assert.match(second.stdout, /^== herdr programs\.json exists — add the pi-bare entry/m);
	assert.equal(fs.statSync(programs).mtimeMs, before);
	assert.equal(fs.statSync(modFile).mtimeMs, modBefore);
});

test('--dry-run prints what it would write and writes nothing', (t) => {
	const home = tempHome(t);
	const out = install(home, ['--dry-run']);
	assert.equal(out.status, 0, out.stderr);
	const configDir = path.join(home, '.config', 'herdr-app');
	assert.equal(fs.existsSync(configDir), false, 'a dry run created the config dir');
	assert.match(out.stdout, /^== herdr config dir would create: /m);
	assert.match(out.stdout, /^== installed herdr mod: prs -> /m);
	assert.match(out.stdout, /^== herdr menu: "Pi \(bare\)" entry installed -> /m);
});

test('the guard task is registered with Git Bash, and the default is the entry itself', (t) => {
	const home = tempHome(t);
	// PI_GIT_BASH is the resolution's override, which is also the only way this
	// runs on a host without Git for Windows.
	// PI_SKIP_SYSTEMD is the opt-out on this branch; cleared, so the gate under
	// test is the default and nothing else.
	const on = { PI_ENABLE_SERVICES: '1', PI_GIT_BASH: '/usr/bin/bash', PI_SKIP_SYSTEMD: '' };
	const out = install(home, ['--dry-run'], on);
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /^== guard: registering a Task Scheduler entry at logon \(this is what repairs a space and its Boss tab\)$/m);
	const registered = out.stdout.match(/^   command: (schtasks .*)$/m);
	assert.ok(registered, 'no registered command line');
	// The `/TR` names wscript.exe and the hidden launcher, never bash.exe directly.
	const launcher = path.join(home, '.pi', 'state', 'guard-hidden.vbs');
	assert.ok(registered[1].includes(`"\\"C:\\Windows\\System32\\wscript.exe\\" \\"${launcher}\\""`), registered[1]);
	assert.doesNotMatch(registered[1], /bash/i, registered[1]);

	// No interpreter: registering the file itself would start nothing, so say so
	// instead of writing a task that silently does nothing at logon.
	const none = install(home, ['--dry-run'], { ...on, PI_GIT_BASH: path.join(home, 'no-such-bash.exe') });
	assert.match(none.stderr, /no Git Bash found/);
	assert.doesNotMatch(none.stdout, /guard: registering a Task Scheduler entry/);
	assert.match(none.stdout, /   fix: install Git for Windows, or set PI_GIT_BASH/);

	// A default run registers it: PI_ENABLE_SERVICES getting in the way was the bug,
	// because the guard is what repairs a space after a reboot. No flag here at all.
	const byDefault = install(home, ['--dry-run'], { PI_SKIP_SYSTEMD: '', PI_GIT_BASH: '/usr/bin/bash' });
	assert.equal(byDefault.status, 0, byDefault.stderr);
	assert.match(byDefault.stdout, /^== guard: registering a Task Scheduler entry at logon/m);
	assert.ok(byDefault.stdout.includes(`Disable: schtasks /Delete /TN ${GUARD_TASK_NAME} /F`), byDefault.stdout);
	// Deleting the task is not stopping the guard: the process the launcher started
	// is still running, with no window to close, so the disable block names the pid
	// the launcher wrote.
	assert.match(
		byDefault.stdout,
		/^Disable: for \/f "usebackq" %p in \(""?.*guard\.pid"\) do taskkill \/F \/PID %p$/m,
		byDefault.stdout,
	);

	// The one way out names the variable that did it, and the line that starts the
	// guard once by hand.
	const gated = install(home, ['--dry-run'], { PI_SKIP_SYSTEMD: '1', PI_GIT_BASH: '/usr/bin/bash' });
	assert.match(gated.stdout, /guard service \(launchd \/ Task Scheduler\): PI_SKIP_SYSTEMD=1 — no login entry registered/);
	assert.doesNotMatch(gated.stdout, /guard: registering a Task Scheduler entry/);
});
