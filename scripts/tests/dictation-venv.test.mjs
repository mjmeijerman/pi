// The dictation venv, built without the 2.5 GB download.
//
// Why this exists: setup.mjs created the venv and stopped. The bash installer it
// replaced ran `venv/bin/pip install --quiet -r requirements.lock` afterwards
// (`git show 665bfe2:setup.sh`), so the port shipped a fresh machine an empty
// venv, `agent/extensions/dictation.ts` failed at runtime, and the next run said
// "dictation venv already exists" and never repaired it.
//
// Three things are pinned here, with stub `python3` and `pip` binaries on a PATH
// this file builds — no network, no wheels, no python3.13 on the host:
//
//   1. the pip step exists at all: the `-r requirements.lock` line is recorded;
//   2. a venv that has python but no faster_whisper is repaired, not declared
//      done — which is the state every machine that ran the broken port is in;
//   3. a python whose minor does not match the lock warns with both numbers
//      instead of producing a venv that cannot import.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DICTATION_MODULE, DICTATION_PYTHON_MINOR, buildDictationVenv, dictationPaths, dictationStatus, pythonMinor } from '../dictation.mjs';

/**
 * fixture — a stub `python3` and a temp agent dir with a requirements.lock.
 *
 * The stub answers `-c` with $STUB_PY_MINOR and makes a venv on `-m venv`: a
 * `bin/python`, a `bin/pip` that records its own argv and, when it is handed
 * `-r`, installs faster_whisper where a real pip would. Every call is recorded,
 * so "did it run `python3 -m venv` again" is a question with an answer.
 */
function fixture(t, { pythonMinorValue = DICTATION_PYTHON_MINOR, lock = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dict-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const bin = path.join(root, 'stub-bin');
	const agentDir = path.join(root, 'agent');
	const record = path.join(root, 'record');
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(path.join(agentDir, 'dictation'), { recursive: true });
	fs.writeFileSync(record, '');
	if (lock) fs.writeFileSync(path.join(agentDir, 'dictation', 'requirements.lock'), 'faster-whisper==1.2.1\n');

	const python = path.join(bin, 'python3');
	fs.writeFileSync(
		python,
		`#!/bin/sh
printf 'python3 %s\\n' "$*" >> "$RECORD"
if [ "$1" = "-c" ]; then printf '%s\\n' "$STUB_PY_MINOR"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
	venv="$3"
	mkdir -p "$venv/bin" "$venv/lib/python$STUB_PY_MINOR/site-packages"
	: > "$venv/bin/python"
	cat > "$venv/bin/pip" <<'PIP'
#!/bin/sh
printf 'pip %s\\n' "$*" >> "$RECORD"
case "$*" in
*-r*) mkdir -p "$STUB_INSTALL_DIR/$STUB_MODULE"; : > "$STUB_INSTALL_DIR/$STUB_MODULE/__init__.py" ;;
esac
exit 0
PIP
	chmod +x "$venv/bin/pip" "$venv/bin/python"
	exit 0
fi
exit 0
`,
	);
	fs.chmodSync(python, 0o755);

	const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RECORD: record, STUB_PY_MINOR: pythonMinorValue, STUB_MODULE: DICTATION_MODULE };
	const log = { notes: [], warns: [] };
	const note = (line) => log.notes.push(line);
	const warn = (line) => log.warns.push(line);
	const lines = () => fs.readFileSync(record, 'utf8').split('\n').filter(Boolean);
	return { root, agentDir, env, log, note, warn, lines, record, bin };
}

/**
 * plantVenv — a venv that exists and has python, without the module: the state
 * every machine that ran the broken port is in. The planted pip records its
 * argv and installs the module on `-r`, like a real pip would.
 */
function plantVenv(agentDir, { minor = DICTATION_PYTHON_MINOR, withModule = false, withPip = true } = {}) {
	const paths = dictationPaths({ agentDir });
	fs.mkdirSync(paths.binDir, { recursive: true });
	fs.writeFileSync(paths.python, '');
	if (withPip)
		fs.writeFileSync(
			paths.pip,
			`#!/bin/sh
printf 'pip %s\\n' "$*" >> "$RECORD"
case "$*" in
*-r*) mkdir -p "$STUB_INSTALL_DIR/$STUB_MODULE"; : > "$STUB_INSTALL_DIR/$STUB_MODULE/__init__.py" ;;
esac
exit 0
`,
		);
	if (withPip) fs.chmodSync(paths.pip, 0o755);
	const site = path.join(paths.venv, 'lib', `python${minor}`, 'site-packages');
	fs.mkdirSync(site, { recursive: true });
	if (withModule) {
		fs.mkdirSync(path.join(site, DICTATION_MODULE), { recursive: true });
		fs.writeFileSync(path.join(site, DICTATION_MODULE, '__init__.py'), '');
	}
	return { paths, site };
}

test('a fresh machine gets a venv WITH the lock installed into it', (t) => {
	const f = fixture(t);
	const paths = dictationPaths({ agentDir: f.agentDir });
	const result = buildDictationVenv({
		agentDir: f.agentDir,
		platform: 'linux',
		env: { ...f.env, STUB_INSTALL_DIR: path.join(paths.venv, 'lib', `python${DICTATION_PYTHON_MINOR}`, 'site-packages') },
		note: f.note,
		warn: f.warn,
	});
	assert.equal(result.ok, true, `build failed: ${JSON.stringify({ notes: f.log.notes, warns: f.log.warns })}`);
	assert.deepEqual(f.log.warns, [], 'a clean build warns about nothing');
	const calls = f.lines();
	assert.ok(calls.some((l) => l.startsWith('python3 -m venv ')), `the venv is created:\n${calls.join('\n')}`);
	// The line the port dropped. Without it the venv is empty and dictation.ts
	// fails at runtime, which is the bug.
	assert.ok(
		calls.some((l) => /^pip install --quiet -r .*requirements\.lock$/.test(l)),
		`pip install -r requirements.lock must run:\n${calls.join('\n')}`,
	);
	assert.equal(dictationStatus({ agentDir: f.agentDir }).complete, true);
});

test('a venv with python but no faster_whisper is repaired, not declared done', (t) => {
	const f = fixture(t);
	const { paths, site } = plantVenv(f.agentDir);
	assert.equal(dictationStatus({ agentDir: f.agentDir }).hasPython, true);
	assert.equal(dictationStatus({ agentDir: f.agentDir }).complete, false, 'python alone is not a complete venv');

	const result = buildDictationVenv({
		agentDir: f.agentDir,
		platform: 'linux',
		env: { ...f.env, STUB_INSTALL_DIR: site },
		note: f.note,
		warn: f.warn,
	});
	assert.equal(result.ok, true, `repair failed: ${JSON.stringify(f.log.warns)}`);
	const calls = f.lines();
	// The existing venv is kept: re-creating it is the expensive half and the
	// half that was never the problem.
	assert.equal(
		calls.some((l) => l.includes('-m venv')),
		false,
		`a repair must not rebuild the venv:\n${calls.join('\n')}`,
	);
	assert.ok(calls.some((l) => /^pip install --quiet -r /.test(l)), `the repair is the pip line:\n${calls.join('\n')}`);
	assert.ok(f.log.notes.some((l) => l.startsWith('reusing the venv')), `the repair says so: ${f.log.notes.join(' | ')}`);
	assert.equal(dictationStatus({ agentDir: f.agentDir }).complete, true);
	assert.ok(fs.existsSync(path.join(site, DICTATION_MODULE)), 'the module landed where the status check looks');

	// And the second run is then quiet: complete venvs are not rebuilt.
	f.log.notes.length = 0;
	fs.writeFileSync(f.record, '');
	const again = buildDictationVenv({ agentDir: f.agentDir, platform: 'linux', env: { ...f.env, STUB_INSTALL_DIR: site }, note: f.note, warn: f.warn });
	assert.equal(again.ok, true);
	assert.deepEqual(f.lines(), [], 'a complete venv spawns nothing');
});

test('a python minor that does not match the lock warns with both numbers', (t) => {
	const f = fixture(t, { pythonMinorValue: '3.12' });
	const paths = dictationPaths({ agentDir: f.agentDir });
	buildDictationVenv({
		agentDir: f.agentDir,
		platform: 'linux',
		env: { ...f.env, STUB_INSTALL_DIR: path.join(paths.venv, 'lib', 'python3.12', 'site-packages') },
		note: f.note,
		warn: f.warn,
	});
	const warning = f.log.warns.find((l) => l.includes('3.12'));
	assert.ok(warning, `a mismatched minor must warn, warnings were: ${JSON.stringify(f.log.warns)}`);
	assert.ok(warning.includes(DICTATION_PYTHON_MINOR), `the warning names the pinned minor too: ${warning}`);
	assert.match(warning, /requirements\.lock/, 'and what carries the pin');
});

test('a venv without pip is said out loud instead of being called done', (t) => {
	const f = fixture(t);
	plantVenv(f.agentDir, { withPip: false });
	const result = buildDictationVenv({ agentDir: f.agentDir, platform: 'linux', env: f.env, note: f.note, warn: f.warn });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'no-pip');
	assert.ok(f.log.warns.some((l) => l.includes('no pip') || l.includes('is missing')), JSON.stringify(f.log.warns));
});

test('no requirements.lock means nothing to install, and it says so', (t) => {
	const f = fixture(t, { lock: false });
	const result = buildDictationVenv({ agentDir: f.agentDir, platform: 'linux', env: f.env, note: f.note, warn: f.warn });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'no-lock');
	assert.match(f.log.warns.join('\n'), /requirements\.lock/);
	assert.deepEqual(f.lines(), [], 'nothing is spawned without a lock');
});

test('--dry-run prints the commands and writes nothing', (t) => {
	const f = fixture(t);
	const result = buildDictationVenv({ agentDir: f.agentDir, platform: 'linux', env: f.env, note: f.note, warn: f.warn, dryRun: true });
	assert.equal(result.dryRun, true);
	const printed = f.log.notes.join('\n');
	assert.match(printed, /\[dry-run\] python3 -m venv /);
	assert.match(printed, /\[dry-run\] .*pip install --quiet -r .*requirements\.lock/);
	assert.deepEqual(f.lines(), [], 'a dry run spawns nothing');
	assert.equal(fs.existsSync(dictationPaths({ agentDir: f.agentDir }).venv), false);
});

test('win32 paths point at Scripts/, where a Windows venv keeps pip', (t) => {
	const f = fixture(t);
	const paths = dictationPaths({ agentDir: f.agentDir, platform: 'win32' });
	assert.equal(paths.python, path.join(paths.venv, 'Scripts', 'python.exe'));
	assert.equal(paths.pip, path.join(paths.venv, 'Scripts', 'pip.exe'));
	assert.equal(paths.sitePackages, path.join(paths.venv, 'Lib', 'site-packages'));
	// The POSIX side of the same function, for contrast.
	const posix = dictationPaths({ agentDir: f.agentDir, platform: 'linux' });
	assert.equal(posix.python, path.join(posix.venv, 'bin', 'python'));
	assert.equal(posix.pip, path.join(posix.venv, 'bin', 'pip'));
});

test('pythonMinor answers the host python, and null when there is none', () => {
	const minor = pythonMinor({ python: 'node', spawn: (file, args) => ({ status: 0, stdout: '3.13' }) });
	assert.equal(minor, '3.13');
	assert.equal(pythonMinor({ python: 'nope', spawn: () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) }), null);
	assert.equal(pythonMinor({ python: 'nope', spawn: () => ({ status: 1, stdout: '' }) }), null);
});

// --- the wiring, through setup.mjs -----------------------------------------
// The module above is only half the fix: the step has to be called from
// setup.mjs, and the win32 decision has to be taken there. These two drive the
// real entry point with --dry-run, so neither can drift back.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function setupDryRun(t, extra = {}, args = []) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dict-setup-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const env = { ...process.env, HOME: home, PI_SKIP_NETWORK: '1', PI_ALLOW_MISSING_PI: '1', PI_SKIP_PREREQS: '1', PI_SKIP_SYSTEMD: '1', ...extra };
	for (const name of ['PI_DRY_RUN', 'USERPROFILE', 'PI_PLATFORM', 'PI_AGENT_DIR', 'PI_BOSS_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) delete env[name];
	const run = spawnSync(process.execPath, [path.join(ROOT, 'setup.mjs'), '-y', '--no-keys', '--no-apt', '--no-verify', '--dry-run', ...args], {
		env: { ...env, ...extra },
		encoding: 'utf8',
		cwd: ROOT,
	});
	return { run, out: `${run.stdout}${run.stderr}`, home };
}

test('setup.mjs installs the lock into the venv (dry run shows the pip line)', (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dict-lock-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	fs.mkdirSync(path.join(home, '.pi', 'agent', 'dictation'), { recursive: true });
	fs.writeFileSync(path.join(home, '.pi', 'agent', 'dictation', 'requirements.lock'), 'faster-whisper==1.2.1\n');
	const { run, out } = setupDryRun(t, { HOME: home, PI_AGENT_DIR: path.join(home, '.pi', 'agent') }, ['--with-dictation']);
	assert.equal(run.status, 0, out.slice(-2000));
	assert.match(out, /\[dry-run\] python3 -m venv /);
	assert.match(out, /\[dry-run\] .*pip install --quiet -r .*requirements\.lock/, `the pip line the port dropped must be there:\n${out}`);
});

test('setup.mjs skips the dictation venv on win32, with the reason in one line', (t) => {
	const { run, out } = setupDryRun(t, { PI_PLATFORM: 'win32' });
	assert.equal(run.status, 0, out.slice(-2000));
	assert.match(out, /dictation: skipped on win32 — dictation\.ts records with arecord/);
	assert.doesNotMatch(out, /\[dry-run\] python3 -m venv /);
});
