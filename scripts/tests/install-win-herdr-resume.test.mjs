// The second login entry: `pi-resume`.
//
// What was missing: the guard repairs a space and its Boss tab and never types into a
// terminal, so after a reboot every tab came back as a plain shell with the pi session
// on disk and nothing pointing at it. `systemd/herdr-resume.service` closes that on
// Linux; on Windows nothing ran `scripts/herdr-resume.mjs` at all — `schtasks /Query`
// listed `pi-guard` and no resume entry, and the string `resume` did not appear in the
// installer. So the task, the hidden launcher and the `hc.exe` resolution are pinned
// here, on the pure builders, from any host.
//
// The engine runs dry: registering a real `pi-resume` on the machine running the tests
// would be the very thing this file exists to make sure a person chose.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	GUARD_TASK_NAME,
	RESUME_LAUNCHER_NAME,
	RESUME_TASK_NAME,
	hcCandidates,
	resumeLauncher,
	resumeLauncherPath,
	resumeLauncherTargets,
	resumeTaskCommand,
	wscriptExe,
} from '../install-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// --- the task ----------------------------------------------------------------

test('resumeTaskCommand runs the hidden launcher through wscript.exe, and quotes both paths', () => {
	const launcherPath = 'C:\\Users\\mj\\.pi\\state\\resume-hidden.vbs';
	const wscriptPath = 'C:\\Windows\\System32\\wscript.exe';
	const task = resumeTaskCommand({ launcherPath, wscriptPath });

	assert.deepEqual(task.args, ['/Create', '/F', '/SC', 'ONLOGON', '/TN', RESUME_TASK_NAME, '/TR', `"${wscriptPath}" "${launcherPath}"`]);
	assert.equal(task.tr, `"${wscriptPath}" "${launcherPath}"`);
	// Never bash.exe directly: bash is a console program, so a task naming it opens a
	// window at every logon.
	assert.doesNotMatch(task.tr, /bash\.exe/i);
	assert.match(task.tr, /wscript\.exe/i);
	assert.equal(
		task.registered,
		`schtasks /Create /F /SC ONLOGON /TN ${RESUME_TASK_NAME} /TR "\\"${wscriptPath}\\" \\"${launcherPath}\\""`,
	);
	assert.equal(task.remove, `schtasks /Delete /TN ${RESUME_TASK_NAME} /F`);
	// The resume run writes no pid file and exits by itself, so the entry is what a person
	// can end — the guard's taskkill has nothing to kill here.
	assert.equal(task.stop, `schtasks /End /TN ${RESUME_TASK_NAME}`);
});

test('the resume entry is a second task, not a rename of the guard', () => {
	assert.equal(RESUME_TASK_NAME, 'pi-resume');
	assert.notEqual(RESUME_TASK_NAME, GUARD_TASK_NAME);
	const resume = resumeTaskCommand({ launcherPath: 'C:\\x\\resume-hidden.vbs' });
	assert.ok(!resume.args.includes(GUARD_TASK_NAME), 'the resume entry names the guard task');
	// Two tasks, two launchers: deleting one must not delete the other.
	assert.match(resume.remove, /\/TN pi-resume /);
	assert.ok(!resume.remove.includes(GUARD_TASK_NAME), resume.remove);
	assert.notEqual(RESUME_LAUNCHER_NAME, 'guard-hidden.vbs');
});

test('nothing is registered or written that would start nothing', () => {
	assert.throws(() => resumeTaskCommand({}), /hidden launcher/);
	assert.throws(() => resumeLauncher({ scriptPath: 'C:\\x\\herdr-resume.sh', hcPath: 'C:\\x\\hc.exe' }), /bash\.exe/);
	assert.throws(() => resumeLauncher({ bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', hcPath: 'C:\\x\\hc.exe' }), /herdr-resume\.sh/);
	assert.throws(() => resumeLauncher({ bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', scriptPath: 'C:\\x\\herdr-resume.sh' }), /hc\.exe/);
});

// --- the launcher ------------------------------------------------------------

const launcherArgs = () => ({
	bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
	scriptPath: 'C:\\Users\\mj\\.pi\\scripts\\herdr-resume.sh',
	hcPath: 'C:\\Users\\mj\\AppData\\Local\\Programs\\herdr-core\\hc.exe',
});

test('the launcher is hidden, does not wait, and names bash, the script and hc', () => {
	const text = resumeLauncher(launcherArgs());
	// Window style 0 and False: no console window, and wscript does not wait — the resume
	// run exits by itself, and waiting would keep wscript alive for the length of a boot.
	assert.match(text, /^shell\.Run command, 0, False$/m);
	assert.doesNotMatch(text, /, 1, /, 'window style 1 shows a window at logon');
	// Read back what it runs, rather than searching for a substring of what would have
	// been generated: the installed file is what a logon runs.
	assert.deepEqual(resumeLauncherTargets(text), {
		bashPath: launcherArgs().bashPath,
		hcPath: launcherArgs().hcPath,
		scriptPath: launcherArgs().scriptPath,
	});
	// `-lc`, not `-c`: the task's environment has no useful PATH, and a login shell is
	// what makes the wrapper's `command -v node` true.
	assert.match(text, / -lc /);
});

test('the launcher path is in the state directory, beside the guard launcher', () => {
	assert.equal(resumeLauncherPath({ piHome: 'C:\\Users\\mj\\.pi' }), path.join('C:\\Users\\mj\\.pi', 'state', RESUME_LAUNCHER_NAME));
	assert.throws(() => resumeLauncherPath({}), /~\/\.pi/);
});

test('a launcher naming something else is not read as this one', () => {
	// The guard's launcher has the same shape and must not be mistaken for the resume one:
	// `bash "<guard>"` has no env prefix and no hc, so the inverse returns null.
	assert.equal(resumeLauncherTargets('command = ""C:\\Git\\bash.exe"" ""C:\\x\\bin\\guard""'), null);
	assert.equal(resumeLauncherTargets('nothing here'), null);
});

// --- hc ----------------------------------------------------------------------

test('hcCandidates looks where herdr puts hc, and the override replaces the search', () => {
	const env = { LOCALAPPDATA: 'C:\\Users\\mj\\AppData\\Local' };
	const found = hcCandidates({ platform: 'win32', env, onPath: 'C:\\Tools\\herdr\\hc.exe' });
	// PATH first, then herdr's own install directory: a task gets no useful PATH, so both
	// are worth trying and the order is the one a person would try.
	assert.deepEqual(found, ['C:\\Tools\\herdr\\hc.exe', 'C:\\Users\\mj\\AppData\\Local\\Programs\\herdr-core\\hc.exe']);
	// The explicit override is a promise: it replaces the list instead of joining it.
	assert.deepEqual(hcCandidates({ platform: 'win32', env: { ...env, PI_HERDR_RESUME_HC: 'D:\\hc\\hc.exe' }, onPath: 'C:\\Tools\\herdr\\hc.exe' }), ['D:\\hc\\hc.exe']);
	// Only Windows registers the task, so nowhere else does it look.
	assert.deepEqual(hcCandidates({ platform: 'linux', env }),
		[]
	);
});

// --- the engine, in a throwaway HOME ----------------------------------------

function tempHome(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-win-resume-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

/** A file `exists` can see, standing in for bash.exe and hc.exe: only their paths matter. */
function fakeExe(home, name) {
	const file = path.join(home, name);
	fs.writeFileSync(file, '');
	return file;
}

function installDry(home, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		PI_PLATFORM: 'win32',
		PI_SKIP_NETWORK: '1',
		PI_SKIP_PREREQS: '1',
		PI_ALLOW_MISSING_PI: '1',
		// The step waits up to 20s for the space; a test does not.
		PI_GUARD_SPACE_WAIT_MS: '0',
		PI_GIT_BASH: fakeExe(home, 'bash.exe'),
		PI_HERDR_RESUME_HC: fakeExe(home, 'hc.exe'),
		...extra,
	};
	// Any of these would decide the answer before the test does.
	for (const name of ['USERPROFILE', 'PI_DRY_RUN', 'PI_AGENT_DIR', 'PI_ENABLE_SERVICES', 'PI_UPDATE_MODS', 'HERDR_MODS']) delete env[name];
	return spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), '--dry-run'], { env: { ...env, ...extra }, encoding: 'utf8', cwd: ROOT });
}

test('a Windows dry run registers both entries and names the resume launcher', (t) => {
	const home = tempHome(t);
	const out = installDry(home);
	assert.equal(out.status, 0, out.stderr);

	// The guard is still registered: this change adds an entry, it does not move one.
	assert.match(out.stdout, /^== guard: registering a Task Scheduler entry at logon/m);
	assert.match(out.stdout, /^== resume: registering a Task Scheduler entry at logon \(this is what puts each pi session back in its tab\)$/m);
	// Neither was started: the dry run says so, and says nothing was registered either.
	assert.match(out.stdout, /^   \[dry-run\] not registered$/m);

	const launcher = path.join(home, '.pi', 'state', RESUME_LAUNCHER_NAME);
	assert.ok(out.stdout.includes(`resume launcher (hidden, no console window) -> ${launcher}`), out.stdout);
	const registered = out.stdout.match(/^   command: (schtasks .*pi-resume.*)$/m);
	assert.ok(registered, 'no registered command line for pi-resume');
	// The system's own wscript.exe (its spelling comes from SystemRoot, which a host is
	// free to have as `C:\\WINDOWS`), and the launcher this install placed.
	assert.ok(registered[1].includes(`\\"${wscriptExe()}\\" \\"${launcher}\\""`), registered[1]);
	assert.doesNotMatch(registered[1], /bash/i, registered[1]);
	// The lines that undo it: the task delete (the next logon) and the end of a run.
	assert.ok(out.stdout.includes(`Disable: schtasks /Delete /TN ${RESUME_TASK_NAME} /F`), out.stdout);
	assert.ok(out.stdout.includes(`Disable: schtasks /End /TN ${RESUME_TASK_NAME}`), out.stdout);
	// Registering resume must not touch the guard entry: the guard's own disable line is the
	// only place a guard delete appears, and the resume block names no guard task at all.
	const resumeLines = out.stdout
		.split('\n')
		.filter((l) => /^== resume:|^   command: .*\/TN pi-resume |^Disable: schtasks \/\w+ \/TN pi-resume/.test(l))
		.join('\n');
	assert.ok(resumeLines.includes('/TN pi-resume'), 'no resume line found to read');
	assert.ok(!resumeLines.includes(GUARD_TASK_NAME), resumeLines);
});

test('the launcher the install would write names the script, bash and the hc it resolved', (t) => {
	const home = tempHome(t);
	const out = installDry(home);
	assert.equal(out.status, 0, out.stderr);
	// A dry run writes nothing; the file is what a real run writes, and this is the same
	// builder it calls — the point is that the three paths are the ones the install
	// resolved, not a guess.
	assert.equal(fs.existsSync(path.join(home, '.pi', 'state', RESUME_LAUNCHER_NAME)), false, 'a dry run wrote the launcher');
	assert.ok(out.stdout.includes(`hc: ${path.join(home, 'hc.exe')}`), out.stdout);
	const targets = resumeLauncherTargets(
		resumeLauncher({
			bashPath: path.join(home, 'bash.exe'),
			scriptPath: path.join(ROOT, 'scripts', 'herdr-resume.sh'),
			hcPath: path.join(home, 'hc.exe'),
		}),
	);
	assert.equal(targets.scriptPath, path.join(ROOT, 'scripts', 'herdr-resume.sh'));
	assert.ok(fs.existsSync(targets.scriptPath), 'the script the launcher names is not in this checkout');
});

test('no hc is a refusal with the line that fixes it, and the guard is still registered', (t) => {
	const home = tempHome(t);
	// PI_HERDR_RESUME_HC pointed at a file that is not there, and no herdr-core install in
	// LOCALAPPDATA: the resume run would ask nothing and exit 0.
	const out = installDry(home, { PI_HERDR_RESUME_HC: path.join(home, 'no-such-hc.exe'), LOCALAPPDATA: path.join(home, 'no-local') });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stderr, /resume: no hc\.exe found/);
	assert.match(out.stdout, /   fix: install herdr \(hc comes with it\), or set PI_HERDR_RESUME_HC/);
	assert.doesNotMatch(out.stdout, /resume: registering a Task Scheduler entry/);
	// The guard does not depend on hc, so it is still registered.
	assert.match(out.stdout, /^== guard: registering a Task Scheduler entry at logon/m);
	assert.match(out.stdout, /Resume task: not registered — the line above says why/);
});

test('the one way out skips the resume entry too', (t) => {
	const home = tempHome(t);
	const out = installDry(home, { PI_SKIP_SYSTEMD: '1' });
	assert.match(out.stdout, /guard service \(launchd \/ Task Scheduler\): PI_SKIP_SYSTEMD=1/);
	assert.doesNotMatch(out.stdout, /resume: registering a Task Scheduler entry/);
	assert.doesNotMatch(out.stdout, /Disable: schtasks \/Delete \/TN pi-resume/);
});
