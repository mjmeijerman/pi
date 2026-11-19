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
// keys that point at them, the bin entries, and the guard login entry where the
// OS has one. Anything skipped on purpose (herdr-app without network, the
// delegation workspace, a login entry the person turned off with
// PI_SKIP_SYSTEMD=1) is asserted as absent or passed with the reason named, so a
// silent half-install cannot pass.
//
// Exit 0 when every row holds, 1 otherwise, one line per row.
// ============================================================================

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { POSIX_WRAPPERS, homePaths, planFor, samePath } from './install-lib.mjs';

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

// Every bash wrapper that landed on PATH also needs its Windows entry point: a
// file starting `#!/usr/bin/env bash` is a text file to PowerShell, and the
// Herdr menu row launches exactly this name. Read off the engine's list, and
// only for the wrappers whose POSIX file is there — `jev` and friends need the
// private clone, which CI skips on purpose.
for (const wrapper of POSIX_WRAPPERS) {
	const posix = path.join(P.binDir, wrapper.name);
	if (!fs.existsSync(posix)) continue;
	if (PLAN.platform === 'win32') {
		const shim = `${posix}.cmd`;
		mustExist(`${wrapper.name}.cmd`, shim);
		if (!fs.existsSync(shim)) continue;
		const text = fs.readFileSync(shim, 'utf8');
		const bash = /^"([^"]+)" "/m.exec(text)?.[1] || '';
		if (bash && fs.existsSync(bash)) pass(`${wrapper.name}.cmd interpreter`, bash);
		else fail(`${wrapper.name}.cmd interpreter`, `does not name a bash.exe that exists: ${bash || 'none'}`);
		if (text.includes(`"${posix.replace(/\\/g, '/')}"`)) pass(`${wrapper.name}.cmd target`, posix);
		else fail(`${wrapper.name}.cmd target`, `does not run ${posix}`);
	} else {
		mustBeAbsent(`${wrapper.name}.cmd`, `${posix}.cmd`, 'bash reads the shebang here');
	}
}

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

// Guard login entry: the guard is what creates and repairs the `big-boss-pi`
// space, so it installs by default on all three systems — a unit on Linux, a
// launchd plist on macOS, a Task Scheduler entry on Windows. Two reasons make a
// row a named skip rather than a failure, and both are decisions the person made
// at install time: PI_SKIP_SYSTEMD=1 (or its alias PI_SKIP_SERVICES=1) turns the
// entry off, and PI_SKIP_NETWORK=1 means there is no clone for it to point at.
const guardSkip =
	process.env.PI_SKIP_SYSTEMD === '1' ? 'PI_SKIP_SYSTEMD=1' : process.env.PI_SKIP_SERVICES === '1' ? 'PI_SKIP_SERVICES=1' : '';
const noClone = process.env.PI_SKIP_NETWORK === '1';

/** programArguments — the strings inside a plist's ProgramArguments array. */
function programArguments(plist) {
	const text = fs.readFileSync(plist, 'utf8');
	const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] || '';
	return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

if (PLAN.service === 'systemd') {
	mustExist('guard unit', path.join(P.serviceDir, 'herdr-resume.service'));
	// Named skip, not a silent pass: without the clone there is no bin/guard, and
	// the engine says the same thing in its own transcript.
	if (noClone) pass('big-boss-pi guard unit', 'not checked — PI_SKIP_NETWORK=1 skips the clone, so there is no bin/guard to point a unit at');
	else mustExist('big-boss-pi guard unit', path.join(P.serviceDir, 'big-boss-pi-guard.service'));
	// A timer without the unit its `Unit=` names is the failure this row exists
	// for: both files are copied by the same step, so nothing notices until the
	// schedule fires weeks later. Read off the installed timers, not a list.
	if (fs.existsSync(P.serviceDir)) {
		for (const name of fs.readdirSync(P.serviceDir).filter((n) => n.endsWith('.timer'))) {
			const text = fs.readFileSync(path.join(P.serviceDir, name), 'utf8');
			for (const match of text.matchAll(/^Unit=(.+)$/gm)) {
				mustExist(`timer ${name}`, path.join(P.serviceDir, match[1].trim()));
			}
		}
	}
} else if (PLAN.service === 'launchd') {
	const plist = path.join(P.serviceDir, 'dev.herdr.big-boss-pi-guard.plist');
	if (guardSkip) pass('launchd login item', `not checked — ${guardSkip} turns the entry off`);
	else if (noClone) pass('launchd login item', 'not checked — PI_SKIP_NETWORK=1 skips the clone the entry points at');
	else if (!fs.existsSync(plist)) fail('launchd login item', `${plist} missing — the guard is what creates the big-boss-pi space`);
	else {
		pass('launchd login item', plist);
		// The plist is only a login item if its ProgramArguments name a program that
		// is on disk: a file pointing at a path this machine does not have launches
		// nothing, and launchd would say so in a log nobody reads.
		const [program] = programArguments(plist);
		if (program && fs.existsSync(program)) pass('launchd login item program', program);
		else fail('launchd login item program', `${program || 'no ProgramArguments'} does not exist`);
	}
} else if (guardSkip) {
	pass('scheduled task', `not checked — ${guardSkip} turns the entry off`);
} else if (noClone) {
	pass('scheduled task', 'not checked — PI_SKIP_NETWORK=1 skips the clone the entry points at');
} else {
	// Asked of Task Scheduler, not of a file: the registration lives in the task
	// store, and "the .cmd is there" answers a different question.
	const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'schtasks.exe') : 'schtasks';
	const query = spawnSync(exe, ['/Query', '/TN', 'big-boss-pi-guard', '/FO', 'LIST'], { encoding: 'utf8' });
	if (query.error) pass('scheduled task', `not checked — no schtasks on this host (${query.error.code || 'unknown'})`);
	else if (query.status !== 0) fail('scheduled task', `schtasks /Query /TN big-boss-pi-guard exited ${query.status} — not registered, and the guard is what creates the big-boss-pi space`);
	else {
		pass('scheduled task', 'big-boss-pi-guard is registered');
		// "Task To Run" is where the interpreter and the guard are, both quoted:
		// the task runs Git Bash on a bash script, and a bare path would break at the
		// first space in `C:\Program Files`.
		const toRun = (/Task To Run:\s*\r?\n?\s*(.+)/i.exec(query.stdout)?.[1] || '').trim();
		const named = [...toRun.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		if (named.length < 2) fail('scheduled task program', `the registered command line names no quoted interpreter and guard: ${toRun || 'nothing'}`);
		else {
			const [bash, guard] = named;
			if (fs.existsSync(bash)) pass('scheduled task interpreter', bash);
			else fail('scheduled task interpreter', `${bash} does not exist`);
			if (fs.existsSync(guard)) pass('scheduled task guard', guard);
			else fail('scheduled task guard', `${guard} does not exist`);
		}
	}
}

// Herdr config: written at sections 1c and 4, before herdr-app's first launch,
// because the app's config directory used to be the app's to create — and on a
// fresh machine that skipped the mods and the menu row silently. Asserted here
// so the matrix proves it on all three OSes instead of trusting the transcript.
mustExist('herdr config dir', P.herdrConfigDir);
mustExist('herdr menu row', path.join(P.herdrConfigDir, 'programs.json'));
// The row is only a row if the program it names is on disk — that is the whole
// Windows hole: #182 wrote the row and nothing wrote `pi-bare.cmd`.
try {
	const programs = JSON.parse(fs.readFileSync(path.join(P.herdrConfigDir, 'programs.json'), 'utf8'));
	const run = Object.values(programs.programs || {})[0]?.run?.[0];
	if (run && fs.existsSync(run)) pass('herdr menu program', run);
	else if (run) fail('herdr menu program', `${run} does not exist — the row launches nothing`);
	else fail('herdr menu program', 'the entry names no program');
} catch (err) {
	fail('herdr menu program', `programs.json is not readable JSON: ${err.message}`);
}
// Counted, not named: the mods come from herdr-mods/ and a verifier that spells
// one of them turns a rename into a red matrix for no reason.
const herdrMods = process.env.HERDR_MODS || path.join(P.herdrConfigDir, 'mods');
let modCount = 0;
try {
	modCount = fs.readdirSync(herdrMods, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
} catch {
	modCount = 0;
}
if (modCount > 0) pass('herdr mods', `${modCount} in ${herdrMods}`);
else fail('herdr mods', `none in ${herdrMods} — a fresh install must write them before herdr-app runs`);

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
