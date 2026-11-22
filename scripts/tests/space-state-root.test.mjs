// #260: a copied `space`, `delegate` or `guard` read a different `state/` from a symlinked one.
//
// On a Windows box after #258 (winget, setup.ps1, no Developer Mode, so every bin entry is a
// copy) `space.cmd list` printed `no spaces — bin/space new <slug> in the project folder` while
// `%USERPROFILE%\.pi\state\spaces\harness\space.json` was right there. Cause: `space-lib.sh`
// derived the state root from the directory the library file sits in, so the copy in
// `~\.local\bin` read `~\.local\state` — a folder that holds nothing — while the symlink a Linux
// install makes resolved to `~\.pi`. The same line decided the rules template, so a copied
// `space new` also found no `agent/space-rules.md`.
//
// One decision replaces it — PI_HOME, then the checkout a symlink resolves to, then the
// library's own parent — plus one line the installer writes into the three copies it makes
// (`stampPiHome`, because a copy has no path back to its checkout that is not a guess).
//
// No Windows host exists here, so the platform is forced (`PI_PLATFORM=win32`, the knob the other
// Windows suites read) and the claims are file- and argv-level: which line the copied entry
// carries, which directory it then reads, and that a symlinked entry reads the same one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PI_HOME_CARRIERS, SOURCE_LIBS, stampPiHome } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN_DIR = (home) => path.join(home, '.local', 'bin');
const CHECKOUT = (home) => path.join(home, '.pi');
const SPACES_IN = (dir) => path.join(dir, 'state', 'spaces');
const TOOLS = ['space', 'delegate', 'guard'];

function tempDir(t, prefix = 'pi-space-root-') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * cleanEnv — a HOME, and none of the four variables that decide the state root before the code
 * under test does. A stray PI_HOME in the runner's environment would make every case pass.
 */
function cleanEnv(home, extra = {}) {
	const env = { ...process.env, HOME: home, ...extra };
	for (const name of ['USERPROFILE', 'PI_HOME', 'PI_SPACE_ROOT', 'SPACE_STATE', 'PI_SPACE_RULES_TEMPLATE', 'PI_AGENT_DIR', 'PI_DRY_RUN']) {
		if (!(name in extra)) delete env[name];
	}
	return env;
}

function run(entry, args, home, extra = {}) {
	return spawnSync(entry, args, { cwd: home, env: cleanEnv(home, extra), encoding: 'utf8' });
}

/**
 * fakeCheckout — the `~/.pi` a real install has: `bin/` with the tools and the libraries they
 * source, `agent/space-rules.md`, and the `state/` the copy install on a Windows box cannot see.
 * A symlink from the bin directory on PATH lands in here, exactly as `~/.local/bin/space ->
 * ~/.pi/bin/space` does on Linux.
 */
function fakeCheckout(t, home) {
	const co = CHECKOUT(home);
	for (const [dir, names] of [
		['bin', [...TOOLS, ...SOURCE_LIBS]],
		['agent', ['space-rules.md']],
	]) {
		fs.mkdirSync(path.join(co, dir), { recursive: true });
		for (const name of names) {
			fs.copyFileSync(path.join(ROOT, dir, name), path.join(co, dir, name));
			fs.chmodSync(path.join(co, dir, name), 0o755);
		}
	}
	return co;
}

/** copyInstall — what copy mode leaves on PATH: the entries stamped, the libraries beside them. */
function copyInstall(home, co) {
	const bin = BIN_DIR(home);
	fs.mkdirSync(bin, { recursive: true });
	for (const name of SOURCE_LIBS) fs.copyFileSync(path.join(co, 'bin', name), path.join(bin, name));
	for (const name of TOOLS) {
		const text = fs.readFileSync(path.join(co, 'bin', name), 'utf8');
		fs.writeFileSync(path.join(bin, name), stampPiHome({ piHome: co, name, text }));
		fs.chmodSync(path.join(bin, name), 0o755);
	}
	return bin;
}

/** symlinkInstall — what a Linux install leaves on PATH: a link into the checkout. */
function symlinkInstall(home, co) {
	const bin = BIN_DIR(home);
	fs.mkdirSync(bin, { recursive: true });
	for (const name of TOOLS) fs.symlinkSync(path.join(co, 'bin', name), path.join(bin, name));
	return bin;
}

function writeRecord(dir, slug = 'harness', kind = 'harness') {
	const recordDir = path.join(SPACES_IN(dir), slug);
	fs.mkdirSync(recordDir, { recursive: true });
	const record = { name: slug, project: dir, git: false, kind, terminals: [] };
	fs.writeFileSync(path.join(recordDir, 'space.json'), `${JSON.stringify(record, null, 2)}\n`);
}

/** stubHerdrApp — a `herdr-app` that opens a space, so `space new` has an app to talk to. */
function stubHerdrApp(home) {
	const dir = path.join(home, 'stub-bin');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'herdr-app'),
		[
			'#!/bin/sh',
			'case "$1 $2" in',
			'  "do space.new") printf \'{"space":"sp-test","tab":"tab-boss","terminal":"term-1"}\\n\' ;;',
			'  "ls ") printf \'{"spaces":[]}\\n\' ;;',
			'  *) exit 1 ;;',
			'esac',
			'',
		].join('\n'),
		{ mode: 0o755 },
	);
	return dir;
}

// --- the stamp --------------------------------------------------------------

test('stampPiHome writes PI_HOME into the entries that read state/, and into nothing else', () => {
	const text = fs.readFileSync(path.join(ROOT, 'bin', 'space'), 'utf8');
	const stamped = stampPiHome({ piHome: '/home/mj/.pi', name: 'space', text });

	// After the shebang, because a line above it is not a script any more, and
	// before the source, because that is the line that reads it.
	const lines = stamped.split('\n');
	assert.equal(lines[0], '#!/usr/bin/env bash');
	assert.ok(stamped.includes("PI_HOME='/home/mj/.pi'"), `no PI_HOME line:\n${stamped.slice(0, 400)}`);
	assert.ok(stamped.indexOf('PI_HOME=') < stamped.indexOf('. "$here/space-lib.sh"'), 'PI_HOME lands after the library that needs it');
	// The body is the tool, untouched: a stamp that reworded the script would be a
	// second copy of bin/space to keep in step.
	assert.equal(stamped.slice(stamped.indexOf('# space — ')), text.slice(text.indexOf('# space — ')));
	assert.deepEqual(PI_HOME_CARRIERS.slice().sort(), TOOLS.slice().sort(), 'the carriers and the tools the test copies disagree');

	// Everything else comes back byte for byte. `herdr-app.exe` is a real binary on
	// Windows: one written line through it is a dead menu row.
	assert.equal(stampPiHome({ piHome: '/home/mj/.pi', name: 'herdr-app.exe', text }), text);
	for (const name of SOURCE_LIBS) assert.equal(stampPiHome({ piHome: '/home/mj/.pi', name, text: fs.readFileSync(path.join(ROOT, 'bin', name), 'utf8') }), fs.readFileSync(path.join(ROOT, 'bin', name), 'utf8'), `${name} was stamped`);
	assert.equal(stampPiHome({ piHome: '/home/mj/.pi', name: 'space', text: 'not a script' }), 'not a script');

	// A home with a quote or a space is a path a person chose, so it is quoted
	// rather than trusted: the line runs before the script's own quoting exists.
	assert.ok(stampPiHome({ piHome: "/home/mj's pi/.pi", name: 'space', text }).includes(`PI_HOME='/home/mj'\\''s pi/.pi'`));
	assert.throws(() => stampPiHome({ name: 'space', text }), /\.pi/);
});

// --- the two installs -------------------------------------------------------

test('a copied entry and a symlinked entry list the same record from the same state/', (t) => {
	const home = tempDir(t);
	const co = fakeCheckout(t, home);
	writeRecord(co);

	// Symlink install first: this is the shape that always worked, and it is the
	// answer the copy has to reproduce — same record, not merely some record.
	const linked = symlinkInstall(home, co);
	const viaLink = run(path.join(linked, 'space'), ['list'], home);
	assert.equal(viaLink.status, 0, viaLink.stderr);
	assert.match(viaLink.stdout, /^harness\b/m, `the symlinked entry lost the record:\n${viaLink.stdout}`);

	// Copy mode: the entries are copies, and only the line the installer wrote
	// gets them back to the checkout.
	fs.rmSync(linked, { recursive: true, force: true });
	const copied = copyInstall(home, co);
	assert.equal(fs.lstatSync(path.join(copied, 'space')).isSymbolicLink(), false);
	const viaCopy = run(path.join(copied, 'space'), ['list'], home);
	assert.equal(viaCopy.status, 0, viaCopy.stderr);
	assert.equal(viaCopy.stdout, viaLink.stdout, 'the copy install reads a different state/ from the symlink install');

	// `delegate` sources the same library and defaults ROOT to it, so the same
	// record has to be visible to it too — on the broken root it printed `no
	// workers` over a space that had one.
	const delegations = path.join(SPACES_IN(co), 'harness', 'delegations.json');
	fs.writeFileSync(delegations, `${JSON.stringify({ w1: { state: 'reported', branch: 'b1' } }, null, 2)}\n`);
	const workers = run(path.join(copied, 'delegate'), ['list'], home);
	assert.equal(workers.status, 0, workers.stderr);
	assert.match(workers.stdout, /^w1\b/m, `the copied delegate read an empty state root:\n${workers.stdout}`);
});

test('a copied space new writes the rules block into the project', (t) => {
	const home = tempDir(t);
	const co = fakeCheckout(t, home);
	const bin = copyInstall(home, co);
	const project = path.join(home, 'project');
	fs.mkdirSync(project, { recursive: true });
	const stub = stubHerdrApp(home);

	const made = run(path.join(bin, 'space'), ['new', 'ruled', '--project', project, '--no-git', '--kind', 'project'], home, {
		PATH: `${stub}${path.delimiter}${process.env.PATH || ''}`,
	});
	assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);

	// The template came from the checkout the copy was stamped with: before this,
	// a copy resolved it to `~/.local/agent/space-rules.md` and warned that the
	// project holds no rules block.
	const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
	assert.equal(agents.match(/<!-- pi-space:begin -->/g)?.length, 1, `no rules block:\n${agents.slice(0, 400)}`);
	assert.match(agents, /<!-- pi-space:end -->/);
	assert.match(agents, /## This space is ruled/);
	assert.ok(fs.existsSync(path.join(SPACES_IN(co), 'ruled', 'space.json')), 'the record landed outside the checkout');
});

test('an unstamped copy names the directory it read instead of an empty list', (t) => {
	const home = tempDir(t);
	const fake = path.join(home, 'bin');
	fs.mkdirSync(fake, { recursive: true });
	// A copy nobody stamped: the case a person reproduces with `cp bin/space …`.
	for (const name of ['space', ...SOURCE_LIBS]) fs.copyFileSync(path.join(ROOT, 'bin', name), path.join(fake, name));
	fs.chmodSync(path.join(fake, 'space'), 0o755);

	const out = run(path.join(fake, 'space'), ['list'], home);
	assert.equal(out.status, 0, out.stderr);
	// Which directory, always: the old line said "no spaces" for a wrong root and for
	// a machine with none, and that is what hid this for a release.
	assert.ok(out.stdout.includes(`${path.join(home, 'state', 'spaces')} — bin/space new`), `the message does not name the state root:\n${out.stdout}`);
	assert.match(out.stdout, /no PI_HOME set and .* is not a harness checkout/);
});

// --- the installer ----------------------------------------------------------

test('copy mode stamps the three entries it copies, and the installed space reads the record', (t) => {
	const home = tempDir(t);
	const env = cleanEnv(home, {
		PI_PLATFORM: 'win32',
		PI_SKIP_NETWORK: '1',
		PI_SKIP_SYSTEMD: '1',
		PI_SKIP_PREREQS: '1',
		PI_ALLOW_MISSING_PI: '1',
	});
	const installed = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], { cwd: ROOT, env, encoding: 'utf8' });
	assert.equal(installed.status, 0, `install.mjs exited ${installed.status}:\n${installed.stdout}${installed.stderr}`);

	// The installer, not the test, is what writes the line: the copy on PATH carries
	// the checkout the same run recorded `state/` under.
	const entry = fs.readFileSync(path.join(BIN_DIR(home), 'space'), 'utf8');
	assert.ok(entry.includes(`PI_HOME='${CHECKOUT(home)}'`), `the copied entry carries no PI_HOME:\n${entry.slice(0, 400)}`);

	writeRecord(CHECKOUT(home));
	const out = run(path.join(BIN_DIR(home), 'space'), ['list'], home);
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /^harness\b/m, `the installed space cannot see its own record:\n${out.stdout}`);
});
