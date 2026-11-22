#!/usr/bin/env node
// ============================================================================
// install.mjs — the single installer engine, for Linux, macOS and Windows.
//
// Usage (run from anywhere, in the clone):
//   node install.mjs                     # install pi with npm when it is missing
//   node install.mjs --no-install-pi     # deliberately not: carry on without it
//   node setup.mjs                       # the interactive pass, then this
//
// This replaces install.sh, and its sections keep the old numbering so a reader
// can map one onto the other:
//   0  prerequisites: git, node and npm, installed through the package manager
//      when missing — before the first question, so node is not a precondition
//   0b the pi binary      — the preflight: found on PATH, found on disk, or
//                           installed with npm before anything is written
//   1  agent config: skills, extensions, settings/*.json, dictation, AGENTS.md
//   1b sandbox/ and scripts/ next to the agent dir (AGENTS.md names them by path)
//   1c herdr-app mods: a file the person did not touch is updated to the shipped
//      one (decided per file, from `mods-installed.json`), a file they edited is
//      kept, and `--update-mods` overrules that; into a config directory created
//      here when the app has not run yet
//   2  global git hooks (§core.hooksPath) + the init template layer
//   3  global gitignore
//   4  git-vuln-scan, pisandbox, pi-bare (+ their .cmd shims), herdr menu
//      entry, the pi wrapper
//   5  herdr-app (vendor installer) per OS
//   5b this checkout's own `bin/` tools, on PATH under their bare names
//   5c the harness space: `bin/space new --name harness --project <this checkout>
//      --kind harness` when no record is there, and not one byte when one is. A
//      fresh install comes up with a space and a Boss tab, on every OS
//   5d the guard service: systemd on Linux, launchd on macOS, Task Scheduler on
//      Windows — installed by default on all three, because `bin/guard` is what
//      repairs a recorded space and its Boss tab after a reboot: an install that
//      registers no login entry opens Herdr with no space in it. Plus the weekly timers, which
//      need systemd and say so. The task runs a hidden `.vbs` launcher through
//      `wscript.exe` (no console) that starts `bin/guard` with the Git for
//      Windows `bash.exe` it resolved: Task Scheduler runs a command line, never
//      a shebang, and a console program it started owned a window the guard's
//      loop never closed.
//
// Idempotent: a second run changes nothing. Never touches auth.json, sessions,
// models-store.json. Never prints a key. Never overwrites a file a person may
// have edited in place (herdr mods, herdr programs.json, the wrapper block
// outside its markers, an existing AGENTS.md rule set).
//
// Env: PI_AGENT_DIR, PI_SKILLS, PI_EXTENSIONS, PI_SPACE_ROOT (where the space
//      records go; defaults to this checkout's `state/`),
//      PI_SKIP_SYSTEMD=1 (copy units on Linux, register no login entry anywhere)
//      and its alias PI_SKIP_SERVICES=1, PI_SKIP_NETWORK=1 (no vendor downloads),
//      PI_SKIP_PREREQS=1 (never call a package manager), PI_GIT_BASH
//      (the bash.exe a Windows scheduled task and every .cmd shim run the bash
//      wrappers with), HERDR_MODS, PI_UPDATE_MODS=1 (the same as --update-mods).
//      PI_ENABLE_SERVICES=1 is still accepted and changes nothing: the login
//      entry is the default now.
//
// Step 0 is the prerequisites: git, node and npm, installed with the first
// package manager this platform has when they are missing. It runs before the
// pi binary check because everything after it needs git, and the command is
// printed before it runs — see scripts/prereqs.mjs, which setup.mjs shares.
//
// Radar basis (Vol. 35): #1 agent sandboxing (Adopt), #68 mise (Adopt),
// #99 Safe Chain.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	GUARD_LABEL,
	GUARD_SPACE_NAME,
	GUARD_SPACE_WAIT_MS,
	GUARD_TASK_NAME,
	GUARD_UNIT_NAME,
	HARNESS_TOOLS,
	LEGACY_GUARD,
	PI_WRAPPER_BEGIN,
	PI_WRAPPER_BLOCK,
	PI_WRAPPER_END,
	POSIX_WRAPPERS,
	cmdShim,
	deepseekApiKey,
	deepseekKeyState,
	guardLauncherPath,
	guardPidPath,
	guardTaskCommand,
	herdrAttempt,
	herdrInstallCommand,
	helpText,
	hiddenLauncher,
	homePaths,
	isRuntimeState,
	parseFlags,
	piDiskCandidates,
	piInstallCommand,
	piPreflight,
	planFor,
	prereqNodePin,
	resolveApiKey,
	resolveGitBash as resolveGitBashAt,
	sandboxSummary,
	schtasksExe,
	spawnPlan,
	spaceIdIn,
	spliceManagedBlock,
	startAndVerifyGuard,
	systemSummary,
	systemdUnitsIn,
	wslMountWarnings,
} from './scripts/install-lib.mjs';
import { prereqsSkipped, stepPrereqs } from './scripts/prereqs.mjs';
import { DURABLE_KEY, durableBinding, mergeDurableKeys } from './herdr-mods/durable/keys.mjs';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(HOME, '.pi', 'agent');
// PI_PLATFORM exists so the per-OS branches can be exercised from one host (CI
// and the tests both use it); a real install reads the platform it runs on.
const PLAN = planFor(process.env.PI_PLATFORM || process.platform, process.env);
const P = homePaths({ home: HOME, agentDir: AGENT_DIR, plan: PLAN });
// The one space a fresh install must have, and the state root its record lives in —
// the same root `bin/space` and `bin/delegate` read (space-lib.sh).
const HARNESS_SPACE = 'harness';
const STATE_DIR =
	process.env.SPACE_STATE ||
	(process.env.PI_SPACE_ROOT ? path.join(process.env.PI_SPACE_ROOT, 'state') : path.join(P.piHome, 'state'));
const HERDR_MODS = process.env.HERDR_MODS || path.join(P.herdrConfigDir, 'mods');
let DRY = process.env.PI_DRY_RUN === '1';
// --update-mods / PI_UPDATE_MODS=1: refresh the herdr mods even where the person
// edited them, and record what was written.
let UPDATE_MODS = process.env.PI_UPDATE_MODS === '1';
const SKIP_NETWORK = process.env.PI_SKIP_NETWORK === '1';
// One way out of the service step, spelled for the platform that reads it: the
// original Linux name, and an alias that is honest on macOS and Windows too.
// The variable is named in the skip line, so nobody has to guess which one they
// set.
const SKIP_SYSTEMD = process.env.PI_SKIP_SYSTEMD === '1';
const SKIP_SERVICES = process.env.PI_SKIP_SERVICES === '1';
// The old way in. Accepted and no longer gates anything, so a script written
// against it keeps working — it just does not have to ask again.
const ENABLE_SERVICES = process.env.PI_ENABLE_SERVICES === '1';

let OPT = { installPi: true };
let changed = 0;
// What stepServices registered, so the summary can say it and say how to undo
// it: a skip must not print a Disable line for an entry that is not there.
let guardService = null;
// Every unit stepSystemd copied, so the summary's disable lines name what is
// really there instead of a list that can drift from the directory.
let systemdInstalled = [];

// --- argv -------------------------------------------------------------------
// The flag list lives in scripts/install-lib.mjs (ENGINE_FLAGS.install), so the
// parser and `--help` are one table and cannot disagree; the test in
// scripts/tests/install-help.test.mjs holds the two together.
function parseArgs(argv) {
	let opts;
	try {
		opts = parseFlags('install', argv);
	} catch (err) {
		die(err.message);
	}
	if (opts.help) {
		process.stdout.write(helpText('install', { command: 'node install.mjs' }));
		process.exit(0);
	}
	return opts;
}

function die(message) {
	process.stderr.write(`!! ${message}\n`);
	process.exit(1);
}

const say = (line) => process.stdout.write(`${line}\n`);
const note = (line) => process.stdout.write(`== ${line}\n`);
const warn = (line) => process.stderr.write(`!! ${line}\n`);
const skipped = (what, why) => say(`== ${what}: ${why}`);

// --- small fs/shell helpers -------------------------------------------------
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

function ensureDir(dir) {
	if (exists(dir) || DRY) return false;
	fs.mkdirSync(dir, { recursive: true });
	return true;
}

/** copyFile — copy only when the content differs; returns true when it wrote. */
function copyFile(src, dst, { mode } = {}) {
	if (!exists(src) || path.resolve(src) === path.resolve(dst)) return false;
	const same = exists(dst) && read(dst) === read(src);
	if (!same) {
		if (!DRY) {
			ensureDir(path.dirname(dst));
			fs.copyFileSync(src, dst);
			if (mode !== undefined) fs.chmodSync(dst, mode);
		}
		changed++;
	}
	return !same;
}

/** copyTree — recursive copy, refreshing files but never deleting extras. */
function copyTree(src, dst, skip = () => false) {
	if (!exists(src) || path.resolve(src) === path.resolve(dst)) return false;
	if (DRY) return false;
	// File by file, skipping the ones that already match: fs.cpSync would rewrite
	// every file on every run, and "the second run wrote nothing" is a claim the
	// report has to be able to make.
	let wrote = 0;
	const walk = (from, to) => {
		ensureDir(to);
		for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
			const s = path.join(from, entry.name);
			const d = path.join(to, entry.name);
			if (entry.isDirectory()) {
				walk(s, d);
				continue;
			}
			if (!entry.isFile()) continue;
			if (skip(s)) continue;
			const bytes = fs.readFileSync(s);
			if (exists(d) && fs.statSync(d).size === bytes.length && fs.readFileSync(d).equals(bytes)) continue;
			fs.writeFileSync(d, bytes);
			try {
				fs.chmodSync(d, fs.statSync(s).mode & 0o777);
			} catch {
				/* a filesystem that refuses chmod still got the bytes */
			}
			wrote++;
		}
	};
	walk(src, dst);
	changed += wrote;
	return wrote > 0;
}

/** copyDirEntries — copy one level of `src` into `dst`, only the named entries. */
function copyDirEntries(src, dst, names) {
	let wrote = false;
	for (const name of names) {
		const from = path.join(src, name);
		const to = path.join(dst, name);
		if (!exists(from)) continue;
		if (fs.statSync(from).isDirectory()) wrote = copyTree(from, to) || wrote;
		else wrote = copyFile(from, to) || wrote;
	}
	return wrote;
}

function writeText(file, text, { mode } = {}) {
	const current = exists(file) ? read(file) : null;
	if (current === text) return false;
	if (!DRY) {
		ensureDir(path.dirname(file));
		fs.writeFileSync(file, text);
		if (mode !== undefined) fs.chmodSync(file, mode);
	}
	changed++;
	return true;
}

function hasCmd(name) {
	// `where` on Windows, `command -v` everywhere else; the POSIX probe is the
	// fallback so PI_PLATFORM=win32 can be exercised from a Linux host.
	if (PLAN.platform === 'win32') {
		const r = spawnSync('where', [name], { stdio: 'ignore' });
		if (r.error === undefined) return r.status === 0;
	}
	return spawnSync('sh', ['-c', `command -v ${name} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function run(cmd, args, { quiet = false, allowFail = false, env } = {}) {
	if (DRY) {
		say(`   [dry-run] ${cmd} ${args.join(' ')}`);
		return 0;
	}
	const spec = spawnPlan(cmd, args, { platform: PLAN.platform });
	const r = spawnSync(spec.file, spec.args, {
		stdio: quiet ? 'ignore' : 'inherit',
		windowsVerbatimArguments: spec.windowsVerbatimArguments,
		env: env ? { ...process.env, ...env } : process.env,
	});
	if (r.status !== 0 && !allowFail) warn(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? 'n/a'})`);
	return r.status ?? 1;
}

function gitConfig(key, value) {
	const current = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' });
	if (current.status === 0 && current.stdout.trim() === value) return false;
	run('git', ['config', '--global', key, value], { quiet: true, allowFail: true });
	changed++;
	return true;
}

/**
 * linkOrCopy — the one place the symlink-vs-copy choice lives. A bin entry is a
 * symlink where the OS allows it and a copy where it needs elevation (Windows
 * without Developer Mode). Re-pointing an existing entry is idempotent.
 */
function linkOrCopy(target, dest) {
	ensureDir(path.dirname(dest));
	const useCopy = PLAN.linkMode === 'copy';
	if (exists(dest)) {
		let already = false;
		try {
			already = useCopy ? read(dest) === read(target) : fs.readlinkSync(dest) === target;
		} catch {
			already = false;
		}
		if (already) return 'same';
		if (!DRY) fs.rmSync(dest, { force: true });
	}
	if (!DRY) {
		if (useCopy) {
			fs.copyFileSync(target, dest);
			fs.chmodSync(dest, 0o755);
		} else {
			fs.symlinkSync(target, dest);
		}
	}
	changed++;
	return useCopy ? 'copy' : 'link';
}

// --- 0. prerequisites -------------------------------------------------------
/**
 * stepPrerequisites — git, node and npm, before anything else the engine does.
 *
 * This is the step that makes `node install.mjs` work on a machine where nobody
 * read INSTALL.md: the tools are installed through the platform's package
 * manager instead of being a precondition. It runs first because every step
 * after it (hooks, the clone, the bin entries) needs git.
 *
 * The node version is the running process's, never `spawnSync('node', ['-v'])`:
 * this file *is* node, so the probe is the one check that can lie — under a
 * runner that starts node by absolute path it reports ENOENT while node runs the
 * check (#175's CI bug).
 */
function stepPrerequisites() {
	const pin = prereqNodePin(SOURCE_DIR, fs.readFileSync);
	const result = stepPrereqs({
		platform: PLAN.platform,
		pin,
		skipPrereqs: prereqsSkipped({ skipPrereqs: OPT.skipPrereqs }),
		io: { have: hasCmd, run: (cmd, args) => run(cmd, args, { allowFail: true }), say, note, warn },
		nodeVersion: process.version,
		nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
	});
	// Same wall the docs document: git installed, the shell holding a PATH from
	// before it. Every git step below would warn with no hint where the answer is.
	if (!result.skipped && !hasCmd('git'))
		warn("git is still not on PATH — docs/install.md#troubleshooting: 'git is not recognized' after a Windows install, and the four-step PATH repair");
	return result;
}

// --- 0b. the pi binary, in the preflight -------------------------------------
// npm is asked for by the name its own OS resolves: `npm.cmd` on Windows, where
// a bare `npm` is the `npm.ps1` a default execution policy refuses. The plan
// carries it, so no call site can spell it wrong on its own.
const NPM = PLAN.npmBin || 'npm';

/** piOnDisk — a pi npm or pnpm installed but not on PATH (pnpm keeps it out). */
function piOnDisk() {
	return piDiskCandidates({ home: HOME, plan: PLAN, env: process.env }).find((c) => exists(c));
}

/**
 * preflightPi — the pi decision, before a single file is written.
 *
 * It used to run at the tail, after the config, hooks and services had landed:
 * a machine with no pi and no npm got a half-installed tree and exit 1. The
 * decision itself is data (piPreflight in scripts/install-lib.mjs), so setup.mjs
 * asks the same question with the same words and the tests drive one function.
 */
function preflightPi() {
	const verdict = piPreflight({
		onPath: hasCmd('pi'),
		onDisk: piOnDisk(),
		npm: hasCmd(NPM),
		npmBin: NPM,
		allowMissing: process.env.PI_ALLOW_MISSING_PI === '1',
		install: OPT.installPi,
		plan: PLAN,
	});
	if (verdict.action === 'present') return;
	if (verdict.action === 'path') {
		process.env.PATH = `${path.dirname(verdict.path)}${path.delimiter}${process.env.PATH}`;
		note(verdict.message);
		return;
	}
	if (verdict.action === 'skip') {
		skipped('pi binary', verdict.message);
		return;
	}
	if (verdict.action === 'install') {
		note(verdict.message);
		if (run(NPM, verdict.argv.slice(1)) !== 0) {
			// Stopping here is the point: nothing has been written yet, so the tree
			// is untouched and the message is the one line that fixes it.
			warn(`installing pi failed — nothing written yet. Run it yourself: ${piInstallCommand(NPM)}`);
			process.exit(1);
		}
		return;
	}
	warn(`${verdict.message} — nothing written yet`);
	for (const line of verdict.fix || []) say(`   ${line}`);
	process.exit(1);
}

/** preflight — everything that has to hold before the first write. */
function preflight({ prereqs = {} } = {}) {
	say('== preflight');
	say(`   source : ${SOURCE_DIR}`);
	say(`   agent  : ${AGENT_DIR}`);
	// systemSummary, not PLAN.platform: on WSL the platform is `linux` and the
	// one thing the banner has to say about it is that it is WSL.
	say(`   system : ${systemSummary(PLAN)}`);
	// Same wall as setup.mjs: git installed, shell holding a PATH from before it.
	// Every git step below would warn with no hint where the answer is. The step
	// above already said it when it tried to install git and could not, so this
	// only speaks for the run that skipped the step on purpose.
	if (prereqs.skipped && !hasCmd('git'))
		warn("git is not on PATH — docs/install.md#troubleshooting: 'git is not recognized' after a Windows install, and the PATH fix");
	preflightPi();
}

// --- 1. agent config --------------------------------------------------------
function splitList(value) {
	return String(value || '')
		.split(/[\s,]+/)
		.filter(Boolean);
}

function stepAgent() {
	ensureDir(AGENT_DIR);
	let wrote = false;
	const skillsSrc = path.join(SOURCE_DIR, 'agent', 'skills');
	if (exists(skillsSrc) && path.resolve(skillsSrc) !== path.resolve(AGENT_DIR, 'skills')) {
		ensureDir(path.join(AGENT_DIR, 'skills'));
		const all = fs
			.readdirSync(skillsSrc, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
		const wanted = splitList(process.env.PI_SKILLS);
		const picked = wanted.length ? all.filter((n) => wanted.includes(n)) : all;
		wrote = copyDirEntries(skillsSrc, path.join(AGENT_DIR, 'skills'), picked) || wrote;
	}

	const extSrc = path.join(SOURCE_DIR, 'agent', 'extensions');
	if (exists(extSrc) && path.resolve(extSrc) !== path.resolve(AGENT_DIR, 'extensions')) {
		const extDst = path.join(AGENT_DIR, 'extensions');
		ensureDir(extDst);
		// lib/ and __tests__/ always come along: extensions import lib, and the
		// test suite is how setup verifies the install afterwards.
		for (const fixed of ['lib', '__tests__']) {
			if (exists(path.join(extSrc, fixed))) copyTree(path.join(extSrc, fixed), path.join(extDst, fixed));
		}
		const all = fs
			.readdirSync(extSrc, { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.ts'))
			.map((d) => d.name);
		const wanted = splitList(process.env.PI_EXTENSIONS);
		const picked = wanted.length ? all.filter((n) => wanted.includes(n)) : all;
		wrote = copyDirEntries(extSrc, extDst, picked) || wrote;
	}

	const configFiles = ['settings.json', 'models.json', 'i-have-adhd.json', 'keybindings.json', 'package.json'];
	for (const name of configFiles) {
		wrote = copyFile(path.join(SOURCE_DIR, 'agent', name), path.join(AGENT_DIR, name)) || wrote;
	}
	// models.json reads the key with a `!command`, so the same question a person
	// asks ("will pi authenticate?") can be answered here, in one line, without
	// printing the key: the command is run the way pi runs it, against the file
	// the wizard writes. Printed every run, not only on change, because it is a
	// state and not a write.
	const apiKey = deepseekApiKey(exists(path.join(AGENT_DIR, 'models.json')) ? read(path.join(AGENT_DIR, 'models.json')) : '');
	const keyFile = exists(path.join(AGENT_DIR, 'deepseek.key'));
	const resolved = keyFile ? resolveApiKey({ apiKey, platform: PLAN.platform }) : { ok: false };
	note(`deepseek key: ${deepseekKeyState({ keyFile, apiKey, resolves: resolved.ok })}`);
	// AGENTS.md is the rule set a person answers questions about in setup.mjs, so
	// this engine never replaces an existing one: that would undo their answers.
	const agentsSrc = path.join(SOURCE_DIR, 'agent', 'AGENTS.md');
	const agentsDst = path.join(AGENT_DIR, 'AGENTS.md');
	if (exists(agentsSrc) && path.resolve(agentsSrc) !== path.resolve(agentsDst)) {
		if (!exists(agentsDst)) wrote = copyFile(agentsSrc, agentsDst) || wrote;
		else if (read(agentsDst) !== read(agentsSrc)) {
			say('== kept the existing AGENTS.md — run ./setup.mjs to re-apply your rule answers');
		}
	}

	// The dictation extension needs its script, lock file and wrapper; the venv
	// (machine-specific, ~2.5 GB) and recorded audio stay out.
	const dictSrc = path.join(SOURCE_DIR, 'agent', 'dictation');
	const dictDst = path.join(AGENT_DIR, 'dictation');
	if (exists(dictSrc) && path.resolve(dictSrc) !== path.resolve(dictDst)) {
		ensureDir(path.join(dictDst, 'bin'));
		for (const name of ['transcribe.py', 'requirements.lock']) copyFile(path.join(dictSrc, name), path.join(dictDst, name));
		copyFile(path.join(dictSrc, 'bin', 'whisper-py'), path.join(dictDst, 'bin', 'whisper-py'));
	}
	note(`${wrote ? 'copied' : 'up to date:'} skills/extensions/settings -> ${AGENT_DIR}`);
}

// --- 1b. paths AGENTS.md and the skills name absolutely ---------------------
function stepRuntimeDirs() {
	for (const sub of ['sandbox', 'scripts']) {
		const src = path.join(SOURCE_DIR, sub);
		const dst = path.join(P.piHome, sub);
		if (!exists(src) || path.resolve(src) === path.resolve(dst)) continue;
		// Machine-local state is never carried over (scripts/install-lib.mjs
		// RUNTIME_STATE_FILES): skipping it in the copy is what makes a second run
		// write nothing, and the delete below is only for a HOME an older installer
		// already put it in.
		const wrote = copyTree(src, dst, (p) => isRuntimeState(p));
		if (exists(path.join(dst, '.agent-panes.json')) && !DRY) fs.rmSync(path.join(dst, '.agent-panes.json'), { force: true });
		note(wrote ? `copied ${sub} -> ${dst}` : `${sub} up to date -> ${dst}`);
	}
}

/**
 * ensureHerdrConfigDir — `~/.config/herdr-app` (or `%USERPROFILE%\.config\herdr-app`,
 * which is the app's config dir on Windows too), created when it is not there.
 *
 * The directory used to arrive with the first launch of herdr-app, and that is
 * section 5 — after the mods (1c) and the menu row (4). So on a fresh machine
 * both steps took their skip branch, silently: no `mods/`, no `Pi (bare)` entry,
 * and a second run did not fix it either, because nothing had opened the app in
 * between. It is plain JSON and folders on disk, so it is written before the app
 * exists and read by the app's first launch.
 * Returns what the caller should say it did.
 */
function ensureHerdrConfigDir() {
	if (exists(P.herdrConfigDir)) return 'found';
	if (DRY) return 'would create';
	fs.mkdirSync(P.herdrConfigDir, { recursive: true });
	return 'created';
}

// --- 1c. herdr-app mods (an unedited one is refreshed, an edited one kept) ---
/**
 * stepHerdrMods — the mods folder, decided per file, from a record of what this
 * installer wrote.
 *
 * The skip that used to live here ("the folder exists, so keep it") could not
 * tell its own old copy from an edit, so it treated both as an edit: mod changes
 * in this repository never reached a running Herdr app, and a copy installed on
 * 14 November stayed on disk while the tree fixed the same file a week later
 * (#203). The promise that skip was protecting is real and stays: a mod the
 * person edited in place is theirs, and an install never overwrites it.
 *
 * The record is `mods-installed.json` in the config dir, never inside a mod
 * folder: the app hashes its own `installed.json` there, so a second record in
 * that tree would be a foreign file the app reads. Its shape is
 * `{ "<mod>": { "<relative path>": "<sha256>" } }`.
 *
 * A hash in the record is of the bytes the installer wrote, not of what is on
 * disk now. A file the person edited keeps its old hash on purpose: recording
 * the edit would make the next run call it untouched and overwrite it.
 */
const MODS_RECORD = path.join(P.herdrConfigDir, 'mods-installed.json');

const MODS_RECORD_HINT = 'run install.sh --update-mods to refresh it';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** modHashes — every file in a folder, relative path ('/') -> sha256. */
function modHashes(dir) {
	const hashes = {};
	const walk = (from, prefix) => {
		for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = path.join(from, entry.name);
			if (entry.isDirectory()) walk(full, rel);
			else if (entry.isFile()) hashes[rel] = sha256(fs.readFileSync(full));
		}
	};
	walk(dir, '');
	return hashes;
}

/**
 * readModsRecord — the record, `null` when there is none, `false` when the file
 * is not one. A corrupt record writes nothing at all: every mod folder it would
 * have described is then a folder nobody can tell an edit inside, and a corrupt
 * file is not a licence to overwrite one.
 */
function readModsRecord() {
	if (!exists(MODS_RECORD)) return null;
	try {
		const parsed = JSON.parse(read(MODS_RECORD));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
		throw new Error('not a JSON object');
	} catch (err) {
		warn(`${MODS_RECORD} is not the record this installer writes (${err.message}) — the herdr mods are left exactly as they are; fix or delete that file, then run this again`);
		return false;
	}
}

/**
 * writeModFile — one file of one mod, written only when the bytes differ.
 * `--dry-run` keeps the line and writes nothing, the record included.
 */
function writeModFile(srcFile, dstFile) {
	const bytes = fs.readFileSync(srcFile);
	if (exists(dstFile) && fs.readFileSync(dstFile).equals(bytes)) return false;
	if (!DRY) {
		ensureDir(path.dirname(dstFile));
		fs.writeFileSync(dstFile, bytes);
		try {
			fs.chmodSync(dstFile, fs.statSync(srcFile).mode & 0o777);
		} catch {
			/* a filesystem that refuses chmod still got the bytes */
		}
	}
	changed++;
	return true;
}

/** writeModsRecord — sorted, so a run that changed nothing writes nothing. */
function writeModsRecord(record) {
	const sorted = {};
	for (const mod of Object.keys(record).sort()) {
		sorted[mod] = {};
		for (const rel of Object.keys(record[mod]).sort()) sorted[mod][rel] = record[mod][rel];
	}
	// Nothing written is nothing to record: a run that only met folders from
	// before the record existed leaves no empty record behind.
	if (Object.keys(sorted).length === 0 && !exists(MODS_RECORD)) return;
	writeText(MODS_RECORD, `${JSON.stringify(sorted, null, 2)}\n`);
}

function stepHerdrMods() {
	const src = path.join(SOURCE_DIR, 'herdr-mods');
	if (!exists(src)) return;
	note(`herdr config dir ${ensureHerdrConfigDir()}: ${P.herdrConfigDir}`);
	const record = readModsRecord();
	if (record === false) return;
	// The record after this run: every mod it describes stays described, so a mod
	// the shipped tree dropped is never forgotten and never deleted.
	const next = record ? JSON.parse(JSON.stringify(record)) : {};
	let added = 0;
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const from = path.join(src, name);
		const dst = path.join(HERDR_MODS, name);
		let there = null;
		try {
			there = exists(dst) ? fs.lstatSync(dst) : null;
		} catch {
			there = null;
		}
		if (there && !there.isDirectory()) {
			say(`== herdr mod ${name} is ${there.isSymbolicLink() ? 'a symlink' : 'not a folder'} — left alone: ${dst}`);
			continue;
		}
		try {
			if (!there) {
				// Case 1: no folder. In a dry run copyTree writes nothing and the line
				// still prints: the point of --dry-run is to show what a fresh install
				// would put there.
				copyTree(from, dst);
				note(`installed herdr mod: ${name} -> ${dst}`);
				next[name] = modHashes(from);
				added++;
				continue;
			}
			const shipped = modHashes(from);
			if (UPDATE_MODS) {
				// --update-mods: the person asked for the shipped bytes, edits and all,
				// and the record is rewritten to say so.
				for (const rel of Object.keys(shipped)) {
					if (writeModFile(path.join(from, rel), path.join(dst, rel)))
						note(`herdr mod ${name}/${rel} overwritten: --update-mods`);
				}
				next[name] = shipped;
				continue;
			}
			if (!record || !record[name]) {
				// Case 3: installed before this record existed. Nothing on disk says
				// which file is the installer's and which is the person's, so all of it
				// is theirs — and the one flag that overrules that is named.
				say(`== kept existing herdr mod: ${name} — installed before the record existed; ${MODS_RECORD_HINT}`);
				continue;
			}
			// Case 2: a record from an earlier install. Per file, three answers.
			for (const rel of Object.keys(shipped)) {
				const target = path.join(dst, rel);
				const onDisk = exists(target) ? sha256(fs.readFileSync(target)) : null;
				const recorded = record[name][rel];
				if (recorded === undefined) {
					// A file this mod did not ship before: new, so write it.
					if (writeModFile(path.join(from, rel), target)) note(`herdr mod ${name}/${rel} added`);
					next[name][rel] = shipped[rel];
					continue;
				}
				if (onDisk === null) {
					say(`== herdr mod ${name}/${rel} kept: you removed it, and this installer never puts one back`);
					continue;
				}
				if (onDisk !== recorded) {
					// Edited by hand: theirs, byte for byte, and the recorded hash stays
					// the old one so the next run still sees an edit and not an update.
					say(`== herdr mod ${name}/${rel} kept: you edited it`);
					continue;
				}
				if (shipped[rel] !== onDisk && writeModFile(path.join(from, rel), target))
					note(`herdr mod ${name}/${rel} updated`);
				next[name][rel] = shipped[rel];
			}
		} catch (err) {
			// A folder that will not read is one mod stuck, not an install that stops.
			warn(`herdr mod ${name}: ${err.message} — left alone`);
		}
	}
	if (added > 0) note(`${added} herdr mod(s) new in ${HERDR_MODS} — in place before herdr-app is first opened`);
	writeModsRecord(next);
}

// --- 1d. the key that makes a durable space ---------------------------------
/**
 * stepHerdrKeys — `alt-shift-n` pressed anywhere opens a tab running `space new`.
 *
 * The mods' own keys live in each mod's `keys.json` and Herdr merges them by hand; that
 * merge is this step, for the one key that has to work on a fresh install. The other
 * half is the argv: `terminal.open` with the installed `space` (and the `.cmd` on
 * Windows), so no machine's home folder is written into a file that travels.
 *
 * A missing keys.json is deliberately not created. Herdr only replaces a keys file whose
 * bytes are a shipped original, so any file written before the app's first start becomes
 * the person's whole key map — one section in it would erase every shortcut it does not
 * mention, ctrl-shift-p among them. The step says the sentence instead, and the next run
 * (after Herdr has written its own) adds the key beside them.
 */
function stepHerdrKeys() {
	const binding = durableBinding({ platform: PLAN.platform, binDir: P.binDir });
	const file = path.join(P.herdrConfigDir, 'keys.json');
	if (!exists(file)) {
		note(`${path.basename(file)}: not there yet — Herdr writes it on its first start, then run this again and ${DURABLE_KEY} lands beside the shipped keys`);
		return;
	}
	const { text, state } = mergeDurableKeys(read(file), binding);
	if (state === 'added') {
		writeText(file, text);
		note(`${DURABLE_KEY} -> ${binding.args.argv.join(' ')} (new tab) in ${file}`);
	} else if (state === 'kept') {
		say(`== kept ${DURABLE_KEY} in ${path.basename(file)}: already ${binding.args.argv.join(' ')}`);
	} else if (state === 'taken') {
		warn(`${DURABLE_KEY} is already bound to something else in ${file} — left as it is; bind it yourself or free the key`);
	} else {
		warn(`${file} is not the JSON Herdr expects — nothing written; fix it, then run this again`);
	}
}

// --- 2. git hooks -----------------------------------------------------------
function stepGitHooks() {
	const src = path.join(SOURCE_DIR, 'git-hooks');
	// The 15 wrapper files are install-hooks.sh's output, not its input: copying
	// the committed copies first and letting the installer rewrite them would make
	// every run look like a change. The scan scripts and patterns do get copied.
	const generated = (file) => {
		try {
			return /generated by install-hooks\.sh/.test(fs.readFileSync(file, 'utf8').slice(0, 400));
		} catch {
			return false;
		}
	};
	if (exists(src) && path.resolve(src) !== path.resolve(P.gitHooksDir)) copyTree(src, P.gitHooksDir, generated);
	const installer = path.join(P.gitHooksDir, 'install-hooks.sh');
	if (exists(installer) && hasCmd('bash')) {
		// The same hook bodies on all three OSes: git's own sh runs them.
		run('bash', [installer], { allowFail: true });
	} else {
		warn('install-hooks.sh or bash not found — writing the wrappers from node is not possible here');
	}
	// Both keys are set from here whatever that script did, because it can fail
	// after doing useful work: inside the sandbox ~/.git-templates is read-only,
	// so it writes the wrappers, dies on the template copy, and used to leave
	// init.templateDir unset — `git init` then got no hook template. The script
	// stays the thing that refreshes the 15 wrapper files; the config values are
	// node's job. Setting them here also keeps the reported value the one node
	// computed: on Windows the shell installer had spelled it /c/Users/..., and
	// the next run would have looked like a change that never happened.
	gitConfig('core.hooksPath', P.gitHooksDir);
	gitConfig('init.templateDir', P.gitTemplatesDir);
	const hooksPath = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' });
	note(`git hooks active : ${(hooksPath.stdout || '').trim() || '(unset)'}`);
}

// --- 3. global gitignore ----------------------------------------------------
function stepGitignore() {
	const src = path.join(SOURCE_DIR, 'gitignore_global');
	if (exists(src) && path.resolve(src) !== path.resolve(P.gitignoreGlobal)) copyFile(src, P.gitignoreGlobal);
	if (exists(P.gitignoreGlobal)) {
		gitConfig('core.excludesFile', P.gitignoreGlobal);
		note(`global gitignore: ${P.gitignoreGlobal}`);
	}
}

// --- 4. scanners, bin entries, herdr menu, the pi wrapper -------------------
function stepBins() {
	const vuln = path.join(SOURCE_DIR, 'git-vuln-scan');
	if (exists(vuln) && !DRY) {
		if (copyFile(vuln, path.join(P.binDir, 'git-vuln-scan'))) fs.chmodSync(path.join(P.binDir, 'git-vuln-scan'), 0o755);
		note(`git-vuln-scan -> ${path.join(P.binDir, 'git-vuln-scan')}`);
	}

	// The bash wrappers: pisandbox and pi-bare are the sandbox without the absolute
	// path (blip 1) and the sanctioned way out of it, as a program a menu can
	// launch. The list is scripts/install-lib.mjs `POSIX_WRAPPERS`, because each
	// copy on win32 also needs the `.cmd` next to it — see installWrapper.
	for (const wrapper of POSIX_WRAPPERS.filter((w) => w.from === 'scripts')) {
		const name = wrapper.name;
		// The installed copy is what a real run links; `--dry-run` on a fresh HOME
		// has none, because the step that copies it is dry too, so the repo's copy
		// is the honest answer to "what would land here".
		const installed = path.join(P.piHome, 'scripts', name);
		const src = exists(installed) ? installed : path.join(SOURCE_DIR, 'scripts', name);
		if (!exists(src)) {
			warn(`scripts/${name} not found — skipped`);
			continue;
		}
		if (!DRY) fs.chmodSync(src, 0o755);
		const dest = path.join(P.binDir, name);
		const how = linkOrCopy(src, dest);
		note(`${name} -> ${dest} (${how})`);
		installWrapper(name, dest);
	}

	// The Herdr menu row is app config, not harness config: install the file when
	// Herdr has none, never overwrite one somebody edited.
	const programsSrc = path.join(SOURCE_DIR, 'sandbox', 'herdr-programs.json');
	const programsDst = path.join(P.herdrConfigDir, 'programs.json');
	if (exists(programsSrc)) {
		// Same reason as stepHerdrMods: the config dir is created here rather than
		// waited for, because section 5 is where the app would have made it.
		ensureHerdrConfigDir();
		if (exists(programsDst)) {
			say('== herdr programs.json exists — add the pi-bare entry from sandbox/herdr-programs.json by hand');
		} else {
			const entry = JSON.parse(read(programsSrc));
			const key = Object.keys(entry.programs || {})[0];
			// The template says `pi-bare` and never a path: a repo cannot know where
			// a machine keeps its bin directory, and the one absolute path it once
			// held was that person's home — every other install inherited a menu row
			// pointing at a file that is not there. This is the only code that knows
			// `P.binDir`, so it resolves the name on every platform, Linux included.
			if (key && entry.programs[key].run) {
				entry.programs[key].run = [path.join(P.binDir, PLAN.platform === 'win32' ? 'pi-bare.cmd' : 'pi-bare')];
			}
			writeText(programsDst, `${JSON.stringify(entry, null, 2)}\n`);
			note(`herdr menu: "Pi (bare)" entry installed -> ${programsDst}`);
		}
	}

	const templatesSrc = path.join(SOURCE_DIR, 'git-templates');
	if (exists(templatesSrc) && path.resolve(templatesSrc) !== path.resolve(P.gitTemplatesDir)) {
		copyTree(templatesSrc, P.gitTemplatesDir);
	}
	if (exists(path.join(P.gitTemplatesDir, 'hooks', 'pre-push'))) {
		gitConfig('init.templateDir', P.gitTemplatesDir);
		note(`git template hooks: ${P.gitTemplatesDir}`);
	}

	stepPiWrapper();
}

/**
 * The wrapper puts `pi` behind the sandbox. It is a POSIX-shell block, so it goes
 * into the two rc files that exist; on Windows there is no such file and the
 * summary says how to get the same thing (`pi-bare` from the menu).
 */
function stepPiWrapper() {
	if (PLAN.rcFiles.length === 0) {
		say(`== pi sandbox wrapper: no POSIX shell rc file on ${PLAN.platform} — skipped (run pi-bare for an unsandboxed session)`);
		return;
	}
	for (const rcName of PLAN.rcFiles) {
		const rc = path.join(HOME, rcName);
		if (!exists(rc)) continue;
		const current = read(rc);
		const next = spliceManagedBlock(current, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
		if (next === current) {
			say(`== pi sandbox wrapper already current -> ${rc}`);
			continue;
		}
		if (!DRY && !exists(`${rc}.bak-pi`)) fs.copyFileSync(rc, `${rc}.bak-pi`);
		if (writeText(rc, next)) {
			const checker = rcName.endsWith('zshrc') ? 'zsh' : 'bash';
			if (hasCmd(checker)) {
				const check = spawnSync(checker, ['-n', rc], { stdio: 'ignore' });
				if (check.status !== 0) warn(`${rc} does not parse (${checker} -n) — previous version kept as ${rc}.bak-pi`);
			}
			note(`pi sandbox wrapper -> ${rc} (PI_BARE=1 pi bypasses it)`);
		}
	}
}

// --- 5. herdr-app -----------------------------------------------------------
/**
 * stepHerdrApp — the vendor installer, and the step that is not allowed to say
 * nothing.
 *
 * On the machine this was found on the vendor installer never ran and the
 * transcript held no `herdr-app` line of any kind, so nothing pointed here.
 * Every run now prints the platform, the path it looks at, whether that path is
 * there, and the exact command, before it can decide to do nothing.
 *
 * The verdict afterwards is read from the disk, not from an exit status: a
 * vendor script can exit 0 and install somewhere else, and that is exactly what
 * made a working install read as missing. The bin link comes last, so it is
 * never the only place a failure shows up.
 */
async function stepHerdrApp() {
	say('== herdr-app');
	const bin = P.herdrInstalled;
	// The facts, looked up here and nowhere else: herdrInstallCommand is pure, so
	// the choice can be tested without a host that has — or lacks — a `pwsh`.
	const command = herdrInstallCommand({
		platform: PLAN.platform,
		hasPwsh: hasCmd('pwsh'),
		hasPowershell: hasCmd('powershell'),
	});
	const present = Boolean(bin) && exists(bin);
	note(`platform : ${PLAN.platform}`);
	note(`bin      : ${bin || '(none — no vendor install path on this OS)'}`);
	note(`exists   : ${present ? 'yes' : 'no'}`);

	// Four reasons not to run it, each said out loud with the manual command
	// behind it. Anything else runs the installer and says so first. The missing
	// PowerShell is one of them now that the choice is a pure function: a shell
	// the step knows is absent is named, instead of reaching spawnSync's ENOENT.
	let whyNot = null;
	if (present) whyNot = 'already installed';
	else if (SKIP_NETWORK) whyNot = 'PI_SKIP_NETWORK=1 — the vendor installer was not downloaded';
	else if (!command.available) whyNot = 'neither pwsh nor powershell is on PATH';
	else if (PLAN.herdrInstall === 'sh' && !hasCmd('curl')) whyNot = 'curl is not on PATH';

	let ran = false;
	if (whyNot) {
		note(`command  : not run — ${whyNot}`);
	} else {
		note(`command  : ${command.line}`);
		if (command.fellBack) note(`fallback : ${command.preferred} is not on PATH — ${command.shell} runs the same script`);
		const attempt = herdrAttempt({ command, spawn: spawnSync, dry: DRY });
		if (attempt.dry) note(`[dry-run] ${command.line}`);
		for (const line of attempt.lines) warn(line);
		ran = attempt.ran;
	}

	const after = Boolean(bin) && exists(bin);
	if (after) {
		note(`installed -> ${bin}`);
	} else if (ran) {
		warn(`!! not installed — run: ${command.manual}`);
	} else {
		note(`!! not installed — run: ${command.manual}`);
	}
	if (!after) {
		note(`bin entry : not linked — ${bin || 'the binary'} is not there`);
		return;
	}
	const dest = path.join(P.binDir, PLAN.platform === 'win32' ? 'herdr-app.exe' : 'herdr-app');
	const how = linkOrCopy(bin, dest);
	note(`herdr-app -> ${dest} (${how})`);
}

// --- 5b. this checkout's own bin tools, on PATH by their bare names ---------
/**
 * stepBinsOnPath — `bin/`'s own tools on PATH, by the bare name a spec types.
 *
 * This repo is the home of the harness, so its `bin/` is what `space`,
 * `delegate`, `guard`, `preflight`, `pr-ready` and `publish` are: the install
 * links them into the bin directory on PATH and, on win32, writes the `.cmd` a
 * PowerShell prompt or a Herdr menu row actually starts.
 */

function stepBinsOnPath() {
	for (const name of HARNESS_TOOLS) {
		// The installed copy is what a real run links; `--dry-run` on a fresh HOME
		// has none, because the step that copies it is dry too, so this checkout's
		// own copy is the honest answer to "what would land here".
		const src = harnessBin(name);
		if (!exists(src)) {
			warn(`bin/${name} not found — skipped its bin entry`);
			continue;
		}
		if (!DRY) fs.chmodSync(src, 0o755);
		const dest = path.join(P.binDir, name);
		const how = linkOrCopy(src, dest);
		note(`${name} -> ${dest} (${how})`);
		installWrapper(name, dest);
	}
}

// --- 5c. the harness space --------------------------------------------------
/**
 * harnessBin — one of this checkout's tools, preferring the installed copy.
 *
 * A real install runs from `~/.pi`, so both spellings are the same file; a run
 * from a clone elsewhere (`PI_AGENT_DIR` pointed at a temp home, or a worker's
 * worktree) has no installed copy yet, and the checkout's own is the honest one.
 */
function harnessBin(name) {
	const installed = path.join(P.piHome, 'bin', name);
	return exists(installed) ? installed : path.join(SOURCE_DIR, 'bin', name);
}

/** spaceByHand — the one command that makes the space when this run cannot. */
function spaceByHand() {
	return `"${harnessBin('space')}" new --name ${HARNESS_SPACE} --project "${P.piHome}" --kind harness`;
}

/** recordProject — the project a space record names, '' when it does not parse. */
function recordProject(record) {
	try {
		return JSON.parse(read(record)).project || '';
	} catch {
		return '';
	}
}

/**
 * stepSpace — the space a fresh install comes up with.
 *
 * Creating it used to be the guard's job, which is why a macOS or Windows box
 * where the guard never ran opened Herdr with no space in it and no error to
 * read. The install makes the space itself now, on every OS, and the guard only
 * repairs what is recorded.
 *
 * A record that is already there is left byte for byte, whatever project it
 * names: it holds reports and delegations, and repointing it would hand them to
 * a different project. `herdr-app` missing (Windows or macOS without it, or a
 * headless run) does not fail the install — the step prints the exact command to
 * run by hand, the way the guard registration already does.
 */
function stepSpace() {
	const record = path.join(STATE_DIR, 'spaces', HARNESS_SPACE, 'space.json');
	if (exists(record)) {
		note(`space ${HARNESS_SPACE}: recorded for ${recordProject(record) || 'a project'} -> ${record}, left as it is`);
		return;
	}
	if (DRY) {
		say(`   [dry-run] ${spaceByHand()}`);
		return;
	}
	if (!hasCmd('herdr-app')) {
		skipped(
			`space ${HARNESS_SPACE}`,
			`herdr-app is not on PATH — no space opened, the rest of the install is unaffected; make it by hand: ${spaceByHand()}`,
		);
		return;
	}
	const status = run(harnessBin('space'), ['new', '--name', HARNESS_SPACE, '--project', P.piHome, '--kind', 'harness'], {
		allowFail: true,
		// The record's root, said out loud: `bin/space` defaults to the tree it lives
		// in, which is this checkout — the same place on a real install, and the
		// only way a run from a clone elsewhere writes where `bin/delegate` reads.
		env: { SPACE_STATE: STATE_DIR },
	});
	if (status === 0) note(`space ${HARNESS_SPACE}: ${P.piHome}, with a Boss tab -> ${record}`);
	else warn(`space ${HARNESS_SPACE} was not created — make it by hand: ${spaceByHand()}`);
}

// --- 5d. the guard service, per init system ---------------------------------
// The same default on all three systems: `bin/guard` repairs every recorded
// space and its Boss tab after a reboot, so a macOS or Windows install that
// registers no login entry opens Herdr after the next logon with nothing in it.
// It used to be opt-in there while systemd on Linux needed no flag, which made
// the documented one-liner install everything except the thing that is visible.
// PI_SKIP_SYSTEMD=1 (or PI_SKIP_SERVICES=1) is the one way out.
function skipServicesVar() {
	if (SKIP_SYSTEMD) return 'PI_SKIP_SYSTEMD';
	if (SKIP_SERVICES) return 'PI_SKIP_SERVICES';
	return null;
}

/**
 * removeLegacyGuardEntry — the login entry registered under the guard's old name, gone.
 *
 * A machine that upgrades must not end up with two entries running one guard: both repair the same
 * records, and a rebuild one is halfway through is what the other adopts. So the old name is
 * disabled and removed **before** the new one is registered, this one time, and the line says what
 * replaced what — a silence here is a second guard nobody can see.
 *
 * What counts as "the old entry exists" is per platform, and each one is a fact on disk: the unit
 * file and the plist have the old name in them, so `exists` answers directly; on Windows the task
 * name changed and the hidden launcher's path did not, so a launcher is the mark an earlier install
 * left behind. `systemd: true` is the one caller that also runs with the units copied and nothing
 * enabled — the old file is still removed there, because an enabled unit this install no longer
 * writes is exactly the entry that would start beside the new one at the next logon.
 */
function systemdGuardUnitName() {
	try {
		const units = systemdUnitsIn(path.join(P.piHome, 'systemd'), fs);
		const found = units.map((u) => u.name).find((name) => /guard\.service$/.test(name));
		if (found) return found;
	} catch {}
	return GUARD_UNIT_NAME;
}

function removeLegacyGuardEntry({ systemd = false } = {}) {
	const old = LEGACY_GUARD;
	if (systemd) {
		const file = path.join(P.serviceDir, old.unit);
		if (!exists(file)) return false;
		if (systemdUserUp() && !skipServicesVar()) {
			run('systemctl', ['--user', 'disable', '--now', old.unit], { allowFail: true });
		}
		try {
			fs.rmSync(file);
		} catch {}
		note(`guard unit: ${old.unit} -> ${systemdGuardUnitName()} (disabled and removed first — two login entries would race on the same records)`);
		return true;
	}
	if (PLAN.service === 'launchd') {
		const plist = path.join(P.serviceDir, `${old.label}.plist`);
		if (!exists(plist)) return false;
		run('launchctl', ['unload', '-w', plist], { allowFail: true });
		try {
			fs.rmSync(plist);
		} catch {}
		note(`guard login item: ${old.label} -> ${GUARD_LABEL} (the old one is unloaded and removed — two login entries would race on the same records)`);
		return true;
	}
	const launcher = guardLauncherPath({ piHome: P.piHome });
	const pidFile = guardPidPath({ piHome: P.piHome });
	if (!exists(launcher)) return false;
	run(schtasksExe(), ['/Delete', '/TN', old.taskName, '/F'], { allowFail: true });
	// Deleting the task cancels the next logon; the guard it started is still running, so the pid
	// the launcher wrote is stopped too.
	let pid = '';
	try {
		pid = fs.readFileSync(pidFile, 'utf8').trim();
	} catch {}
	if (/^[0-9]+$/.test(pid)) run('taskkill', ['/F', '/PID', pid], { allowFail: true });
	note(`guard task: ${old.taskName} -> ${GUARD_TASK_NAME} (the old entry is deleted and stopped — two login entries would race on the same records)`);
	return true;
}

/** guardByHand — the line that starts the guard once, for the OS at hand. */
function guardByHand() {
	const guard = harnessBin('guard');
	if (PLAN.platform !== 'win32') return `"${guard}" &`;
	const bash = resolveGitBash();
	return bash ? `"${bash}" "${guard}"` : `"<git-bash>\\bin\\bash.exe" "${guard}"`;
}

function stepServices() {
	if (!PLAN.services) return;
	if (PLAN.service === 'systemd') return stepSystemd();
	if (ENABLE_SERVICES) note('guard service: PI_ENABLE_SERVICES=1 is accepted — the login entry is the default now, so it changes nothing');
	const skipVar = skipServicesVar();
	if (skipVar) {
			skipped(
			'guard service (launchd / Task Scheduler)',
			`${skipVar}=1 — no login entry registered, so a space a reboot loses is repaired by hand; start it by hand: ${guardByHand()}`,
		);
		return;
	}
	const guard = harnessBin('guard');
	if (!exists(guard)) {
		// A skip that names itself is not a silent skip: a checkout with no bin/guard
		// would have a task registering nothing, and registering a task that points
		// nowhere is worse than saying so.
		warn(`guard service: ${guard} missing — nothing to register, so nothing repairs a space after a reboot`);
		say('   fix: re-run the install from the pi checkout (bin/guard is part of it), then register the entry');
		return;
	}
	if (PLAN.service === 'launchd') {
		removeLegacyGuardEntry();
		const plist = path.join(P.serviceDir, `${GUARD_LABEL}.plist`);
		writeText(plist, launchdPlist(GUARD_LABEL, guard), { mode: 0o644 });
		note(`guard login item -> ${plist}`);
		run('launchctl', ['load', '-w', plist], { allowFail: true });
		guardService = { label: `launchd login item ${plist}`, remove: `launchctl unload -w ${plist}` };
		say(`   disable: launchctl unload -w ${plist} && rm ${plist}`);
		return startGuardNow();
	}
	// The guard is bash (`#!/usr/bin/env bash`), and Task Scheduler runs a command
	// line, not a shebang: registering the file itself started nothing, which is
	// why the space never appeared on Windows. Git for Windows is
	// already the one prerequisite this platform has (INSTALL.md), so its bash is
	// the interpreter — resolved, never assumed, because `C:\Program Files` is not
	// where a per-user Git for Windows lands and a task gets no useful PATH.
	const bash = resolveGitBash();
	if (!bash) {
		warn('no Git Bash found — a task pointing at bin/guard starts nothing, so none was registered');
		say('   fix: install Git for Windows, or set PI_GIT_BASH to bash.exe, then re-run');
		return;
	}
	// The task runs a hidden launcher, not bash: bash is a console program, so
	// registering it opened a console window at logon and again on the `/Run`
	// below, and the guard loops — the window never closed. The launcher starts
	// the same bash command line with window style 0 and records the pid, so the
	// Disable line can stop the process the task delete does not reach.
	const launcher = guardLauncherPath({ piHome: P.piHome });
	const pidFile = guardPidPath({ piHome: P.piHome });
	// Before the new name is registered: the old entry must not be left running beside it.
	removeLegacyGuardEntry();
	if (writeText(launcher, hiddenLauncher({ bashPath: bash, guardPath: guard, pidPath: pidFile })))
		note(`guard launcher (hidden, no console window) -> ${launcher}`);
	const task = guardTaskCommand({ launcherPath: launcher, pidPath: pidFile });
	note('guard: registering a Task Scheduler entry at logon (this is what repairs a space and its Boss tab)');
	note(`interpreter: ${bash}   # run hidden by ${launcher}`);
	say(`   command: ${task.registered}`);
	// Printed above as the pasteable line, so run()'s own `[dry-run] cmd args`
	// echo would be a second, differently-quoted spelling of the same thing.
	if (DRY) say('   [dry-run] not registered');
	// task.exe, not task.program: a bare name goes through cmd.exe, whose quotes
	// would double the ones inside /TR and register a different command line.
	else run(task.exe, task.args, { allowFail: true });
	guardService = { label: `Task Scheduler entry ${GUARD_TASK_NAME} (hidden: ${launcher})`, remove: task.remove, stop: task.stop };
	say(`   disable: ${task.remove}`);
	say(`   disable: ${task.stop}`);
	return startGuardNow();
}

/**
 * startGuardNow — the entry is registered; now run it, and say whether the
 * space appeared.
 *
 * `/SC ONLOGON` is a promise about the *next* logon, and that is exactly what
 * the Windows box reported: install finished, Herdr opened, no space, no error.
 * So the install starts the entry once and waits a bounded time for the space,
 * and a failure names the task, the guard's log and the app instead of leaving a
 * green transcript over an empty window. A failing start does not abort the
 * install: the entry is registered, the next logon gets a try.
 */
function startGuardNow() {
	const waitMs = Number(process.env.PI_GUARD_SPACE_WAIT_MS ?? GUARD_SPACE_WAIT_MS);
	return startAndVerifyGuard({
		platform: PLAN.platform,
		piHome: P.piHome,
		uid: typeof process.getuid === 'function' ? process.getuid() : 0,
		dry: DRY,
		timeoutMs: Number.isFinite(waitMs) ? waitMs : GUARD_SPACE_WAIT_MS,
		run: (cmd, args) => run(cmd, args, { allowFail: true }),
		probe: probeSpace,
		out: { say, note },
	});
}

/** probeSpace — what `herdr-app ls` says about the harness space right now.
 * A herdr-app that is not installed or not answering yet is `running: false`,
 * which the wait reads as "not a failure yet" rather than as a missing space. */
function probeSpace() {
	const r = spawnSync('herdr-app', ['ls'], { encoding: 'utf8', env: process.env });
	if (r.error || r.status !== 0) return { running: false, id: null };
	return { running: true, id: spaceIdIn(r.stdout || '', GUARD_SPACE_NAME) };
}

/** resolveGitBash — the first bash.exe that is really there (install-lib does
 * the order and the PI_GIT_BASH override; both the guard task and the `.cmd`
 * shims are built from this one answer). */
function resolveGitBash() {
	const probe = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
	const execPath = probe.status === 0 ? (probe.stdout || '').trim() : '';
	return resolveGitBashAt({ platform: PLAN.platform, env: process.env, execPath, exists });
}

// The shim resolution, asked for once per run: a run with five wrappers and no
// Git Bash must say so once, not five times, and must write no `.cmd` at all.
let shimBash;
let shimBashSaid = false;
function shimInterpreter() {
	if (shimBash !== undefined) return shimBash;
	shimBash = resolveGitBash();
	return shimBash;
}

/**
 * installWrapper — the POSIX wrapper stays, and on win32 a `<name>.cmd` lands
 * next to it: Windows has no shebang, so a copy named `pi-bare` starts nothing
 * from PowerShell or a Herdr menu row. Git Bash keeps using the file itself.
 *
 * No bash anywhere is said once, names the override, and writes no shim: a
 * `.cmd` with a path that is not there would be the same broken menu row in a
 * new file.
 */
function installWrapper(name, scriptPath) {
	if (PLAN.platform !== 'win32') return;
	const bash = shimInterpreter();
	if (!bash) {
		if (shimBashSaid) return;
		shimBashSaid = true;
		warn('no Git Bash found — no .cmd shim written for any wrapper, so pi-bare and the rest start nothing outside Git Bash; install Git for Windows or set PI_GIT_BASH to bash.exe, then re-run');
		return;
	}
	const file = `${scriptPath}.cmd`;
	if (writeText(file, cmdShim({ bashPath: bash, scriptPath }))) note(`${name}.cmd -> ${file} (runs ${bash})`);
}

function launchdPlist(label, program, args = []) {
	const argv = [program, ...args]
		.map((a) => `        <string>${String(a).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by ~/.pi/install.mjs. Edit the source there and re-run it. -->
<plist version="1.0">
    <dict>
        <key>Label</key>
        <string>${label}</string>
        <key>ProgramArguments</key>
        <array>
${argv}
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>StandardOutPath</key>
        <string>${path.join(HOME, 'Library', 'Logs', `${label}.log`)}</string>
        <key>StandardErrorPath</key>
        <string>${path.join(HOME, 'Library', 'Logs', `${label}.log`)}</string>
    </dict>
</plist>
`;
}

/** systemdUserUp — is there a user manager to enable a unit into? */
function systemdUserUp() {
	if (PLAN.platform !== 'linux' || !hasCmd('systemctl')) return false;
	const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 0}`;
	if (!process.env.DBUS_SESSION_BUS_ADDRESS && !exists(path.join(runtime, 'bus'))) return false;
	const r = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
	return r.status === 0 || /^(running|degraded|starting|initializing)$/m.test((r.stdout || '').trim());
}

function stepSystemd() {
	const systemdDir = P.serviceDir;
	const srcDir = path.join(SOURCE_DIR, 'systemd');
	systemdInstalled = [];
	const units = [];
	// The guard unit used to be copied out of the delegation clone, because that
	// clone's `bin/guard` was the supervisor. It is not any more: the clone's copy
	// knows one hard-coded space, while `%h/.pi/bin/guard` restores everything
	// recorded in `~/.pi/state/spaces/`. So the guard unit lives in this repo's
	// systemd/ with the other units and arrives through the same loop.
	// The unit's name changed with the harness: the old entry is disabled and removed here,
	// before the new name is enabled, so a machine that upgrades has one entry and not two.
	removeLegacyGuardEntry({ systemd: true });

	// The repo's units are read off systemd/, never listed here: the timers were
	// copied without the .service files their `Unit=` names, and a hard-coded
	// list is how that happens. scripts/tests/systemd-units.test.mjs reads the
	// same directory and fails if a timer names a unit this would not copy.
	for (const unit of systemdUnitsIn(srcDir, fs)) {
		units.push({ file: path.join(srcDir, unit.name), name: unit.name, enable: unit.enable, now: unit.now });
	}

	for (const unit of units) {
		const dst = path.join(systemdDir, unit.name);
		writeText(dst, read(unit.file).replaceAll('%h', HOME), { mode: 0o644 });
		systemdInstalled.push(unit);
		note(`${unit.name} -> ${dst}`);
	}
	if (units.length === 0) return;
	const enableable = units.filter((u) => u.enable);

	if (skipServicesVar()) {
		say(`== ${skipServicesVar()}=1 — units copied, none enabled`);
	} else if (!systemdUserUp()) {
		// A container or a bare tty has the files and no user manager; enabling
		// there prints systemd's own error and looks like an installer bug.
		const now = enableable.filter((u) => u.now).map((u) => u.name);
		const later = enableable.filter((u) => !u.now).map((u) => u.name);
		const lines = [];
		if (now.length > 0) lines.push(`systemctl --user enable --now ${now.join(' ')}`);
		if (later.length > 0) lines.push(`systemctl --user enable ${later.join(' ')}`);
		skipped('enable', `no systemd user session — start it, then: ${lines.join(' && ')}`);
	} else {
		run('systemctl', ['--user', 'daemon-reload'], { allowFail: true });
		for (const unit of enableable) {
			run('systemctl', ['--user', 'enable', ...(unit.now ? ['--now'] : []), unit.name], { allowFail: true });
		}
		// `enable --now` starts a unit that was stopped; a guard that was already
		// running still holds the process from before this install, so restart it —
		// "install finished" means the guard now runs this checkout's bin/guard.
		// Named by pattern, not by file name: scripts/tests/systemd-units.test.mjs
		// fails if this file names any unit in systemd/ itself.
		const guardUnit = enableable.find((u) => /guard\.service$/.test(u.name));
		if (guardUnit) {
			say(`   start: systemctl --user restart ${guardUnit.name}`);
			run('systemctl', ['--user', 'restart', guardUnit.name], { allowFail: true });
		}
	}
}

// --- summary ----------------------------------------------------------------
function summary() {
	say('');
	note(`done — ${changed} change(s) written${DRY ? ' (dry run: nothing written)' : ''}`);
	say(`new durable space: ${DURABLE_KEY} (or: space new <name>)`);
	say('Verify:');
	say('   git config --global --get core.hooksPath        # global hooks');
	say(`   ${path.join(P.binDir, 'git-vuln-scan')} --help`);
	if (PLAN.sandbox) {
		const sandbox = sandboxSummary(PLAN, { piHome: P.piHome, bwrap: PLAN.wsl ? hasCmd('bwrap') : true });
		say(sandbox.ok ? `   ${sandbox.message} --help   # sandbox` : `   sandbox: ${sandbox.message}`);
	} else say(`   sandbox: ${sandboxSummary(PLAN).message}`);
	say('   herdr-app --version                             # desktop app');
	say('   jev count "split this task"                     # the tools bin/ puts on PATH');
	say('   bin/space list                                  # the spaces this machine records');
	if (PLAN.service === 'systemd' && systemdInstalled.length > 0) {
		say('Disable:');
		for (const unit of systemdInstalled.filter((u) => u.enable)) {
			say(`   systemctl --user disable${unit.now ? ' --now' : ''} ${unit.name}`);
		}
		// Named, so the block accounts for every file that was copied: a unit
		// without [Install] cannot be disabled and its timer starts it.
		for (const unit of systemdInstalled.filter((u) => !u.enable)) {
			say(`   # ${unit.name}: started by its timer — nothing to disable`);
		}
	} else if (PLAN.service === 'launchd') {
		if (!guardService) say('Guard login item: not registered — the line above says why, and nothing repairs a space after the next logon');
		else {
			say(`${DRY ? 'Would install' : 'Installed'}: ${guardService.label}`);
			say(`Disable: ${guardService.remove}`);
			say('Disable: launchctl unload -w ~/Library/LaunchAgents/*.plist   # every pi login item');
		}
	} else {
		if (!guardService) say('Guard task: not registered — the line above says why, and nothing repairs a space after the next logon');
		else {
			say(`${DRY ? 'Would install' : 'Installed'}: ${guardService.label}`);
			say(`Disable: ${guardService.remove}`);
			// The delete stops the next logon; the guard this install started is still
			// running with no window to close, so the launcher's pid file is named
			// next to it rather than leaving "deleted, still running" to be found out.
			if (guardService.stop) say(`Disable: ${guardService.stop}`);
		}
	}
	say('');
	say('Done. Restart pi (or run /reload) to load the extensions.');
}

// --- main -------------------------------------------------------------------
async function main() {
	OPT = parseArgs(process.argv.slice(2));
	if (OPT.dryRun) {
		DRY = true;
		process.env.PI_DRY_RUN = '1';
	}
	if (OPT.updateMods) UPDATE_MODS = true;
	// Prerequisites first: git, node and npm through this OS's package manager,
	// before the pi decision and before the first write. `--skip-prereqs` /
	// PI_SKIP_PREREQS=1 prints the skip lines and calls no package manager.
	const prereqs = stepPrerequisites();
	// Same shape as before, with one difference that matters: the pi decision is
	// the preflight's, so a missing pi (and no npm to install it) stops here with
	// an empty tree and the command for this OS, instead of at the tail with a
	// half-installed one. It also prints the banner and the git-not-on-PATH
	// warning for a run that skipped the prerequisite step on purpose, so the old
	// banner block and its own git check are gone, not repeated.
	preflight({ prereqs });
	// WSL: the plan is Linux and the sandbox is the Linux one, so nothing below
	// changes — but a path on a Windows drive loses the mode bits the hooks need,
	// and the fix is one move. Named path, named fix, once. It has to run after
	// the preflight: only then are SOURCE_DIR, AGENT_DIR and STATE_DIR known.
	for (const w of wslMountWarnings({
		wsl: PLAN.wsl,
		paths: [
			{ what: 'this pi repo', path: SOURCE_DIR },
			{ what: 'the agent dir', path: AGENT_DIR },
			{ what: 'the space state', path: STATE_DIR },
		],
	}))
		warn(w.message);
	stepAgent();
	stepRuntimeDirs();
	stepHerdrMods();
	stepGitHooks();
	stepGitignore();
	stepBins();
	await stepHerdrApp();
	stepBinsOnPath();
	stepHerdrKeys();
	stepSpace();
	await stepServices();
	summary();
}

await main();
