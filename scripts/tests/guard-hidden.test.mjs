// The Windows install ends and a console window stays open — and comes back at
// logon.
//
// Why: the task registered `bash.exe`, a console program, to run a loop that
// never returns, so the window it owned never closed. The fix is not to make the
// guard quieter or to detach it — it is to stop registering a console program.
// The task now names `wscript.exe` (a GUI program, no console) and a generated
// `.vbs` that runs the same Git Bash command line with window style 0, and the
// installer's own `/Run` uses that same task, so neither start opens a window.
//
// What this host cannot settle: this is Linux, `wscript.exe` never runs here. The
// launcher's behaviour is argv-level proof plus real files — the exact command
// line, its quoting, and the pid file the disable line reads — not a window that
// was seen to be absent. Only a real Windows box proves the last step.
//
// Also pinned here, because the change is Windows-only: the macOS plist against a
// golden string and the systemd units byte-for-byte, so "Linux and macOS are
// untouched" is a test and not a sentence.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	GUARD_LAUNCHER_NAME,
	GUARD_PID_NAME,
	guardLauncherPath,
	guardPidPath,
	guardStopCommand,
	guardTaskCommand,
	hiddenLauncher,
	launcherTargets,
	resolveGitBash,
	wscriptExe,
} from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// --- the launcher, generated from the resolved paths -------------------------
test('the launcher is generated from the resolved bash on a fake Program Files layout', () => {
	// A machine whose only Git for Windows is the default install; `exists` answers
	// for it, so this runs here and not only on Windows.
	const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\mj\\AppData\\Local' };
	const bashPath = resolveGitBash({ platform: 'win32', env, exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe' });
	assert.equal(bashPath, 'C:\\Program Files\\Git\\bin\\bash.exe');

	const guardPath = 'C:\\Users\\mj\\big-boss-pi\\bin\\guard';
	const pidPath = 'C:\\Users\\mj\\big-boss-pi\\state\\guard.pid';
	const text = hiddenLauncher({ bashPath, guardPath, pidPath });

	// One VBScript line, both paths quoted, a quote inside a string spelled by
	// doubling it — the space in `Program Files` is the reason for all of it.
	assert.ok(text.includes('command = """C:\\Program Files\\Git\\bin\\bash.exe"" ""C:\\Users\\mj\\big-boss-pi\\bin\\guard"""'), text);
	// 0 = hidden, False = do not wait: the guard is a loop and outlives this file.
	assert.match(text, /^    shell\.Run command, 0, False$/m);
	// A guard that is already running is not started a second time: the launcher
	// looks first and records that pid, which is what makes a second install (or a
	// logon over a live guard) one guard and not two.
	assert.ok(text.includes('pid = GuardPid("C:\\Users\\mj\\big-boss-pi\\bin\\guard")'), text);
	assert.ok(
		text.indexOf('pid = GuardPid(') < text.indexOf('shell.Run command, 0, False'),
		'the launcher starts a guard before looking whether one is running',
	);
	assert.match(text, /^If pid = 0 Then$/m);
	// The pid the disable line needs, in the file it names.
	assert.ok(text.includes('pidPath = "C:\\Users\\mj\\big-boss-pi\\state\\guard.pid"'), text);
	assert.match(text, /^Set out = fso\.CreateTextFile\(pidPath, True\)$/m);
	// A .vbs written for Windows, with Windows line endings, and nothing that
	// depends on the locale of the machine that generated it.
	assert.ok(text.includes('\r\n'));
	assert.match(text, /^Option Explicit$/m);
});

test('a path with a space survives the round trip, through the task and the pid', () => {
	const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
	const guardPath = 'C:\\Users\\John Smith\\big-boss-pi\\bin\\guard';
	const pidPath = 'C:\\Users\\John Smith\\big-boss-pi\\state\\guard.pid';

	assert.deepEqual(launcherTargets(hiddenLauncher({ bashPath, guardPath, pidPath })), { bashPath, guardPath, pidPath });

	// The `/TR` carries two quoted strings, and they are the wscript and the
	// launcher — not bash, and not a path with its quoting stripped.
	const piHome = 'C:\\Users\\John Smith\\.pi';
	const launcherPath = guardLauncherPath({ piHome });
	const task = guardTaskCommand({ launcherPath });
	const [program, argument] = [...task.tr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	assert.equal(program, wscriptExe());
	assert.equal(argument, launcherPath);
	assert.equal(task.args[task.args.length - 1], task.tr, 'the argv carries the same /TR value');
	assert.equal(launcherPath.endsWith(GUARD_LAUNCHER_NAME), true, 'next to the installer state, no new top-level dir');
	assert.equal(path.basename(guardPidPath({ piHome: 'C:\\Users\\John Smith\\.pi' })), GUARD_PID_NAME);
});

test('the disable line can stop the process the task delete does not reach', () => {
	const pidPath = 'C:\\Users\\John Smith\\big-boss-pi\\state\\guard.pid';
	const stop = guardStopCommand({ pidPath });
	// `usebackq` is what makes the quoted path a file name: the pid lives under a
	// profile directory, and `John Smith` is why it is quoted.
	assert.equal(stop, 'for /f "usebackq" %p in ("C:\\Users\\John Smith\\big-boss-pi\\state\\guard.pid") do taskkill /F /PID %p');
	const task = guardTaskCommand({ launcherPath: 'C:\\x\\.pi\\state\\guard-hidden.vbs', pidPath });
	assert.equal(task.remove, 'schtasks /Delete /TN big-boss-pi-guard /F');
	assert.equal(task.stop, stop);
	assert.equal(guardTaskCommand({ launcherPath: 'C:\\x\\.pi\\state\\guard-hidden.vbs' }).stop, '', 'no pid file, no second line');
});

// --- the engine, on a fake Windows layout ------------------------------------
/** tempHome — a throwaway HOME, and a cwd a fake `C:\...` tree can live in. */
function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-hidden-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

/** fakeWindowsTree — `C:\Program Files\Git\bin\bash.exe` and the LOCALAPPDATA
 * copy, as directories that really exist under `home`. Relative-looking on this
 * host, absolute on Windows: the engine resolves them with `path.win32.join`,
 * and `existsSync` answers for the cwd it was started in. */
function fakeWindowsTree(home) {
	const files = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Users\\mj\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'];
	for (const file of files) {
		fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
		fs.writeFileSync(path.join(home, file), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
	}
	// The guard the install registers is this checkout's own `bin/guard`: a run
	// from a clone that is not `~/.pi` has no installed copy yet, and naming a
	// path that is not there is the silent skip these tests exist to prevent.
	return { bash: files[0], guard: path.join(ROOT, 'bin', 'guard') };
}

function envFor(home, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		PI_PLATFORM: 'win32',
		PI_SKIP_NETWORK: '1',
		PI_ALLOW_MISSING_PI: '1',
		PI_SKIP_PREREQS: '1',
		PI_BOSS_DIR: path.join(home, 'big-boss-pi'),
		// The Windows layout, as the platform's own variables spell it.
		ProgramFiles: 'C:\\Program Files',
		LOCALAPPDATA: 'C:\\Users\\mj\\AppData\\Local',
		...extra,
	};
	// Either of these would decide the answer before the test does.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES', 'PI_GIT_BASH', 'Path']) delete env[name];
	return { ...env, ...extra };
}

function install(home, args = [], extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), ...args], {
		env: envFor(home, extra),
		encoding: 'utf8',
		cwd: home,
	});
}

const LAUNCHER = (home) => path.join(home, '.pi', 'state', GUARD_LAUNCHER_NAME);

test('a Windows install writes the launcher with the bash it resolved and the guard it registers', (t) => {
	const home = tempHome(t);
	const fake = fakeWindowsTree(home);
	const out = install(home);
	assert.equal(out.status, 0, out.stderr);

	const launcher = LAUNCHER(home);
	assert.ok(fs.existsSync(launcher), `no launcher at ${launcher}`);
	// `C:\Program Files` wins over the LOCALAPPDATA copy, and the launcher carries
	// exactly that resolved path and the guard — not a `%PI_GIT_BASH%` placeholder
	// a task with no useful environment could never expand.
	assert.deepEqual(launcherTargets(fs.readFileSync(launcher, 'utf8')), {
		bashPath: fake.bash,
		guardPath: fake.guard,
		pidPath: path.join(home, '.pi', 'state', GUARD_PID_NAME),
	});
	assert.match(out.stdout, /^== guard launcher \(hidden, no console window\) -> .*guard-hidden\.vbs$/m);

	// The registered task names wscript and that launcher, never bash.exe, and the
	// `/Run` right after it starts that same entry — so the install opens no window
	// either.
	const registered = out.stdout.match(/^   command: (schtasks .*)$/m)?.[1] || '';
	assert.match(registered, /wscript\.exe/i, registered);
	assert.ok(registered.includes(launcher), registered);
	assert.doesNotMatch(registered, /bash\.exe/i, registered);
	assert.match(out.stdout, /^   start: schtasks \/Run \/TN big-boss-pi-guard$/m);
});

test('a second install rewrites the launcher byte-identically, and does not even touch it', (t) => {
	const home = tempHome(t);
	fakeWindowsTree(home);
	assert.equal(install(home).status, 0);
	const launcher = LAUNCHER(home);
	const first = fs.readFileSync(launcher);
	const stamp = fs.statSync(launcher).mtimeMs;

	const second = install(home);
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual(fs.readFileSync(launcher), first);
	assert.equal(fs.statSync(launcher).mtimeMs, stamp, 'the launcher was written again');
	assert.doesNotMatch(second.stdout, /guard launcher \(hidden/m);
});

test('PI_SKIP_SYSTEMD=1 writes no launcher and registers nothing', (t) => {
	const home = tempHome(t);
	fakeWindowsTree(home);
	const out = install(home, [], { PI_SKIP_SYSTEMD: '1' });
	assert.equal(out.status, 0, out.stderr);
	assert.equal(fs.existsSync(LAUNCHER(home)), false, 'a launcher was written with the entry turned off');
	assert.doesNotMatch(out.stdout, /guard launcher \(hidden/m);
	assert.doesNotMatch(out.stdout, /command: schtasks/);
	assert.match(out.stdout, /PI_SKIP_SYSTEMD=1 — no login entry registered/);
});

// --- macOS and Linux are untouched -------------------------------------------
test('the macOS plist is byte-identical to the golden', (t) => {
	const home = tempHome(t);
	const fake = fakeWindowsTree(home);
	const out = install(home, [], { PI_PLATFORM: 'darwin' });
	assert.equal(out.status, 0, out.stderr);

	const plist = path.join(home, 'Library', 'LaunchAgents', 'dev.herdr.big-boss-pi-guard.plist');
	const text = fs.readFileSync(plist, 'utf8').split(home).join('~');
	assert.equal(
		text,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by ~/.pi/install.mjs. Edit the source there and re-run it. -->
<plist version="1.0">
    <dict>
        <key>Label</key>
        <string>dev.herdr.big-boss-pi-guard</string>
        <key>ProgramArguments</key>
        <array>
        <string>${path.join(ROOT, 'bin', 'guard').split(home).join('~')}</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>StandardOutPath</key>
        <string>~/Library/Logs/dev.herdr.big-boss-pi-guard.log</string>
        <key>StandardErrorPath</key>
        <string>~/Library/Logs/dev.herdr.big-boss-pi-guard.log</string>
    </dict>
</plist>
`,
	);
	// launchd starts a shebang script by itself; the hidden launcher is Windows'
	// stand-in for that, and it must not appear here.
	assert.equal(fs.existsSync(path.join(home, '.pi', 'state', GUARD_LAUNCHER_NAME)), false);
	assert.equal(fake.guard.endsWith(path.join('bin', 'guard')), true);
});

test('the systemd units are still copied byte for byte', (t) => {
	const home = tempHome(t);
	fakeWindowsTree(home);
	const out = install(home, [], { PI_PLATFORM: 'linux', PI_SKIP_SYSTEMD: '1' });
	assert.equal(out.status, 0, out.stderr);

	const installed = path.join(home, '.config', 'systemd', 'user');
	const sources = fs.readdirSync(path.join(ROOT, 'systemd')).sort();
	assert.ok(sources.length >= 5, `read nothing from systemd/: ${sources.join(', ')}`);
	for (const name of sources) {
		const want = fs.readFileSync(path.join(ROOT, 'systemd', name), 'utf8').replaceAll('%h', home);
		assert.equal(fs.readFileSync(path.join(installed, name), 'utf8'), want, `${name} changed`);
	}
	assert.equal(fs.existsSync(path.join(home, '.pi', 'state', GUARD_LAUNCHER_NAME)), false);
});
