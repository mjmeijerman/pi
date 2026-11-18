#!/usr/bin/env node
// ============================================================================
// install.mjs — the single installer engine, for Linux, macOS and Windows.
//
// Usage (run from anywhere, in the clone):
//   node install.mjs                     # machine where ~/.pi already exists
//   node install.mjs --install-pi        # install pi with npm first when missing
//   node setup.mjs                       # the interactive pass, then this
//
// This replaces install.sh, and its sections keep the old numbering so a reader
// can map one onto the other:
//   0  the pi binary
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
//      plist / scheduled task on macOS and Windows), HERDR_MODS.
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
	HERDR_INSTALL_PS1,
	HERDR_INSTALL_SH,
	PI_WRAPPER_BEGIN,
	PI_WRAPPER_BLOCK,
	PI_WRAPPER_END,
	helpText,
	homePaths,
	parseFlags,
	planFor,
	spawnPlan,
	spliceManagedBlock,
	systemdUnitsIn,
} from './scripts/install-lib.mjs';

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

let OPT = { installPi: false };
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

// --- 0. the pi binary -------------------------------------------------------
function stepPi() {
	const candidates = [
		path.join(process.env.PNPM_HOME || path.join(HOME, '.local', 'share', 'pnpm'), 'bin', 'pi'),
		path.join(HOME, '.local', 'bin', 'pi'),
	];
	const binName = PLAN.platform === 'win32' ? ['pi.cmd', 'pi.exe'] : ['pi'];
	const onDisk = candidates
		.flatMap((c) => (PLAN.platform === 'win32' ? binName.map((b) => path.join(path.dirname(c), b)) : [c]))
		.find((c) => exists(c));
	if (hasCmd('pi')) return;
	if (onDisk) {
		process.env.PATH = `${path.dirname(onDisk)}${path.delimiter}${process.env.PATH}`;
		note(`pi found on disk, added to PATH: ${onDisk}`);
		return;
	}
	// CI provisions a runner with no pi on purpose: the installer has to prove it
	// wires the config without one, so the check is a skip there and a stop here.
	if (process.env.PI_ALLOW_MISSING_PI === '1') {
		skipped('pi binary', 'PI_ALLOW_MISSING_PI=1 — config only');
		return;
	}
	if (OPT.installPi && hasCmd('npm')) {
		note('installing pi via npm (global)');
		run('npm', ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent']);
		return;
	}
	warn("'pi' not found on PATH. Install it first, e.g.:");
	say('   npm install -g --ignore-scripts @earendil-works/pi-coding-agent');
	say('   (or: pnpm add -g @earendil-works/pi-coding-agent)');
	say('   Then re-run this installer (add --install-pi to auto-install).');
	process.exit(1);
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
		const wrote = copyTree(src, dst);
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
async function stepHerdrApp() {
	const bin = P.herdrInstalled;
	if (bin && exists(bin)) {
		note(`herdr-app already installed -> ${bin}`);
	} else if (SKIP_NETWORK) {
		skipped('herdr-app', 'PI_SKIP_NETWORK=1 — vendor installer not downloaded');
	} else if (PLAN.herdrInstall === 'sh') {
		if (!hasCmd('curl')) {
			warn('curl not found — cannot install herdr-app, skipping');
		} else {
			note(`installing herdr-app from ${HERDR_INSTALL_SH}`);
			const r = await runShell(`curl -fsSL ${HERDR_INSTALL_SH} | sh`);
			if (r !== 0) warn(`herdr-app installer failed — install it by hand from ${HERDR_INSTALL_SH}`);
		}
	} else {
		note(`installing herdr-app from ${HERDR_INSTALL_PS1}`);
		const r = await runShell(`powershell -NoProfile -Command "irm ${HERDR_INSTALL_PS1} | iex"`);
		if (r !== 0) warn(`herdr-app installer failed — install it by hand from ${HERDR_INSTALL_PS1}`);
	}
	if (bin && exists(bin)) {
		const how = linkOrCopy(bin, path.join(P.binDir, PLAN.platform === 'win32' ? 'herdr-app.exe' : 'herdr-app'));
		note(`herdr-app -> ${path.join(P.binDir, 'herdr-app')} (${how})`);
	} else {
		skipped('herdr-app', `${bin || 'installer'} missing — skipped the bin entry`);
	}
}

function runShell(command) {
	if (DRY) {
		say(`   [dry-run] ${command}`);
		return 0;
	}
	const shell = PLAN.platform === 'win32' ? 'powershell' : 'sh';
	const args = PLAN.platform === 'win32' ? ['-NoProfile', '-Command', command.replace(/^powershell -NoProfile -Command /, '')] : ['-c', command];
	const r = spawnSync(shell, args, { stdio: 'inherit' });
	return r.status ?? 1;
}

// --- 5b/5c. the delegation workspace ---------------------------------------
function stepBoss() {
	if (exists(BOSS_DIR)) {
		note(`big-boss-pi workspace already present -> ${BOSS_DIR}`);
	} else if (SKIP_NETWORK) {
		skipped('big-boss-pi', 'PI_SKIP_NETWORK=1 — not cloned');
	} else if (hasCmd('gh') && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0) {
		note(`cloning ${BOSS_REPO} via gh -> ${BOSS_DIR}`);
		run('gh', ['repo', 'clone', BOSS_REPO, BOSS_DIR], { allowFail: true });
	} else {
		note(`cloning ${BOSS_REPO} over SSH -> ${BOSS_DIR}`);
		run('git', ['clone', `git@github.com:${BOSS_REPO}.git`, BOSS_DIR], { allowFail: true });
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
	if (PLAN.sandbox) say(`   ${path.join(P.piHome, 'sandbox', 'pi-sandbox.sh')} --help   # sandbox`);
	else say(`   sandbox: unavailable on ${PLAN.platform} — pi runs unsandboxed here`);
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
	say('== pi installer ==');
	say(`   source : ${SOURCE_DIR}`);
	say(`   agent  : ${AGENT_DIR}`);
	say(`   system : ${PLAN.platform}${PLAN.sandbox ? ' (sandbox available)' : ' (no sandbox)'}`);

	stepPi();
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
