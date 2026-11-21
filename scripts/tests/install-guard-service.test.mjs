// The guard login entry is the visible half of the install on macOS and Windows.
//
// What it costs to get this wrong is not a warning line: the documented one-liner
// finished on a clean Windows 11 box, Herdr opened, and there was no
// `big-boss-pi` space — because the step that creates it (`bin/guard`) was
// opt-in there while systemd on Linux needed no flag. So these tests hold the
// four claims the fix makes, on the plans rather than on the host:
//
//   1. a default run registers the entry on all three systems;
//   2. PI_SKIP_SYSTEMD=1 — and its alias PI_SKIP_SERVICES=1 — registers nothing
//      and says which variable did it;
//   3. PI_ENABLE_SERVICES=1 is still accepted, so a script written against the
//      old flag keeps working;
//   4. the two honest failures (no clone, no Git Bash) name what is missing and
//      what to set, instead of skipping in silence.
//
// Everything runs in a throwaway HOME with a stand-in `bin/guard`, and the
// macOS plist is read off the disk: "it printed the line" is not the claim.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-service-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

/** cloneWithGuard — the two files these steps look for, as the real clone has them. */
function cloneWithGuard(home) {
	const boss = path.join(home, 'big-boss-pi');
	const guard = path.join(boss, 'bin', 'guard');
	fs.mkdirSync(path.dirname(guard), { recursive: true });
	fs.writeFileSync(guard, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
	// A stand-in clone with its own systemd/ copy of the old pre-space guard unit:
	// the install must now take the guard unit from this repo instead, so the
	// Linux test below can prove the clone's copy does not win.
	fs.mkdirSync(path.join(boss, 'systemd'), { recursive: true });
	fs.writeFileSync(
		path.join(boss, 'systemd', 'big-boss-pi-guard.service'),
		'[Unit]\nDescription=big-boss-pi guard\n\n[Service]\nExecStart=%h/big-boss-pi/bin/guard\n\n[Install]\nWantedBy=default.target\n',
	);
	return { boss, guard };
}

function install(home, platform, args = [], extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		PI_PLATFORM: platform,
		PI_SKIP_NETWORK: '1',
		PI_SKIP_PREREQS: '1',
		PI_ALLOW_MISSING_PI: '1',
		PI_BOSS_DIR: path.join(home, 'big-boss-pi'),
		// The step waits up to 20s for the space; a test does not. The wait itself
		// is driven with a fake clock in scripts/tests/guard-start.test.mjs.
		PI_GUARD_SPACE_WAIT_MS: '0',
		...extra,
	};
	// Any of these would decide the answer before the test does: the host's
	// platform, a real workspace, the gates under test.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES', 'PI_SKIP_SYSTEMD', 'PI_SKIP_SERVICES', 'PI_GIT_BASH']) delete env[name];
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), ...args], {
		env: { ...env, ...extra },
		encoding: 'utf8',
		cwd: ROOT,
	});
}

const plistPath = (home) => path.join(home, 'Library', 'LaunchAgents', 'dev.herdr.big-boss-pi-guard.plist');

test('macOS: a default run writes the launchd plist, pointed at bin/guard', (t) => {
	const home = tempHome(t);
	const { guard } = cloneWithGuard(home);

	const out = install(home, 'darwin');
	assert.equal(out.status, 0, out.stderr);

	const plist = plistPath(home);
	assert.ok(fs.existsSync(plist), 'no launchd plist written on a default run');
	assert.match(out.stdout, /^== guard login item -> .*dev\.herdr\.big-boss-pi-guard\.plist$/m);
	// The entry is only an entry if ProgramArguments names the guard itself.
	const text = fs.readFileSync(plist, 'utf8');
	assert.match(text, /<key>ProgramArguments<\/key>/);
	assert.ok(text.includes(`<string>${guard}</string>`), 'the plist does not name bin/guard');
	assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
	// And the summary says what was installed and how to undo it.
	assert.match(out.stdout, /^Installed: launchd login item .*dev\.herdr\.big-boss-pi-guard\.plist$/m);
	assert.match(out.stdout, /^Disable: launchctl unload -w .*dev\.herdr\.big-boss-pi-guard\.plist$/m);
});

test('Windows: a default run registers the Task Scheduler entry', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	// PI_GIT_BASH is the resolution's override and the only way this runs on a host
	// without Git for Windows; --dry-run keeps a Linux host from asking schtasks.
	const out = install(home, 'win32', ['--dry-run'], { PI_GIT_BASH: '/usr/bin/bash' });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /^== guard: registering a Task Scheduler entry at logon \(this is what creates the big-boss-pi space\)$/m);
	const registered = out.stdout.match(/^   command: (schtasks .*)$/m);
	assert.ok(registered, 'no registered command line');
	// wscript.exe and the generated launcher, never bash.exe: bash is a console
	// program, and the guard is a loop — the window it opened never closed.
	const launcher = path.join(home, '.pi', 'state', 'guard-hidden.vbs');
	assert.ok(registered[1].includes(`"\\"C:\\Windows\\System32\\wscript.exe\\" \\"${launcher}\\""`), registered[1]);
	assert.doesNotMatch(registered[1], /bash/i, registered[1]);
	assert.match(out.stdout, /^Would install: Task Scheduler entry big-boss-pi-guard \(.*\)$/m);
	assert.match(out.stdout, /^Disable: schtasks \/Delete \/TN big-boss-pi-guard \/F$/m);
	assert.match(out.stdout, /^Disable: for \/f "usebackq" %p in \(".*guard\.pid"\) do taskkill \/F \/PID %p$/m);
});

// Registering is not starting: `/SC ONLOGON` is a promise about the next logon,
// and the Windows run that found no space was exactly that promise, unkept. So
// the start comes after the registration, on the same entry — and never when
// nothing was registered, because there is nothing to start.
test('Windows: the entry is started after it is registered, in that order', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	const out = install(home, 'win32', ['--dry-run'], { PI_GIT_BASH: '/usr/bin/bash' });
	assert.equal(out.status, 0, out.stderr);
	const created = out.stdout.indexOf('   command: schtasks /Create');
	const started = out.stdout.indexOf('   start: schtasks /Run /TN big-boss-pi-guard');
	assert.ok(created >= 0, 'no /Create line: ' + out.stdout);
	assert.ok(started >= 0, 'no /Run line: ' + out.stdout);
	assert.ok(created < started, 'the entry was started before it was registered');
	assert.match(out.stdout, /^   \[dry-run\] not started$/m);
});

test('nothing is started when no entry was registered', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	// Skipped on purpose, and the honest failure (no Git Bash): neither
	// registered an entry, so neither may claim to have started one.
	const skippedOut = install(home, 'win32', ['--dry-run'], { PI_SKIP_SYSTEMD: '1', PI_GIT_BASH: '/usr/bin/bash' });
	assert.doesNotMatch(skippedOut.stdout, /schtasks \/Run/);
	// A task that points at no interpreter was never registered, so there is
	// nothing to /Run: the step must not start a task it did not create.
	const noBash = install(home, 'win32', ['--dry-run'], { PI_GIT_BASH: path.join(home, 'no-such-bash.exe') });
	assert.doesNotMatch(noBash.stdout, /schtasks \/Run/);
	const macSkip = install(home, 'darwin', [], { PI_SKIP_SYSTEMD: '1' });
	assert.doesNotMatch(macSkip.stdout, /launchctl kickstart/);
});

test('Linux: a default run copies the guard unit out of this repo, pointed at the supervisor', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	const out = install(home, 'linux');
	assert.equal(out.status, 0, out.stderr);
	const unit = path.join(home, '.config', 'systemd', 'user', 'big-boss-pi-guard.service');
	assert.ok(fs.existsSync(unit), 'no big-boss-pi guard unit copied');
	// The installed unit is this repo's `systemd/big-boss-pi-guard.service` with %h
	// resolved: it starts `~/.pi/bin/guard`, the supervisor that restores every
	// recorded space — not the clone's pre-space copy that knew one workspace.
	const text = fs.readFileSync(unit, 'utf8');
	assert.ok(text.includes(`ExecStart=${path.join(home, '.pi', 'bin', 'guard')}`), text);
	assert.ok(
		!text.includes(path.join(home, 'big-boss-pi', 'bin', 'guard')),
		"the clone's pre-space guard is still what the unit starts",
	);
	assert.match(out.stdout, /^== big-boss-pi-guard\.service -> /m);
});

test('PI_SKIP_SYSTEMD=1 registers nothing and names the variable', (t) => {
	const home = tempHome(t);
	const { guard } = cloneWithGuard(home);

	const mac = install(home, 'darwin', [], { PI_SKIP_SYSTEMD: '1' });
	assert.equal(mac.status, 0, mac.stderr);
	assert.equal(fs.existsSync(plistPath(home)), false, 'PI_SKIP_SYSTEMD=1 still wrote a login item');
	assert.match(mac.stdout, /^== guard service \(launchd \/ Task Scheduler\): PI_SKIP_SYSTEMD=1 — no login entry registered/m);
	// The skip is only useful if it says how to start the guard once, by hand.
	assert.ok(mac.stdout.includes(guard), 'the skip line does not name bin/guard');
	assert.match(mac.stdout, /start it by hand: ".*bin\/guard" &/);
	assert.match(mac.stdout, /^Guard login item: not registered/m);

	const win = install(home, 'win32', ['--dry-run'], { PI_SKIP_SYSTEMD: '1', PI_GIT_BASH: '/usr/bin/bash' });
	assert.match(win.stdout, /^== guard service \(launchd \/ Task Scheduler\): PI_SKIP_SYSTEMD=1/m);
	assert.doesNotMatch(win.stdout, /guard: registering a Task Scheduler entry/);
});

test('PI_SKIP_SERVICES=1 is the same way out, spelled honestly on all three platforms', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	const mac = install(home, 'darwin', [], { PI_SKIP_SERVICES: '1' });
	assert.match(mac.stdout, /^== guard service \(launchd \/ Task Scheduler\): PI_SKIP_SERVICES=1 — no login entry registered/m);
	assert.equal(fs.existsSync(plistPath(home)), false);

	// The Linux half of the alias: the units are copied and nothing is enabled.
	const linux = install(home, 'linux', [], { PI_SKIP_SERVICES: '1' });
	assert.match(linux.stdout, /^== PI_SKIP_SERVICES=1 — units copied, none enabled$/m);
	assert.ok(
		fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'big-boss-pi-guard.service')),
		'the alias must still copy the units it says it copied',
	);
});

test('PI_ENABLE_SERVICES=1 is still accepted, and changes nothing', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	const out = install(home, 'win32', ['--dry-run'], { PI_ENABLE_SERVICES: '1', PI_GIT_BASH: '/usr/bin/bash' });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /PI_ENABLE_SERVICES=1 is accepted — the login entry is the default now/);
	assert.match(out.stdout, /^== guard: registering a Task Scheduler entry at logon/m);
});

test('Windows with no Git Bash prints the PI_GIT_BASH line and registers nothing', (t) => {
	const home = tempHome(t);
	cloneWithGuard(home);

	const out = install(home, 'win32', ['--dry-run'], { PI_GIT_BASH: path.join(home, 'no-such-bash.exe') });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stderr, /no Git Bash found/);
	assert.match(out.stdout, /   fix: install Git for Windows, or set PI_GIT_BASH to bash\.exe, then re-run/);
	assert.doesNotMatch(out.stdout, /guard: registering a Task Scheduler entry/);
	assert.match(out.stdout, /^Guard task: not registered/m);
});

test('a missing bin/guard is named, with what to set — never a silent skip', (t) => {
	const home = tempHome(t);
	// No clone at all: PI_SKIP_NETWORK=1 and nothing on disk, which is the state the
	// first Windows install was in when the space did not appear.
	const out = install(home, 'darwin');

	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stderr.includes(path.join(home, 'big-boss-pi', 'bin', 'guard')), out.stderr);
	assert.match(out.stderr, /missing — nothing to register/);
	assert.match(out.stdout, /   fix: the delegation workspace is not cloned — re-run without PI_SKIP_NETWORK=1/);
	assert.equal(fs.existsSync(plistPath(home)), false);
});
