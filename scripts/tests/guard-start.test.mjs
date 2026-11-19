// "Install finished" has to mean the `big-boss-pi` space exists — or the install
// has to say why not.
//
// The Windows run that made this a task: the installer registered the Task
// Scheduler entry with `/SC ONLOGON` and never `/Run`, so the guard started at
// the *next* logon. The person ran the installer, Herdr opened, the space was
// missing, and nothing anywhere said so. These tests pin the five answers the
// step can now give, each one without a desktop app, a Task Scheduler or a
// twenty-second sleep — `startAndVerifyGuard` takes its effects as parameters.
//
// What is *not* tested here on purpose: `bin/guard`'s own `space_id` parser. It
// is bash in another repo; `spaceIdIn` mirrors its one predicate
// (`spaces.find(s => s.name === name)`) and is pinned against the same snapshot
// shape, which is the part the two readers have to agree on.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	GUARD_SPACE_NAME,
	guardDoor,
	guardStartCommand,
	spaceIdIn,
	startAndVerifyGuard,
	waitForSpace,
} from '../install-lib.mjs';

const SNAPSHOT = JSON.stringify({
	spaces: [
		{ id: 'space-1', name: 'other' },
		{ id: 'space-9', name: 'big-boss-pi' },
	],
});

/** recorder — one object holding every line and every call the step made. */
function recorder() {
	const lines = [];
	const calls = [];
	return {
		lines,
		calls,
		out: { say: (l) => lines.push(l), note: (l) => lines.push(l) },
		run: (exe, args) => {
			calls.push([exe, ...args]);
			return 0;
		},
	};
}

// --- the start command -------------------------------------------------------

test('Windows: the start is schtasks /Run on the absolute exe, after /Create', () => {
	const start = guardStartCommand({ platform: 'win32' });
	assert.deepEqual(start.args, ['/Run', '/TN', 'big-boss-pi-guard']);
	assert.match(start.exe, /schtasks\.exe$/, 'a bare schtasks goes through cmd.exe');
	assert.equal(start.program, 'schtasks /Run /TN big-boss-pi-guard');
});

test('macOS: the start is launchctl kickstart -k on the label that was loaded', () => {
	const start = guardStartCommand({ platform: 'darwin', uid: 501 });
	assert.deepEqual(start.args, ['kickstart', '-k', 'gui/501/dev.herdr.big-boss-pi-guard']);
	assert.equal(start.exe, 'launchctl');
});

test('Linux has no start command here: the unit is enabled --now and restarted', () => {
	assert.equal(guardStartCommand({ platform: 'linux' }), null);
});

// --- the space, read off a herdr-app snapshot --------------------------------

test('spaceIdIn finds the space by name, and only that name', () => {
	assert.equal(spaceIdIn(SNAPSHOT, GUARD_SPACE_NAME), 'space-9');
	assert.equal(spaceIdIn(SNAPSHOT, 'nope'), null);
	assert.equal(spaceIdIn('not json', GUARD_SPACE_NAME), null);
	assert.equal(spaceIdIn('{}', GUARD_SPACE_NAME), null);
});

// --- the bounded wait --------------------------------------------------------

test('waitForSpace stops at the deadline when the app is up and the space is not', async () => {
	let clock = 0;
	const sleeps = [];
	const answer = await waitForSpace({
		probe: () => ({ running: true, id: null }),
		timeoutMs: 20000,
		intervalMs: 500,
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	});
	assert.equal(answer.state, 'missing');
	// Bounded, not a hang: forty polls of 500ms, and not one millisecond more.
	assert.equal(sleeps.length, 40);
	assert.equal(clock, 20000);
});

test('waitForSpace returns as soon as the space shows up', async () => {
	let polls = 0;
	const answer = await waitForSpace({
		probe: () => {
			polls++;
			return { running: true, id: polls < 3 ? null : 'space-9' };
		},
		timeoutMs: 20000,
		intervalMs: 10,
		sleep: async () => {},
	});
	assert.deepEqual(answer, { state: 'found', id: 'space-9' });
	assert.equal(polls, 3);
});

// --- the five things the step can say ---------------------------------------

test('a start that fails does not abort, and prints the door', async () => {
	const r = recorder();
	const verdict = await startAndVerifyGuard({
		platform: 'win32',
		bossDir: 'C:\\Users\\mj\\big-boss-pi',
		run: () => 1,
		probe: () => ({ running: true, id: null }),
		out: r.out,
	});
	assert.equal(verdict.state, 'start-failed');
	assert.ok(
		r.lines.some((l) => /^== guard: registered, but starting it failed \(exit 1\)/.test(l)),
		'a failed /Run has to be loud: ' + JSON.stringify(r.lines),
	);
	for (const line of guardDoor({ platform: 'win32', bossDir: 'C:\\Users\\mj\\big-boss-pi' })) {
		assert.ok(r.lines.includes(line), `missing door line: ${line}`);
	}
	// The point of the door: the task, the guard's own log, the app.
	assert.ok(r.lines.some((l) => l.includes('schtasks /Query /TN big-boss-pi-guard /V /FO LIST')));
	assert.ok(r.lines.some((l) => l.includes('state\\guard.log')));
	assert.ok(r.lines.some((l) => l.includes('herdr-app ls')));
});

test('an app that is not running passes with the "when Herdr starts" line', async () => {
	const r = recorder();
	const verdict = await startAndVerifyGuard({
		platform: 'darwin',
		bossDir: '/Users/mj/big-boss-pi',
		uid: 501,
		run: r.run,
		probe: () => ({ running: false, id: null }),
		out: r.out,
	});
	assert.deepEqual(r.calls, [['launchctl', 'kickstart', '-k', 'gui/501/dev.herdr.big-boss-pi-guard']]);
	assert.equal(verdict.state, 'app-down');
	assert.ok(
		r.lines.some((l) => /registered and started — Herdr is not running yet/.test(l)),
		JSON.stringify(r.lines),
	);
	assert.ok(!r.lines.some((l) => l.startsWith('== guard: registered and started, but no')), 'a down app is not a failure');
});

test('a running app without the space prints the loud line and the door', async () => {
	const r = recorder();
	// A fake clock the fake sleep advances: the deadline is reached in four calls,
	// so the test costs nothing and the loop still ends the real way.
	let clock1000 = 0;
	const verdict = await startAndVerifyGuard({
		platform: 'win32',
		bossDir: 'C:\\Users\\mj\\big-boss-pi',
		run: r.run,
		probe: () => ({ running: true, id: null }),
		timeoutMs: 1000,
		intervalMs: 250,
		now: () => clock1000,
		sleep: async (ms) => {
			clock1000 += ms;
		},
		out: r.out,
	});
	assert.equal(verdict.state, 'missing');
	assert.ok(r.lines.includes(`== guard: registered and started, but no ${GUARD_SPACE_NAME} space appeared`), JSON.stringify(r.lines));
	assert.equal(r.lines.filter((l) => l.startsWith('   ')).length >= 3, true, 'the door is three lines: ' + JSON.stringify(r.lines));
});

test('a space that appears is said in one line, and nothing is called loud', async () => {
	const r = recorder();
	const verdict = await startAndVerifyGuard({
		platform: 'win32',
		bossDir: 'C:\\Users\\mj\\big-boss-pi',
		run: r.run,
		probe: () => ({ running: true, id: spaceIdIn(SNAPSHOT, GUARD_SPACE_NAME) }),
		out: r.out,
	});
	assert.equal(verdict.state, 'found');
	assert.ok(r.lines.some((l) => l.includes('the big-boss-pi space is there (space-9)')));
	assert.ok(!r.lines.some((l) => l.startsWith('==')));
});

test('a dry run plans the start and starts nothing', async () => {
	const r = recorder();
	const verdict = await startAndVerifyGuard({ platform: 'win32', bossDir: 'C:\\b', dry: true, run: r.run, probe: () => ({ running: true, id: null }), out: r.out });
	assert.equal(verdict.state, 'dry');
	assert.deepEqual(r.calls, []);
	assert.ok(r.lines.includes('   start: schtasks /Run /TN big-boss-pi-guard'));
	assert.ok(r.lines.includes('   [dry-run] not started'));
});
