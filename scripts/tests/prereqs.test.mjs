// The installer has to install its own prerequisites.
//
// Why this exists: the install was "one command" that opened by telling a person
// to install git and Node by hand, because `setup.sh` was `exec node setup.mjs`
// and node cannot install itself from a shim that needs node. The fix is a
// bootstrap (setup.sh, setup.ps1) plus a prerequisites step in the engine, and
// what they must never do is disagree with each other or with the docs. So the
// planning is one pure table in scripts/install-lib.mjs and this file pins it
// per platform: the manager chosen, the exact argv per missing tool, the skip
// flag, and the two things a wrong install would cost — a `sudo` nobody was
// warned about, and one failed package aborting the rest of the tree.
//
// Cheap on purpose: no network, no package manager, one child process at the end
// that runs the real engine into a throwaway HOME.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	PREREQ_PACKAGES,
	installCommand,
	pickPackageManager,
	prereqNodePin,
	prereqPackage,
	prereqPlan,
} from '../install-lib.mjs';
import { PREREQ_SKIP_ENV, prereqsSkipped, stepPrereqs } from '../prereqs.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A fake engine: `has` answers from `missing`, every run is recorded. */
function mkIo({ missing = [], present = [], fail = [] } = {}) {
	const gone = new Set(missing);
	const failing = new Set(fail);
	const lines = [];
	const runs = [];
	const pkgToTool = (args) => {
		for (const tool of Object.keys(PREREQ_PACKAGES)) {
			for (const manager of Object.keys(PREREQ_PACKAGES[tool])) {
				const pkg = prereqPackage(tool, manager, 24);
				if (pkg && args.includes(pkg)) return tool;
			}
		}
		return null;
	};
	return {
		lines,
		runs,
		io: {
			have: (name) => !gone.has(name),
			run: (file, args) => {
				runs.push([file, ...args].join(' '));
				const tool = pkgToTool(args);
				if (tool && failing.has(tool)) return 1;
				if (tool) gone.delete(tool);
				return 0;
			},
			say: (line) => lines.push(line),
			note: (line) => lines.push(line),
			warn: (line) => lines.push(`!! ${line}`),
		},
	};
}

const has = (...names) => (name) => names.includes(name);

test('pickPackageManager: the manager this platform would use, in order', () => {
	assert.equal(pickPackageManager({ platform: 'linux', has: has('apt-get') }), 'apt-get');
	assert.equal(pickPackageManager({ platform: 'linux', has: has('apt-get', 'dnf') }), 'apt-get', 'apt first where both exist');
	assert.equal(pickPackageManager({ platform: 'linux', has: has('dnf') }), 'dnf');
	assert.equal(pickPackageManager({ platform: 'linux', has: has('pacman') }), 'pacman');
	assert.equal(pickPackageManager({ platform: 'linux', has: has('mise') }), 'mise', 'a machine with only mise still has an answer');
	assert.equal(pickPackageManager({ platform: 'darwin', has: has('apt-get', 'brew') }), 'brew', 'macOS ignores apt-get');
	assert.equal(pickPackageManager({ platform: 'win32', has: has('winget', 'mise') }), 'winget');
	assert.equal(pickPackageManager({ platform: 'win32', has: () => false }), null, 'no manager is a real answer, not a crash');
});

test('the planned command, per package manager and missing tool', () => {
	const cases = [
		['linux', 'apt-get', 'git', 'git', { file: 'sudo', args: ['apt-get', 'install', '-y', 'git'], sudo: true }],
		['linux', 'apt-get', 'node', 'nodejs', { file: 'sudo', args: ['apt-get', 'install', '-y', 'nodejs'], sudo: true }],
		['linux', 'dnf', 'npm', 'npm', { file: 'sudo', args: ['dnf', 'install', '-y', 'npm'], sudo: true }],
		['linux', 'pacman', 'node', 'nodejs', { file: 'sudo', args: ['pacman', '-S', '--needed', '--noconfirm', 'nodejs'], sudo: true }],
		['darwin', 'brew', 'node', 'node@24', { file: 'brew', args: ['install', 'node@24'], sudo: false }],
		['darwin', 'brew', 'git', 'git', { file: 'brew', args: ['install', 'git'], sudo: false }],
		['linux', 'mise', 'node', 'node', { file: 'mise', args: ['use', '-g', 'node@24'], sudo: false }],
	];
	for (const [platform, manager, tool, pkg, expected] of cases) {
		const plan = prereqPlan({ platform, has: has(manager), optional: [] });
		assert.deepEqual(plan.missing, ['git', 'node', 'npm'], `${platform}/${manager} missing set`);
		const step = plan.steps.find((s) => s.tool === tool);
		assert.ok(step, `${manager} plans no step for ${tool}`);
		assert.equal(step.package, pkg, `${manager} package for ${tool}`);
		assert.deepEqual(
			{ file: step.file, args: step.args, sudo: step.sudo },
			expected,
			`${manager} ${tool}: ${step.line}`,
		);
		// The engine prints `line` before it runs anything, so the announced command
		// is the executed one by construction.
		assert.equal(step.line, [expected.file, ...expected.args].join(' '));
	}

	// winget is its own shape: no root, and two accept flags so a bare machine is
	// never left looking at a prompt.
	assert.deepEqual(installCommand('winget', 'Git.Git'), {
		file: 'winget',
		args: ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'],
		sudo: false,
	});
	// A manager with nothing for the tool is null, not an invented command.
	assert.equal(installCommand('mise', 'git'), null);
	assert.equal(prereqPackage('git', 'mise', 24), null, 'mise installs node and nothing else');
	assert.equal(prereqPackage('npm', 'brew', 24), null, 'npm ships with node on brew');
	// The node pin follows .node-version, so a repo pinned to 26 installs 26.
	assert.equal(prereqPackage('node', 'brew', 26), 'node@26');
});

test('nothing runs sudo without saying so, and brew/winget never use it', () => {
	for (const [manager, pkg] of [
		['apt-get', 'git'],
		['dnf', 'git'],
		['pacman', 'git'],
		['brew', 'git'],
		['winget', 'Git.Git'],
	]) {
		const command = installCommand(manager, pkg);
		assert.equal(command.file === 'sudo', command.sudo, `${manager}: the sudo flag and the command disagree`);
	}
});

test('PI_SKIP_PREREQS=1 plans no command at all', () => {
	assert.equal(prereqsSkipped({ env: { PI_SKIP_PREREQS: '1' } }), true);
	assert.equal(prereqsSkipped({ skipPrereqs: true, env: {} }), true);
	assert.equal(prereqsSkipped({ env: {} }), false);
	assert.equal(prereqsSkipped({ env: { PI_SKIP_PREREQS: '0' } }), false, 'only 1 means off');

	const plan = prereqPlan({ platform: 'linux', has: has('apt-get'), skip: true, optional: [] });
	assert.deepEqual(plan.steps, [], 'a skipped plan carries no commands');
	assert.deepEqual(plan.missing, ['git', 'node', 'npm'], 'the missing tools are still reported, for the skip line');
});

test('everything present: nothing is installed, and the step says so once', () => {
	const fake = mkIo({ present: ['git', 'node', 'npm'] });
	fake.io.have = has('git', 'node', 'npm', 'gh');
	const result = stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: [] });
	assert.deepEqual(fake.runs, [], 'a full machine must not reach a package manager');
	assert.deepEqual(result.missing, []);
	assert.equal(result.installed.length, 0);
	assert.match(fake.lines.join('\n'), /nothing to install/);
});

test('a missing node major is a warning with the upgrade line, never an exit', () => {
	const fake = mkIo({ missing: ['node'] });
	fake.io.have = has('git', 'npm', 'apt-get');
	const result = stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: [], nodeVersion: 'v20.11.0', nodeMajor: 20 });
	assert.deepEqual(result.installed, ['node']);
	assert.match(fake.lines.join('\n'), /node v20\.11\.0 is older than 24/);
	assert.match(fake.lines.join('\n'), /docs\/install\.md#troubleshooting/);
});

test('one failed install prints the manual line and the next prerequisite still runs', () => {
	const fake = mkIo({ missing: ['git', 'node', 'npm'], fail: ['git'] });
	fake.io.have = (name) => ['apt-get'].includes(name);
	const result = stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: [] });
	assert.deepEqual(result.failed, ['git']);
	assert.ok(result.installed.includes('node'), 'node is still attempted after git failed');
	assert.equal(fake.runs.length, 3, 'all three prerequisites were attempted');
	const text = fake.lines.join('\n');
	assert.match(text, /sudo apt-get install -y git/, 'the failing tool names the line that fixes it by hand');
	assert.match(text, /continuing with the rest/);
});

test('the announced command comes before the run, sudo in its own line', () => {
	const fake = mkIo({ missing: ['git'] });
	fake.io.have = has('node', 'npm', 'apt-get');
	stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: [] });
	const text = fake.lines.join('\n');
	assert.ok(text.includes('run: sudo apt-get install -y git'), text);
	assert.ok(text.includes('note: sudo'), 'a password prompt nobody announced is the wall this closes');
	assert.deepEqual(fake.runs, ['sudo apt-get install -y git'], 'the announced line is the executed line');
});

test('npm on brew: it arrives with node, and the line says so instead of "no command"', () => {
	const fake = mkIo({ missing: ['git', 'node', 'npm'] });
	fake.io.have = (name) => name === 'brew';
	const result = stepPrereqs({ platform: 'darwin', pin: 24, io: fake.io, optional: [] });
	assert.deepEqual(result.unresolved, ['npm']);
	const text = fake.lines.join('\n');
	assert.match(text, /npm: missing, and node carries it/);
	// The line printed before this fix contradicted the branch that produced it:
	// "node carries it, so it arrives with the node install" followed by
	// "install it by hand: install npm". brew has no npm package, so there is
	// nothing separate to install and nothing to print.
	assert.doesNotMatch(text, /install it by hand:.*npm/, 'a hand-install line for a package brew does not have');
	assert.doesNotMatch(text, /install npm/, 'the reader is told to install npm by hand on a machine where node brings it');
	assert.deepEqual(fake.runs, ['brew install git', 'brew install node@24']);
});

test('gh is optional and a real package: the by-hand line names gh, never Node', () => {
	// The sentence this replaces read "install gh (Node 24) with your package
	// manager" — a node version in a gh message, because the fallback spelled the
	// tool as a node package. It also said no manager installs gh while apt-get
	// was on PATH.
	const fake = mkIo({ missing: ['git', 'node', 'npm', 'gh'] });
	fake.io.have = has('apt-get');
	const result = stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: ['gh'] });
	assert.deepEqual(result.unresolved, [], 'apt-get carries gh, so it is a step and not a shrug');
	assert.deepEqual(fake.runs, ['sudo apt-get install -y git', 'sudo apt-get install -y nodejs', 'sudo apt-get install -y npm', 'sudo apt-get install -y gh']);

	// No manager at all: the fallback must name the tool it is about, and only a
	// node line may mention a node major.
	const bare = mkIo({ missing: ['git', 'node', 'npm', 'gh'] });
	bare.io.have = () => false;
	stepPrereqs({ platform: 'linux', pin: 24, io: bare.io, optional: ['gh'] });
	const text = bare.lines.join('\n');
	assert.match(text, /install it by hand: install gh with your OS package manager/);
	assert.doesNotMatch(text, /install gh \(Node/, 'a node version in a gh sentence');
	assert.doesNotMatch(text, /install git \(Node/, 'a node version in a git sentence');
});

test('no package manager at all: every tool is named with the line that installs it by hand', () => {
	const fake = mkIo({ missing: ['git', 'node', 'npm'] });
	fake.io.have = () => false;
	const result = stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: [] });
	assert.deepEqual(fake.runs, [], 'nothing to run means nothing runs');
	assert.deepEqual(result.unresolved, ['git', 'node', 'npm']);
	const text = fake.lines.join('\n');
	assert.match(text, /no package manager here installs it/);
	assert.match(text, /install it by hand:/);
});

test('the skip flag prints skip lines and reaches no package manager', () => {
	const fake = mkIo({ missing: ['git', 'node', 'npm'] });
	fake.io.have = has('apt-get');
	const result = stepPrereqs({ platform: 'linux', pin: 24, io: fake.io, optional: [], skipPrereqs: true });
	assert.equal(result.skipped, true);
	assert.deepEqual(fake.runs, []);
	assert.ok(fake.lines.join('\n').includes(`${PREREQ_SKIP_ENV}=1`), fake.lines.join('\n'));
});

test('prereqNodePin reads .node-version, and falls back when it is missing', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prereq-pin-'));
	try {
		assert.equal(prereqNodePin(dir, fs.readFileSync), 24, 'no file is the same fallback mise.toml has');
		fs.writeFileSync(path.join(dir, '.node-version'), '26\n');
		assert.equal(prereqNodePin(dir, fs.readFileSync), 26);
		fs.writeFileSync(path.join(dir, '.node-version'), 'v25.1.0\n');
		assert.equal(prereqNodePin(dir, fs.readFileSync), 25);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	// The repo's own file, so the engine cannot plan against a different major
	// than the one CI installs.
	assert.equal(prereqNodePin(ROOT, fs.readFileSync), Number.parseInt(fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8'), 10));
});

test('setup.ps1 is PowerShell 5.1: no &&, and it installs both prerequisites with winget', () => {
	// The Windows bootstrap is the one file no test on this host can execute, so
	// its two failure modes are read instead: 5.1 rejects `&&`, and the reason
	// this file exists is that git and Node are installed, not requested.
	const src = fs.readFileSync(new URL('../../setup.ps1', import.meta.url), 'utf8');
	const code = src
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n');
	assert.ok(!/&&/.test(code), 'setup.ps1 joins commands with && — that is PowerShell 7, not the 5.1 a fresh Windows opens');
	assert.ok(/Id = 'Git\.Git'/.test(code) && /& winget install --id \$id/.test(code), 'setup.ps1 does not install git with winget');
	assert.ok(/Id = 'OpenJS\.NodeJS\.LTS'/.test(code), 'setup.ps1 does not install Node');
	assert.ok(/GetEnvironmentVariable\(\s*'Path'/.test(code), 'setup.ps1 does not read the PATH environment block');
	assert.ok(/\$env:Path = /.test(code) && /'Machine'/.test(code) && /'User'/.test(code), 'setup.ps1 does not refresh $env:Path from both blocks');
	assert.ok(/PI_SKIP_PREREQS/.test(code), 'setup.ps1 ignores PI_SKIP_PREREQS');
	assert.ok(/& node .*setup\.mjs/.test(code), 'setup.ps1 does not run the engine');
});

 test('setup.ps1 hands every -SetupArgs element to the engine as its own argument', () => {
	// `powershell -File setup.ps1 -SetupArgs '--skip-prereqs','--help'` is the
	// shape a person types, and -File does no expression parsing: the whole
	// `'--skip-prereqs','--help'` arrives as ONE string. Splatting it unchanged is
	// how the engine came to read `--skip-prereqs,--help` as a single unknown
	// option on the Windows job. So the script splits and unquotes it into an
	// array before it calls node, and this pins that shape plus the argv the three
	// invocations produce. Only the Windows job can run the real PowerShell; what
	// is proved here is the rule, on a host that has no PowerShell at all.
	const src = fs.readFileSync(new URL('../../setup.ps1', import.meta.url), 'utf8');
	const code = src
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n');
	assert.ok(/\$nodeArgs = @\(Get-NodeArgs \(\$SetupArgs \+ \$Rest\)\)/.test(code), 'setup.ps1 does not build $nodeArgs from -SetupArgs and the rest');
	assert.ok(/& node \(Join-Path \$Root 'setup\.mjs'\) @nodeArgs/.test(code), 'setup.ps1 does not call node with the array');
	assert.doesNotMatch(code, /@SetupArgs\b/, 'setup.ps1 still splats the raw -SetupArgs, which is the one-string bug');
	assert.ok(/\$part\.Trim\(\)\.Trim\("'"\)\.Trim\('"'\)\.Trim\(\)/.test(code), 'setup.ps1 does not strip the quotes -File left on the value');

	// The same rule, modeled: this is what the array holds for each invocation a
	// person types, and it is the argv the engine gets.
	const psSplit = (items) =>
		items
			.flatMap((item) => String(item).split(','))
			.map((part) => part.trim().replace(/^['"]+|['"]+$/g, '').trim())
			.filter(Boolean);
	assert.deepEqual(psSplit(["'--skip-prereqs','--help'"]), ['--skip-prereqs', '--help'], 'the comma-joined -File shape');
	assert.deepEqual(psSplit(['--skip-prereqs', '--help']), ['--skip-prereqs', '--help'], 'the real array shape');
	assert.deepEqual(psSplit(['--help']), ['--help'], 'a single flag');
	assert.deepEqual(psSplit([]), [], 'no flags');

	// And the workflow keeps the shape this normalizes: a change there has to come
	// with a change here.
	const workflow = fs.readFileSync(new URL('../../.github/workflows/install-matrix.yml', import.meta.url), 'utf8');
	assert.match(workflow, /-File \.\/setup\.ps1 -SetupArgs '--skip-prereqs','--help'/, 'the Windows job no longer runs the shape setup.ps1 normalizes');
	assert.match(workflow, /LASTEXITCODE -ne 0/, 'the Windows job does not assert the exit code --help has to leave');
});

test('setup.sh plans the same packages as the engine (the shell table cannot drift)', () => {
	// setup.sh has to know the package names before node exists, so it carries its
	// own copy of the table. scripts/tests/setup-bootstrap.test.sh runs that copy;
	// this asserts the source of truth it has to match.
	const pkgFor = (tool, manager) => prereqPackage(tool, manager, 24);
	assert.equal(pkgFor('git', 'apt-get'), 'git');
	assert.equal(pkgFor('git', 'winget'), 'Git.Git');
	assert.equal(pkgFor('node', 'brew'), 'node@24');
	assert.equal(pkgFor('node', 'winget'), 'OpenJS.NodeJS.LTS');
	assert.equal(pkgFor('node', 'apt-get'), 'nodejs');
	assert.equal(pkgFor('npm', 'apt-get'), 'npm');
});

test('the engine with PI_SKIP_PREREQS=1 installs, and a second run changes nothing', (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prereqs-home-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const env = { ...process.env, HOME: home, PI_SKIP_PREREQS: '1', PI_SKIP_NETWORK: '1', PI_SKIP_SYSTEMD: '1', PI_ALLOW_MISSING_PI: '1' };
	for (const name of ['USERPROFILE', 'PI_AGENT_DIR', 'PI_DRY_RUN', 'CI']) delete env[name];
	const run = () => {
		const r = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], { env, encoding: 'utf8', cwd: ROOT });
		assert.equal(r.status, 0, `install.mjs exited ${r.status}:\n${r.stdout}${r.stderr}`);
		return r.stdout;
	};
	const first = run();
	assert.ok(first.includes(`prerequisites: ${PREREQ_SKIP_ENV}=1`), 'the skip is a line a person can read, not silence');
	assert.match(run(), /== done — 0 change\(s\) written/);
});
