// A fresh install must come up with a `harness` space and a Boss tab.
//
// Why this exists: creating the space used to be the guard's job, and the guard
// is a login entry — on Windows and macOS it never ran during the install, so
// Herdr opened with no space in it, and on Linux the install leaned on a clone
// of a second repo for the record. Both are gone: the installer calls
// `bin/space new --name harness --project ~/.pi --kind harness` itself, once,
// and the record is the proof. The log is not the proof: a line that says
// "space harness" over a missing file is exactly the green transcript the
// Windows box reported.
//
// Shape: a throwaway HOME, the real engine, and a stub `herdr-app` on PATH that
// answers `do space.new` and `ls` and nothing else — so the test drives the real
// `bin/space`, the real record writer and the real installer, and never touches
// the desktop app on the machine running the suite. The no-app case filters the
// PATH entries that carry a `herdr-app`, which is the same machine without the
// app rather than a mocked absence.
//
// The install half of the retirement — no step and no doc points at the checkout
// that is going away — used to be a test here, over this file's own list of steps
// and docs. It is the one retirement test in scripts/tests/ now: every tracked
// file, with the few names that must stay allow-listed by path and a reason. A
// second, narrower copy of that claim is a copy that can disagree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RECORD = (home) => path.join(home, '.pi', 'state', 'spaces', 'harness', 'space.json');

function envFor(home, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		// Node reads USERPROFILE on Windows; the POSIX tools read HOME.
		USERPROFILE: home,
		PI_AGENT_DIR: path.join(home, '.pi', 'agent'),
		PI_SKIP_NETWORK: '1',
		PI_SKIP_PREREQS: '1',
		PI_SKIP_SYSTEMD: '1',
		PI_ALLOW_MISSING_PI: '1',
		...extra,
	};
	// Each of these would decide an answer before the installer does, or aim a
	// write at the machine's own config instead of the throwaway home.
	for (const name of ['PI_DRY_RUN', 'PI_PLATFORM', 'PI_ENABLE_SERVICES', 'PI_GIT_BASH', 'HERDR_MODS', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
		delete env[name];
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

function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-space-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

/**
 * stubHerdrApp — a PATH directory holding one program: a `herdr-app` that
 * answers the two calls the install makes and nothing else. It prints the shape
 * the app prints (`space`, `tab`, `terminal`), so the record `bin/space` writes
 * is the real record, filled from a real JSON answer.
 */
function stubHerdrApp(t, home) {
	const dir = path.join(home, 'stub-bin');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'herdr-app');
	fs.writeFileSync(
		file,
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

/** pathWithout — PATH with every directory that carries `name` removed. */
function pathWithout(name) {
	const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
	return dirs
		.filter((d) => !fs.existsSync(path.join(d, name)) && !fs.existsSync(path.join(d, `${name}.exe`)))
		.join(path.delimiter);
}

test('a throwaway-HOME install writes the harness record, with the checkout as its project', (t) => {
	const home = tempHome(t);
	const stub = stubHerdrApp(t, home);
	const run = install(home, { PATH: `${stub}${path.delimiter}${process.env.PATH || ''}` });
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);
	assert.ok(fs.existsSync(RECORD(home)), `no ${RECORD(home)} — the install made no space:\n${out}`);

	const record = JSON.parse(fs.readFileSync(RECORD(home), 'utf8'));
	// The record is the proof, not the log line: the kind a learner reads, and the
	// project a space may never be repointed away from.
	assert.equal(record.kind, 'harness', `the record is not a harness space: ${JSON.stringify(record)}`);
	assert.equal(record.project, fs.realpathSync(path.join(home, '.pi')), `the record names another project: ${record.project}`);
	// A space with no Boss tab is a space nobody can talk to.
	assert.equal(record.boss, 'Boss');
});

test('a second run leaves the record byte for byte identical', (t) => {
	const home = tempHome(t);
	const stub = stubHerdrApp(t, home);
	const env = { PATH: `${stub}${path.delimiter}${process.env.PATH || ''}` };
	const first = install(home, env);
	assert.equal(first.status, 0, `the first install failed:\n${first.stdout}${first.stderr}`);
	const before = fs.readFileSync(RECORD(home));

	const second = install(home, env);
	const out = `${second.stdout}${second.stderr}`;
	assert.equal(second.status, 0, `the second install failed:\n${out}`);
	assert.deepEqual(fs.readFileSync(RECORD(home)), before, 'the second run rewrote the space record');
	assert.match(out, /^== space harness: recorded for .*left as it is$/m, `the second run did not say it left the record alone:\n${out}`);
});

test('a record for another project is untouched and named in one line', (t) => {
	const home = tempHome(t);
	const stub = stubHerdrApp(t, home);
	const record = RECORD(home);
	fs.mkdirSync(path.dirname(record), { recursive: true });
	const other = `${JSON.stringify({ name: 'harness', kind: 'harness', project: '/somewhere/else', boss: 'Boss' }, null, 2)}\n`;
	fs.writeFileSync(record, other);

	const run = install(home, { PATH: `${stub}${path.delimiter}${process.env.PATH || ''}` });
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);
	assert.equal(fs.readFileSync(record, 'utf8'), other, 'the install rewrote a record that named another project — a space is never repointed');
	const lines = out.split('\n').filter((line) => line.includes('/somewhere/else'));
	assert.equal(lines.length, 1, `the run should name the existing record in one line, not ${lines.length}:\n${out}`);
});

test('without herdr-app the install still exits 0 and prints the by-hand command', (t) => {
	const home = tempHome(t);
	const run = install(home, { PATH: pathWithout('herdr-app') });
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status} with no herdr-app:\n${out}`);
	assert.match(
		out,
		/^== space harness: herdr-app is not on PATH — .*make it by hand: .*bin\/space" new --name harness --project .* --kind harness$/m,
		`the by-hand command is not in the transcript:\n${out}`,
	);
	assert.equal(fs.existsSync(RECORD(home)), false, 'a record was written with no app to open the space in');
});

