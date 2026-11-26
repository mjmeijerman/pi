// The argv a worker's tab is started with, pinned where it is built.
//
// What went wrong: `bin/delegate` handed herdr `["sh","-lc","…"]`, herdr types that
// argv into the tab's own shell, and on Windows that shell is PowerShell — no `sh` on
// its PATH. The tab printed "The term 'sh' is not recognized" and stayed a prompt;
// `delegate spawn` printed its JSON anyway, so the failure was silent. So the first
// word is resolved (`bin/worker-argv.sh`), and it is resolved the way PowerShell reads
// it: an absolute Windows path, forward slashes, drive letter.
//
// These tests drive the builder directly — it is a sourced function and pure argv in,
// argv out — so the Windows answer is pinned from any host, and they read `bin/delegate`
// for the two call sites, because "the spawn was fixed and the restart was not" is
// exactly how the two spellings drift apart again.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** bashFor the test itself: this host's, named as an absolute path so the builder is what is
 * tested, and so a case that replaces PATH still has a shell to start. */
function hostBash() {
	// bash first, and not `$SHELL`: the builder is sourced by bash in production
	// (`bin/delegate`, `scripts/agent-pane.sh`), and a zsh login shell has no `BASH_SOURCE` —
	// running it under one tested a shell the file never claimed. `$SHELL` and `PI_GIT_BASH`
	// stay last, as the fallback for a host whose bash is not on the usual PATH.
	const tries = [];
	// An absolute path a Windows host can spawn: `command -v bash` answers a POSIX one
	// (`/usr/bin/bash`), which CreateProcess does not find, so cygpath spells it first.
	for (const probe of [
		'cygpath -m "$(command -v bash)" 2>/dev/null || command -v bash',
		'command -v bash',
	]) {
		const r = spawnSync('bash', ['-c', probe], { encoding: 'utf8' });
		if (r.status === 0 && (r.stdout || '').trim()) tries.push(r.stdout.trim());
	}
	tries.push(process.env.PI_GIT_BASH, process.env.SHELL);
	for (const candidate of tries) {
		if (!candidate) continue;
		if (spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0) return candidate;
	}
	return null;
}

/** bashOut — run a script through the builder and hand back stdout, stderr and the status. */
function bashOut(script, { bash, env }) {
	const r = spawnSync(bash, ['-c', script], {
		encoding: 'utf8',
		cwd: ROOT,
		env: { ...process.env, ...env },
	});
	return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function tempDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-worker-argv-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A "bash.exe" that is only a file: `[ -f ]` is what the resolver asks of it on Windows. */
function fakeBash(dir) {
	const file = path.join(dir, 'bash.exe');
	fs.writeFileSync(file, '');
	fs.chmodSync(file, 0o755);
	return file;
}

/** A fake `cygpath` that answers the one question the builder asks: the Windows spelling. */
function fakeCygpath(dir, answer) {
	const file = path.join(dir, 'cygpath');
	fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`);
	fs.chmodSync(file, 0o755);
	return dir;
}

// The builder is a function, so the test does not need a herdr, a space record or a
// spawn — none of which exist in a test, and all of which would hide the argv in the
// middle of a log. `unset OSTYPE MSYSTEM` is what lets a Windows host answer the
// non-Windows question: PI_PLATFORM is the switch the resolver reads when the shell
// does not announce itself as MSYS.
const BUILD = (platform, line) =>
	[
		'unset OSTYPE MSYSTEM',
		`export PI_PLATFORM=${platform}`,
		'. bin/worker-argv.sh',
		`worker_tab_argv ${JSON.stringify(line)}`,
	].join('\n');

const bash = hostBash();

test('a host that is not Windows keeps exactly the argv it always had: sh -lc', (t) => {
	if (!bash) return t.skip('no bash on this host to run the builder with');
	const { status, stdout, stderr } = bashOut(BUILD('linux', 'exec pi -a'), {
		bash,
		env: { PATH: process.env.PATH },
	});
	assert.equal(status, 0, stderr);
	assert.deepEqual(JSON.parse(stdout), ['sh', '-lc', 'exec pi -a']);
});

test('on Windows the argv starts with the absolute bash, spelled the way PowerShell resolves it', (t) => {
	if (!bash) return t.skip('no bash on this host to run the builder with');
	const dir = tempDir(t);
	const win = 'C:/Windows/System32/fake/bash.exe';
	// cygpath is the one thing that turns a POSIX path into a Windows one, and a test
	// host need not have Git for Windows, so the answer is fixed instead of looked up.
	const pathEnv = [fakeCygpath(dir, win), path.dirname(process.execPath)].join(path.delimiter);
	const { status, stdout, stderr } = bashOut(BUILD('win32', 'exec pi -a'), {
		bash,
		env: { PATH: pathEnv, PI_GIT_BASH: fakeBash(dir) },
	});
	assert.equal(status, 0, stderr);
	const argv = JSON.parse(stdout);
	assert.equal(argv[0], win, 'the first word is not the absolute Windows bash');
	assert.equal(argv[1], '-lc');
	assert.equal(argv[2], 'exec pi -a');
	// Three words, never one: herdr types argv as argv, and a joined command line would
	// be re-split by whatever shell types it.
	assert.equal(argv.length, 3);
});

test('no bash is a refusal with the line that fixes it, never a tab that types nothing', (t) => {
	if (!bash) return t.skip('no bash on this host to run the builder with');
	// PATH holds neither cygpath nor a bash: the resolver's own "no bash found" line.
	const empty = tempDir(t);
	const none = bashOut(BUILD('win32', 'exec pi -a'), {
		bash,
		env: { PATH: [empty, path.dirname(process.execPath)].join(path.delimiter), PI_GIT_BASH: '' },
	});
	assert.notEqual(none.status, 0, 'a spawn with no bash reported success');
	assert.equal(none.stdout, '', 'it printed an argv anyway');
	assert.match(none.stderr, /PI_GIT_BASH/);

	// A bash that is there but cannot be spelled for Windows: `/tmp/x/bash.exe` is not a
	// path PowerShell finds, and printing it would be the same silent dead tab.
	const unspellable = bashOut(BUILD('win32', 'exec pi -a'), {
		bash,
		env: { PATH: [empty, path.dirname(process.execPath)].join(path.delimiter), PI_GIT_BASH: fakeBash(empty) },
	});
	assert.notEqual(unspellable.status, 0, 'a POSIX path was handed to PowerShell');
	assert.equal(unspellable.stdout, '');
	assert.match(unspellable.stderr, /PI_GIT_BASH/);
});

test('a shell with no BASH_SOURCE is told to source it from bash, not handed a bad substitution', (t) => {
	// zsh is the login shell on the Mac and on this box; it parses `BASH_SOURCE` without
	// complaining and expands it to nothing, so the old `${BASH_SOURCE[0]%/*}` was a "Bad
	// substitution" from a callback, or a lookup beside `/`. The refusal has to be one line
	// naming the fix, and the same status 127 the other refusals use.
	// `zsh` by name, never through a shell: a `shell: true` spawn is the shape semgrep refuses,
	// and it is the shape this test exists to stop trusting. A host without zsh runs nothing.
	const zsh = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh'].find((p) => fs.existsSync(p));
	if (!zsh) return t.skip('no zsh on this host to source the builder with');
	const r = spawnSync(zsh, ['-c', '. bin/worker-argv.sh; worker_tab_argv "exec pi -a"'], {
		encoding: 'utf8',
		cwd: ROOT,
		// The guard is asked before anything is looked up, so a zsh that also has a bash on
		// its PATH still gets the sentence: the file is sourced by the wrong shell, not by a
		// shell missing a tool.
		env: { ...process.env },
	});
	assert.equal(r.status, 127, 'a shell without BASH_SOURCE reported success');
	assert.equal((r.stdout || '').trim(), '', 'it printed an argv anyway');
	assert.match((r.stderr || '').trim(), /source it from bash/);
});

test('an empty command line is refused instead of started', (t) => {
	if (!bash) return t.skip('no bash on this host to run the builder with');
	const { status, stdout } = bashOut(
		['unset OSTYPE MSYSTEM', 'export PI_PLATFORM=linux', '. bin/worker-argv.sh', "worker_tab_argv ''"].join('\n'),
		{ bash, env: { PATH: process.env.PATH } },
	);
	assert.notEqual(status, 0);
	assert.equal(stdout, '');
});

// --- the call sites ----------------------------------------------------------

const delegate = fs.readFileSync(path.join(ROOT, 'bin', 'delegate'), 'utf8');
const pane = fs.readFileSync(path.join(ROOT, 'scripts', 'agent-pane.sh'), 'utf8');

test('the spawn and the restart both use the one builder, and nothing spells its own argv', () => {
	// Two call sites: `cmd_spawn` and `restart_worker`. A third spelling is the bug this
	// file exists for, so the count is a claim and not a coincidence.
	const calls = delegate.match(/argv=\$\(worker_tab_argv /g) || [];
	assert.equal(calls.length, 2, `bin/delegate builds a tab argv somewhere else: ${calls.length} builder call(s)`);
	assert.doesNotMatch(delegate, /\["sh","-lc"/, 'bin/delegate still spells the argv by hand');
	// The command line each one hands over still carries the three things the worker
	// needs: its slug in the environment, the thinking level, and the runner.
	for (const line of delegate.split('\n').filter((l) => l.includes('argv=$(worker_tab_argv'))) {
		assert.match(line, /AGENT_SLUG=/, line);
		assert.match(line, /--thinking/, line);
		assert.match(line, /\$runner/, line);
	}
	// agent-pane.sh opens the tabs the same way, so a tab opened there and a worker
	// started by delegate cannot disagree about the first word.
	assert.doesNotMatch(pane, /\["sh","-lc"/, 'agent-pane.sh still spells the argv by hand');
	assert.match(pane, /argv=\$\(tab_argv /);
});
