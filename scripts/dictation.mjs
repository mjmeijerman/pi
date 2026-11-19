// ============================================================================
// dictation.mjs — the faster-whisper venv, as a step that can be tested without
// the 2.5 GB download.
//
// setup.mjs used to create the venv and stop, which is where the bash installer
// this replaced was already doing two more things (`git show 665bfe2:setup.sh`,
// the "dictation virtualenv" section): a python-minor check, then
// `venv/bin/pip install --quiet -r requirements.lock`. The port dropped the pip
// line, so a fresh machine got an empty venv, `agent/extensions/dictation.ts`
// failed at runtime, and the next run printed "venv already exists" and never
// repaired it. Three decisions, all here so a test can hold them:
//
//   1. the pip line is back, and it is what "built" means;
//   2. the lock is resolved for one python minor (it pins av, ctranslate2 and
//      faster-whisper, and agent/dictation/bin/whisper-py hardcodes
//      `lib/python3.13/site-packages`), so a different minor warns with both
//      numbers instead of producing a venv that fails to import;
//   3. a venv without faster_whisper is incomplete, not present. The old check
//      asked "does venv/bin/python exist", which an empty venv answers yes to —
//      which is how a broken machine stayed broken on every re-run.
//
// Everything that spawns is passed in, so the tests drive real stub `python3`
// and `pip` binaries on a PATH they build, with no network and no wheels.
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The one minor the lock was resolved for. `agent/dictation/bin/whisper-py`
// names the same number in its LD_LIBRARY_PATH line.
export const DICTATION_PYTHON_MINOR = '3.13';
// The import `agent/extensions/dictation.ts` cannot run without.
export const DICTATION_MODULE = 'faster_whisper';

/** dictationPaths — every path the step reads or writes, per OS. */
export function dictationPaths({ agentDir, platform = process.platform }) {
	const dir = path.join(agentDir, 'dictation');
	const venv = path.join(dir, 'venv');
	const win = platform === 'win32';
	const binDir = path.join(venv, win ? 'Scripts' : 'bin');
	return {
		dir,
		venv,
		lock: path.join(dir, 'requirements.lock'),
		binDir,
		python: path.join(binDir, win ? 'python.exe' : 'python'),
		pip: path.join(binDir, win ? 'pip.exe' : 'pip'),
		// A venv's site-packages is spelled two ways; the module check has to
		// look where pip actually wrote.
		sitePackages: win ? path.join(venv, 'Lib', 'site-packages') : path.join(venv, 'lib', `python${DICTATION_PYTHON_MINOR}`, 'site-packages'),
	};
}

/**
 * sitePackagesDirs — every directory pip could have written the module into.
 *
 * The pinned minor first, then whatever `lib/python3.x` the venv actually has:
 * a venv built by another minor is still a venv, and asking only the pinned
 * path would call a working install broken — the same class of mistake as the
 * old "venv/bin/python exists" check, one layer down.
 */
export function sitePackagesDirs({ venv, platform = process.platform, readdir = fs.readdirSync } = {}) {
	if (platform === 'win32') return [path.join(venv, 'Lib', 'site-packages')];
	const dirs = [];
	try {
		for (const entry of readdir(path.join(venv, 'lib'))) {
			if (/^python\d/.test(entry)) dirs.push(path.join(venv, 'lib', entry, 'site-packages'));
		}
	} catch {
		/* no lib/ yet: an empty venv, and that is what the venv itself is missing */
	}
	if (dirs.length === 0) dirs.push(path.join(venv, 'lib', `python${DICTATION_PYTHON_MINOR}`, 'site-packages'));
	return dirs;
}

/**
 * dictationStatus — what is on disk, and the one question that matters:
 * `complete` is python AND the module, never the python alone.
 *
 * `exists`/`readdir` are injectable so a test can plant a venv without building
 * one, and so this stays a read: nothing here writes.
 */
export function dictationStatus({ agentDir, platform = process.platform, exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
	const paths = dictationPaths({ agentDir, platform });
	const hasLock = exists(paths.lock);
	const hasPython = exists(paths.python);
	const dirs = sitePackagesDirs({ venv: paths.venv, platform, readdir });
	const found = dirs.find((dir) => exists(path.join(dir, DICTATION_MODULE)));
	return { ...paths, hasLock, hasPython, hasModule: Boolean(found), sitePackagesFound: found || null, complete: hasPython && Boolean(found) };
}

/**
 * pythonMinor — the `3.13` of the python that would build the venv, or null
 * when it cannot answer (no python3, or one without `-c`).
 */
export function pythonMinor({ python = 'python3', spawn = spawnSync, env = process.env } = {}) {
	const r = spawn(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', env });
	if (!r || r.error || (r.status ?? 1) !== 0) return null;
	return String(r.stdout || '').trim() || null;
}

/**
 * buildDictationVenv — create the venv when it is missing and install the lock
 * into it, then prove the result by looking for the module.
 *
 * The venv is only created when `venv/bin/python` is absent: repairing an empty
 * venv means running pip into the one that is there, which is the cheap half of
 * the work and the half the port lost.
 */
export function buildDictationVenv({
	agentDir,
	platform = process.platform,
	python = 'python3',
	env = process.env,
	spawn = spawnSync,
	dryRun = false,
	note = () => {},
	warn = () => {},
} = {}) {
	const paths = dictationPaths({ agentDir, platform });
	const step = (file, args) => {
		if (dryRun) {
			note(`[dry-run] ${file} ${args.join(' ')}`);
			return 0;
		}
		const r = spawn(file, args, { stdio: 'inherit', env });
		if (!r || r.error) {
			warn(`could not run ${file} (${(r && r.error && (r.error.code || r.error.message)) || 'no result'})`);
			return -1;
		}
		return r.status ?? 1;
	};

	if (!fs.existsSync(paths.lock)) {
		warn(`no ${paths.lock} — nothing to install, dictation stays unavailable`);
		return { ok: false, reason: 'no-lock' };
	}

	// Idempotent on the module, not on the directory: a complete venv costs
	// nothing to check and nothing to skip, which is what makes a second run
	// quiet instead of re-installing 2.5 GB of wheels.
	const before = dictationStatus({ agentDir, platform });
	if (before.complete) {
		note(`dictation venv complete -> ${paths.venv}`);
		return { ok: true, skipped: true, status: before };
	}

	if (dryRun) {
		if (!fs.existsSync(paths.python)) step(python, ['-m', 'venv', paths.venv]);
		step(paths.pip, ['install', '--quiet', '--upgrade', 'pip']);
		step(paths.pip, ['install', '--quiet', '-r', paths.lock]);
		return { ok: false, dryRun: true, reason: 'dry-run' };
	}

	// Before spending anything: the lock, and the interpreter that will read it,
	// are pinned to one minor. A warning with both numbers is what keeps a
	// mismatch from arriving as "ModuleNotFoundError: faster_whisper" later.
	const minor = pythonMinor({ python, spawn, env });
	if (minor === null) warn(`could not read the version of ${python} — is python3 installed?`);
	else if (minor !== DICTATION_PYTHON_MINOR)
		warn(`python ${minor} builds this venv, but requirements.lock and agent/dictation/bin/whisper-py are pinned to ${DICTATION_PYTHON_MINOR} — dictation may fail to import`);

	if (!fs.existsSync(paths.python)) {
		if (step(python, ['-m', 'venv', paths.venv]) !== 0) {
			warn('venv creation failed — install the python3 venv module (apt-get install python3-venv) and re-run');
			return { ok: false, reason: 'venv-failed' };
		}
	} else {
		note(`reusing the venv at ${paths.venv}`);
	}

	if (!fs.existsSync(paths.pip)) {
		warn(`${paths.pip} is missing — that venv has no pip; delete ${paths.venv} and re-run`);
		return { ok: false, reason: 'no-pip' };
	}

	step(paths.pip, ['install', '--quiet', '--upgrade', 'pip']);
	if (step(paths.pip, ['install', '--quiet', '-r', paths.lock]) !== 0) {
		warn('pip install failed — dictation stays disabled');
		return { ok: false, reason: 'pip-failed' };
	}

	const after = dictationStatus({ agentDir, platform });
	if (!after.complete) {
		warn(`pip finished but ${DICTATION_MODULE} is not under ${after.sitePackagesFound || after.sitePackages} — dictation stays disabled`);
		return { ok: false, reason: 'module-missing' };
	}
	note(`dictation venv ready -> ${paths.venv}`);
	return { ok: true, status: after };
}
