// A fresh install must not leave the pi repo dirty.
//
// `~/.pi` is a git clone, and the wizard writes its answers to
// `~/.pi/state/setup.json`. No rule in `.gitignore` covered that folder, so the
// first `git status` after a fresh Windows install showed an untracked `state/`
// — one line to fix today, and a class to stop: anything the installer or the
// wizard writes into the home as machine state has to be ignored, and a write
// that is not must be noticed here rather than by the next person who runs
// `git status` and wonders whose folder it is.
//
// Shape: a throwaway HOME whose `.pi` is a real git repo of this checkout, then
// the real `install.mjs` and the real `setup.mjs --yes --no-keys --rules=all`
// into it with `PI_SKIP_NETWORK=1 PI_SKIP_PREREQS=1 PI_ALLOW_MISSING_PI=1`, then
// `git status`. Anything that comes out untracked is machine state with no rule,
// and the failure names every path at once — a guard that names one path per run
// costs one CI round per path.
//
// The tracked files are copied from the working tree (`git ls-files -s`), not
// from HEAD with `git archive`: the guard has to be red on the `.gitignore` line
// a person just deleted, and `git archive` would answer about the last commit
// instead. Modes come from the index, because the install runs `chmod 755` on
// some of these and a copy that lost the bit would look like a write.
//
// Only `??` lines fail. The install rewrites the tracked `git-hooks/*` wrappers
// on purpose — each carries the absolute `HOOKS_HOME` of the machine that
// generated it — and that is a dirty *tracked* file, a different question from
// "machine state nobody ignored". Paths outside the repo (`~/.local/bin`,
// `~/.config`, `~/.git-templates`, the workspace clone) are outside the repo on
// a real machine too, so they are not this test's business.
//
// One consequence to know before debugging it: the install copies this
// checkout's `scripts/` and `sandbox/` into the home, so an untracked file left
// in either of those is copied too and named in the failure. The fix there is to
// commit it or move it out, not to add an ignore rule.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function git(cwd, args) {
	const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
	assert.equal(out.status, 0, `git ${args.join(' ')} failed in ${cwd}:\n${out.stdout}${out.stderr}`);
	return out.stdout;
}

/** trackedCopy — every tracked file, as it is on disk, at its index mode. */
function trackedCopy(dest) {
	const entries = git(ROOT, ['ls-files', '-s', '-z']).split('\0').filter(Boolean);
	for (const entry of entries) {
		const tab = entry.indexOf('\t');
		const mode = entry.slice(0, tab).split(' ')[0];
		const rel = entry.slice(tab + 1);
		const to = path.join(dest, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), to);
		fs.chmodSync(to, mode === '100755' ? 0o755 : 0o644);
	}
}

function envFor(home) {
	const env = {
		...process.env,
		// Both spellings: node reads USERPROFILE on Windows, git and the POSIX
		// tools read HOME.
		HOME: home,
		USERPROFILE: home,
		PI_AGENT_DIR: path.join(home, '.pi', 'agent'),
		PI_SKIP_NETWORK: '1',
		PI_SKIP_PREREQS: '1',
		PI_ALLOW_MISSING_PI: '1',
	};
	// Each of these would decide the answer before the install does, or aim a
	// write at the person's own config instead of the throwaway home.
	for (const name of [
		'PI_DRY_RUN',
		'PI_PLATFORM',
		'PI_ENABLE_SERVICES',
		'PI_SKIP_SYSTEMD',
		'PI_GIT_BASH',
		'PI_BOSS_DIR',
		'BOSS_REPO',
		'HERDR_MODS',
		'XDG_CONFIG_HOME',
		'XDG_DATA_HOME',
		'GIT_CONFIG_GLOBAL',
	]) {
		delete env[name];
	}
	return env;
}

const run = (script, args, cwd, env) =>
	spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd, env, encoding: 'utf8' });

test('the install and the wizard leave nothing untracked in the home', (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-clean-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));

	// The clone as a person gets it: this repo, and a git history holding it.
	const piHome = path.join(home, '.pi');
	trackedCopy(piHome);
	git(piHome, ['init', '-q', '.']);
	git(piHome, ['add', '-A']);
	git(piHome, ['-c', 'user.name=pi', '-c', 'user.email=pi@example.com', 'commit', '-qm', 'the clone as the person gets it']);

	// The two engines, one after the other, exactly as `setup.sh` runs them. The
	// whole point is a real run: a mocked one would not write the file that was
	// missing a rule.
	const env = envFor(home);
	const install = run('install.mjs', [], piHome, env);
	assert.equal(install.status, 0, `install.mjs failed:\n${install.stdout}${install.stderr}`);
	const setup = run('setup.mjs', ['--yes', '--no-keys', '--rules=all'], piHome, env);
	assert.equal(setup.status, 0, `setup.mjs failed:\n${setup.stdout}${setup.stderr}`);

	// The wizard's own file is the case that was reported: it has to be there
	// (otherwise this test passes by writing nothing) and it has to be ignored.
	const stateFile = path.join(piHome, 'state', 'setup.json');
	assert.ok(fs.existsSync(stateFile), `the wizard wrote no ${stateFile} — this test would pass vacuously`);
	const ignored = spawnSync('git', ['check-ignore', '-q', 'state/setup.json'], { cwd: piHome });
	assert.equal(ignored.status, 0, 'state/setup.json is not ignored — the answers are machine state, not harness code');

	// `--untracked-files=all`, so a folder is reported as the files in it: the
	// message then says which file needs a rule without a second run.
	const untracked = git(piHome, ['status', '--porcelain', '--untracked-files=all'])
		.split('\n')
		.filter((line) => line.startsWith('?? '))
		.map((line) => line.slice(3));
	assert.deepEqual(
		untracked,
		[],
		`the install wrote ${untracked.length} path(s) into the home that .gitignore does not cover: ${untracked.join(', ')} — ` +
			'add a rule for the folder to .gitignore, with a comment saying what it is',
	);
});
