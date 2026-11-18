// One file owns the node major: mise.toml (Radar Vol. 35 blip 68, mise, Adopt).
//
// The claim under test is "the number setup.mjs prints comes from mise.toml", so
// every case writes a throwaway mise.toml and runs the real functions from
// scripts/install-lib.mjs — the ones setup.mjs calls — then reads the message
// that was actually produced. A grep for the string "24" would be satisfied by a
// comment while the die still printed a hardcoded 24.
//
// This replaced scripts/tests/mise-pin.test.sh when the installer moved from
// bash to Node: the old test spliced lines 1..N out of setup.sh and ran them with
// a fake `node` on PATH, and there is no such block to splice any more. What it
// pinned is unchanged — one source for the number, the same two messages, and the
// same fallback for a tree with no mise.toml.
//
// Cheap on purpose: no network, no model, no mise, temp dirs under one mkdtemp.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { nodePreflight, pinnedNodeMajor } from '../install-lib.mjs';

const MADE = [];

function tree(miseToml, { readable = true } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pin-'));
	MADE.push(dir);
	if (miseToml !== null) {
		const file = path.join(dir, 'mise.toml');
		fs.writeFileSync(file, miseToml);
		if (!readable) fs.chmodSync(file, 0o000);
	}
	return dir;
}

function pinOf(miseToml, options) {
	const root = tree(miseToml, options);
	return pinnedNodeMajor(root, fs.readFileSync);
}

test.after(() => {
	for (const dir of MADE) {
		try {
			for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o644);
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* a temp dir the platform will not release is not a test failure */
		}
	}
});

test('pin 24, node v22.1.0: the warn names the pinned major', () => {
	const pin = pinOf('[tools]\nnode = "24"\nnpm = "11"\n');
	assert.equal(pin, 24);
	const v = nodePreflight({ pin, nodeVersion: 'v22.1.0', nodeMajor: 22 });
	assert.equal(v.level, 'warn');
	assert.match(v.message, /older than 24/);
	assert.match(v.message, /pi 1\.5\.x expects 24 or 26/);
});

test('pin 26: the warn follows mise.toml, not the old literal', () => {
	const v = nodePreflight({ pin: pinOf('[tools]\nnode = "26"\n'), nodeVersion: 'v22.1.0', nodeMajor: 22 });
	assert.match(v.message, /older than 26/);
	assert.doesNotMatch(v.message, /older than 24/);
});

test('pin 26, no node at all: the die text follows mise.toml', () => {
	const v = nodePreflight({ pin: pinOf('[tools]\nnode = "26"\n'), nodeVersion: undefined, nodeMajor: undefined });
	assert.equal(v.level, 'die');
	assert.equal(v.message, 'node is not installed (pi needs Node 26 or newer)');
});

test('pin 24, node 26: silent when node is new enough', () => {
	const v = nodePreflight({ pin: pinOf('[tools]\nnode = "24"\n'), nodeVersion: 'v26.0.0', nodeMajor: 26 });
	assert.equal(v.level, 'ok');
	assert.doesNotMatch(v.message, /older than/);
});

test('a point release pins its major', () => {
	assert.equal(pinOf('[tools]\n# no npm entry: a one-tool mise.toml still pins node\nnode = "25.1.0"'), 25);
});

test('no mise.toml: the fallback is the old literal 24', () => {
	assert.equal(pinOf(null), 24);
	assert.equal(
		nodePreflight({ pin: 24, nodeVersion: undefined, nodeMajor: undefined }).message,
		'node is not installed (pi needs Node 24 or newer)',
	);
	assert.equal(nodePreflight({ pin: 24, nodeVersion: 'v22.1.0', nodeMajor: 22 }).message, 'node v22.1.0 is older than 24; pi 1.5.x expects 24 or 26');
});

test('a non-numeric pin falls back to 24', () => {
	assert.equal(pinOf('[tools]\nnode = "twenty-four"\n'), 24);
});

test('an unreadable mise.toml falls back to 24', () => {
	const pin = pinOf('[tools]\nnode = "26"\n', { readable: false });
	assert.equal(pin, process.getuid && process.getuid() === 0 ? 26 : 24);
});
