// A fresh install leaves `alt-shift-n` bound to the space prompt — and never eats a key.
//
// Shape: a throwaway HOME, the real installer, and no herdr-app anywhere (the app is not
// needed to write a keys.json, and a machine without it must still get the line). The two
// answers that matter are pinned here: Herdr's own file is merged, never invented, because
// a keys.json written before the app's first start becomes the person's whole key map; and
// the argv the installer writes names a file that is really there afterwards — on Windows
// the `.cmd` shim, which is the only spelling Windows can start.
//
// Run it when the plan's config directory is the one this host resolves: the mapping from
// HOME to `~/.config/herdr-app` is install-lib's answer, so the test asks for it instead of
// typing a path that is only right on Linux.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { homePaths, planFor } from '../../scripts/install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'alt-shift-n';
const LINE = `new durable space: ${KEY} (or: space new <name>)`;

function envFor(home, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_AGENT_DIR: path.join(home, '.pi', 'agent'),
		PI_SKIP_NETWORK: '1',
		PI_SKIP_PREREQS: '1',
		PI_SKIP_SYSTEMD: '1',
		PI_ALLOW_MISSING_PI: '1',
		...extra,
	};
	for (const name of [
		'PI_DRY_RUN',
		'PI_PLATFORM',
		'PI_ENABLE_SERVICES',
		'PI_GIT_BASH',
		'HERDR_MODS',
		'XDG_CONFIG_HOME',
		'GIT_CONFIG_GLOBAL',
		'GIT_CONFIG_SYSTEM',
	]) {
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
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-durable-key-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

/** The paths the installer itself resolves for this HOME and this platform. */
function paths(home) {
	const plan = planFor(process.platform, envFor(home));
	return homePaths({ home, agentDir: path.join(home, '.pi', 'agent'), plan });
}

const keysFile = (home) => path.join(paths(home).herdrConfigDir, 'keys.json');

function writeKeys(home, value) {
	const file = keysFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
	return file;
}

const readText = (file) => fs.readFileSync(file, 'utf8');

test('a HOME without keys.json gets the line, and no invented key map', (t) => {
	const home = tempHome(t);
	const run = install(home);
	assert.equal(run.status, 0, run.stderr);
	assert.ok(run.stdout.includes(LINE), `the install line is missing:\n${run.stdout}`);
	// Herdr rewrites only a keys file whose bytes are a shipped original, so a file we
	// wrote first would delete every shortcut it does not mention. Not written is the answer.
	assert.equal(fs.existsSync(keysFile(home)), false, 'no keys.json exists yet, so none is written');
	assert.match(run.stdout, /keys\.json: not there yet/);
});

test('an existing keys.json gets the key, and its other keys survive', (t) => {
	const home = tempHome(t);
	const shipped = {
		global: { 'ctrl-shift-t': 'tab.new', 'ctrl-shift-p': 'app.palette' },
		terminal: { 'ctrl-shift-c': 'terminal.copy' },
	};
	const file = writeKeys(home, shipped);

	const run = install(home);
	assert.equal(run.status, 0, run.stderr);
	assert.ok(run.stdout.includes(LINE), `the install line is missing:\n${run.stdout}`);

	const after = JSON.parse(readText(file));
	assert.equal(after.global[KEY].command, 'terminal.open');
	assert.equal(after.global[KEY].args.place, 'tab');
	assert.deepEqual(after.global[KEY].args.argv.slice(1), ['new']);
	// The argv names the program that is really there after this install: on Windows the
	// `.cmd` shim beside the bash wrapper, everywhere else the wrapper itself.
	assert.ok(fs.existsSync(after.global[KEY].args.argv[0]), `${after.global[KEY].args.argv[0]} is not there after install`);
	assert.equal(after.global['ctrl-shift-t'], 'tab.new');
	assert.equal(after.global['ctrl-shift-p'], 'app.palette');
	assert.deepEqual(after.terminal, { 'ctrl-shift-c': 'terminal.copy' });

	// A second install is not a second change: the bytes stay, and it says so.
	const before = readText(file);
	const again = install(home);
	assert.equal(again.status, 0, again.stderr);
	assert.ok(again.stdout.includes('kept alt-shift-n'), again.stdout);
	assert.equal(readText(file), before);
});

test('a key somebody already uses is reported, not replaced', (t) => {
	const home = tempHome(t);
	const file = writeKeys(home, { global: { [KEY]: 'space.next' } });
	const before = readText(file);

	const run = install(home);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stderr, /alt-shift-n is already bound to something else/);
	assert.equal(readText(file), before);
	// The line still prints: the key is the ergonomic path, `space new <name>` is the promise.
	assert.ok(run.stdout.includes(LINE), run.stdout);
});
