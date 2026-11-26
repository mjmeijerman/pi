// herdr-app-stub.mjs — the `herdr-app` a test hands a child process, and the environment that
// makes it the ONLY app that child can reach.
//
// Why this file exists: `bin/space new` opens a real space in the real app. A test that gave its
// child a throwaway HOME still found `herdr-app` on the user's PATH, so a full test run opened
// dozens of real spaces named after a temp folder that was deleted a moment later — spaces nothing
// owned — and each one took the keyboard from whoever was reading. The record died with the temp
// HOME; the space did not. Which files did it was found by counting `herdr-app ls` around each one,
// and the answer has to be structural, not a list somebody remembers to update.
//
// So: a stub that answers the two calls a space step makes and writes every call it saw to
// `calls.log`, and `withStub`, which puts that stub first on PATH *and* names it in
// `PI_GUARD_HERDR_APP` — the override `bin/space` and `bin/guard` both read before PATH — while
// removing every real `herdr-app` directory from the child's PATH. A test can then assert on the
// argv the app was given, and the app that would have opened a space is not reachable at all.
//
// This is not a test file: `node --test scripts/tests/*.test.mjs` does not pick it up.

import fs from 'node:fs';
import path from 'node:path';

/** The names a directory can carry a real `herdr-app` under. */
const APP_NAMES = ['herdr-app', 'herdr-app.exe', 'herdr-app.cmd'];

/**
 * stubHerdrApp — a PATH directory holding one `herdr-app`. Idempotent: the same home gives the
 * same stub, so a test may call it twice. It logs the argv of every call to `calls.log` beside it,
 * answers `do space.new` and `ls` in the shape the real app prints, and exits 1 on anything else —
 * a call nobody expected is a red test, not a silent success.
 */
export function stubHerdrApp(home, { spaces = [{ id: 'sp-stub', name: 'harness' }] } = {}) {
	const dir = path.join(home, 'stub-bin');
	fs.mkdirSync(dir, { recursive: true });
	const app = path.join(dir, 'herdr-app');
	fs.writeFileSync(
		app,
		[
			'#!/bin/sh',
			// Beside the stub, so two tests in one home never read each other's calls.
			'printf \'%s\\n\' "$*" >>"$(dirname "$0")/calls.log"',
			'case "$1 $2" in',
			'  "do space.new") printf \'{"space":"sp-stub","tab":"tab-boss","terminal":"term-1"}\\n\' ;;',
			`  "ls "*) printf '${JSON.stringify({ spaces }).replace(/'/g, "'\\''")}\\n' ;;`,
			'  *) printf \'stub herdr-app: unexpected call: %s\\n\' "$*" >&2; exit 1 ;;',
			'esac',
			'',
		].join('\n'),
		{ mode: 0o755 },
	);
	return { dir, app, log: path.join(dir, 'calls.log') };
}

/** calls — every argv the stub was handed, one line each, oldest first. */
export function calls(stub) {
	if (!fs.existsSync(stub.log)) return [];
	return fs.readFileSync(stub.log, 'utf8').split('\n').filter(Boolean);
}

/**
 * listSeparator — the separator the list in `value` was written with.
 *
 * Not `path.delimiter`: `install-win-space.test.mjs` hands its child a *Windows* PATH on a Linux
 * host (there is no Windows runner here), and splitting that one on `:` turned
 * `<binDir>;C:\Windows` into a single directory named after both. The list's own spelling decides,
 * the way `programName` in `scripts/herdr-resume.mjs` lets the path decide and not the host.
 * A POSIX PATH entry containing a `;` is the one thing this reads wrongly, and no directory here
 * has one.
 */
export function listSeparator(value = '') {
	return process.platform === 'win32' || String(value).includes(';') ? ';' : ':';
}

/**
 * pathWithoutHerdr — PATH with every directory that carries a real `herdr-app` removed, plus the
 * vendor install folders the app is known to live in. The absence is the machine without the app,
 * not a mocked one: nothing is renamed and nothing is hidden behind a shim.
 */
export function pathWithoutHerdr(realPath = process.env.PATH || '', env = process.env) {
	const separator = listSeparator(realPath);
	const home = env.HOME || env.USERPROFILE || '';
	const vendor = [
		path.join(env.LOCALAPPDATA || '', 'Programs', 'herdr-app'),
		path.join(home, 'AppData', 'Local', 'Programs', 'herdr-app'),
		path.join(home, '.local', 'share', 'herdr-app'),
	].filter((dir) => dir.length > 0);
	return realPath
		.split(separator)
		.filter(Boolean)
		.filter((dir) => !APP_NAMES.some((name) => fs.existsSync(path.join(dir, name))))
		.filter((dir) => !vendor.some((v) => path.resolve(dir) === path.resolve(v)))
		.join(separator);
}

/**
 * withStub — `env` with the stub as the only `herdr-app` its child can reach: first on PATH, named
 * in the override the tools read before PATH, and every real app directory gone. A caller's own
 * PATH is kept (minus the real app) so the child still finds node, bash and git.
 */
export function withStub(env, stub) {
	const inherited = env.PATH === undefined ? process.env.PATH || '' : env.PATH;
	return {
		...env,
		PATH: [stub.dir, pathWithoutHerdr(inherited, env)].filter(Boolean).join(listSeparator(inherited)),
		PI_GUARD_HERDR_APP: env.PI_GUARD_HERDR_APP || stub.app,
	};
}
