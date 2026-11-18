#!/usr/bin/env node
// ============================================================================
// verify-install.mjs — assert an install, and that a second one changed nothing.
//
//   node setup.mjs -y --no-keys --no-apt --no-verify      # into a throwaway HOME
//   node scripts/verify-install.mjs --home "$HOME" --snapshot /tmp/before.json
//   node setup.mjs -y --no-keys --no-apt --no-verify
//   node scripts/verify-install.mjs --home "$HOME" --snapshot /tmp/before.json
//
// The first call asserts the manifest and writes the snapshot; the second
// asserts the manifest again and fails on any byte that moved. That is the whole
// idempotency claim, as a check instead of a sentence: the CI matrix runs it on
// Linux, macOS and Windows (blip 29, harness quality evaluation).
//
// What the manifest holds is what the OS dictates: a skills directory, the
// extensions that were picked, the config files, the global hooks and the git
// keys that point at them, the bin entries, and the guard unit where the OS has
// one. Anything skipped on purpose (herdr-app without network, the delegation
// workspace, a launchd entry nobody opted into) is asserted as absent, so a
// silent half-install cannot pass.
//
// Exit 0 when every row holds, 1 otherwise, one line per row.
// ============================================================================

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { homePaths, planFor, samePath } from './install-lib.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE;
let agentDirArg = null;
let snapshot = null;
let platform = process.platform;
let home = null;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--home') home = argv[++i];
	else if (arg === '--agent') agentDirArg = argv[++i];
	else if (arg === '--snapshot') snapshot = argv[++i];
	else if (arg === '--platform') platform = argv[++i];
	else if (arg === '-h' || arg === '--help') {
		process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 24).join('\n') + '\n');
		process.exit(0);
	} else {
		process.stderr.write(`verify-install: unknown option: ${arg}\n`);
		process.exit(2);
	}
}

home = home || process.env.PI_VERIFY_HOME || HOME;
const AGENT_DIR = agentDirArg || process.env.PI_AGENT_DIR || path.join(home, '.pi', 'agent');
const PLAN = planFor(platform, { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
const P = homePaths({ home, agentDir: AGENT_DIR, plan: PLAN });

const rows = [];
const fail = (check, detail) => rows.push({ ok: false, check, detail });
const pass = (check, detail) => rows.push({ ok: true, check, detail });

function mustExist(check, file) {
	if (fs.existsSync(file)) pass(check, file);
	else fail(check, `${file} missing`);
}

function mustBeAbsent(check, file, why) {
	if (!fs.existsSync(file)) pass(check, `absent (${why})`);
	else fail(`${check}`, `${file} present but ${why}`);
}

function gitConfig(key) {
	const r = spawnSync('git', ['config', '--global', '--get', key], {
		encoding: 'utf8',
		env: { ...process.env, HOME: home, USERPROFILE: home },
	});
	return (r.stdout || '').trim();
}

function readState() {
	try {
		return JSON.parse(fs.readFileSync(P.stateFile, 'utf8'));
	} catch {
		return null;
	}
}

// --- the manifest -----------------------------------------------------------
const state = readState();

mustExist('settings.json', path.join(AGENT_DIR, 'settings.json'));
mustExist('AGENTS.md', path.join(AGENT_DIR, 'AGENTS.md'));
mustExist('models.json', path.join(AGENT_DIR, 'models.json'));
mustExist('keybindings.json', path.join(AGENT_DIR, 'keybindings.json'));
mustExist('i-have-adhd.json', path.join(AGENT_DIR, 'i-have-adhd.json'));
mustExist('scripts/agent-pane.sh', path.join(P.piHome, 'scripts', 'agent-pane.sh'));
mustExist('git-hooks/pre-commit', path.join(P.gitHooksDir, 'pre-commit'));
if (!samePath(gitConfig('core.hooksPath'), P.gitHooksDir, platform)) fail('core.hooksPath', `is ${gitConfig('core.hooksPath') || 'unset'}, want ${P.gitHooksDir}`);
else pass('core.hooksPath', P.gitHooksDir);
if (!samePath(gitConfig('core.excludesFile'), P.gitignoreGlobal, platform)) fail('core.excludesFile', 'does not point at the global gitignore');
else pass('core.excludesFile', P.gitignoreGlobal);
mustExist('pisandbox', path.join(P.binDir, 'pisandbox'));
mustExist('pi-bare', path.join(P.binDir, 'pi-bare'));

if (state) {
	for (const skill of state.skills || []) mustExist(`skill ${skill}`, path.join(AGENT_DIR, 'skills', skill, 'SKILL.md'));
	for (const ext of state.extensions || []) mustExist(`extension ${ext}`, path.join(AGENT_DIR, 'extensions', ext));
	if (fs.existsSync(path.join(AGENT_DIR, 'skills'))) pass('skills', `${(state.skills || []).length} installed`);
}

const agentsMd = path.join(AGENT_DIR, 'AGENTS.md');
if (fs.existsSync(agentsMd)) {
	const rules = fs.readFileSync(agentsMd, 'utf8').split('\n').filter((l) => /^- /.test(l)).length;
	if (rules > 0) pass('agent rules', `${rules} rule(s)`);
	else fail('agent rules', 'AGENTS.md carries no bullet rules');
}

// Guard service: present where the OS has an init system, and only opted into
// off Linux, so a matrix run does not register a login item on a shared mac.
if (PLAN.service === 'systemd') {
	mustExist('guard unit', path.join(P.serviceDir, 'herdr-resume.service'));
} else if (PLAN.service === 'launchd') {
	mustBeAbsent('launchd login item', path.join(P.serviceDir, 'dev.herdr.big-boss-pi-guard.plist'), 'PI_ENABLE_SERVICES was not set');
} else {
	pass('scheduled task', 'not registered without PI_ENABLE_SERVICES=1');
}

// Deliberately skipped in CI: the vendor download, the private workspace.
if (process.env.PI_SKIP_NETWORK === '1') {
	mustBeAbsent('herdr-app', path.join(P.binDir, PLAN.platform === 'win32' ? 'herdr-app.exe' : 'herdr-app'), 'PI_SKIP_NETWORK=1 skipped the vendor installer');
	mustBeAbsent('big-boss-pi', path.join(home, 'big-boss-pi'), 'PI_SKIP_NETWORK=1 skips the private clone');
}

// Sandbox: Linux-only, and the pointer to it lives in AGENTS.md.
if (PLAN.sandbox) mustExist('sandbox launcher', path.join(P.piHome, 'sandbox', 'pi-sandbox.sh'));
else pass('sandbox', `unavailable on ${PLAN.platform} (expected)`);

// --- the snapshot -----------------------------------------------------------
// What a second run must leave alone. Runtime state is not in here: packages
// under agent/npm and agent/git are reconciled by pi, a session log grows by
// design, and neither is something the installer wrote.
const WATCH = ['agent', 'scripts', 'sandbox', 'git-hooks', 'herdr-mods', 'state'];
const EXCLUDE = ['npm', 'git', 'sessions', 'herdr-resume', 'retro', 'evals', 'proposals', 'bin', 'deepseek.key', 'env.secret', 'auth.json', 'models-store.json', 'suggestions.jsonl'];

function walk(dir, into) {
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return into;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const file = path.join(dir, entry.name);
		if (EXCLUDE.includes(entry.name)) continue;
		if (entry.isDirectory()) walk(file, into);
		else if (entry.isFile()) {
			const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
			into.push(`${file}\u0000${hash}`);
		}
	}
	return into;
}

function buildSnapshot() {
	const files = [];
	for (const sub of WATCH) walk(path.join(P.piHome, sub), files);
	walk(P.binDir, files);
	const config = ['core.hooksPath', 'core.excludesFile', 'init.templateDir'].map((k) => `${k}=${gitConfig(k)}`);
	return { files: files.sort(), config };
}

if (snapshot) {
	const current = buildSnapshot();
	if (fs.existsSync(snapshot)) {
		const before = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
		const beforeSet = new Set(before.files);
		const currentSet = new Set(current.files);
		const added = current.files.filter((f) => !beforeSet.has(f));
		const removed = before.files.filter((f) => !currentSet.has(f));
		const configChanged = JSON.stringify(before.config) !== JSON.stringify(current.config);
		if (added.length === 0 && removed.length === 0 && !configChanged) pass('second run', 'nothing changed');
		else {
			for (const line of added.slice(0, 8)) fail('second run: written again', line.split('\u0000')[0]);
			for (const line of removed.slice(0, 8)) fail('second run: lost', line.split('\u0000')[0]);
			if (configChanged) fail('second run: git config moved', `${before.config.join(',')} -> ${current.config.join(',')}`);
		}
	} else {
		fs.writeFileSync(snapshot, `${JSON.stringify(current, null, '\t')}\n`);
		pass('snapshot', `${current.files.length} file(s) recorded -> ${snapshot}`);
	}
}

// --- report -----------------------------------------------------------------
let failed = 0;
for (const row of rows) {
	if (!row.ok) failed++;
	process.stdout.write(`${row.ok ? 'ok  ' : 'FAIL'}  ${row.check}: ${row.detail}\n`);
}
process.stdout.write(`\n${rows.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
