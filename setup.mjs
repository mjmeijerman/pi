#!/usr/bin/env node
// ============================================================================
// setup.mjs — the interactive pass: what to keep, then install.mjs.
//
//   git clone git@github.com:mjmeijerman/pi.git ~/.pi
//   cd ~/.pi && ./setup.sh          # = node setup.mjs
//
// It asks four things, with a default on every question:
//   1. skills      — one per skill in agent/skills (+ ~/.pi/skills extras)
//   2. extensions  — one per extension in agent/extensions
//   3. rules       — one per bullet rule in agent/AGENTS.md, "rule 4 of 17",
//                    each shown by its own first line. The filtered AGENTS.md
//                    is written from the answers.
//   4. keys        — TYPESAFE_API_KEY (jev) and the DeepSeek key models.json
//                    reads. Input is hidden, a key is never echoed, never
//                    logged, and only ever written to the file that owns it.
// Then it runs install.mjs, reconciles the pi packages, and verifies.
//
// Answers are recorded in ~/.pi/state/setup.json, so a dropped rule stays
// dropped and only what the file does not cover gets asked again. --reask
// ignores the record.
//
// Flags: node setup.mjs --help prints the list. It is one table
// (scripts/install-lib.mjs, ENGINE_FLAGS.setup) that the parser reads, so the
// printed flags are the accepted flags; docs/install.md is the human copy.
//
// Radar basis (Vol. 35): #1 agent sandboxing (Adopt), #36 agent instruction
// bloat (a rule nobody wants is a rule that gets skipped), #99 Safe Chain.
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
	extensionNames,
	filterAgentsMd,
	helpText,
	homePaths,
	nodePreflight,
	parseAgentsMd,
	parseFlags,
	parseRuleSelection,
	pinnedNodeMajor,
	planFor,
	ruleAnswer,
	skillNames,
	spawnPlan,
} from './scripts/install-lib.mjs';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(HOME, '.pi', 'agent');
// PI_PLATFORM exists so the per-OS branches can be exercised from one host (CI
// and the tests both use it); a real install reads the platform it runs on.
const PLAN = planFor(process.env.PI_PLATFORM || process.platform, process.env);
const P = homePaths({ home: HOME, agentDir: AGENT_DIR, plan: PLAN });
const TTY = Boolean(process.stdin.isTTY);

const say = (line) => process.stdout.write(`${line}\n`);
const note = (line) => process.stdout.write(`   ${line}\n`);
const warn = (line) => process.stderr.write(`!! ${line}\n`);
const step = (name) => say(`\n== ${name}`);
const die = (message) => {
	warn(message);
	process.exit(1);
};

// --- flags ------------------------------------------------------------------
// One table in scripts/install-lib.mjs (ENGINE_FLAGS.setup) drives both the
// parser and `--help`, so the printed flags are the accepted flags.
function parseArgs(argv) {
	let opts;
	try {
		opts = parseFlags('setup', argv);
	} catch (err) {
		die(err.message);
	}
	if (opts.help) {
		say(helpText('setup', { command: 'node setup.mjs' }));
		process.exit(0);
	}
	return opts;
}

// --- prompts ----------------------------------------------------------------
// A default on every question, and no prompt at all when there is nobody to
// answer: -y, a piped stdin, or --yes all mean "the default".
async function confirm(question, def = true) {
	if (OPT.yes || !TTY) {
		note(`${question} -> ${def ? 'yes' : 'no'} (${OPT.yes ? '-y' : 'no tty'})`);
		return def;
	}
	const answer = await askLine(`${question} [${def ? 'Y/n' : 'y/N'}] `);
	if (answer === '') return def;
	return /^y(es)?$/i.test(answer.trim());
}

function askLine(question) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

/**
 * askSecret — read a line with the terminal echo off. The value is never printed
 * and never returned by anything that logs: the caller writes it to one file.
 */
function askSecret(question) {
	if (!TTY) return Promise.resolve('');
	return new Promise((resolve) => {
		process.stdout.write(question);
		const stdin = process.stdin;
		const wasRaw = stdin.isRaw;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		let buf = '';
		const done = (value, code = 0) => {
			stdin.setRawMode(Boolean(wasRaw));
			stdin.pause();
			stdin.removeListener('data', onData);
			process.stdout.write('\n');
			if (code) process.exit(code);
			resolve(value);
		};
		const onData = (chunk) => {
			for (const ch of chunk) {
				if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(buf);
				if (ch === '\u0003') return done('', 130);
				if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
				else buf += ch;
			}
		};
		stdin.on('data', onData);
	});
}

// --- state ------------------------------------------------------------------
function readState() {
	try {
		return JSON.parse(fs.readFileSync(P.stateFile, 'utf8'));
	} catch {
		return { version: 1, skills: [], extensions: [], rules: {}, keys: {} };
	}
}

function writeState(state) {
	if (OPT.dryRun) return;
	fs.mkdirSync(path.dirname(P.stateFile), { recursive: true });
	fs.writeFileSync(P.stateFile, `${JSON.stringify(state, null, '\t')}\n`);
}

// --- descriptions -----------------------------------------------------------
function skillDescription(dir) {
	try {
		const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
		const line = /^description:[ \t]*(.*)$/m.exec(text);
		return trimDescription(line ? line[1].replace(/^["']|["']$/g, '') : '');
	} catch {
		return '';
	}
}

function extensionDescription(file) {
	try {
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		if (lines[0] === '/**') {
			const body = [];
			for (const line of lines.slice(1, 20)) {
				if (line.startsWith(' * ')) body.push(line.slice(3));
				else if (body.length) break;
			}
			return trimDescription(body.join(' '));
		}
		const comment = lines.slice(0, 3).find((l) => /^\/\/ [A-Za-z0-9]/.test(l));
		return trimDescription(comment ? comment.slice(3) : '');
	} catch {
		return '';
	}
}

function trimDescription(text) {
	let d = String(text || '').trim();
	const first = /^([^.]{25,})\..*/.exec(d);
	if (first) d = first[1];
	if (d.length > 96) d = `${d.slice(0, 96).replace(/\s+\S*$/, '')}…`;
	return d;
}

// --- 1. skills --------------------------------------------------------------
async function chooseSkills(state) {
	step('skills');
	const dirs = [
		{ dir: path.join(SOURCE_DIR, 'agent', 'skills'), label: 'repo' },
		{ dir: path.join(P.piHome, 'skills'), label: 'local' },
	];
	const names = [];
	for (const { dir, label } of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const name of skillNames(dir, (d) => fs.readdirSync(d, { withFileTypes: true }))) {
			if (label === 'local' && fs.existsSync(path.join(SOURCE_DIR, 'agent', 'skills', name))) continue;
			names.push({ name, dir: path.join(dir, name), label });
		}
	}
	if (names.length === 0) {
		note('no skills found');
		return [];
	}
	const total = names.length;
	const picked = [];
	let i = 0;
	for (const { name, dir, label } of names) {
		i++;
		const recorded = !OPT.reask && Array.isArray(state.skills) && state.skills.includes(name);
		const forced = OPT.skills ? OPT.skills.includes(name) : undefined;
		const desc = skillDescription(dir) || '(no description in SKILL.md)';
		note(`[${i}/${total}] ${name}${label === 'local' ? ' (local)' : ''}`);
		note(`        ${desc}`);
		let keep;
		if (forced !== undefined) keep = forced;
		else if (recorded) keep = true;
		else keep = await confirm(`install ${name}?`, true);
		if (keep) picked.push(name);
		else note(`skipped: ${name}`);
	}
	return picked;
}

// --- 2. extensions ----------------------------------------------------------
async function chooseExtensions(state) {
	step('extensions');
	const dir = path.join(SOURCE_DIR, 'agent', 'extensions');
	if (!fs.existsSync(dir)) {
		note('no extensions found');
		return [];
	}
	const all = extensionNames(dir, (d) => fs.readdirSync(d, { withFileTypes: true }));
	const picked = [];
	let i = 0;
	for (const name of all) {
		i++;
		const recorded = !OPT.reask && Array.isArray(state.extensions) && state.extensions.includes(`${name}.ts`);
		const forced = OPT.extensions ? OPT.extensions.includes(name) || OPT.extensions.includes(`${name}.ts`) : undefined;
		note(`[${i}/${all.length}] ${name}`);
		note(`        ${extensionDescription(path.join(dir, `${name}.ts`)) || '(no header comment)'}`);
		let keep;
		if (forced !== undefined) keep = forced;
		else if (recorded) keep = true;
		else keep = await confirm(`install ${name}?`, true);
		if (keep) picked.push(`${name}.ts`);
		else note(`skipped: ${name}`);
	}
	return picked;
}

// --- 3. agent rules ---------------------------------------------------------
async function chooseRules(state) {
	step('agent rules (agent/AGENTS.md)');
	const src = path.join(SOURCE_DIR, 'agent', 'AGENTS.md');
	if (!fs.existsSync(src)) {
		note('no agent/AGENTS.md — nothing to filter');
		return null;
	}
	const text = fs.readFileSync(src, 'utf8');
	const { rules } = parseAgentsMd(text);
	const forced = OPT.rules ? parseRuleSelection(OPT.rules, rules.length) : null;
	const answer = {};
	let i = 0;
	for (const rule of rules) {
		i++;
		// Three sources, in order: an explicit --rules= flag, the answer this file
		// recorded last time, then the person. Re-asking only the uncovered ones is
		// what keeps a dropped rule dropped.
		const fromFlag = forced ? forced.get(rule.index) : undefined;
		const recorded = OPT.reask ? undefined : ruleAnswer(state, rule.slug);
		let keep;
		if (fromFlag !== undefined) keep = fromFlag;
		else if (recorded !== undefined) keep = Boolean(recorded);
		else keep = await confirm(`rule ${i} of ${rules.length} — ${firstLine(rule.text)}`, true);
		answer[rule.slug] = keep;
		if (!keep) note(`dropped: rule ${i}`);
	}
	return { text, answer };
}

function firstLine(text) {
	const cut = String(text).split(/(?<=\.)\s/)[0];
	return cut.length > 150 ? `${cut.slice(0, 150)}…` : cut;
}

/**
 * writeAgentsMd — the filtered rule set, and never over an edit without asking.
 * A target that already holds the filtered text is left alone (idempotent).
 *
 * `apply` is what an explicit `--rules=` on the command line means: the person
 * named the rule set in the invocation, so it is written, not offered. The
 * confirm stays for the interactive path, where a differing AGENTS.md may be
 * one somebody edited by hand and a default of "keep it" is the safe answer.
 */
async function writeAgentsMd(filtered, { apply = false } = {}) {
	const dst = path.join(AGENT_DIR, 'AGENTS.md');
	if (!apply && fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') !== filtered) {
		const replace = await confirm(`${AGENTS_FILE_REL} exists and differs — rewrite it from your rule answers?`, false);
		if (!replace) {
			note('kept the existing AGENTS.md — the rule answers were recorded, not applied');
			return false;
		}
	}
	if (OPT.dryRun) {
		note(`[dry-run] would write ${dst}`);
		return true;
	}
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.writeFileSync(dst, filtered);
	note(`wrote ${dst} (${filtered.split('\n').filter((l) => /^- /.test(l)).length} rules)`);
	return true;
}

const AGENTS_FILE_REL = 'AGENTS.md';

// --- 4. keys ----------------------------------------------------------------
/**
 * The DeepSeek key is read by models.json (`!cat ~/.pi/agent/deepseek.key`); the
 * jev key is read from the TYPESAFE_API_KEY= line of ~/.pi/agent/env.secret.
 * Both are written mode 600 and never printed, echoed or logged.
 */
async function askKeys(state) {
	step('keys');
	const deepseek = path.join(AGENT_DIR, 'deepseek.key');
	const envSecret = path.join(AGENT_DIR, 'env.secret');
	state.keys = state.keys || {};

	if (OPT.noKeys) {
		note('--no-keys — no key was asked for');
		return;
	}

	if (fs.existsSync(deepseek) && !OPT.forceKey) {
		note('deepseek.key already present — left alone (use --force-key to replace)');
		state.keys.deepseek = 'present';
	} else if (!TTY && !process.env.DEEPSEEK_API_KEY) {
		note('deepseek.key absent and nothing to answer with — skipped; the default model fails until it exists');
		state.keys.deepseek = 'skipped';
	} else {
		const key = (process.env.DEEPSEEK_API_KEY || (await askSecret('   Paste the DeepSeek API key (hidden, empty to skip): '))).trim();
		if (!key) {
			note('skipped — the default model will fail until the key exists (umask 077; printf "%s\\n" sk... > deepseek.key)');
			state.keys.deepseek = 'skipped';
		} else if (!key.startsWith('sk-')) {
			warn("that does not look like a DeepSeek key (expected prefix 'sk-'); not written");
			state.keys.deepseek = 'skipped';
		} else if (OPT.dryRun) {
			note(`[dry-run] would write ${deepseek} (mode 600)`);
		} else {
			writeSecretFile(deepseek, `${key}\n`);
			note(`wrote ${deepseek} (mode 600, never printed)`);
			state.keys.deepseek = 'present';
		}
	}

	const hasJev = fs.existsSync(envSecret) && /^TYPESAFE_API_KEY=/m.test(fs.readFileSync(envSecret, 'utf8'));
	if (hasJev) {
		note('TYPESAFE_API_KEY already present in env.secret — left alone');
		state.keys.jev = 'present';
		return;
	}
	const jevKey = (process.env.TYPESAFE_API_KEY || (TTY ? await askSecret('   Paste TYPESAFE_API_KEY for jev (hidden, empty to skip): ') : '')).trim();
	if (!jevKey) {
		note('jev has no key — /jev calls will fail until TYPESAFE_API_KEY is set; skipped');
		state.keys.jev = 'skipped';
		return;
	}
	if (OPT.dryRun) {
		note(`[dry-run] would add TYPESAFE_API_KEY to ${envSecret} (mode 600)`);
		return;
	}
	const current = fs.existsSync(envSecret) ? fs.readFileSync(envSecret, 'utf8') : '';
	writeSecretFile(envSecret, `${current}${current && !current.endsWith('\n') ? '\n' : ''}TYPESAFE_API_KEY=${jevKey}\n`);
	note(`wrote TYPESAFE_API_KEY to ${envSecret} (mode 600, never printed)`);
	state.keys.jev = 'present';
}

function writeSecretFile(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fd = fs.openSync(file, 'w', 0o600);
	fs.writeFileSync(fd, text);
	fs.closeSync(fd);
	fs.chmodSync(file, 0o600);
}

// --- preflight + system packages -------------------------------------------
function have(cmd) {
	if (PLAN.platform === 'win32') {
		const r = spawnSync('where', [cmd], { stdio: 'ignore' });
		if (r.error === undefined) return r.status === 0;
	}
	return spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function run(cmd, args, { quiet = false } = {}) {
	if (OPT.dryRun) {
		note(`[dry-run] ${cmd} ${args.join(' ')}`);
		return 0;
	}
	const spec = spawnPlan(cmd, args, { platform: PLAN.platform });
	return spawnSync(spec.file, spec.args, {
		stdio: quiet ? 'ignore' : 'inherit',
		windowsVerbatimArguments: spec.windowsVerbatimArguments,
	}).status ?? 1;
}

function preflight() {
	step('preflight');
	note(`source : ${SOURCE_DIR}`);
	note(`agent  : ${AGENT_DIR}`);
	note(`system : ${PLAN.platform}${PLAN.sandbox ? '' : ' (sandbox unavailable here)'}`);
	if (!fs.existsSync(path.join(SOURCE_DIR, 'agent'))) die('run this from the cloned pi repo (agent/ not found)');
	if (!have('git')) die('git is not installed');
	// One file owns the number: mise.toml. The messages come from install-lib, so
	// `node --test scripts/tests/mise-pin.test.mjs` can pin the text that is
	// really printed instead of grepping for a literal (blip 68).
	const pin = pinnedNodeMajor(SOURCE_DIR, fs.readFileSync);
	const probe = spawnSync('node', ['-v'], { encoding: 'utf8' });
	const verdict = nodePreflight({
		pin,
		nodeVersion: probe.status === 0 ? probe.stdout.trim() : undefined,
		nodeMajor: probe.status === 0 ? Number.parseInt(process.versions.node.split('.')[0], 10) : undefined,
	});
	if (verdict.level === 'die') die(verdict.message);
	if (verdict.level === 'warn') warn(verdict.message);
	if (!have('pi')) note('pi is not on PATH yet; install.mjs can install it with --install-pi');
}

async function systemPackages() {
	step('system packages');
	if (PLAN.platform !== 'linux') {
		note(`nothing to install with a package manager on ${PLAN.platform} — skipped`);
		return;
	}
	const wanted = [
		['bwrap', 'bubblewrap'],
		['jq', 'jq'],
		['arecord', 'alsa-utils'],
		['curl', 'curl'],
		['gh', 'gh'],
	];
	const missing = wanted.filter(([bin]) => !have(bin));
	if (missing.length === 0) {
		note('all required packages present');
		return;
	}
	for (const [bin, pkg] of missing) note(`missing: ${bin}  (apt: ${pkg})`);
	const pkgs = [...new Set(missing.map(([, pkg]) => pkg))];
	note(`install with: sudo apt-get install -y ${pkgs.join(' ')}`);
	if (OPT.doApt && have('apt-get') && (await confirm('install them now with sudo apt-get?', false))) {
		run('sudo', ['apt-get', 'install', '-y', ...pkgs]);
	} else {
		note('skipped — install them by hand, or re-run with --no-apt to keep it quiet');
	}
}

// --- install ----------------------------------------------------------------
function runInstaller(env) {
	step('install.mjs');
	const args = [];
	if (OPT.dryRun) args.push('--dry-run');
	if (OPT.installPi) args.push('--install-pi');
	if (env.PI_SKILLS) args.push(`--skills=${splitList(env.PI_SKILLS).join(',')}`);
	if (env.PI_EXTENSIONS) args.push(`--extensions=${splitList(env.PI_EXTENSIONS).join(',')}`);
	const status = spawnSync(process.execPath, [path.join(SOURCE_DIR, 'install.mjs'), ...args], {
		stdio: 'inherit',
		env: { ...process.env, ...env },
	}).status;
	if (status !== 0) die('install.mjs failed — fix the line above and re-run');
}

function splitList(value) {
	return String(value || '')
		.split(/[\s,]+/)
		.filter(Boolean);
}

// --- pi packages, identity, optional extras, verification -------------------
function piPackages() {
	step('pi packages (declared in settings.json)');
	if (process.env.PI_SKIP_NETWORK === '1') {
		note('PI_SKIP_NETWORK=1 — no package reconciliation');
		return;
	}
	if (!have('pi')) {
		note('skipped: pi is not installed yet');
		return;
	}
	const settings = path.join(AGENT_DIR, 'settings.json');
	let packages = [];
	try {
		packages = JSON.parse(fs.readFileSync(settings, 'utf8')).packages || [];
	} catch {
		note('no readable settings.json — skipped');
		return;
	}
	if (packages.length === 0) note('none declared');
	else for (const pkg of packages) note(pkg);
	if (run('pi', ['update', '--extensions'], { quiet: true }) !== 0) warn('package reconciliation failed (offline?); pi retries on next start');
	else note('packages reconciled (pi update --extensions)');
}

function gitIdentity() {
	step('git identity and GitHub auth');
	const name = spawnSync('git', ['config', '--global', '--get', 'user.name'], { encoding: 'utf8' }).stdout || '';
	const email = spawnSync('git', ['config', '--global', '--get', 'user.email'], { encoding: 'utf8' }).stdout || '';
	if (name.trim() && email.trim()) note(`${name.trim()} <${email.trim()}>`);
	else {
		warn('git identity is not set globally');
		note('git config --global user.name <you>');
		note('git config --global user.email <you@example.com>');
	}
	if (!have('gh')) note('gh not installed — the PR workflow and merge-guard need it');
	else if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0) note('gh: authenticated');
	else warn('gh is not authenticated — run gh auth login');
}

async function extras() {
	step('optional extras');
	const model = process.env.PI_LOCAL_MODEL || 'qwen3.8:27b';
	if (!have('ollama')) note('ollama is not installed — the local_llm tool stays unavailable');
	else if (OPT.withOllama || (await confirm(`pull the local model ${model} (~17 GB)?`, false))) run('ollama', ['pull', model]);
	else note(`skipped — /local will fail until: ollama pull ${model}`);

	const lock = path.join(AGENT_DIR, 'dictation', 'requirements.lock');
	if (!fs.existsSync(lock)) note('no dictation requirements.lock — the extension reports itself unavailable');
	else if (fs.existsSync(path.join(AGENT_DIR, 'dictation', 'venv', 'bin', 'python'))) note('dictation venv already exists');
	else if (OPT.withDictation || (await confirm('build the faster-whisper venv (~2.5 GB of wheels)?', false))) {
		run('python3', ['-m', 'venv', path.join(AGENT_DIR, 'dictation', 'venv')]);
	}
	else note('skipped — re-run with --with-dictation to build it');
}

function verify() {
	step('verification');
	const countDirs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length : 0);
	const countExt = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).length : 0);
	const config = (key) => (spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).stdout || '').trim() || 'MISSING';
	note(`skills      : ${countDirs(path.join(AGENT_DIR, 'skills'))}`);
	note(`extensions  : ${countExt(path.join(AGENT_DIR, 'extensions'))}`);
	note(`rules       : ${fs.existsSync(path.join(AGENT_DIR, 'AGENTS.md')) ? fs.readFileSync(path.join(AGENT_DIR, 'AGENTS.md'), 'utf8').split('\n').filter((l) => /^- /.test(l)).length : 0}`);
	note(`hooksPath   : ${config('core.hooksPath')}`);
	note(`excludesFile: ${config('core.excludesFile')}`);
	note(`templateDir : ${config('init.templateDir')}`);
	note(`sandbox     : ${PLAN.sandbox ? path.join(P.piHome, 'sandbox', 'pi-sandbox.sh') : `unavailable on ${PLAN.platform}`}`);
	note(`api key     : ${fs.existsSync(path.join(AGENT_DIR, 'deepseek.key')) ? 'present' : 'MISSING'}`);
	const harness = path.join(P.piHome, 'scripts', 'harness-check.sh');
	if (fs.existsSync(harness) && have('bash')) {
		const out = spawnSync('bash', [harness], { encoding: 'utf8' });
		const line = (out.stdout || '').split('\n').filter((l) => /^[0-9]+ passed/.test(l)).pop();
		note(`harness-chk : ${line || 'could not run'}`);
	}
}

// --- main -------------------------------------------------------------------
let OPT = {};

async function main() {
	OPT = parseArgs(process.argv.slice(2));
	if (OPT.dryRun) process.env.PI_DRY_RUN = '1';
	const state = OPT.reask ? { version: 1, skills: [], extensions: [], rules: {}, keys: {} } : readState();

	preflight();
	await systemPackages();

	const skills = await chooseSkills(state);
	const extensions = await chooseExtensions(state);
	const rules = await chooseRules(state);

	state.version = 1;
	state.skills = skills;
	state.extensions = extensions;
	state.rules = { ...(state.rules || {}), ...(rules ? rules.answer : {}) };
	if (!OPT.dryRun) writeState(state);

	if (rules) {
		const keep = (rule) => {
			const recorded = state.rules[rule.slug];
			return recorded === undefined ? true : Boolean(recorded);
		};
		await writeAgentsMd(filterAgentsMd(rules.text, keep), { apply: Boolean(OPT.rules) });
	}

	await askKeys(state);
	if (!OPT.dryRun) writeState(state);

	runInstaller({ PI_SKILLS: skills.join(' '), PI_EXTENSIONS: extensions.join(' ') });
	piPackages();
	gitIdentity();
	await extras();
	if (OPT.verify && !OPT.dryRun) verify();

	step('done');
	say(`   Config, hooks and sandbox live under ${P.piHome}.`);
	say('   Start pi in a project directory:  cd ~/some-repo && pi');
	say('');
	say('   Still manual, by design: git config --global user.name/email, gh auth login, pi auth.');
	say('   Re-run ./setup.sh any time; --reask asks again about every recorded answer.');
}

await main();
