// The delegation workspace arrives on a machine with no GitHub key.
//
// Why this exists: both repos are public, and stepBoss tried `gh repo clone`
// (needs auth) and then `git clone git@github.com:…` (needs a key). On a bare
// machine neither can work, and the failure was invisible for two reasons — the
// clone ran with `allowFail` so nobody read its status, and a failed `git clone`
// still creates the target directory, which the top of stepBoss reads as
// "already present". So the workspace never arrived and every later run said it
// had. The plan is pure and lives in scripts/install-lib.mjs; the order is pinned
// here, and the second half drives the real engine with a fake `git` on PATH that
// fails once after making the directory — the shape of the bug — and succeeds the
// second time only if that half-clone was removed first.
//
// Run: node --test scripts/tests/boss-clone.test.mjs  (or make scripts-test)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bossClonePlan } from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const transports = (attempts) => attempts.map((a) => a.transport);

test('bossClonePlan: https before ssh, and gh first when it is authenticated', () => {
	const anonymous = bossClonePlan({ repo: 'mjmeijerman/big-boss-pi', dir: '/home/me/big-boss-pi' });
	assert.deepEqual(transports(anonymous), ['https', 'ssh']);
	assert.deepEqual(anonymous[0].args, ['clone', 'https://github.com/mjmeijerman/big-boss-pi.git', '/home/me/big-boss-pi']);
	// The last resort is the one that needs a key, and it is named so the engine
	// can say so instead of failing in silence.
	assert.deepEqual(anonymous[1].args, ['clone', 'git@github.com:mjmeijerman/big-boss-pi.git', '/home/me/big-boss-pi']);

	const authed = bossClonePlan({ ghAuthed: true, repo: 'mjmeijerman/big-boss-pi', dir: 'x' });
	assert.deepEqual(transports(authed), ['gh', 'https', 'ssh'], 'an authenticated gh still wins');
	assert.deepEqual(authed[0].args, ['repo', 'clone', 'mjmeijerman/big-boss-pi', 'x']);
});

test('bossClonePlan: PI_SKIP_NETWORK means no attempts at all', () => {
	assert.deepEqual(bossClonePlan({ hasNetwork: false }), []);
	// Authenticated gh does not override the air gap: an offline box must not be
	// handed a command that will hang.
	assert.deepEqual(bossClonePlan({ ghAuthed: true, hasNetwork: false }), []);
});

/** A PATH entry with one executable shell script in it. */
function stub(dir, name, body) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
	return file;
}

test('a failed first attempt removes the half-clone and the next attempt runs', { skip: process.platform === 'win32' }, (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-boss-clone-'));
	t.after(() => fs.rmSync(work, { recursive: true, force: true }));
	const home = path.join(work, 'home');
	const bin = path.join(work, 'bin');
	for (const dir of [home, bin]) fs.mkdirSync(dir, { recursive: true });
	const countFile = path.join(work, 'clone-count');
	const logFile = path.join(work, 'clone-log');

	// The real git answers `git config`; only `clone` is faked. A failed clone
	// leaves a directory behind exactly as git does: `mkdir -p "$target"` first,
	// then the fatal line and a non-zero exit.
	const realGit = path.join(work, 'real-git');
	stub(
		work,
		'real-git',
		`exec ${JSON.stringify(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim())} "$@"\n`,
	);
	stub(
		bin,
		'git',
		`if [ "$1" = clone ]; then
	echo "$*" >> ${JSON.stringify(logFile)}
	for target; do :; done
	# Real git refuses a destination that is already there, which is what makes
	# the next assertion prove the half-clone was removed rather than reused.
	if [ -e "$target" ]; then
		echo "fatal: destination path '$target' already exists and is not an empty directory." >&2
		exit 128
	fi
	mkdir -p "$target"
	n=$(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0)
	n=$((n + 1))
	echo "$n" > ${JSON.stringify(countFile)}
	if [ "$n" -eq 1 ]; then
		echo half-cloned > "$target/half-clone.txt"
		echo 'fatal: could not read from remote repository' >&2
		exit 1
	fi
	mkdir -p "$target/bin"
	for name in jev delegate local-run; do
		printf '#!/bin/sh\\nexit 0\\n' > "$target/bin/$name"
		chmod +x "$target/bin/$name"
	done
	exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`,
	);
	// `gh` present but not authenticated, and no curl: the vendor download must
	// not reach the network in a test.
	stub(bin, 'gh', 'exit 1\n');
	stub(bin, 'curl', 'exit 1\n');

	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		PI_SKIP_SYSTEMD: '1',
		PI_ALLOW_MISSING_PI: '1',
	};
	for (const name of ['PI_SKIP_NETWORK', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_BOSS_DIR', 'BOSS_REPO', 'USERPROFILE']) delete env[name];

	const run = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], { env, encoding: 'utf8', cwd: ROOT });
	const out = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `install.mjs exited ${run.status}:\n${out}`);

	const attemptLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
	const attempts = attemptLog.split('\n').filter(Boolean);
	assert.equal(attempts.length, 2, `expected two clone attempts, got:\n${attemptLog}`);
	assert.match(attempts[0], /^clone https:\/\/github\.com\//, 'the first attempt is https, not ssh');
	assert.match(attempts[1], /^clone git@github\.com:/, 'ssh is only reached after the https attempt failed');

	const workspace = path.join(home, 'big-boss-pi');
	assert.equal(fs.existsSync(path.join(workspace, 'half-clone.txt')), false, 'the half-clone that made the first attempt fail was not removed');
	assert.equal(fs.existsSync(path.join(workspace, 'bin', 'jev')), true, 'the second attempt did not land');
	assert.match(out, /big-boss-pi cloned via ssh/, 'the installer does not name the transport that worked');
	// The last resort says why it is the last resort, so a reader on a bare
	// machine knows a key is the ask and https is the no-key path.
	assert.match(out, /over SSH needs a GitHub key/);
});
