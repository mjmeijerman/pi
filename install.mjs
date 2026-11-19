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
//   1c herdr-app mods (never overwrites a folder the person may have edited)
//   2  global git hooks (§core.hooksPath) + the init template layer
//   3  global gitignore
//   4  git-vuln-scan, pisandbox, pi-bare, herdr menu entry, the pi wrapper
//   5  herdr-app (vendor installer) per OS
//   5b big-boss-pi workspace clone, 5c its bin links
//   5d the guard service: systemd on Linux, launchd on macOS, Task Scheduler on
//      Windows — plus the weekly timers, which need systemd and say so
//
// Idempotent: a second run changes nothing. Never touches auth.json, sessions,
// models-store.json. Never prints a key. Never overwrites a file a person may
// have edited in place (herdr mods, herdr programs.json, the wrapper block
// outside its markers, an existing AGENTS.md rule set).
//
// Env: PI_AGENT_DIR, PI_SKILLS, PI_EXTENSIONS, PI_BOSS_DIR, BOSS_REPO,
//      PI_SKIP_SYSTEMD=1 (copy units, do not enable), PI_SKIP_NETWORK=1 (no
//      vendor downloads, no clone), PI_ENABLE_SERVICES=1 (opt in to a launchd
//      plist / scheduled task on macOS and Windows), PI_SKIP_PREREQS=1 (never
//      call a package manager), HERDR_MODS.
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PI_WRAPPER_BEGIN,
	PI_WRAPPER_BLOCK,
	PI_WRAPPER_END,
	bossClonePlan,
	herdrAttempt,
	herdrInstallCommand,
	helpText,
	homePaths,
	isRuntimeState,
	parseFlags,
	piDiskCandidates,
	piInstallCommand,
	piPreflight,
	planFor,
	prereqNodePin,
	sandboxSummary,
	spawnPlan,
	spliceManagedBlock,
	systemSummary,
	systemdUnitsIn,
	wslMountWarnings,
} from './scripts/install-lib.mjs';
import { prereqsSkipped, stepPrereqs } from './scripts/prereqs.mjs';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(HOME, '.pi', 'agent');
// PI_PLATFORM exists so the per-OS branches can be exercised from one host (CI
// and the tests both use it); a real install reads the platform it runs on.
const PLAN = planFor(process.env.PI_PLATFORM || process.platform, process.env);
const P = homePaths({ home: HOME, agentDir: AGENT_DIR, plan: PLAN });
const BOSS_REPO = process.env.BOSS_REPO || 'mjmeijerman/big-boss-pi';
const BOSS_DIR = process.env.PI_BOSS_DIR || path.join(HOME, 'big-boss-pi');
const HERDR_MODS = process.env.HERDR_MODS || path.join(P.herdrConfigDir, 'mods');
let DRY = process.env.PI_DRY_RUN === '1';
const SKIP_NETWORK = process.env.PI_SKIP_NETWORK === '1';
const SKIP_SERVICES = process.env.PI_SKIP_SYSTEMD === '1';
const ENABLE_SERVICES = process.env.PI_ENABLE_SERVICES === '1';

let OPT = { installPi: true };
let changed = 0;
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

function run(cmd, args, { quiet = false, allowFail = false } = {}) {
	if (DRY) {
		say(`   [dry-run] ${cmd} ${args.join(' ')}`);
		return 0;
	}
	const spec = spawnPlan(cmd, args, { platform: PLAN.platform });
	const r = spawnSync(spec.file, spec.args, {
		stdio: quiet ? 'ignore' : 'inherit',
		windowsVerbatimArguments: spec.windowsVerbatimArguments,
		env: process.env,
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

// --- 1c. herdr-app mods (never overwrite an edited folder) ------------------
function stepHerdrMods() {
	const src = path.join(SOURCE_DIR, 'herdr-mods');
	if (!exists(src) || !exists(P.herdrConfigDir)) return;
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dst = path.join(HERDR_MODS, entry.name);
		if (exists(dst)) {
			say(`== kept existing herdr mod: ${entry.name}`);
			continue;
		}
		copyTree(path.join(src, entry.name), dst);
		note(`installed herdr mod: ${entry.name} -> ${dst}`);
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

	// pisandbox and pi-bare: the sandbox without the absolute path (blip 1), and
	// the sanctioned way out of it, as a program a menu can launch.
	for (const name of ['pisandbox', 'pi-bare']) {
		const src = path.join(P.piHome, 'scripts', name);
		if (!exists(src)) {
			warn(`scripts/${name} not found — skipped`);
			continue;
		}
		if (!DRY) fs.chmodSync(src, 0o755);
		const how = linkOrCopy(src, path.join(P.binDir, name));
		note(`${name} -> ${path.join(P.binDir, name)} (${how})`);
	}

	// The Herdr menu row is app config, not harness config: install the file when
	// Herdr has none, never overwrite one somebody edited.
	const programsSrc = path.join(SOURCE_DIR, 'sandbox', 'herdr-programs.json');
	const programsDst = path.join(P.herdrConfigDir, 'programs.json');
	if (exists(programsSrc) && exists(P.herdrConfigDir)) {
		if (exists(programsDst)) {
			say('== herdr programs.json exists — add the pi-bare entry from sandbox/herdr-programs.json by hand');
		} else {
			const entry = JSON.parse(read(programsSrc));
			const key = Object.keys(entry.programs || {})[0];
			if (key && entry.programs[key].run && PLAN.platform !== 'linux') {
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

// --- 5b/5c. the delegation workspace ---------------------------------------
/**
 * ghAuthed — is `gh` here AND logged in? A gh that exists but is not authed
 * cannot clone, and asking it to is how the first attempt used to die quietly.
 */
function ghAuthed() {
	return hasCmd('gh') && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
}

/**
 * cloneBoss — try the transports in the order scripts/install-lib.mjs gives,
 * checking each exit status here rather than through run()'s warn path.
 *
 * The order is the fix: https needs no key, so a public repo arrives on a bare
 * machine; SSH is last and says why it is last. Two details keep it honest —
 * the status is read for each attempt instead of the loop moving on regardless,
 * and a failed clone's half-made directory is removed before the next attempt,
 * because the check at the top of stepBoss reads "exists" as "already present"
 * and a leftover directory would make every future run report success.
 * Returns the transport that landed, or null.
 */
function cloneBoss() {
	for (const attempt of bossClonePlan({ ghAuthed: ghAuthed(), hasNetwork: true, repo: BOSS_REPO, dir: BOSS_DIR })) {
		note(`cloning ${BOSS_REPO} via ${attempt.transport} -> ${BOSS_DIR}`);
		if (attempt.transport === 'ssh') {
			warn(`${BOSS_REPO} over SSH needs a GitHub key — ${BOSS_REPO} is public, so check the network before the key`);
		}
		const status = run(attempt.cmd, attempt.args, { allowFail: true });
		if (status === 0) return attempt.transport;
		if (exists(BOSS_DIR)) fs.rmSync(BOSS_DIR, { recursive: true, force: true });
	}
	return null;
}

function stepBoss() {
	if (exists(BOSS_DIR)) {
		note(`big-boss-pi workspace already present -> ${BOSS_DIR}`);
	} else if (SKIP_NETWORK) {
		skipped('big-boss-pi', 'PI_SKIP_NETWORK=1 — not cloned');
	} else {
		const landed = cloneBoss();
		if (landed) note(`big-boss-pi cloned via ${landed} -> ${BOSS_DIR}`);
		else warn(`big-boss-pi did not arrive — clone ${BOSS_REPO} by hand into ${BOSS_DIR}`);
	}

	// The workspace's own bin/ scripts, on PATH under their bare names: AGENTS.md
	// and every spec call them as `jev`, `delegate` and `local-run`.
	const binDir = path.join(BOSS_DIR, 'bin');
	if (!exists(binDir)) {
		skipped('jev/delegate/local-run', `${binDir} missing`);
		return;
	}
	for (const name of ['jev', 'delegate', 'local-run']) {
		const src = path.join(binDir, name);
		if (!exists(src)) {
			warn(`${src} missing — skipped its bin entry`);
			continue;
		}
		const dest = path.join(P.binDir, name);
		const how = linkOrCopy(src, dest);
		note(`${name} -> ${dest} (${how})`);
	}
}

// --- 5d. the guard service, per init system ---------------------------------
function stepServices() {
	if (!PLAN.services) return;
	if (PLAN.service === 'systemd') return stepSystemd();
	if (SKIP_SERVICES || !ENABLE_SERVICES) {
		skipped(
			'guard service (launchd / Task Scheduler)',
			`opt-in on ${PLAN.platform}: re-run with PI_ENABLE_SERVICES=1 to install a login entry`,
		);
		return;
	}
	const guard = path.join(BOSS_DIR, 'bin', 'guard');
	if (!exists(guard)) {
		skipped('guard service', `${guard} missing — inside the delegation workspace`);
		return;
	}
	if (PLAN.service === 'launchd') {
		const plist = path.join(P.serviceDir, 'dev.herdr.big-boss-pi-guard.plist');
		writeText(plist, launchdPlist('dev.herdr.big-boss-pi-guard', guard), { mode: 0o644 });
		note(`guard login item -> ${plist}`);
		run('launchctl', ['load', '-w', plist], { allowFail: true });
		say(`   disable: launchctl unload -w ${plist} && rm ${plist}`);
		return;
	}
	note('guard: registering a Task Scheduler entry at logon');
	run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'big-boss-pi-guard', '/TR', guard], { allowFail: true });
	say('   disable: schtasks /Delete /TN big-boss-pi-guard /F');
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
	const bossUnit = path.join(BOSS_DIR, 'systemd', 'big-boss-pi-guard.service');
	if (exists(bossUnit)) units.push({ file: bossUnit, name: 'big-boss-pi-guard.service', enable: true, now: true });
	else warn(`${bossUnit} not found — skipped the big-boss-pi guard unit`);

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

	if (SKIP_SERVICES) {
		say('== PI_SKIP_SYSTEMD=1 — units copied, none enabled');
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
	}
}

// --- summary ----------------------------------------------------------------
function summary() {
	say('');
	note(`done — ${changed} change(s) written${DRY ? ' (dry run: nothing written)' : ''}`);
	say('Verify:');
	say('   git config --global --get core.hooksPath        # global hooks');
	say(`   ${path.join(P.binDir, 'git-vuln-scan')} --help`);
	if (PLAN.sandbox) {
		const sandbox = sandboxSummary(PLAN, { piHome: P.piHome, bwrap: PLAN.wsl ? hasCmd('bwrap') : true });
		say(sandbox.ok ? `   ${sandbox.message} --help   # sandbox` : `   sandbox: ${sandbox.message}`);
	} else say(`   sandbox: ${sandboxSummary(PLAN).message}`);
	say('   herdr-app --version                             # desktop app');
	say('   jev count "split this task"                     # delegation workspace on PATH (needs the clone)');
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
		say(`Disable: launchctl unload -w ${path.join(P.serviceDir, 'dev.herdr.big-boss-pi-guard.plist')}`);
		say('Disable: launchctl unload -w ~/Library/LaunchAgents/*.plist   # every pi login item');
	} else {
		say('Disable: schtasks /Delete /TN big-boss-pi-guard /F');
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
	// the preflight: only then are SOURCE_DIR, AGENT_DIR and BOSS_DIR known.
	for (const w of wslMountWarnings({
		wsl: PLAN.wsl,
		paths: [
			{ what: 'this pi repo', path: SOURCE_DIR },
			{ what: 'the agent dir', path: AGENT_DIR },
			{ what: 'PI_BOSS_DIR', path: BOSS_DIR },
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
	stepBoss();
	stepServices();
	summary();
}

await main();
