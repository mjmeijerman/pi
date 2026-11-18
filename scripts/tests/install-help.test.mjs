// The help text and the parser have to be the same table, or the docs drift.
//
// Why this exists: setup.mjs used to print the first 42 lines of its own header
// comment as `--help`, so a flag added to the parser and not to that comment was
// a flag nobody could find — and docs/install.md, written from the help text,
// would have named a flag that did nothing. So the parser reads ENGINE_FLAGS
// (scripts/install-lib.mjs), `--help` renders the same table, and this test
// fails the day an entry has no help line or a printed flag is not accepted.
//
// Cheap on purpose: no network, no model, two child processes that print and
// exit 0 before touching a file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ENGINE_FLAGS, helpText, parseFlags } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENGINES = ['install', 'setup'];

test('every flag the parser accepts has a help line', () => {
	for (const engine of ENGINES) {
		for (const entry of ENGINE_FLAGS[engine]) {
			assert.ok(entry.help && entry.help.trim().length > 8, `${engine} ${entry.names.join('/')} has no help text`);
			assert.ok(entry.key, `${engine} ${entry.names.join('/')} sets no option`);
		}
	}
});

test('help text names every flag, and only flags the parser accepts', () => {
	for (const engine of ENGINES) {
		const printed = helpText(engine);
		for (const entry of ENGINE_FLAGS[engine]) {
			for (const name of entry.names) {
				assert.ok(printed.includes(name), `--help for ${engine} does not print ${name}`);
				// The same names, handed back to the parser, are accepted.
				const argv = name.endsWith('=') ? [`${name}x`] : [name];
				assert.doesNotThrow(() => parseFlags(engine, argv), `--help prints ${name}, the parser rejects it`);
			}
		}
	}
});

test('parseFlags: defaults, negation, lists and the unknown option', () => {
	assert.deepEqual(parseFlags('install', []), { installPi: false, dryRun: false });
	assert.equal(parseFlags('install', ['--help']).help, true);
	assert.deepEqual(parseFlags('install', ['--skills=a,b']).skills, ['a', 'b']);

	const setup = parseFlags('setup', []);
	assert.equal(setup.doApt, true, 'apt is on unless --no-apt says otherwise');
	assert.equal(setup.verify, true);
	assert.equal(setup.yes, false);
	assert.equal(parseFlags('setup', ['--no-apt']).doApt, false);
	assert.equal(parseFlags('setup', ['-y']).yes, true);
	assert.equal(parseFlags('setup', ['--rules=drop:3,4']).rules, 'drop:3,4');
	assert.deepEqual(parseFlags('setup', ['--extensions=a.ts,b']).extensions, ['a.ts', 'b']);

	assert.throws(() => parseFlags('install', ['--nope']), /unknown option: --nope/);
	assert.throws(() => parseFlags('setup', ['-x']), /unknown option: -x/);
});

test('node <engine>.mjs --help exits 0 and prints the table', () => {
	for (const engine of ENGINES) {
		const file = path.join(ROOT, `${engine}.mjs`);
		const r = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
		assert.equal(r.status, 0, `${engine}.mjs --help exited ${r.status}: ${r.stderr}`);
		assert.match(r.stdout, /^Usage: /);
		for (const entry of ENGINE_FLAGS[engine]) {
			for (const name of entry.names) assert.ok(r.stdout.includes(name), `${engine}.mjs --help does not print ${name}`);
		}
		// Nothing written: help runs before main() does.
		assert.equal(r.stderr, '', `${engine}.mjs --help wrote to stderr`);
	}
});
