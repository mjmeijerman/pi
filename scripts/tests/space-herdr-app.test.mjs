// `space new` opens a space, and a test must never be the reason one appears.
//
// Two faults, one file:
//
// 1. The leak. `bin/space` resolved the app with `command -v herdr-app` and had no override, so a
//    test handing its child a throwaway HOME still talked to the REAL app on the user's PATH.
//    `space new` opened a real space, the record landed in the temp HOME and died with it, and the
//    space stayed — named `harness`, on a deleted folder, owned by nothing. Four test files did it
//    (install-win-herdr-guard, install-win-space, space-state-root, prereqs); install-space.test.mjs
//    leaked nothing because it already put a stub on PATH. The fix is the override `bin/guard`
//    already reads, PI_GUARD_HERDR_APP, resolved before PATH — so a stub answers and the real app
//    is unreachable instead of merely outrun.
//
// 2. The focus grab. The app shows a new space at once unless it is told `--focus false`
//    (`herdr-app commands`: "with no space shown, the new space is shown"), so `bin/space new` and
//    every test running it moved the person's view mid-run. `bin/guard` already passes the flag on
//    every `space.new` and `tab.new`; `bin/space` did not.
//
// These tests pin the argv, the count, and the refusal — not the prose.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { calls, pathWithoutHerdr, stubHerdrApp, withStub } from './herdr-app-stub.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SPACE = path.join(ROOT, 'bin', 'space');
const TEMPLATE = path.join(ROOT, 'agent', 'space-rules.md');

function tempHome(t, prefix = 'pi-space-focus-') {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

/** cleanEnv — a HOME, no variable that would decide the state root or the platform first. */
function cleanEnv(home, extra = {}) {
	const env = { ...process.env, HOME: home, ...extra };
	for (const name of ['USERPROFILE', 'PI_HOME', 'PI_SPACE_ROOT', 'SPACE_STATE', 'PI_SPACE_RULES_TEMPLATE', 'PI_PLATFORM', 'PI_DRY_RUN']) {
		if (!(name in extra)) delete env[name];
	}
	return env;
}

/**
 * spaceRun — `bin/space` with the arguments, env and cwd a person would give it.
 *
 * On Windows the file is a bash program and CreateProcess reads no shebang, so it is started the
 * way the installer starts it: through bash. On Linux and macOS the entry runs itself.
 */
function spaceRun(args, env, cwd) {
	const run = process.platform === 'win32' ? spawnSync('bash', [SPACE, ...args], { cwd, env, encoding: 'utf8' }) : spawnSync(SPACE, args, { cwd, env, encoding: 'utf8' });
	return { ...run, out: `${run.stdout || ''}${run.stderr || ''}` };
}

/** install — the real engine, into a throwaway HOME. */
function install(home, env) {
	const run = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], {
		cwd: ROOT,
		env: {
			...env,
			PI_SKIP_NETWORK: '1',
			PI_SKIP_SYSTEMD: '1',
			PI_SKIP_PREREQS: '1',
			PI_ALLOW_MISSING_PI: '1',
		},
		encoding: 'utf8',
	});
	return { ...run, out: `${run.stdout}${run.stderr}` };
}

/** A project folder and the state root a test may write, both inside the temp home. */
function sandbox(t, home) {
	const project = path.join(home, 'project');
	fs.mkdirSync(project, { recursive: true });
	return { project, state: path.join(home, 'state'), record: (slug) => path.join(home, 'state', 'spaces', slug, 'space.json') };
}

test('space new opens the space with --focus false, and the app it asks is the stub', (t) => {
	const home = tempHome(t);
	const box = sandbox(t, home);
	const stub = stubHerdrApp(home);
	const env = withStub(cleanEnv(home, { SPACE_STATE: box.state, PI_SPACE_RULES_TEMPLATE: TEMPLATE }), stub);

	const made = spaceRun(['new', 'demo', '--project', box.project, '--no-git', '--kind', 'project'], env, home);
	assert.equal(made.status, 0, `space new failed:\n${made.out}`);
	assert.ok(fs.existsSync(box.record('demo')), `no record at ${box.record('demo')}:\n${made.out}`);

	// The argv, not the exit status: the space is opened one way and the app is told not to take
	// the keyboard. `--focus false` is what keeps the shown space the shown space.
	const opened = calls(stub).filter((line) => line.startsWith('do space.new'));
	assert.equal(opened.length, 1, `the stub was asked ${opened.length} times, not once: ${JSON.stringify(calls(stub))}`);
	assert.ok(opened[0].includes('--focus false'), `space.new was called without --focus false: ${opened[0]}`);
	assert.ok(opened[0].includes('--name demo'), `space.new was called without the name: ${opened[0]}`);

	// The read path honours the same override: `list` may not talk to the real app either.
	const listed = spaceRun(['list'], env, home);
	assert.equal(listed.status, 0, listed.out);
	assert.ok(calls(stub).some((line) => line === 'ls' || line.startsWith('ls ')), `bin/space list did not ask the stub: ${JSON.stringify(calls(stub))}`);
	assert.match(listed.stdout, /^demo\b/m, `the record is not listed:\n${listed.stdout}`);
});

test('the override decides, even with the real app on PATH and the stub on none', (t) => {
	const home = tempHome(t);
	const box = sandbox(t, home);
	const stub = stubHerdrApp(home);
	// The old resolution — `command -v herdr-app` — is left intact here on purpose. It is the
	// bug: with the real app first on PATH, only an override can explain the stub being asked.
	const env = cleanEnv(home, {
		SPACE_STATE: box.state,
		PI_SPACE_RULES_TEMPLATE: TEMPLATE,
		PI_GUARD_HERDR_APP: stub.app,
	});

	const made = spaceRun(['new', 'override', '--project', box.project, '--no-git', '--kind', 'project'], env, home);
	assert.equal(made.status, 0, `space new failed:\n${made.out}`);
	const opened = calls(stub).filter((line) => line.startsWith('do space.new'));
	assert.equal(opened.length, 1, `the override was not the app that was asked: ${JSON.stringify(calls(stub))}`);
	assert.ok(opened[0].includes('--focus false'), opened[0]);
	// And the stub is nowhere on PATH, so nothing but the override could have found it.
	const onPath = (env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'herdr-app')));
	assert.equal(onPath, false, 'the stub directory is on PATH, so this case proves nothing');
});

test('with no app at all nothing is recorded, and the refusal names the command to run', (t) => {
	const home = tempHome(t);
	const box = sandbox(t, home);
	const env = cleanEnv(home, { SPACE_STATE: box.state, PI_SPACE_RULES_TEMPLATE: TEMPLATE, PATH: pathWithoutHerdr(process.env.PATH || '') });

	const made = spaceRun(['new', 'noapp', '--project', box.project, '--no-git', '--kind', 'project'], env, home);
	assert.equal(made.status, 1, `space new with no app exited ${made.status}:\n${made.out}`);
	// Nothing is recorded and no folder is made: the person can run the command later and lose
	// nothing, which is the whole reason the refusal comes before the write.
	assert.equal(fs.existsSync(path.join(box.state, 'spaces', 'noapp')), false, 'a record folder was made with no app to open the space in');
	// The by-hand line is the one that would have run, focus flag and all.
	assert.match(made.out, /herdr-app is not on PATH/, made.out);
	assert.match(made.out, /herdr-app do space\.new --name noapp .*--focus false/, made.out);
});

test('a second install over the record present asks no app at all, so the count cannot move', (t) => {
	const home = tempHome(t);
	const stub = stubHerdrApp(home);
	const env = withStub(cleanEnv(home), stub);

	const first = install(home, env);
	assert.equal(first.status, 0, `the first install failed:\n${first.out}`);
	assert.ok(fs.existsSync(path.join(home, '.pi', 'state', 'spaces', 'harness', 'space.json')), `no harness record:\n${first.out}`);
	const afterFirst = calls(stub).filter((line) => line.startsWith('do space.new'));
	assert.equal(afterFirst.length, 1, `the install opened ${afterFirst.length} spaces, not one: ${JSON.stringify(calls(stub))}`);
	assert.ok(afterFirst[0].includes('--focus false'), `the install's space step grabbed focus: ${afterFirst[0]}`);

	// The count is the claim: a run with the record in place must not ask the app for a space.
	const before = calls(stub).length;
	const second = install(home, env);
	assert.equal(second.status, 0, `the second install failed:\n${second.out}`);
	assert.equal(
		calls(stub).filter((line) => line.startsWith('do space.new')).length,
		afterFirst.length,
		`the second install opened another space: ${JSON.stringify(calls(stub).slice(before))}`,
	);
	assert.match(second.out, /^== space harness: recorded for .*left as it is$/m, `the second run did not say it left the record alone:\n${second.out}`);
});
