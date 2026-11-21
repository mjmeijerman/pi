// The DeepSeek key has to reach pi on a machine nobody tested on.
//
// `agent/models.json` is a tracked file and it said
// `"apiKey": "!cat /home/mark/.pi/agent/deepseek.key"`. The wizard was right on
// every platform — setup.mjs writes `path.join(AGENT_DIR, 'deepseek.key')` — and
// then pi ran `cat` on one laptop's home, got nothing, and said "api key auth
// failed for provider deepseek". This is the half of that class that lives in
// this repo (#68 fixed the halves that did not).
//
// The mechanism is pi's own, from docs/models-configuration.md: the field takes a
// literal, `$NAME` interpolation, or a leading `!command`. A `$NAME` needs the
// variable exported by whatever starts pi, which means every entry point (a
// terminal, Herdr, a `.cmd` shim npm regenerates on upgrade), so the choice here
// is the `!command`: a node one-liner, because pi runs it through `sh -c` on
// POSIX and through `cmd.exe` on Windows when Git Bash is not there
// (dist/core/resolve-config-value.js), and node is there because pi is node.
//
// What these tests prove: a throwaway-HOME install ships a models.json with no
// absolute home in it; the key the wizard wrote reaches an HTTP server as
// `Authorization: Bearer …` through that command and nothing else; a second
// install is byte-identical; the key never appears in output, in state, or in any
// file but its own. The Windows half is argv/string level — no Windows host
// exists here — and says so.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	DEEPSEEK_API_KEY_COMMAND,
	apiKeyShell,
	cmdShim,
	deepseekApiKey,
	deepseekKeyState,
	resolveApiKey,
} from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_MODELS = path.join(ROOT, 'agent', 'models.json');
// Short alias: the full constant is also what a template pair spells out, and
// the point of this file is the behaviour, not the spelling.
const shipped = DEEPSEEK_API_KEY_COMMAND;
// What a person might paste by hand instead of a command: no `!`, so pi treats
// it as a literal and never runs it.
const plain = 'notacmd';

function envFor(home) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_AGENT_DIR: path.join(home, '.pi', 'agent'),
		PI_SKIP_NETWORK: '1',
		PI_SKIP_PREREQS: '1',
		PI_ALLOW_MISSING_PI: '1',
		PI_SKIP_SERVICES: '1',
	};
	// A variable in this shell must not be the reason a test passes, and neither
	// must a path aimed at the person's own config.
	for (const name of [
		'DEEPSEEK_API_KEY',
		'TYPESAFE_API_KEY',
		'DEEPSEEK_KEY',
		'PI_CODING_AGENT_DIR',
		'PI_DRY_RUN',
		'PI_PLATFORM',
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

/** tree — every file under dir with its bytes, for a "second run changed nothing" check. */
function tree(dir) {
	const out = new Map();
	const walk = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else out.set(path.relative(dir, p), fs.readFileSync(p, 'utf8'));
		}
	};
	walk(dir);
	return out;
}

/** everyFile — path → bytes for a whole home, so a test can say "the key is only here". */
function everyFile(dir, base = dir) {
	const out = new Map();
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const [k, v] of everyFile(p, base)) out.set(k, v);
			continue;
		}
		// A socket or a pipe cannot be read as text and is not written by us.
		try {
			out.set(path.relative(base, p), fs.readFileSync(p, 'utf8'));
		} catch {
			out.set(path.relative(base, p), '');
		}
	}
	return out;
}

// `stdio: ['ignore', …]`: a real install prompts when it has a terminal, and a
// test must not wait on a pipe nobody closes. `spawnSync` blocks this event loop,
// so nothing here may be waiting on a response from this process.
const runScript = (script, args, env, cwd = ROOT) =>
	spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
		cwd,
		env,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 120000,
	});

// One throwaway home for the shipped-file checks. The idempotency and wizard
// tests below take their own, so a file one test writes cannot decide another.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-apikey-'));
const agentDir = path.join(home, '.pi', 'agent');
const env = envFor(home);
// A sample in the wizard's shape, generated per run so this file never carries a
// key-shaped literal that a scanner has to learn to ignore.
const sample = ['sk', crypto.randomBytes(16).toString('hex')].join('-');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const first = runScript('install.mjs', [], env);
const firstModelsBytes = fs.existsSync(path.join(agentDir, 'models.json'))
	? fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')
	: '';

test('the install succeeds, so the rest of this file is about a real run', () => {
	assert.equal(first.status, 0, `install.mjs failed:\n${first.stdout}${first.stderr}`);
});

test('a throwaway home gets a models.json with no absolute home in it', () => {
	const text = firstModelsBytes;
	assert.ok(!/\/home\/[a-z]/.test(text), `models.json carries an absolute home:\n${text}`);
	assert.ok(!/[A-Za-z]:\\\\Users/i.test(text), `models.json carries a Windows home:\n${text}`);
	assert.ok(!text.includes(home), 'models.json carries the home it was installed into — the same class, one machine later');
	assert.equal(deepseekApiKey(text), shipped, 'the installed key line is not the command this repo ships');
	// The line both engines print, so a person can check it in one command.
	assert.match(first.stdout, /deepseek key: /, 'install.mjs does not say whether models.json can read the key');
});

test('the installed models.json is this repo\'s, with only the key line replaced', () => {
	const tracked = JSON.parse(fs.readFileSync(SOURCE_MODELS, 'utf8'));
	const installed = JSON.parse(firstModelsBytes);
	const want = installed.providers.deepseek.apiKey;
	assert.equal(want, shipped);
	const expected = structuredClone(tracked);
	expected.providers.deepseek.apiKey = want;
	assert.deepEqual(installed, expected, 'the installed models.json is not this repo\'s models.json with one field replaced');
	// The tracked file itself: the half that needed no install to be wrong.
	assert.ok(!/\/home\/[a-z]/.test(fs.readFileSync(SOURCE_MODELS, 'utf8')), 'agent/models.json itself still carries an absolute home');
});

test('a second install is byte-identical', (t) => {
	const twice = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-apikey-twice-'));
	t.after(() => fs.rmSync(twice, { recursive: true, force: true }));
	const twiceEnv = envFor(twice);
	const once = runScript('install.mjs', [], twiceEnv);
	assert.equal(once.status, 0, `install.mjs failed:\n${once.stdout}${once.stderr}`);
	const afterOnce = tree(path.join(twice, '.pi', 'agent'));
	assert.ok(afterOnce.size > 0, 'the first install wrote nothing to the agent dir — this test would pass vacuously');
	const again = runScript('install.mjs', [], twiceEnv);
	assert.equal(again.status, 0, `the second install.mjs failed:\n${again.stdout}${again.stderr}`);
	assert.deepEqual(tree(path.join(twice, '.pi', 'agent')), afterOnce, 'the second install changed the agent dir — it is not idempotent');
	assert.ok(!`${once.stdout}${once.stderr}${again.stdout}${again.stderr}`.includes(sample), 'the installer printed the key it never saw');
});

test('the wizard writes the key where the command reads it, and never prints it', (t) => {
	// The reported symptom starts here: setup.mjs writes the key, pi then fails to
	// read it. So this runs the real wizard, with the key handed over the way it
	// hands one over itself when there is no terminal.
	const wizHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-apikey-wizard-'));
	t.after(() => fs.rmSync(wizHome, { recursive: true, force: true }));
	const wizEnv = { ...envFor(wizHome), DEEPSEEK_API_KEY: sample, TYPESAFE_API_KEY: '' };
	const wizard = runScript('setup.mjs', ['--yes', '--rules=all', '--no-verify', '--no-apt'], wizEnv);
	assert.equal(wizard.status, 0, `setup.mjs failed:\n${wizard.stdout}${wizard.stderr}`);

	const written = path.join(wizHome, '.pi', 'agent', 'deepseek.key');
	assert.ok(fs.existsSync(written), 'the wizard wrote no deepseek.key — this test would pass vacuously');
	assert.equal(fs.readFileSync(written, 'utf8').trim(), sample, 'the wizard wrote something other than the key it was given');
	assert.equal(fs.statSync(written).mode & 0o777, 0o600, 'the key file is readable by everyone');
	// And the mechanism reads exactly that file: no installation step between.
	const r = resolveApiKey({ apiKey: deepseekApiKey(fs.readFileSync(path.join(wizHome, '.pi', 'agent', 'models.json'), 'utf8')), platform: 'linux', env: { ...wizEnv, PI_CODING_AGENT_DIR: path.join(wizHome, '.pi', 'agent') } });
	assert.equal(r.ok, true, `models.json cannot read the key the wizard just wrote: ${r.reason}`);
	assert.equal(r.key, sample, 'the command answered with something other than the key the wizard wrote');

	// Never printed, never logged, never in state: the key lives in one file.
	assert.ok(!wizard.stdout.includes(sample) && !wizard.stderr.includes(sample), 'the wizard printed the key');
	const stateFile = path.join(wizHome, '.pi', 'state', 'setup.json');
	assert.ok(fs.existsSync(stateFile), 'the wizard wrote no state file — the "not in state" half would pass vacuously');
	for (const [rel, text] of everyFile(path.join(wizHome, '.pi'))) {
		if (rel === path.join('agent', 'deepseek.key')) continue;
		assert.ok(!text.includes(sample), `the key is also in ${rel}`);
	}
});

test('the key reaches an HTTP server as Authorization: Bearer, resolved the way pi resolves it', async (t) => {
	// The wizard's own write, in the wizard's own shape (mode 600, one line).
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, 'deepseek.key'), `${sample}\n`, { mode: 0o600 });

	let seen;
	const server = http.createServer((req, res) => {
		seen = req.headers.authorization;
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"ok":true}');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	t.after(() => server.close());

	// A stub pi, not the real one: a real `pi` cannot be pointed at a stub server
	// headlessly here. What it reproduces is the part under test — read
	// models.json, resolve its key line the way pi does, send it as a Bearer
	// header. `spawnSync` through `/bin/sh` IS pi's POSIX path (execSync), and the
	// child env carries only PATH and HOME, so nothing this shell exported can
	// make it pass.
	const stub = `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const agent = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const line = JSON.parse(fs.readFileSync(path.join(agent, 'models.json'), 'utf8')).providers.deepseek.apiKey;
const out = spawnSync('/bin/sh', ['-c', line.slice(1)], { encoding: 'utf8', env: process.env });
if (out.status !== 0) { console.error('resolve failed'); process.exit(1); }
const got = out.stdout.trim();
const req = http.request({ host: '127.0.0.1', port: ${port}, path: '/v1/ping', method: 'POST', headers: { authorization: \`Bearer \${got}\` } }, (res) => {
	console.log('status=' + res.statusCode);
	res.resume();
	res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});
req.on('error', (e) => { console.error(String(e)); process.exit(1); });
req.end('{}');
`;
	const stubPath = path.join(home, 'stub-pi.mjs');
	fs.writeFileSync(stubPath, stub);

	// `spawn`, not `spawnSync`: this test serves the request the child makes, so
	// blocking this event loop would deadlock both halves. The child's own
	// `spawnSync` through `/bin/sh` is the shell pi would use.
	const started = await new Promise((resolve) => {
		const child = spawn(process.execPath, [stubPath], {
			env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('close', (status) => resolve({ status, stdout, stderr }));
	});
	assert.equal(started.status, 0, `the stub pi could not authenticate:\n${started.stdout}${started.stderr}`);
	assert.match(started.stdout, /status=200/);
	assert.equal(seen, `Bearer ${sample}`, 'the server did not receive the wizard\'s key as a Bearer token');
	assert.ok(!started.stdout.includes(sample) && !started.stderr.includes(sample), 'the stub pi printed the key');
});

test('the shims need no export: nothing the installer writes carries the key', () => {
	// The other candidate was the `${DEEPSEEK_API_KEY}` interpolation, which would
	// have needed every entry point to export it — including npm's own `pi.cmd`,
	// which npm rewrites on upgrade. This pins that the shims carry no key line,
	// so a later change that starts exporting one has to say so here.
	const shims = [];
	for (const name of ['pi-bare', 'pi-sandboxed', 'pi-nonet', 'pisandbox']) {
		const p = path.join(home, '.local', 'bin', name);
		if (fs.existsSync(p)) shims.push([name, fs.readFileSync(p, 'utf8')]);
	}
	for (const name of ['.bashrc', '.profile', '.bash_profile']) {
		const p = path.join(home, name);
		if (fs.existsSync(p)) shims.push([name, fs.readFileSync(p, 'utf8')]);
	}
	assert.ok(shims.length > 0, 'the installer wrote no shim to check — this test would pass vacuously');
	for (const [name, text] of shims) {
		assert.ok(!/DEEPSEEK_API_KEY/.test(text), `${name} exports DEEPSEEK_API_KEY — the command mechanism needs no export`);
	}
});

test('the command pi runs answers with the key file, and a literal is never run', () => {
	const childEnv = { ...env, PI_CODING_AGENT_DIR: agentDir, PATH: process.env.PATH };
	const r = resolveApiKey({ apiKey: shipped, platform: 'linux', env: childEnv });
	assert.equal(r.ok, true, `the command did not resolve a key: ${r.reason}`);
	assert.equal(r.key, sample, 'the command answered with something other than the key the wizard wrote');
	assert.equal(
		deepseekKeyState({ keyFile: true, apiKey: shipped, resolves: r.ok }),
		'present, models.json reads it',
		'install and setup would print the wrong verdict for a working install',
	);
	// A literal key is not a command, so it is never run as one.
	assert.equal(apiKeyShell('node -v').file, '/bin/sh');
	assert.equal(resolveApiKey({ apiKey: plain }).ok, false);
});

test('the missing and unreadable cases have their own words', () => {
	assert.match(deepseekKeyState({ keyFile: false }), /MISSING/);
	assert.match(deepseekKeyState({ keyFile: true, apiKey: shipped, resolves: false }), /cannot read it/);
	assert.match(deepseekKeyState({ keyFile: true, apiKey: plain }), /does not read a command/);
});

// --- Windows: argv and string level, no Windows host here -------------------
//
// pi spawns `!command` through `cmd.exe /d /s /c "<command>"` on Windows when
// Git Bash is absent (dist/core/resolve-config-value.js → execSync), and `/s`
// strips exactly the first and last quote — the ones execSync itself added — so
// what cmd.exe parses is the command as written, quotes and all. Hence the
// invariant below: `node -e "…"`, with no double quote, `%` or cmd
// metacharacter inside the script. That is checkable here; that cmd.exe then
// runs node is the part only a Windows machine can show.

test('the command survives cmd.exe quoting, argv level', () => {
	const body = shipped.slice(1);
	assert.deepEqual(apiKeyShell(body, { platform: 'win32', comspec: 'cmd.exe' }), {
		file: 'cmd.exe',
		args: ['/d', '/s', '/c', body],
	});
	assert.ok(/^[ -~]+$/.test(body), 'the command is not plain ASCII');
	const prefix = 'node -e "';
	assert.ok(body.startsWith(prefix), 'the command is no longer `node -e "…"`, so cmd.exe would read it differently');
	assert.ok(body.endsWith('"'), 'the inline script is not closed, so cmd.exe would keep swallowing the line');
	const code = body.slice(prefix.length, -1);
	assert.ok(!code.includes('"'), 'the inline script carries a double quote, which cmd.exe would close');
	assert.ok(!/[%&|<>^]/.test(code), `the inline script carries a cmd metacharacter: ${code}`);
});

test('the Windows shim the installer writes needs no export for the key, contents level', () => {
	// A .cmd shim is one line of cmd.exe calling Git Bash on the wrapper. The key
	// mechanism adds nothing to it: nothing here names the key, so a later change
	// that starts exporting DEEPSEEK_API_KEY into a shim has to come back to this
	// test. Argv level: no Windows host runs these bytes here.
	const shim = cmdShim({
		bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
		scriptPath: 'C:\\Users\\someone\\.local\\bin\\pi-bare',
	});
	assert.ok(!/DEEPSEEK/.test(shim), 'the Windows shim carries a key export');
	assert.match(shim, /bash\.exe/, 'the shim no longer calls bash');
});
