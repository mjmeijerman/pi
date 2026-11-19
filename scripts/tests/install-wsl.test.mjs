// The WSL path, run end to end.
//
// Why this exists: a Windows machine running pi inside WSL is the recommended
// sandbox path, and it is the one host the installer cannot recognise from
// `process.platform` — that says `linux`, correctly, because WSL2 has a real
// kernel. So the detection is a function of the environment and the kernel
// release (scripts/install-lib.mjs, `isWsl`), and these tests drive the real
// engine with a throwaway HOME and the variables a WSL shell exports. A dry run
// is enough: what is under test is the plan and the lines, not the writes.
//
// The second test is the warning that only exists in WSL: a path on a Windows
// drive. It is planted through PI_AGENT_DIR, which the engine reads, and the
// quiet case runs the same way with the agent dir under the throwaway HOME.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// The variables a WSL2 shell exports. WSL_INTEROP is WSL2-only; WSL_DISTRO_NAME
// is set in both generations, which is why the kernel release is checked too.
const WSL_ENV = { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/8_interop' };

function envFor(home, extra = {}) {
	const env = { ...process.env, HOME: home, PI_SKIP_NETWORK: '1', PI_SKIP_SYSTEMD: '1', PI_ALLOW_MISSING_PI: '1', ...WSL_ENV, ...extra };
	// Inherited from the host that runs the suite: either one would decide the
	// platform before the test does.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_PLATFORM', 'PI_BOSS_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) delete env[name];
	return env;
}

function dryRun(home, extra = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), '--dry-run'], {
		env: envFor(home, extra),
		encoding: 'utf8',
		cwd: ROOT,
	});
}

function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wsl-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

test('a WSL shell takes the Linux path, says WSL, and never calls the sandbox unavailable', { skip: process.platform !== 'linux' }, (t) => {
	const home = tempHome(t);
	const run = dryRun(home);
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);

	// The plan is the Linux one: the summary line is where a person reads it.
	assert.match(run.stdout, /system : linux \(WSL, sandbox available\)/, `no WSL flag in the summary:\n${run.stdout}`);
	// And the sandbox is pointed at, not disclaimed. This is the sentence the
	// spec exists for: on Windows `pi` printed "sandbox unavailable" and ran bare.
	assert.doesNotMatch(out, /unavailable on this OS/, `the sandbox is disclaimed inside WSL:\n${out}`);
	assert.doesNotMatch(out, /sandbox unavailable/, `the sandbox is disclaimed inside WSL:\n${out}`);
	assert.match(run.stdout, /sandbox/, 'the summary does not mention the sandbox at all');
});

test('a repo or agent dir on /mnt/c is warned about, by name; one under ~/ is silent', { skip: process.platform !== 'linux' }, (t) => {
	const home = tempHome(t);
	const mount = path.join('/mnt/c', 'Users', 'me', '.pi', 'agent');

	const loud = dryRun(home, { PI_AGENT_DIR: mount });
	const loudOut = `${loud.stdout}${loud.stderr}`;
	assert.equal(loud.status, 0, `install.mjs exited ${loud.status} with a /mnt/c agent dir:\n${loudOut}`);
	assert.match(loudOut, /\/mnt\/c\/Users\/me\/\.pi\/agent/, `the warning does not name the path:\n${loudOut}`);
	assert.match(loudOut, /Windows drive/, 'the warning does not say what is wrong with it');
	assert.match(loudOut, /move .*under ~\//, 'the warning does not name the fix');
	// A warning, not a stop: the install still printed its summary.
	assert.match(loud.stdout, /system : linux \(WSL, sandbox available\)/);

	const quiet = dryRun(home);
	assert.equal(quiet.status, 0);
	assert.doesNotMatch(`${quiet.stdout}${quiet.stderr}`, /Windows drive/, 'the warning fired on a path under ~/');
});
