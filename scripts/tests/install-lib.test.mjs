// Tests for the installer's pure half (scripts/install-lib.mjs).
//
// These pin the two properties the cross-platform port must not lose:
//   1. `keep every rule` reproduces agent/AGENTS.md byte for byte, so an
//      unfiltered setup on a working machine changes nothing.
//   2. the per-OS differences stay in ONE table, so they cannot spread into the
//      engine as `if (win32)` branches — the revert trigger in the spec is
//      "per-OS special cases spreading past three places".
//
// Run: node --test scripts/tests/install-lib.test.mjs  (or make scripts-test)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
	OS_PLAN,
	PI_WRAPPER_BEGIN,
	PI_WRAPPER_BLOCK,
	PI_WRAPPER_END,
	filterAgentsMd,
	homePaths,
	isRuntimeState,
	isWsl,
	parseAgentsMd,
	parseRuleSelection,
	pickNames,
	planFor,
	sandboxSummary,
	spawnPlan,
	systemSummary,
	windowsMount,
	wslMountWarnings,
	ruleIds,
	ruleSlug,
	samePath,
	spliceManagedBlock,
} from '../install-lib.mjs';

const AGENTS = fs.readFileSync(new URL('../../agent/AGENTS.md', import.meta.url), 'utf8');
const SECTIONS = ['Sandbox', 'Landing changes', 'Harness sources', 'Models', 'Harness feedback', 'Herdr', 'Machine / screens'];

test('agent/AGENTS.md: 17 rules, each in a named section', () => {
	const parsed = parseAgentsMd(AGENTS);
	assert.equal(parsed.rules.length, 17, 'setup.mjs says "rule N of 17"; a new rule means a new number');
	for (const section of SECTIONS) {
		assert.ok(
			parsed.rules.some((r) => r.section === section),
			`no rule under "## ${section}" — setup would not offer it`,
		);
	}
	assert.equal(new Set(ruleIds(parsed).map((r) => r.slug)).size, 17, 'every rule needs its own slug, or one answer covers two rules');
});

test('keeping every rule reproduces AGENTS.md byte for byte', () => {
	assert.equal(filterAgentsMd(AGENTS, () => true), AGENTS);
});

test('dropping a rule removes its bullet and keeps the others', () => {
	const parsed = parseAgentsMd(AGENTS);
	const target = parsed.rules[4]; // the second "Landing changes" rule
	const filtered = filterAgentsMd(AGENTS, (rule) => rule.index !== target.index);
	assert.equal(filtered.split('\n').filter((l) => /^- /.test(l)).length, 16);
	assert.ok(!filtered.includes(target.text.slice(0, 40)), 'the dropped rule is still there');
	assert.ok(filtered.includes(parsed.rules[5].text.slice(0, 40)), 'a rule after it went missing');
});

test('a section whose only rule was dropped loses its heading', () => {
	const parsed = parseAgentsMd(AGENTS);
	const sandbox = parsed.rules.find((r) => r.section === 'Sandbox');
	const filtered = filterAgentsMd(AGENTS, (rule) => rule.index !== sandbox.index);
	assert.ok(!filtered.includes('## Sandbox'), 'an empty heading is a rule nobody can follow');
	assert.ok(filtered.includes('## Harness sources'));
	assert.equal(filtered.endsWith('\n'), true);
	assert.equal(filtered.includes('\n\n\n'), false, 'no double blank lines left behind');
});

test('a recorded answer survives a rule inserted above it', () => {
	const before = parseAgentsMd(AGENTS);
	const ruffled = AGENTS.replace('# Global rules\n\n', '# Global rules\n\n- A brand new rule nobody has answered yet, inserted at the top.\n');
	const after = parseAgentsMd(ruffled);
	assert.equal(after.rules.length, before.rules.length + 1);
	for (const rule of before.rules) {
		const match = after.rules.find((r) => r.slug === rule.slug);
		assert.ok(match, `slug ${rule.slug} moved — answers recorded against it would be lost`);
		assert.equal(match.index, rule.index + 1, 'indexes shift, slugs must not');
	}
});

test('ruleSlug is derived from the rule text, not its position', () => {
	assert.equal(ruleSlug('- Never merge, push to trunk'), ruleSlug('Never merge, push to trunk'));
	assert.match(ruleSlug('Always respond in English, regardless of the language'), /^always-respond-in-english-regardless-of$/);
});

test('the pi wrapper block is spliced, not appended twice', () => {
	const rc = '# my rc\n\nexport PATH="$HOME/.local/bin:$PATH"\n';
	const once = spliceManagedBlock(rc, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
	const twice = spliceManagedBlock(once, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
	assert.equal(twice, once, 'a second install must not stack a second wrapper');
	assert.ok(once.startsWith('# my rc\n'), 'what was outside the markers is still first');
	assert.equal(once.split(PI_WRAPPER_BEGIN).length, 2);
});

test('an old wrapper block is replaced where it stood', () => {
	const stale = `# rc\n${PI_WRAPPER_BEGIN}\npi() { echo old; }\n${PI_WRAPPER_END}\n# after\n`;
	const next = spliceManagedBlock(stale, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
	assert.ok(!next.includes('echo old'), 'the stale block survived');
	assert.ok(next.includes('# after'), 'a line after the block was eaten');
});

test('one per-OS table: three plans, and only the real differences differ', () => {
	const n = OS_PLAN;
	assert.deepEqual(Object.keys(n).sort(), ['darwin', 'linux', 'win32']);
	assert.equal(n.linux.linkMode, 'symlink');
	assert.equal(n.win32.linkMode, 'copy', 'a symlink on Windows needs elevation or Developer Mode');
	assert.equal(n.linux.binSubdir, n.darwin.binSubdir);
	assert.equal(n.linux.service, 'systemd');
	assert.equal(n.darwin.service, 'launchd');
	assert.equal(n.win32.service, 'schtasks');
	assert.equal(n.linux.sandbox, true);
	assert.equal(n.darwin.sandbox, false);
	assert.equal(n.win32.sandbox, false);
	assert.deepEqual(n.win32.rcFiles, [], 'no POSIX rc file on Windows');
	assert.equal(n.win32.herdrInstall, 'powershell');
	assert.equal(n.linux.herdrInstall, 'sh');
	assert.match(planFor('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }).herdrInstalled, /herdr-app[\\/]herdr-app\.exe$/);
	assert.equal(planFor('plan9').platform, 'linux', 'an unknown platform reads as POSIX rather than crashing a setup');
});

test('homePaths derives every path the engine writes from HOME', () => {
	const plan = planFor('linux');
	const p = homePaths({ home: '/home/me', agentDir: '/home/me/.pi/agent', plan });
	assert.equal(p.binDir, '/home/me/.local/bin');
	assert.equal(p.stateFile, '/home/me/.pi/state/setup.json');
	assert.equal(p.gitHooksDir, '/home/me/.pi/git-hooks');
	assert.equal(p.serviceDir, '/home/me/.config/systemd/user');
	assert.equal(homePaths({ home: 'C:\\Users\\me', agentDir: 'C:\\Users\\me\\.pi\\agent', plan: planFor('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }) }).serviceDir, null);
});

test('pickNames: nothing given means everything', () => {
	assert.deepEqual(pickNames(['a', 'b'], []), ['a', 'b']);
	assert.deepEqual(pickNames(['a', 'b', 'c'], ['c']), ['c']);
	assert.deepEqual(pickNames(['a', 'b'], ['zzz']), []);
});

test('--rules= parses into one answer per rule', () => {
	assert.equal(parseRuleSelection(undefined, 17).size, 0);
	assert.equal([...parseRuleSelection('none', 3).values()].every((v) => v === false), true);
	assert.deepEqual([...parseRuleSelection('drop:2', 3).entries()], [
		[1, true],
		[2, false],
		[3, true],
	]);
	assert.deepEqual([...parseRuleSelection('keep:2,3', 3).entries()], [
		[1, false],
		[2, true],
		[3, true],
	]);
	assert.throws(() => parseRuleSelection('some', 3), /--rules wants/);
});

test('samePath: git echoes back a different spelling of the same directory', () => {
	assert.equal(samePath('/home/me/.pi/git-hooks', '/home/me/.pi/git-hooks/'), true);
	assert.equal(samePath('/home/me/.pi/git-hooks', '/home/other/.pi/git-hooks'), false);
	assert.equal(samePath('/c/Users/me/.pi/git-hooks', 'C:\\Users\\me\\.pi\\git-hooks', 'win32'), true);
	assert.equal(samePath('/c/Users/me/.pi/git-hooks', '/c/Users/me/.pi/git-hooks/', 'win32'), true);
	assert.equal(samePath('', '/home/me', 'linux'), false);
});

// `.cmd` shims: npm, gh and the rest are .cmd files on Windows, which node
// cannot exec directly. The fix is argv, not `shell: true` — a shell turns argv
// into a string, and a string is one quote away from a second command. These
// two tests pin the argv that replaces it, so nobody can quietly put the shell
// back: semgrep: javascript.lang.security.audit.spawn-shell-true.
test('spawnPlan: a .cmd command on win32 goes through cmd.exe, argv intact', () => {
	const spec = spawnPlan('npm.cmd', ['install', '-g', 'pi'], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
	assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
	assert.equal(spec.args[0], '/d', '/d skips AutoRun, which a person may have pointed at anything');
	assert.equal(spec.args[1], '/s', '/s is what makes cmd.exe keep the outer quotes as written');
	assert.equal(spec.args[2], '/c');
	assert.equal(spec.args[3], '"npm.cmd install -g pi"');
	assert.equal(spec.args.length, 4, 'the command line is ONE argument: /c takes the rest of the line');
	assert.equal(spec.windowsVerbatimArguments, true, 'node must not quote the quotes a second time');
	// One argument with a space and one with an operator: both are quoted, and
	// the arguments around them are left alone.
	assert.equal(
		spawnPlan('gh.cmd', ['pr', 'create', '--title', 'One Node installer & friends', '-R', 'a/b'], { platform: 'win32' }).args[3],
		'"gh.cmd pr create --title "One Node installer & friends" -R a/b"',
		'quote the argument cmd.exe would split, not the whole line',
	);
});

test('spawnPlan: everything else is spawned directly, with no shell in sight', () => {
	for (const platform of ['linux', 'darwin']) {
		const spec = spawnPlan('git', ['config', '--global', 'user.name', 'Mark'], { platform });
		assert.equal(spec.file, 'git', platform);
		assert.deepEqual(spec.args, ['config', '--global', 'user.name', 'Mark'], platform);
		assert.equal(spec.windowsVerbatimArguments, false, platform);
	}
	// A plain .exe on Windows is exec'd, not handed to cmd.exe: only CreateProcess
	// runs there, and cmd.exe would add a parsing layer for nothing.
	for (const command of ['gh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
		assert.equal(spawnPlan(command, ['auth', 'status'], { platform: 'win32', comspec: 'cmd.exe' }).file, command);
	}
});

// PATHEXT is a shell feature: node's CreateProcess appends `.exe` and stops. So
// `run('npm', …)` — the --install-pi path — cannot exec the npm.cmd shim unless
// `npm` is routed through cmd.exe too. Dropping `shell: true` without this
// would have fixed the scanner and broken Windows.
test('spawnPlan: a bare name on win32 goes through cmd.exe, because PATHEXT does', () => {
	const spec = spawnPlan('npm', ['install', '-g', 'pi'], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
	assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
	assert.deepEqual(spec.args, ['/d', '/s', '/c', '"npm install -g pi"']);
	assert.equal(spec.windowsVerbatimArguments, true);
	// Same for a shim named by its full path, where the space needs the quotes.
	const viaPath = spawnPlan('C:\\Program Files\\nodejs\\npm.cmd', ['i'], { platform: 'win32', comspec: 'cmd.exe' });
	assert.equal(viaPath.args[3], '""C:\\Program Files\\nodejs\\npm.cmd" i"');
	// A bare name on a POSIX platform is untouched by all of this.
	assert.equal(spawnPlan('npm', ['i'], { platform: 'linux' }).file, 'npm');
});

// The point of the two tests above is that nobody puts the shell back to make a
// scanner quiet. That is a property of the engines, so it is read off them.
test('the engines build argv with spawnPlan and never set a shell', () => {
	for (const file of ['../../install.mjs', '../../setup.mjs']) {
		const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
		assert.ok(!/\bshell\s*:/.test(src), `${file} sets a child_process shell option again`);
		assert.ok(/spawnPlan\(/.test(src), `${file} does not run commands through spawnPlan`);
		assert.ok(!/nosemgrep/.test(src), `${file} silences a scanner finding instead of fixing it`);
	}
});

// Node on Windows installs `npm` twice: `npm.cmd` for cmd.exe and `npm.ps1` for
// PowerShell. PowerShell resolves the bare name to the `.ps1`, and the default
// `Restricted` execution policy refuses to run a script — that is the wall the
// first real Windows install hit while checking the npm version, before git or
// node were even usable. The plan names the shim, and the engine takes the name
// from the plan, so no call site can reintroduce the bare one.
test('the win32 plan names npm.cmd, and never npm.ps1', () => {
	assert.equal(planFor('win32').npmBin, 'npm.cmd', 'a bare npm is the .ps1 the policy blocks');
	assert.equal(planFor('linux').npmBin, 'npm', 'no shim on Linux');
	assert.equal(planFor('darwin').npmBin, 'npm', 'no shim on macOS');
	// The plan value is what spawnPlan is handed, so this is the command line a
	// Restricted machine actually runs.
	const spec = spawnPlan(planFor('win32').npmBin, ['install', '-g', 'x'], {
		platform: 'win32',
		comspec: 'C:\\Windows\\system32\\cmd.exe',
	});
	assert.equal(spec.args[3], '"npm.cmd install -g x"');
	assert.ok(!/npm\.ps1/.test(spec.args.join(' ')), 'the .ps1 form is the one that cannot run');
	// And the engine reads it off the plan: the literal in the source is the
	// regression this test exists for.
	const src = fs
		.readFileSync(new URL('../../install.mjs', import.meta.url), 'utf8')
		.replace(/^\s*\/\/.*$/gm, '');
	assert.ok(/PLAN\.npmBin/.test(src), 'install.mjs does not take npm from the per-OS plan');
	assert.ok(!/\b(run|hasCmd|spawnSync)\(\s*'npm'/.test(src), "install.mjs spells 'npm' by hand — Windows would get npm.ps1");
});

// The installer copies scripts/ into ~/.pi/scripts, and agent-pane.sh writes its
// pane map in the same folder. That file is state, not config: carrying it into
// a fresh HOME claims panes nobody opened there, and copy-then-delete counted a
// written file on every run, so "the second run writes nothing" was false on any
// machine that had used agent-pane. The list is what the copy skips.
test('isRuntimeState: the agent-pane map is state, the script next to it is not', () => {
	assert.equal(isRuntimeState(path.join('/h/.pi', 'scripts', '.agent-panes.json')), true);
	assert.equal(isRuntimeState('.agent-panes.json'), true, 'a bare name is the same file');
	assert.equal(isRuntimeState(path.join('/repo', 'scripts', 'agent-pane.sh')), false, 'the script is shipped');
	assert.equal(isRuntimeState(path.join('/repo', 'scripts', 'tests', 'harness-check.sh')), false);
	// The engine has to hand the list to its copy: a correct list nobody uses
	// leaves the bug in place.
	const src = fs
		.readFileSync(new URL('../../install.mjs', import.meta.url), 'utf8')
		.replace(/^\s*\/\/.*$/gm, '');
	assert.ok(/copyTree\(src, dst, \(p\) => isRuntimeState\(p\)\)/.test(src), 'install.mjs copies scripts/ without skipping runtime state');
});

// --- WSL ---------------------------------------------------------------------
// `process.platform` answers `linux` inside WSL, and that answer is right: WSL2
// has a real kernel, so the Linux plan and the Linux bubblewrap launcher are what
// should run. What the platform cannot say is that the person is on Windows, and
// both things that break there — a repo on `/mnt/c`, a `herdr-app` installed on
// the other side of a filesystem wall — only exist once the installer knows it.
test('isWsl: real WSL env, WSL1, plain Linux, win32, darwin', () => {
	const real = { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/8_interop' };
	assert.equal(isWsl({ platform: 'linux', release: '5.15.90.1-microsoft-standard-WSL2', env: real }), true, 'a WSL2 shell is WSL');
	assert.equal(
		isWsl({ platform: 'linux', release: '5.15.90.1-microsoft-standard-WSL2', env: {} }),
		true,
		'a cron or systemd unit carries no env; the kernel still says so',
	);
	assert.equal(isWsl({ platform: 'linux', release: '4.4.0-19041-Microsoft', env: { WSL_DISTRO_NAME: 'Debian' } }), true, 'WSL1 has no WSL_INTEROP and must still be caught');
	assert.equal(isWsl({ platform: 'linux', release: '4.4.0-19041-Microsoft', env: {} }), true);
	assert.equal(isWsl({ platform: 'linux', release: '6.8.0-45-generic', env: {} }), false, 'plain Linux is not WSL');
	assert.equal(isWsl({ platform: 'linux', release: '6.8.0-45-generic', env: real }), true, 'a shell that kept the variables is still WSL');
	assert.equal(isWsl({ platform: 'win32', release: '10.0.26100', env: real }), false, 'a Windows shell is not a Linux host, whatever it exports');
	assert.equal(isWsl({ platform: 'darwin', release: '23.6.0', env: {} }), false);
});

test('planFor carries the WSL flag, and only a Linux host can be WSL', () => {
	assert.equal(planFor('linux', {}, '6.8.0-45-generic').wsl, false);
	const wsl = planFor('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '6.8.0-45-generic');
	assert.equal(wsl.wsl, true);
	assert.equal(wsl.sandbox, true, 'WSL keeps the Linux sandbox — the kernel is real, not emulated');
	assert.equal(planFor('win32', {}, '10.0.26100').wsl, false);
	assert.equal(planFor('darwin', {}, '23.6.0').wsl, false);
	assert.equal(planFor('plan9', {}, '6.8.0-45-generic').wsl, false, 'falling back to the Linux plan is not a WSL host');
});

test('the /mnt/ warning names the path and stays quiet on ~/', () => {
	const paths = [
		{ what: 'this pi repo', path: '/mnt/c/Users/me/pi' },
		{ what: 'the agent dir', path: '/home/me/.pi/agent' },
		{ what: 'PI_BOSS_DIR', path: '/mnt/d/boss' },
	];
	const out = wslMountWarnings({ wsl: true, paths });
	assert.deepEqual(out.map((w) => w.what), ['this pi repo', 'PI_BOSS_DIR'], 'only the Windows-drive paths, in order');
	assert.equal(out[0].mount, '/mnt/c');
	assert.match(out[0].message, /\/mnt\/c\/Users\/me\/pi/);
	assert.match(out[0].message, /move \/mnt\/c\/Users\/me\/pi under ~\//);
	assert.deepEqual(wslMountWarnings({ wsl: false, paths }), [], 'a Linux host has no /mnt/ warning to give');
	assert.deepEqual(wslMountWarnings({ wsl: true, paths: [{ what: 'the agent dir', path: '/home/me/.pi/agent' }] }), []);
	// A path that merely starts with /mnt is not a drive mount: /mnt/wsl is tmpfs.
	assert.equal(windowsMount('/mnt/wsl/docker'), null);
	assert.equal(windowsMount('/mnt/c'), '/mnt/c');
	assert.equal(windowsMount('/mnt/c/foo'), '/mnt/c');
	assert.equal(windowsMount('/home/me'), null);
});

test('the summary prints the WSL flag, and the sandbox line never says "unavailable" in WSL', () => {
	assert.equal(systemSummary({ platform: 'linux', wsl: true, sandbox: true }), 'linux (WSL, sandbox available)');
	assert.equal(systemSummary({ platform: 'win32', wsl: false, sandbox: false }), 'win32 (no sandbox)');
	assert.equal(systemSummary({ platform: 'linux', wsl: false, sandbox: true }), 'linux (sandbox available)');
	const ok = sandboxSummary({ platform: 'linux', wsl: true, sandbox: true }, { piHome: '/home/me/.pi', bwrap: true });
	assert.equal(ok.ok, true);
	assert.equal(ok.message, '/home/me/.pi/sandbox/pi-sandbox.sh');
	const missing = sandboxSummary({ platform: 'linux', wsl: true, sandbox: true }, { piHome: '/home/me/.pi', bwrap: false });
	assert.equal(missing.ok, false);
	assert.match(missing.message, /install bubblewrap/, 'in WSL a missing bwrap is an apt line, not a missing feature');
	assert.doesNotMatch(missing.message, /unavailable on this OS/);
	assert.match(sandboxSummary({ platform: 'win32', wsl: false, sandbox: false }).message, /unavailable on win32/);
});
