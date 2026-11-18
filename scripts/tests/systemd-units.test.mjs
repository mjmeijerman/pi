// The timers have to arrive with the units they name.
//
// Why this exists: install.mjs carried a hard-coded list of three files —
// `pi-evals.timer`, `pi-retro.timer`, `herdr-resume.service` — while
// systemd/pi-evals.timer:17 says `Unit=pi-evals.service` and
// systemd/pi-retro.timer:16 says `Unit=pi-retro.service`. So an enabled timer
// pointed at a unit that was never copied, and the fix for it lived in
// docs/install.md as "run `make evals-install` once", which is a workaround
// pretending to be a release note.
//
// The list is now read off systemd/ (systemdUnitsIn in scripts/install-lib.mjs),
// so a fifth unit is copied the day it lands. These tests read the real
// directory and the real engine: a timer naming a unit the installer would not
// copy is a red test, not a sentence in the docs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { systemdUnitsIn } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SYSTEMD = path.join(ROOT, 'systemd');

/** timerTargets — every `Unit=` a timer names, with the timer it was read from. */
function timerTargets(units) {
	const out = [];
	for (const unit of units.filter((u) => u.name.endsWith('.timer'))) {
		for (const match of unit.text.matchAll(/^Unit=(.+)$/gm)) out.push({ timer: unit.name, target: match[1].trim() });
	}
	return out;
}

test('every unit a copied timer names is itself copied', () => {
	const units = systemdUnitsIn(SYSTEMD, fs);
	const copied = new Set(units.map((u) => u.name));
	const dangling = timerTargets(units).filter((t) => !copied.has(t.target));
	assert.deepEqual(
		dangling,
		[],
		`a timer names a unit the installer would not copy: ${dangling.map((t) => `${t.timer} -> ${t.target}`).join(', ')}`,
	);
	assert.ok(timerTargets(units).length >= 2, 'no timer in systemd/ names a Unit= — the check read nothing');
});

test('the plan is every unit file in systemd/, sorted', () => {
	const onDisk = fs
		.readdirSync(SYSTEMD)
		.filter((name) => /\.(service|timer)$/.test(name))
		.sort();
	assert.deepEqual(
		systemdUnitsIn(SYSTEMD, fs).map((u) => u.name),
		onDisk,
	);
});

test('timers are enabled --now, herdr-resume.service without --now, timer services never', () => {
	const units = new Map(systemdUnitsIn(SYSTEMD, fs).map((u) => [u.name, u]));
	for (const [name, unit] of units) {
		if (name.endsWith('.timer')) {
			assert.equal(unit.enable, true, `${name} must be enabled`);
			assert.equal(unit.now, true, `${name} must be enabled --now`);
		} else if (name === 'herdr-resume.service') {
			assert.equal(unit.enable, true, 'herdr-resume.service must be enabled');
			assert.equal(unit.now, false, 'herdr-resume.service must not be started by the installer');
		} else {
			// A oneshot behind a timer: no [Install] section, so `systemctl
			// enable` would fail with "no installation config" — the timer's
			// Unit= starts it. Copied, not enabled, and still counted.
			assert.equal(unit.enable, false, `${name} has no [Install] section and cannot be enabled`);
			assert.ok(units.has(name), `${name} must be in the plan`);
		}
	}
});

test('install.mjs names no unit itself — the list comes from systemd/', () => {
	const src = fs.readFileSync(path.join(ROOT, 'install.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
	for (const name of fs.readdirSync(SYSTEMD)) {
		assert.ok(!src.includes(name), `install.mjs hard-codes ${name} again; read it off systemd/ instead`);
	}
	assert.ok(/systemdUnitsIn\(/.test(src), 'install.mjs does not derive the unit list with systemdUnitsIn');
});

test('the dangling-target check bites: a timer naming a missing unit is reported', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-systemd-units-'));
	try {
		fs.writeFileSync(
			path.join(dir, 'fifth.timer'),
			'[Timer]\nOnCalendar=daily\nUnit=fifth.service\n\n[Install]\nWantedBy=timers.target\n',
		);
		const units = systemdUnitsIn(dir, fs);
		const copied = new Set(units.map((u) => u.name));
		const dangling = timerTargets(units).filter((t) => !copied.has(t.target));
		assert.deepEqual(dangling, [{ timer: 'fifth.timer', target: 'fifth.service' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
