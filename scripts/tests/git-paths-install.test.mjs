// A failing install-hooks.sh must not cost a git path.
//
// Why this exists: install.mjs set `core.hooksPath` from node after the shell
// script, but `init.templateDir` only in the branch where bash was missing
// entirely. The shell script fails partway in the pi sandbox — it writes the
// template layer before anything else, and `~/.git-templates` is bound read-only
// there — so the one place this matters was the one path that skipped the fix.
// docs/install.md then told the reader to run a command by hand to repair it.
//
// This test runs the real engine in a throwaway HOME where the template write
// cannot work, and asserts both keys are set anyway. It checks the script really
// fails in that layout first, so a green run cannot mean "the script succeeded".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function envFor(home) {
	const env = { ...process.env, HOME: home, PI_SKIP_NETWORK: '1', PI_SKIP_SYSTEMD: '1', PI_ALLOW_MISSING_PI: '1' };
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_GIT_HOOKS_DIR', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
		delete env[name];
	}
	return env;
}

function gitConfig(home, key) {
	const r = spawnSync('git', ['config', '--global', '--get', key], { env: envFor(home), encoding: 'utf8' });
	return (r.stdout || '').trim();
}

test('a failing install-hooks.sh still leaves both git paths set', { skip: process.platform === 'win32' }, (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-git-paths-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	// A regular file where the template directory goes: `mkdir -p` inside
	// git-hooks/install-hooks.sh fails with "Not a directory" and set -e ends the
	// script — the same shape as the read-only bind in the sandbox, and it works
	// for root too, where a chmod 0444 directory would not.
	fs.writeFileSync(path.join(home, '.git-templates'), 'not a directory\n');
	const env = envFor(home);

	const installer = spawnSync('bash', [path.join(ROOT, 'git-hooks', 'install-hooks.sh')], { env, encoding: 'utf8' });
	assert.notEqual(installer.status, 0, `install-hooks.sh was expected to fail in this layout:\n${installer.stdout}${installer.stderr}`);

	const run = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], { env, encoding: 'utf8', cwd: ROOT });
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${run.stdout}${run.stderr}`);

	assert.equal(gitConfig(home, 'core.hooksPath'), path.join(home, '.pi', 'git-hooks'));
	assert.equal(gitConfig(home, 'init.templateDir'), path.join(home, '.git-templates'));
	// The failed template write left its placeholder alone, so the two keys above
	// were set by node, not by the script finishing.
	assert.equal(fs.statSync(path.join(home, '.git-templates')).isFile(), true);
});

test('a second run over that HOME is still 0 changes', { skip: process.platform === 'win32' }, (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-git-paths-twice-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const env = envFor(home);
	const once = (n) => {
		const r = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], { env, encoding: 'utf8', cwd: ROOT });
		assert.equal(r.status, 0, `run ${n} exited ${r.status}:\n${r.stdout}${r.stderr}`);
		return r.stdout;
	};
	once(1);
	// A HOME an older installer already put the pane map in: dropping it is a
	// cleanup, not a change this run wrote — the copy skips state files, so the
	// count has to stay 0 and the file has to be gone.
	const state = path.join(home, '.pi', 'scripts', '.agent-panes.json');
	fs.writeFileSync(state, '{}\n');
	assert.match(once(2), /== done — 0 change\(s\) written/);
	assert.equal(fs.existsSync(state), false, 'the agent-pane map was carried into the new HOME');
});
