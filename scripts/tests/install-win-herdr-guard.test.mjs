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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GUARD_TASK_NAME, gitBashCandidates, guardTaskCommand, hiddenLauncher, resolveGitBash, schtasksExe, spawnPlan, wscriptExe } from '../install-lib.mjs';

import { stubHerdrApp, withStub } from './herdr-app-stub.mjs';

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
	// directly, argv untouched. The shell is named, not read from `process.env`:
	// every real Windows sets ComSpec, so a default here made this assertion a
	// statement about the host rather than about the wrapping.
	assert.equal(spawnPlan('schtasks', task.args, { platform: 'win32', comspec: 'cmd.exe' }).file, 'cmd.exe');
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

test('a POSIX PI_GIT_BASH — what `which bash` prints — is read as the Windows path it means', () => {
	const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\mj\\AppData\\Local' };
	const execPath = 'C:\\Program Files\\Git\\ucrt64\\libexec\\git-core';
	const exists = (p) => p === 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';

	// `./install.sh` runs in Git Bash, so `which bash` prints `/usr/bin/bash` and that
	// is the value the override most often gets. It crosses into a Windows node
	// process, where no MSYS converts it: before this, a machine WITH Git for Windows
	// took the "no Git Bash found" branch and registered no task at all.
	assert.equal(
		resolveGitBash({ platform: 'win32', env: { ...env, PI_GIT_BASH: '/usr/bin/bash' }, execPath, exists }),
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
	);
	// MSYS adds the extension, so the value a person copies from `which` works as typed.
	assert.ok(
		gitBashCandidates({ platform: 'win32', env: { ...env, PI_GIT_BASH: '/usr/bin/bash' }, execPath }).includes('C:\\Program Files\\Git\\usr\\bin\\bash.exe'),
	);
	// `/c/...` is the other spelling a POSIX path arrives in, and it needs no root.
	const drive = gitBashCandidates({ platform: 'win32', env: { ...env, PI_GIT_BASH: '/c/Program Files/Git/bin/bash.exe' }, execPath });
	assert.equal(drive[0], 'C:\\Program Files\\Git\\bin\\bash.exe', drive.join('\n'));
	// A POSIX value that matches nothing is still nothing: translated, never invented.
	assert.equal(resolveGitBash({ platform: 'win32', env: { ...env, PI_GIT_BASH: '/opt/bash' }, execPath, exists: () => false }), null);
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
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES', 'PI_GIT_BASH', 'PI_UPDATE_MODS', 'HERDR_MODS']) delete env[name];
	// A stub, always: the engine's space step opens a real space in whatever `herdr-app` the
	// child can reach, and a throwaway HOME does not stop that — it only lets the record die with
	// the folder and leaves a space behind. `withStub` is the stub on PATH plus the override the
	// tools read before PATH, with every real app directory taken off PATH.
	return withStub({ ...env, ...extra }, stubHerdrApp(home));
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
	// The behaviour this line used to pin — `kept existing herdr mod: prs` for
	// every folder, untouched or not — was the bug in #203: no mod change ever
	// reached the app. An untouched mod that matches the shipped file has nothing
	// to say now, and a second run still writes neither file.
	assert.doesNotMatch(second.stdout, /herdr mod prs/m, second.stdout);
	assert.match(second.stdout, /^== herdr programs\.json exists — add the pi-bare entry/m);
	assert.equal(fs.statSync(programs).mtimeMs, before);
	assert.equal(fs.statSync(modFile).mtimeMs, modBefore);
});

// --- the mods update, decided per file ---------------------------------------
//
// `stepHerdrMods` used to skip any mod folder that existed, so it could not tell
// its own old copy from an edit and treated both as an edit: no mod change in
// this repository reached a running app (#203: the buttons still created the old
// hardcoded space). These tests install from a copy of the tree, change the shipped
// file in that copy and install again — which is what a `git pull` and a second
// `./install.sh` is: the installed copy came from the old tree, the new tree
// ships different bytes, and the person's HOME is untouched in between.

/** The parts of this checkout an install reads; a copy is the tree after a fix. */
const TREE_ENTRIES = ['install.mjs', 'scripts', 'herdr-mods', 'sandbox', 'git-hooks', 'gitignore_global', 'git-vuln-scan', 'systemd', 'bin', 'git-templates'];

function sourceCopy(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tree-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	for (const name of TREE_ENTRIES) {
		const from = path.join(ROOT, name);
		if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, name), { recursive: true });
	}
	return dir;
}

function installFrom(tree, home, args = []) {
	return spawnSync(process.execPath, [path.join(tree, 'install.mjs'), ...args], {
		env: envFor(home),
		encoding: 'utf8',
		cwd: tree,
	});
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const MAIN = path.join('prs', 'main.js');
const recordPath = (home) => path.join(home, '.config', 'herdr-app', 'mods-installed.json');
const modPath = (home, rel) => path.join(home, '.config', 'herdr-app', 'mods', rel);

test('a mod file the person did not touch is updated to the shipped one, and the record follows', (t) => {
	const home = tempHome(t);
	const tree = sourceCopy(t);
	assert.equal(installFrom(tree, home).status, 0);

	// The tree moves on: this is the fix that never used to reach the app.
	const shipped = path.join(tree, 'herdr-mods', MAIN);
	const fixed = `${fs.readFileSync(shipped, 'utf8')}\n// the fix from #203\n`;
	fs.writeFileSync(shipped, fixed);

	const second = installFrom(tree, home);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /^== herdr mod prs\/main\.js updated$/m);
	assert.equal(fs.readFileSync(modPath(home, MAIN), 'utf8'), fixed, 'the installed mod is not the shipped one');
	// The record is what the next run compares against: the hash of what was written.
	assert.equal(JSON.parse(fs.readFileSync(recordPath(home), 'utf8')).prs['main.js'], sha256(Buffer.from(fixed)));

	// And a third run has nothing left to do.
	const third = installFrom(tree, home);
	assert.equal(third.status, 0, third.stderr);
	assert.doesNotMatch(third.stdout, /herdr mod prs/m, third.stdout);
});

test('a mod file the person edited is kept byte for byte, and the line names it', (t) => {
	const home = tempHome(t);
	const tree = sourceCopy(t);
	assert.equal(installFrom(tree, home).status, 0);

	const installed = modPath(home, MAIN);
	const mine = `${fs.readFileSync(installed, 'utf8')}\n// my own edit\n`;
	fs.writeFileSync(installed, mine);
	const before = fs.statSync(installed).mtimeMs;
	// The tree ships a change too: an edit is kept even when the installer has
	// something newer to offer — that is the promise the old skip was protecting.
	fs.appendFileSync(path.join(tree, 'herdr-mods', MAIN), '\n// newer in the tree\n');

	const second = installFrom(tree, home);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /^== herdr mod prs\/main\.js kept: you edited it$/m);
	assert.equal(fs.readFileSync(installed, 'utf8'), mine);
	assert.equal(fs.statSync(installed).mtimeMs, before);
});

test('a folder with no record is kept whole, and the line names --update-mods', (t) => {
	const home = tempHome(t);
	const tree = sourceCopy(t);
	assert.equal(installFrom(tree, home).status, 0);
	// Every install that exists on a machine today is in this state.
	fs.rmSync(recordPath(home));
	const installed = modPath(home, MAIN);
	const before = fs.readFileSync(installed, 'utf8');
	fs.appendFileSync(path.join(tree, 'herdr-mods', MAIN), '\n// newer in the tree\n');

	const second = installFrom(tree, home);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /^== kept existing herdr mod: prs — installed before the record existed; run install\.sh --update-mods to refresh it$/m);
	assert.equal(fs.readFileSync(installed, 'utf8'), before);
});

test('--update-mods overwrites an edited file and re-records it', (t) => {
	const home = tempHome(t);
	const tree = sourceCopy(t);
	assert.equal(installFrom(tree, home).status, 0);

	const installed = modPath(home, MAIN);
	fs.writeFileSync(installed, '// my own edit\n');
	const shipped = fs.readFileSync(path.join(tree, 'herdr-mods', MAIN), 'utf8');

	const forced = installFrom(tree, home, ['--update-mods']);
	assert.equal(forced.status, 0, forced.stderr);
	assert.match(forced.stdout, /^== herdr mod prs\/main\.js overwritten: --update-mods$/m);
	assert.equal(fs.readFileSync(installed, 'utf8'), shipped);
	assert.equal(JSON.parse(fs.readFileSync(recordPath(home), 'utf8')).prs['main.js'], sha256(Buffer.from(shipped)));
	// Fully recorded: the plain run after it has nothing to say, and keeps the file.
	const after = installFrom(tree, home);
	assert.equal(after.status, 0, after.stderr);
	assert.doesNotMatch(after.stdout, /herdr mod prs/m, after.stdout);
});

test('--dry-run shows the update and writes nothing, not even the record', (t) => {
	const home = tempHome(t);
	const tree = sourceCopy(t);
	assert.equal(installFrom(tree, home).status, 0);
	fs.appendFileSync(path.join(tree, 'herdr-mods', MAIN), '\n// newer in the tree\n');

	const installed = modPath(home, MAIN);
	const modBefore = fs.readFileSync(installed);
	const recordBefore = fs.readFileSync(recordPath(home));

	const dry = installFrom(tree, home, ['--dry-run']);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /^== herdr mod prs\/main\.js updated$/m);
	assert.ok(fs.readFileSync(installed).equals(modBefore), 'a dry run rewrote the mod');
	assert.ok(fs.readFileSync(recordPath(home)).equals(recordBefore), 'a dry run rewrote the record');
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
	// wscript's path is the one the installer resolves, not this machine's casing of
	// `%SystemRoot%`: that is `C:\WINDOWS` on the Windows box that found this, and a
	// `/TR` compared against `C:\Windows` is an assertion about the host. It cannot
	// be pinned through the child's env either — Windows keeps the inherited
	// spelling of SystemRoot, so passing one in changes nothing.
	const launcher = path.join(home, '.pi', 'state', 'guard-hidden.vbs');
	const wscript = wscriptExe();
	assert.ok(registered[1].includes(`"\\"${wscript}\\" \\"${launcher}\\""`), registered[1]);
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
