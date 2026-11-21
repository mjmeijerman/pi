// ============================================================================
// install-lib.mjs — the pure half of the installer.
//
// install.mjs (the engine) and setup.mjs (the interactive pass) both import this
// file, and `node --test scripts/tests/install-lib.test.mjs` tests it without a
// filesystem, a network or a host: every function here is input -> output.
//
// Two things live here on purpose:
//   1. the per-OS plan, as ONE table. A cross-platform installer fails when the
//      `if (win32)` branches spread through the code, so the differences between
//      Linux, macOS and Windows are data (OS_PLAN) and the engine reads a plan.
//   2. the AGENTS.md rule parser, because "keep 12 of 18 rules" has to reproduce
//      the other 12 byte for byte, and that is a property, not a habit.
//
// Radar basis (Vol. 35): #1 agent sandboxing (Adopt) — the wrapper survives the
// port; #68 mise, Adopt — mise.toml stays the one place the node major is written;
// #99 Safe Chain — the npm quarantine is set by the installer, not remembered.
// ============================================================================

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The two vendor installers, named once so a moving URL is one edit.
export const HERDR_INSTALL_SH = 'https://releases.herdr.dev/app/install.sh';
export const HERDR_INSTALL_PS1 = 'https://releases.herdr.dev/app/install.ps1';
export const MISE_INSTALL_SH = 'https://mise.run';
// Where each vendor installer actually puts the binary — read from the vendor
// script, not guessed:
//   install.sh  -> ${XDG_DATA_HOME:-$HOME/.local/share}/herdr-app/herdr-app, plus
//                  a symlink named herdr-app in ~/.local/bin.
//   install.ps1 -> %LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe, that folder
//                  on the user PATH, plus a Start-menu entry.
// The `Programs` segment is the part that was missing: detection looked one
// folder higher, so a machine where the installer had worked read as "not
// installed" and the step re-ran or was skipped for good.
export const HERDR_INSTALLED_POSIX = path.join('.local', 'share', 'herdr-app', 'herdr-app');
export const HERDR_INSTALLED_WIN = { dir: path.join('Programs', 'herdr-app'), file: 'herdr-app.exe' };

/**
 * herdrInstallCommand — the argv the vendor installer is invoked with, per OS.
 *
 * Pure, and it takes the facts as arguments, because the alternative was this
 * function looking at `PATH` itself — and then the answer depended on the host
 * that ran the tests. A runner ships PowerShell 7 as `pwsh`; this laptop does
 * not; the same test passed here and failed there. Facts in, command out:
 * `hasPwsh` and `hasPowershell` are passed by the step, which is the only place
 * allowed to look at `PATH`.
 *
 * PowerShell is not one program on Windows: `pwsh` (7, present when someone
 * installed it) is preferred, `powershell` (the 5.1 that ships with the OS) is
 * the fallback, and neither means there is nothing to run — which is said with
 * the manual line instead of an ENOENT nobody reads.
 *
 * `manual` is the line a person can paste, and it always says `powershell`:
 * that one exists on every Windows machine, so it is the copy that cannot be
 * wrong.
 */
export function herdrInstallCommand({ platform = process.platform, hasPwsh = false, hasPowershell = false } = {}) {
	if (platform === 'win32') {
		const script = `irm ${HERDR_INSTALL_PS1} | iex`;
		const shell = hasPwsh ? 'pwsh' : hasPowershell ? 'powershell' : null;
		const manual = `powershell -c "irm ${HERDR_INSTALL_PS1} | iex"`;
		if (!shell) {
			return {
				shell: null,
				args: [],
				line: null,
				manual,
				url: HERDR_INSTALL_PS1,
				preferred: 'pwsh',
				fellBack: true,
				// Nothing to spawn. The step turns this into the manual line rather
				// than letting spawnSync report an ENOENT for a shell it just
				// established is not there.
				available: false,
			};
		}
		return {
			shell,
			args: ['-NoProfile', '-Command', script],
			line: `${shell} -NoProfile -Command "${script}"`,
			manual,
			url: HERDR_INSTALL_PS1,
			// Named so the engine can print it: "we picked powershell" is then a
			// fact a person can check instead of a guess.
			preferred: 'pwsh',
			fellBack: shell !== 'pwsh',
			available: true,
		};
	}
	return {
		shell: 'sh',
		args: ['-c', `curl -fsSL ${HERDR_INSTALL_SH} | sh`],
		line: `curl -fsSL ${HERDR_INSTALL_SH} | sh`,
		manual: `curl -fsSL ${HERDR_INSTALL_SH} | sh`,
		url: HERDR_INSTALL_SH,
		preferred: null,
		fellBack: false,
		available: true,
	};
}

/**
 * herdrAttempt — run one command and say what happened in words a person can
 * act on. `spawn` is passed in, so the ENOENT branch is testable off Windows:
 * an absent PowerShell is the case that used to be silent.
 *
 * ENOENT and a non-zero exit are different failures and get different lines.
 * The first means the installer never started, so nothing will be in any log;
 * the second means it started and refused. Both name the manual command.
 */
export function herdrAttempt({ command, spawn, dry = false }) {
	if (dry) return { ran: false, ok: false, dry: true, lines: [] };
	const r = spawn(command.shell, command.args, { stdio: 'inherit' }) || {};
	if (r.error) {
		const code = r.error.code || r.error.message || 'unknown error';
		return {
			ran: true,
			ok: false,
			childCode: code,
			lines: [
				`herdr-app: could not run ${command.shell} (${code}) — the vendor installer did not run`,
				`install it by hand: ${command.manual}`,
			],
		};
	}
	if ((r.status ?? 1) !== 0) {
		return {
			ran: true,
			ok: false,
			childCode: `exit ${r.status ?? 'n/a'}`,
			lines: [`herdr-app installer exited ${r.status ?? 'n/a'} — ${command.url}`, `install it by hand: ${command.manual}`],
		};
	}
	return { ran: true, ok: true, lines: [] };
}

// --- the one per-OS table ---------------------------------------------------
// linkMode     how a bin entry is created: 'symlink' or 'copy' (Windows needs
//              elevation or Developer Mode for a symlink, so it copies).
// service      which init system the guard/units target.
// herdrInstall how the vendor installer is invoked.
// npmBin       the npm executable this OS resolves to. Windows is the odd one: it
//              ships `npm` as a `.cmd` shim next to an `npm.ps1`, and a default
//              `Restricted` execution policy refuses exactly that script. Asking
//              for `npm.cmd` by name is what keeps an install running on a
//              machine nobody reconfigured.
// sandbox      bubblewrap exists only on Linux; the other two say so in one line.
export const OS_PLAN = {
	linux: {
		platform: 'linux',
		binSubdir: path.join('.local', 'bin'),
		linkMode: 'symlink',
		service: 'systemd',
		serviceDir: path.join('.config', 'systemd', 'user'),
		herdrConfigSubdir: path.join('.config', 'herdr-app'),
		herdrInstall: 'sh',
		herdrInstalled: HERDR_INSTALLED_POSIX,
			rcFiles: ['.bashrc', '.zshrc'],
		npmBin: 'npm',
		sandbox: true,
		services: true,
	},
	darwin: {
		platform: 'darwin',
		binSubdir: path.join('.local', 'bin'),
		linkMode: 'symlink',
		service: 'launchd',
		serviceDir: path.join('Library', 'LaunchAgents'),
		herdrConfigSubdir: path.join('.config', 'herdr-app'),
		herdrInstall: 'sh',
		herdrInstalled: HERDR_INSTALLED_POSIX,
		rcFiles: ['.zshrc', '.bashrc'],
		npmBin: 'npm',
		sandbox: false,
		services: true,
	},
	win32: {
		platform: 'win32',
		binSubdir: path.join('.local', 'bin'),
		linkMode: 'copy',
		service: 'schtasks',
		serviceDir: null,
		herdrConfigSubdir: path.join('.config', 'herdr-app'),
		herdrInstall: 'powershell',
		herdrInstalled: null,
		rcFiles: [],
		// `.cmd`, never a bare `npm`: PowerShell resolves that to `npm.ps1`, and
		// the default execution policy refuses to run a script.
		npmBin: 'npm.cmd',
		sandbox: false,
		services: true,
	},
};

// --- WSL ---------------------------------------------------------------------
/**
 * isWsl — is this process inside the Windows Subsystem for Linux?
 *
 * `process.platform` answers `linux` there, and that answer is right: WSL2 runs
 * a real Linux kernel, so the Linux half of the plan is the correct half and
 * the sandbox is the same bubblewrap launcher. What a bare `linux` cannot say is
 * that the person is on Windows, and two things go wrong when nobody knows it:
 * a repo under `/mnt/c/…` has no Unix mode bits and every write is slow, and a
 * `herdr-app` installed on the Windows side cannot see a `~` inside the distro.
 *
 * Three signals, on purpose, because each alone has a hole: `WSL_DISTRO_NAME`
 * (set for the shell a person gets), `WSL_INTEROP` (set under WSL2), and the
 * kernel release (every WSL kernel — 1 and 2 — carries `microsoft`). Passing the
 * three in is what makes this a property instead of a host read, so the tests
 * can drive every case: real WSL, WSL1, plain Linux, win32, darwin.
 */
export function isWsl({ platform = process.platform, release = '', env = {} } = {}) {
	if (platform !== 'linux') return false;
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	return /microsoft/i.test(String(release));
}

/** windowsMount — the Windows drive a path sits on inside WSL, or null. */
export function windowsMount(p) {
	const m = /^\/mnt\/[a-z](?=\/|$)/i.exec(String(p || ''));
	return m ? m[0] : null;
}

/**
 * wslMountWarnings — one entry per path that lives on a Windows drive while pi
 * runs in WSL. Empty when this is not WSL or no path is on a drive.
 *
 * Not an error: it works, badly. Git's mode bits do not survive `DrvFs` (every
 * file reads as 0777, so the hook scripts are "executable" whatever they say),
 * symlinks need Developer Mode on the Windows side, and every read is a 9p round
 * trip. So the install carries on and names the path and the fix once.
 */
export function wslMountWarnings({ wsl = false, paths = [] } = {}) {
	if (!wsl) return [];
	const out = [];
	for (const { what, path: dir } of paths) {
		const mount = windowsMount(dir);
		if (!mount) continue;
		out.push({
			what,
			path: String(dir),
			mount,
			message: `${what} lives on ${mount}, a Windows drive: Unix mode bits do not survive there, symlinks and hooks behave differently and every write is slow — move ${dir} under ~/ and re-run`,
		});
	}
	return out;
}

/**
 * systemSummary — the OS line the engines print in the preflight and the
 * summary. WSL is named because the plan alone cannot say it: `linux` is true on
 * a distro and on a distro under Windows, and only one of them has a `/mnt/c`.
 */
export function systemSummary(plan) {
	const inner = [plan.wsl ? 'WSL' : null, plan.sandbox ? 'sandbox available' : 'no sandbox'].filter(Boolean).join(', ');
	return `${plan.platform} (${inner})`;
}

/**
 * sandboxSummary — where the sandbox is, or the one line that says what is
 * missing. `ok` is whether there is a launcher to point at.
 *
 * In WSL the sandbox is the Linux one, so a missing bubblewrap there is
 * "install bubblewrap" and never "unavailable on this OS": that sentence is for
 * macOS and native Windows, where there is genuinely nothing to install.
 */
export function sandboxSummary(plan, { piHome = '', bwrap = true } = {}) {
	if (!plan.sandbox) return { ok: false, message: `unavailable on ${plan.platform} — pi runs unsandboxed here` };
	if (plan.wsl && !bwrap)
		return { ok: false, message: 'bubblewrap is missing — install bubblewrap (sudo apt-get install -y bubblewrap) and re-run' };
	return { ok: true, message: path.join(piHome, 'sandbox', 'pi-sandbox.sh') };
}

/** planFor — the OS plan, defaulting to the platform the process runs on. */
export function planFor(platform = process.platform, env = process.env, release = os.release()) {
	const plan = OS_PLAN[platform] || OS_PLAN.linux;
	// The platform asked for, not the plan's: an unknown platform falls back to
	// the Linux plan, and a fallback is not a reason to call a host WSL.
	const wsl = isWsl({ platform, release, env });
	if (plan.platform === 'win32') {
		const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || '', 'AppData', 'Local');
		return { ...plan, wsl, herdrInstalled: path.join(local, HERDR_INSTALLED_WIN.dir, HERDR_INSTALLED_WIN.file) };
	}
	// POSIX is the vendor script's own resolution: $XDG_DATA_HOME when it is set,
	// $HOME/.local/share when it is not. Resolved here instead of left relative,
	// because a relative path is read against the current directory and the
	// installer runs from the clone — which read as "not installed" every time.
	const dataHome = env.XDG_DATA_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.local', 'share');
	return { ...plan, wsl, herdrInstalled: path.join(dataHome, 'herdr-app', 'herdr-app') };
}

/**
 * homePaths — every absolute path the installer writes, derived from $HOME (and
 * PI_AGENT_DIR, which is how a throwaway HOME is pointed at a temp directory).
 */
export function homePaths({ home, agentDir, plan }) {
	const piHome = dirname(agentDir);
	const herdrInstalled = plan.herdrInstalled;
	return {
		home,
		piHome,
		agentDir,
		binDir: path.join(home, plan.binSubdir),
		gitHooksDir: path.join(piHome, 'git-hooks'),
		gitTemplatesDir: path.join(home, '.git-templates'),
		gitignoreGlobal: path.join(piHome, 'gitignore_global'),
		herdrConfigDir: path.join(home, plan.herdrConfigSubdir),
		serviceDir: plan.serviceDir ? path.join(home, plan.serviceDir) : null,
		stateFile: path.join(piHome, 'state', 'setup.json'),
		herdrInstalled,
	};
}

function dirname(p) {
	return path.dirname(p);
}

// --- the DeepSeek key models.json reads --------------------------------------
/**
 * The one `apiKey` string `agent/models.json` ships, in one place, so the file,
 * the installer, the wizard and the tests cannot drift apart.
 *
 * It is the `!command` form `docs/models-configuration.md` names, and it is a
 * node one-liner on purpose: pi runs it through `sh -c` on POSIX and through
 * `cmd.exe` on Windows (dist/core/resolve-config-value.js — `execSync`, and
 * Git Bash when it is there), so the command has to mean the same thing in
 * both. It therefore carries no double quotes of its own, no `$`, no `%` and no
 * `&`/`|`/`<`/`>`: nothing either shell would read as syntax rather than text.
 * `PI_CODING_AGENT_DIR` is honoured first because that is where pi looks for
 * its agent directory; otherwise it is `~/.pi/agent`, the path the wizard
 * writes the key to. No absolute home in a tracked file, and no variable that
 * somebody has to export before starting pi.
 */
export const DEEPSEEK_KEY_FILE = 'deepseek.key';
export const DEEPSEEK_API_KEY_COMMAND =
	`!node -e "const f=require('fs'),p=require('path'),a=process.env.PI_CODING_AGENT_DIR??p.join(require('os').homedir(),'.pi','agent');process.stdout.write(f.readFileSync(p.join(a,'deepseek.key'),'utf8').trim())"`;

/**
 * apiKeyCommandBody — the shell command inside an `apiKey` value, or null when
 * the value is not a command (a literal, `$NAME` interpolation, or `$$!`/`$!`
 * which pi unescapes to a literal).
 */
export function apiKeyCommandBody(apiKey) {
	if (typeof apiKey !== 'string') return null;
	const value = apiKey.trim();
	if (!value.startsWith('!')) return null;
	if (value.startsWith('$!')) return null;
	return value.slice(1);
}

/** deepseekApiKey — the deepseek `apiKey` string of a models.json body, or null. */
export function deepseekApiKey(text) {
	try {
		return JSON.parse(text)?.providers?.deepseek?.apiKey ?? null;
	} catch {
		return null;
	}
}

/**
 * apiKeyShell — the argv pi itself would run for `!command`, per platform.
 * POSIX: `sh -c`, which is what execSync() does. Windows: `cmd.exe /d /s /c`,
 * which is what execSync() does there — and the reason the command may not use
 * POSIX shell syntax.
 */
export function apiKeyShell(command, { platform = process.platform, comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
	return platform === 'win32'
		? { file: comspec, args: ['/d', '/s', '/c', command] }
		: { file: '/bin/sh', args: ['-c', command] };
}

/**
 * resolveApiKey — run the `apiKey` command the way pi runs it and answer
 * whether it returned anything. `key` is for comparing two answers, never for
 * printing: every caller in this repo prints `ok` only.
 */
export function resolveApiKey({ apiKey, platform = process.platform, env = process.env, run } = {}) {
	const body = apiKeyCommandBody(apiKey);
	if (body === null) return { ok: false, reason: 'apiKey is not a command' };
	const { file, args } = apiKeyShell(body, { platform });
	const spawn = run || spawnSync;
	let out;
	try {
		out = spawn(file, args, { encoding: 'utf8', timeout: 10000, windowsHide: true, env });
	} catch {
		return { ok: false, reason: 'the shell could not run' };
	}
	if (!out || out.status !== 0) return { ok: false, reason: 'the command failed' };
	const key = String(out.stdout || '').trim();
	return key ? { ok: true, key } : { ok: false, reason: 'the command printed nothing' };
}

/**
 * deepseekKeyState — one line for install and setup output, pure so a test can
 * pin it: is the key file there, does models.json read it, and does reading it
 * work. Never the key itself.
 */
export function deepseekKeyState({ keyFile = false, apiKey = null, resolves = false } = {}) {
	if (!keyFile) return 'MISSING — ./setup.sh asks for it; models.json needs deepseek.key';
	if (apiKeyCommandBody(apiKey) === null) return 'present, but models.json does not read a command — re-run ./install.sh';
	return resolves ? 'present, models.json reads it' : 'present, but models.json cannot read it — re-run ./install.sh';
}

// --- the Windows guard task --------------------------------------------------
export const GUARD_TASK_NAME = 'big-boss-pi-guard';

/**
 * gitBashCandidates — where Git for Windows may have put `bash.exe`, best guess
 * first.
 *
 * Why this exists: `bin/guard` starts with `#!/usr/bin/env bash`, and Task
 * Scheduler has no shebang interpretation — a task pointing at the file itself
 * starts nothing, which is exactly what the Windows run reported. So the
 * scheduled command has to name the interpreter, and naming it means resolving
 * it: a task gets no useful PATH, `C:\Program Files\Git` is only the default (a
 * per-user install lands in `%LOCALAPPDATA%\Programs\Git`), and being wrong here
 * fails silently at the next logon.
 *
 * `execPath` is `git --exec-path` — `<root>\mingw64\libexec\git-core`, or
 * `<root>\libexec\git-core` for a 64-bit-only install. Rather than encode those
 * layouts, every ancestor of it is tried with `bin\bash.exe` appended: the root
 * is one of them whatever the layout, and a candidate that does not exist costs
 * one `existsSync`.
 *
 * `PI_GIT_BASH` replaces the whole list instead of joining it: an explicit
 * override is a promise, and a wrong one should say "that is not there" rather
 * than quietly register whichever bash happened to be found instead. The value
 * is returned verbatim — a path outside the default layout is the reason to set
 * it, so normalising it is how it stops matching.
 *
 * The order is the one a person would try: the override, then `bash.exe` as
 * PATH has it, then the Git for Windows directories. The WSL launcher
 * (`%SystemRoot%\System32\bash.exe`) is filtered out of PATH: it is named bash
 * and it is not Git Bash, so a shim or a task built on it would start a Linux
 * shell that cannot run a `C:\...` script path.
 */
export function gitBashCandidates({ platform = process.platform, env = process.env, execPath = '' } = {}) {
	if (platform !== 'win32') return [];
	if (env.PI_GIT_BASH) return [env.PI_GIT_BASH];
	const win = path.win32;
	const out = [];
	const add = (p) => {
		if (!p || out.includes(p)) return;
		out.push(p);
	};
	const systemRoot = win.normalize(env.SystemRoot || 'C:\\Windows').toLowerCase();
	for (const dir of `${env.PATH || env.Path || ''}`.split(';')) {
		if (!dir.trim()) continue;
		const candidate = win.join(dir, 'bash.exe');
		if (win.normalize(win.dirname(candidate)).toLowerCase() === win.join(systemRoot, 'System32').toLowerCase()) continue;
		add(candidate);
	}
	if (execPath) {
		let dir = win.dirname(win.normalize(execPath));
		for (let up = 0; up < 5 && dir; up++) {
			add(win.join(dir, 'bin', 'bash.exe'));
			const parent = win.dirname(dir);
			if (!parent || parent === dir) break;
			dir = parent;
		}
	}
	const gitRoots = [win.join(env.ProgramFiles || 'C:\\Program Files', 'Git'), win.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git')];
	if (env.LOCALAPPDATA) gitRoots.push(win.join(env.LOCALAPPDATA, 'Programs', 'Git'));
	// `bin` is what Git Bash puts on PATH; `usr\bin` is the same bash one level
	// down, and the only one there on an install that kept PATH bare.
	for (const root of gitRoots) {
		add(win.join(root, 'bin', 'bash.exe'));
		add(win.join(root, 'usr', 'bin', 'bash.exe'));
	}
	return out;
}

/**
 * resolveGitBash — the one answer to "where is bash" on Windows.
 *
 * Both the guard's `schtasks /TR` and every `.cmd` shim are built from this, so
 * there is one lookup and one override (`PI_GIT_BASH`) to learn. `exists` is a
 * parameter because a test needs to answer it without a Windows disk.
 */
export function resolveGitBash({ platform = process.platform, env = process.env, execPath = '', exists = (p) => fs.existsSync(p) } = {}) {
	return gitBashCandidates({ platform, env, execPath }).find((p) => exists(p)) || null;
}

/**
 * POSIX_WRAPPERS — every bin entry the installer puts on PATH that is really a
 * bash program (`#!/usr/bin/env bash`), with the directory its source lives in.
 *
 * One list, because two facts depend on it: the copy loop in install.mjs, and
 * the `.cmd` shim written next to each copy on win32. Spelled twice, a sixth
 * wrapper would arrive as a file Windows cannot start and nobody would notice
 * until they typed its name in PowerShell.
 */
export const POSIX_WRAPPERS = [
	{ name: 'pi-bare', from: 'scripts' },
	{ name: 'pisandbox', from: 'scripts' },
	{ name: 'jev', from: 'bin' },
	{ name: 'delegate', from: 'bin' },
	{ name: 'local-run', from: 'bin' },
];

/**
 * cmdShim — the `.cmd` a person (and Herdr) actually runs on Windows.
 *
 * Windows has no shebang: the POSIX wrapper copied onto PATH does nothing when
 * typed in PowerShell or put in a menu row. So each wrapper gets a `.cmd` whose
 * whole job is to name the resolved bash, hand it the script, forward `%*`
 * verbatim and pass the exit status through — `%ERRORLEVEL%` is read after the
 * program ran, which is why `exit /b` is its own line.
 *
 * The bash path is written in, not `%PI_GIT_BASH%`: a menu row and a scheduled
 * task inherit no useful environment, and a shim that only works in a prompt
 * where a variable was set is the bug this replaces. Moving Git means re-running
 * the installer — which is already how every other path in here behaves.
 *
 * Two path spellings on purpose. bash.exe is executed by cmd.exe, so it keeps
 * its native backslashes; the script path is handed to Git Bash, which reads
 * `C:/Users/...` without asking whether a backslash was an escape, so it is
 * written with forward slashes. `scripts/tests/install-win-cmd-shims.test.mjs`
 * pins both.
 */
export function cmdShim({ bashPath, scriptPath }) {
	if (!bashPath) throw new Error('cmdShim needs the absolute path of bash.exe');
	if (!scriptPath) throw new Error('cmdShim needs the absolute path of the POSIX wrapper it starts');
	return [
		'@echo off',
		'rem Generated by ~/.pi/install.mjs. Edit the source there and re-run it.',
		`"${bashPath}" "${scriptPath.replace(/\\/g, '/')}" %*`,
		'exit /b %ERRORLEVEL%',
		'',
	].join('\r\n');
}

/**
 * pasteArg — one argument spelled so it can be pasted into cmd.exe, backslash
 * escapes and all. Not the shared `cmdQuote` below: that one doubles a quote,
 * which is right for cmd.exe reading a command line, and wrong here — the value
 * being carried is itself a quoted program line that schtasks parses with
 * MSVCRT rules, where `\"` is the escape.
 */
function pasteArg(value) {
	return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * schtasksExe — the absolute `schtasks.exe`.
 *
 * Spawned by that path and never as bare `schtasks`: scripts/install-lib.mjs
 * `spawnPlan` sends a bare name on Windows through `cmd.exe` (it cannot know the
 * name is not a `.cmd` shim), and cmd.exe quotes the command line on its way in
 * — which doubles every `"` inside the `/TR` value. The task then registers a
 * command line that is not the one printed. A full `.exe` path is spawned
 * directly, argv untouched.
 */
export function schtasksExe({ systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
	return path.win32.join(systemRoot, 'System32', 'schtasks.exe');
}

/**
 * wscriptExe — the absolute `wscript.exe`, the Windows Script Host for `.vbs`.
 *
 * The task names this instead of `bash.exe` because wscript is a GUI program:
 * it owns no console. `bash.exe` is a console program, so a task pointing at it
 * opened a console window at logon and again on the installer's own `/Run`, and
 * the guard is a loop — the window never closed by itself.
 */
export function wscriptExe({ systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
	return path.win32.join(systemRoot, 'System32', 'wscript.exe');
}

/** The hidden launcher's name, written next to the installer's own state. */
export const GUARD_LAUNCHER_NAME = 'guard-hidden.vbs';
/** The file the launcher records the guard's pid in, so Disable: can stop it. */
export const GUARD_PID_NAME = 'guard.pid';

/** guardLauncherPath — `~/.pi/state/guard-hidden.vbs`: no new top-level dir. */
export function guardLauncherPath({ piHome }) {
	if (!piHome) throw new Error('guardLauncherPath needs ~/.pi');
	return path.join(piHome, 'state', GUARD_LAUNCHER_NAME);
}

/** guardPidPath — `~/big-boss-pi/state/guard.pid`, beside the guard's own log. */
export function guardPidPath({ bossDir }) {
	if (!bossDir) throw new Error('guardPidPath needs the delegation workspace');
	return path.join(bossDir, 'state', GUARD_PID_NAME);
}

/**
 * hiddenLauncher — the `.vbs` Task Scheduler runs instead of a console program.
 *
 * `wscript.exe` starts this file; it runs the Git Bash command line with window
 * style 0 (`Run command, 0, False` — hidden, and do not wait, because the guard
 * runs until the machine stops), records the guard's pid, and exits. Both paths
 * are the resolved absolute ones, quoted for the space in `C:\Program Files`,
 * and a quote inside a VBScript string is spelled by doubling it.
 *
 * Two consequences of exiting, both handled here rather than in Task Scheduler:
 * the task now reads Ready while the guard runs (the launcher is not the loop),
 * so the pid file is what says whether it is up; and a second `/Run` — a second
 * install, or a logon over a guard that is already going — would start a second
 * guard, so an existing one is looked for first and its pid recorded instead.
 *
 * The pid is not returned by `Run` (it answers the exit code, and there is none
 * to wait for), so it is found through WMI: the `bash.exe` whose command line
 * names this guard. Bounded — fifty tries at 100 ms — because a launcher that
 * hangs on a lookup is a window that never closes again. An empty pid file is
 * the honest answer when the guard never appeared, and the disable line then
 * stops at the task delete.
 */
export function hiddenLauncher({ bashPath, guardPath, pidPath }) {
	if (!bashPath) throw new Error('hiddenLauncher needs the absolute path of bash.exe');
	if (!guardPath) throw new Error('hiddenLauncher needs the absolute path of bin/guard');
	if (!pidPath) throw new Error('hiddenLauncher needs the path to write the guard pid to');
	const vbs = (value) => `"${String(value).replace(/"/g, '""')}"`;
	const command = `${vbs(bashPath)} ${vbs(guardPath)}`;
	return [
		"' Generated by ~/.pi/install.mjs. Edit the source there and re-run it.",
		"'",
		"' Task Scheduler runs this file through wscript.exe, which has no console: the",
		"' guard is a loop, so a console program it started owned a window forever.",
		"' Window style 0 = hidden, False = do not wait; the guard outlives this file.",
		"' A guard that is already running is not started twice — its pid is recorded.",
		'Option Explicit',
		'Dim shell, command, pidPath, wmi, pid, fso, out, tries',
		'Set shell = CreateObject("WScript.Shell")',
		'Set fso = CreateObject("Scripting.FileSystemObject")',
		'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
		`command = ${vbs(command)}`,
		`pidPath = ${vbs(pidPath)}`,
		`pid = GuardPid(${vbs(guardPath)})`,
		'If pid = 0 Then',
		'    shell.Run command, 0, False',
		'    For tries = 1 To 50',
		`        pid = GuardPid(${vbs(guardPath)})`,
		'        If pid > 0 Then Exit For',
		'        WScript.Sleep 100',
		'    Next',
		'End If',
		'Set out = fso.CreateTextFile(pidPath, True)',
		'If pid > 0 Then out.WriteLine pid',
		'out.Close',
		'Function GuardPid(guardPath)',
		'    Dim processes, process, found',
		'    GuardPid = 0',
		'    Set processes = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = \'bash.exe\'")',
		'    For Each process In processes',
		'        If Not IsNull(process.CommandLine) Then',
		'            If InStr(LCase(process.CommandLine), LCase(guardPath)) > 0 Then found = process.ProcessId',
		'        End If',
		'    Next',
		'    If IsEmpty(found) Then Exit Function',
		'    GuardPid = found',
		'End Function',
		'',
	].join('\r\n');
}

/**
 * launcherTargets — read back what a generated launcher runs.
 *
 * The inverse of `hiddenLauncher` for the two paths that matter, so
 * `scripts/verify-install.mjs` can assert on the installed file instead of on
 * the string it would have generated: a launcher naming a bash.exe that is not
 * on this machine starts nothing, and the task would still look healthy.
 */
export function launcherTargets(text) {
	const source = String(text);
	const command = /^command = """([^"]+)"" ""([^"]+)"""\s*$/m.exec(source);
	if (!command) return null;
	const pid = /^pidPath = "([^"]+)"\s*$/m.exec(source)?.[1] || null;
	return { bashPath: command[1], guardPath: command[2], pidPath: pid };
}

/**
 * guardStopCommand — the line that stops a guard the hidden launcher started.
 *
 * Deleting the task cancels the *next* logon; the guard this install started is
 * still running, and with no window there is nothing to close. The launcher
 * wrote the pid, so this reads that file and kills that process. `usebackq` is
 * what makes the quoted path a file name rather than a literal string — and the
 * quotes are there for `C:\Users\<a name with a space>\`.
 */
export function guardStopCommand({ pidPath }) {
	if (!pidPath) throw new Error('guardStopCommand needs the launcher pid file');
	return `for /f "usebackq" %p in ("${pidPath}") do taskkill /F /PID %p`;
}

/**
 * guardTaskCommand — the `schtasks` argv for the guard, and the lines a person
 * needs from it.
 *
 * The `/TR` value is the whole program line Task Scheduler will run, one string
 * containing both paths, each quoted: `C:\Program Files` has a space in it and
 * an unquoted program path is a task that starts nothing. The argv is passed as
 * argv (node quotes it for the child), while `registered` is the same command
 * quoted for cmd.exe, so what the installer prints is what a person can paste
 * into a prompt — the two differ, and that is why both exist.
 *
 * It names `wscript.exe` and the launcher, never `bash.exe` directly: bash is a
 * console program, so registering it opened a console window at logon and again
 * on the installer's `/Run`, and a guard that loops forever kept it open. The
 * launcher runs that same bash command line hidden (`hiddenLauncher`), so the
 * guard, the interval and the space it creates are unchanged.
 */
export function guardTaskCommand({ launcherPath, pidPath = '', wscriptPath = wscriptExe(), taskName = GUARD_TASK_NAME }) {
	if (!launcherPath) throw new Error('guardTaskCommand needs the absolute path of the hidden launcher');
	const tr = `"${wscriptPath}" "${launcherPath}"`;
	const args = ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', tr];
	const remove = `schtasks /Delete /TN ${taskName} /F`;
	return {
		// `program` is what a person types; `exe` is what the engine spawns, for the
		// quoting reason in schtasksExe.
		program: 'schtasks',
		exe: schtasksExe(),
		args,
		tr,
		wscriptPath,
		launcherPath,
		registered: `schtasks ${args
			.map((a) => (a === tr ? pasteArg(a) : a))
			.join(' ')}`,
		remove,
		// Two commands, because the task is not the running process: the delete
		// stops the next logon, the pid from the launcher stops this one.
		stop: pidPath ? guardStopCommand({ pidPath }) : '',
	};
}

// --- starting the guard now, and saying whether the space appeared ------------
// Registering the login entry is not the same as running the guard. `schtasks
// /SC ONLOGON` starts at the *next logon*, so on the Windows box the person ran
// the installer, Herdr opened, and the space was missing with nothing to read:
// "install finished" promised something the entry had not done yet. So the step
// starts the entry once, then waits a bounded time for the space and says what
// it saw — a green install that names the task, the log and the app.
export const GUARD_LABEL = 'dev.herdr.big-boss-pi-guard';
export const GUARD_SPACE_NAME = 'big-boss-pi';
/** How long the step waits for the space before it says it did not appear. */
export const GUARD_SPACE_WAIT_MS = 20000;

/**
 * guardStartCommand — the argv that starts the entry that was just registered.
 *
 * `launchctl load` installs and, with RunAtLoad, starts — but a reload of an
 * already-loaded label is a no-op, so the explicit `kickstart -k` is what makes
 * this install start the guard rather than the previous boot's one. Task
 * Scheduler needs `/Run`, always: `/SC ONLOGON` alone is a promise about the
 * next logon.
 */
export function guardStartCommand({ platform, taskName = GUARD_TASK_NAME, label = GUARD_LABEL, uid = 0 } = {}) {
	if (platform === 'win32') {
		const args = ['/Run', '/TN', taskName];
		// The absolute exe for the same quoting reason as schtasksExe: a bare name is
		// sent through cmd.exe.
		return { program: `schtasks ${args.join(' ')}`, exe: schtasksExe(), args };
	}
	if (platform === 'darwin') {
		const args = ['kickstart', '-k', `gui/${uid}/${label}`];
		return { program: `launchctl ${args.join(' ')}`, exe: 'launchctl', args };
	}
	return null;
}

/**
 * spaceIdIn — the id of the space called `name` in a `herdr-app ls` snapshot.
 *
 * The same predicate as `bin/guard`'s `space_id`, which is the parser this
 * mirrors: `(j.spaces || []).find(s => s.name === SPACE_NAME)`. It lives here
 * too because the two readers of that snapshot are a bash script and a node
 * installer, and the alternative — a second, differently-worded matcher — is how
 * the installer and the guard start disagreeing about whether the space exists.
 * Null when the snapshot is not JSON or names no such space.
 */
export function spaceIdIn(lsText, name = GUARD_SPACE_NAME) {
	let snapshot;
	try {
		snapshot = JSON.parse(lsText);
	} catch {
		return null;
	}
	const hit = (snapshot.spaces || []).find((s) => s && s.name === name);
	return hit ? String(hit.id ?? '') : null;
}

/**
 * waitForSpace — poll until the space exists, the app stops answering, or time
 * runs out. Bounded on purpose: an install must not hang on a desktop app, and
 * "not there yet" is not "broken".
 *
 * `probe` answers `{ running, id }`: a herdr-app that is not up yet is not a
 * failure (the guard creates the space when the app starts), so the first
 * not-running answer ends the wait as `app-down` instead of burning the budget.
 * `now`/`sleep` are parameters so a test drives twenty seconds in a few calls.
 */
export async function waitForSpace({
	probe,
	timeoutMs = GUARD_SPACE_WAIT_MS,
	intervalMs = 500,
	now = () => Date.now(),
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
	const deadline = now() + timeoutMs;
	for (;;) {
		const answer = probe();
		if (!answer || !answer.running) return { state: 'app-down', id: null };
		if (answer.id) return { state: 'found', id: answer.id };
		const left = deadline - now();
		if (left <= 0) return { state: 'missing', id: null };
		await sleep(Math.min(intervalMs, left));
	}
}

/**
 * guardDoor — the three commands to look at when the space did not appear.
 *
 * This list is the point of the whole step: the Windows run ended with "install
 * finished, Herdr is empty" and no next move. A failure that names where to look
 * costs one line at install time and saves the person a support thread.
 */
export function guardDoor({ platform, bossDir, label = GUARD_LABEL, uid = 0, taskName = GUARD_TASK_NAME }) {
	const how = platform === 'win32' ? `schtasks /Query /TN ${taskName} /V /FO LIST` : `launchctl print gui/${uid}/${label}`;
	// The platform's own join, not the host's: a Windows line has to read
	// `...\state\guard.log` even when the test that prints it runs on Linux.
	const log = (platform === 'win32' ? path.win32 : path).join(bossDir, 'state', 'guard.log');
	return [
		`   the entry: ${how}`,
		`   the guard log: ${log}   (tail -n 20 it)`,
		`   the app: herdr-app ls`,
	];
}

/**
 * startAndVerifyGuard — start the entry, then answer in one of four ways.
 *
 * Every effect is injected (`run`, `probe`, `say`, `sleep`, `now`) so the five
 * outcomes are testable without a desktop app, a Task Scheduler or a sleep:
 *   - `dry`: nothing is started, the plan is printed;
 *   - `start-failed`: the start command failed — said loudly, and the install
 *     does not abort (the entry is registered; the next logon still gets a try);
 *   - `found`: the space is there, said in one line;
 *   - `app-down`: herdr-app is not running yet — not a failure, and the line says
 *     when the space will appear;
 *   - `missing`: the app is running and the space is not — the loud line plus the
 *     three commands above.
 */
export async function startAndVerifyGuard({
	platform,
	bossDir,
	taskName = GUARD_TASK_NAME,
	label = GUARD_LABEL,
	uid = 0,
	name = GUARD_SPACE_NAME,
	dry = false,
	run,
	probe,
	timeoutMs = GUARD_SPACE_WAIT_MS,
	intervalMs = 500,
	now,
	sleep,
	out = {},
} = {}) {
	const say = out.say || (() => {});
	const note = out.note || (() => {});
	const start = guardStartCommand({ platform, taskName, label, uid });
	if (!start) return { started: false, state: 'no-entry' };

	say(`   start: ${start.program}`);
	if (dry) {
		say('   [dry-run] not started');
		return { started: false, state: 'dry' };
	}

	const exit = run ? run(start.exe, start.args) : 0;
	if (exit !== 0) {
		say(`== guard: registered, but starting it failed (exit ${exit ?? 'n/a'}) — the entry is there, so the next logon still gets a try`);
		for (const line of guardDoor({ platform, bossDir, label, uid, taskName })) say(line);
		return { started: false, state: 'start-failed' };
	}
	note(`guard: started the ${platform === 'win32' ? 'scheduled task' : 'login item'} — waiting up to ${Math.round(timeoutMs / 1000)}s for the ${name} space`);

	if (platform !== 'win32' && platform !== 'darwin') return { started: true, state: 'started' };
	if (typeof probe !== 'function') return { started: true, state: 'started' };

	const answer = await waitForSpace({ probe, timeoutMs, intervalMs, now, sleep });
	if (answer.state === 'found') {
		note(`guard: the ${name} space is there (${answer.id})`);
	} else if (answer.state === 'app-down') {
		note(`guard: registered and started — Herdr is not running yet, so the guard creates the ${name} space when it starts`);
	} else {
		say(`== guard: registered and started, but no ${name} space appeared`);
		for (const line of guardDoor({ platform, bossDir, label, uid, taskName })) say(line);
	}
	return { started: true, state: answer.state };
}

// --- the delegation workspace clone ------------------------------------------
export const BOSS_REPO_DEFAULT = 'mjmeijerman/big-boss-pi';

/**
 * bossClonePlan — the clone transports for the delegation workspace, in order.
 *
 * Both repos are public, so the first step on a bare machine must not need a
 * key: `https://` clones without one, and it is the attempt that carries no
 * precondition beyond the network. `gh` still goes first when it is
 * authenticated (it is the account people already have), SSH is last because it
 * is the only transport that fails for want of a key — and when it was the only
 * fallback, the workspace silently did not arrive and the top of stepBoss read
 * the missing directory as "fine".
 *
 * `hasNetwork: false` is PI_SKIP_NETWORK=1: no attempts at all, which is what
 * the engine prints as skipped instead of cloning into an air-gapped box.
 */
export function bossClonePlan({
	ghAuthed = false,
	hasNetwork = true,
	repo = BOSS_REPO_DEFAULT,
	dir = 'big-boss-pi',
} = {}) {
	if (!hasNetwork) return [];
	const attempts = [];
	if (ghAuthed) attempts.push({ transport: 'gh', cmd: 'gh', args: ['repo', 'clone', repo, dir] });
	attempts.push({ transport: 'https', cmd: 'git', args: ['clone', `https://github.com/${repo}.git`, dir] });
	attempts.push({ transport: 'ssh', cmd: 'git', args: ['clone', `git@github.com:${repo}.git`, dir] });
	return attempts;
}

// --- AGENTS.md rules --------------------------------------------------------

/** ruleSlug — a stable id for a rule: its first six words, lowercased. */
export function ruleSlug(text) {
	const words = String(text)
		.toLowerCase()
		.replace(/[`*_()[\]{}#]/g, ' ')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6);
	return words
		.join('-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

/**
 * parseAgentsMd — turns the rule file into items (headings, rules, text) plus a
 * flat rule list. A rule owns the indented continuation lines that follow it, so
 * a dropped rule takes its whole paragraph with it.
 */
export function parseAgentsMd(text) {
	const lines = String(text).split('\n');
	const items = [];
	const rules = [];
	let section = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^#{1,6}\s/.test(line)) {
			section = line.replace(/^#+\s*/, '').trim();
			items.push({ kind: 'heading', line });
			continue;
		}
		if (/^\s*[-*]\s+\S/.test(line) && !/^\s+/.test(line)) {
			const body = [line];
			let j = i + 1;
			while (j < lines.length && /^[ \t]+\S/.test(lines[j])) {
				body.push(lines[j]);
				j++;
			}
			const rule = {
				index: rules.length + 1,
				section,
				text: line.replace(/^\s*[-*]\s+/, ''),
				lines: body,
			};
			rule.slug = ruleSlug(rule.text);
			rules.push(rule);
			items.push({ kind: 'rule', rule });
			i = j - 1;
			continue;
		}
		items.push({ kind: 'text', line });
	}
	return { items, rules };
}

/** ruleIds — index -> slug, the map the state file records answers against. */
export function ruleIds(parsed) {
	return parsed.rules.map((r) => ({ index: r.index, slug: r.slug, section: r.section, text: r.text }));
}

/**
 * filterAgentsMd — keep the rules `keep(rule)` says yes to and reproduce every
 * other byte. Keeping all rules returns the input verbatim, which is the
 * property that makes an unfiltered install a no-op.
 * A `##` section whose rules are all dropped loses its heading too: a heading is
 * an instruction, and an empty one is a rule nobody can follow.
 */
export function filterAgentsMd(text, keep) {
	const source = String(text);
	if (typeof keep !== 'function') {
		const set = new Set(keep || []);
		keep = (rule) => set.has(rule.index) || set.has(rule.slug);
	}
	const { items } = parseAgentsMd(source);
	const kept = [];
	for (const item of items) {
		if (item.kind === 'rule') {
			if (keep(item.rule)) kept.push(item);
			continue;
		}
		if (item.kind === 'heading' && item.line.startsWith('## ')) {
			kept.push({ ...item, pending: true });
			continue;
		}
		kept.push(item);
	}
	const out = [];
	for (let i = 0; i < kept.length; i++) {
		const item = kept[i];
		if (item.kind === 'heading' && item.pending) {
			let hasRule = false;
			for (let j = i + 1; j < kept.length; j++) {
				if (kept[j].kind === 'heading') break;
				if (kept[j].kind === 'rule') {
					hasRule = true;
					break;
				}
			}
			if (!hasRule) {
				// Drop the heading and the blank lines it left behind.
				while (i + 1 < kept.length && kept[i + 1].kind === 'text' && kept[i + 1].line.trim() === '') i++;
				continue;
			}
		}
		if (item.kind === 'rule') out.push(...item.rule.lines);
		else out.push(item.line);
	}
	// One blank line between blocks, one newline at the end.
	const squeezed = [];
	for (const line of out) {
		if (line.trim() === '' && (squeezed.length === 0 || squeezed[squeezed.length - 1].trim() === '')) continue;
		squeezed.push(line);
	}
	while (squeezed.length && squeezed[squeezed.length - 1].trim() === '') squeezed.pop();
	return `${squeezed.join('\n')}\n`;
}

/** ruleAnswer — the recorded answer for a rule, or undefined when never asked. */
export function ruleAnswer(state, slug) {
	const rules = (state && state.rules) || {};
	return Object.prototype.hasOwnProperty.call(rules, slug) ? rules[slug] : undefined;
}

// --- managed blocks (the pi wrapper) ---------------------------------------

/**
 * spliceManagedBlock — replace the marked block in a shell rc file, keeping
 * everything outside it and appending when it is not there yet. Re-running it
 * with the same block is a no-op, which is what makes install idempotent.
 */
export function spliceManagedBlock(text, begin, end, block) {
	const lines = String(text).split('\n');
	const out = [];
	let inside = false;
	for (const line of lines) {
		if (line === begin) {
			inside = true;
			continue;
		}
		if (line === end) {
			inside = false;
			continue;
		}
		if (!inside) out.push(line);
	}
	while (out.length && out[out.length - 1].trim() === '') out.pop();
	const tail = block.endsWith('\n') ? block.slice(0, -1).split('\n') : block.split('\n');
	out.push(...tail);
	return `${out.join('\n')}\n`;
}

// The sandbox is the default for `pi` on purpose: a wrapper you have to remember
// to type is willpower, not a default (blip 1, Adopt). PI_BARE=1 is the escape
// hatch, and a missing sandbox falls back to the plain binary — a broken sandbox
// must never make pi unusable.
export const PI_WRAPPER_BEGIN = '# >>> pi sandbox >>>';
export const PI_WRAPPER_END = '# <<< pi sandbox <<<';

export const PI_WRAPPER_BLOCK = `# >>> pi sandbox >>>
# Managed by ~/.pi/install.mjs — edit there, not here; re-run it to refresh.
# Radar blip 1 (Adopt, agent sandboxing): plain \`pi\` is sandboxed, so safety
# does not depend on remembering a prefix. Bypass one session: PI_BARE=1 pi
pi() {
	local _pi_bin="\${PI_BIN:-$HOME/.local/share/pnpm/bin/pi}"
	[ -x "$_pi_bin" ] || _pi_bin="$HOME/.local/bin/pi"
	if [ ! -x "$_pi_bin" ]; then
		printf 'pi: binary not found (set PI_BIN=/path/to/pi)\\n' >&2
		return 127
	fi
	# A bash login shell carries no PNPM_HOME, and pisandbox refuses to start
	# when it cannot find pi on PATH: put the shim's directory on PATH first.
	case ":$PATH:" in
	*":\${_pi_bin%/*}:"*) ;;
	*) PATH="\${_pi_bin%/*}:$PATH" ;;
	esac
	export PATH
	if [ "\${PI_BARE:-}" = 1 ]; then
		"$_pi_bin" "$@"
		return
	fi
	if [ ! -x "$HOME/.pi/scripts/pisandbox" ] || ! command -v bwrap >/dev/null 2>&1; then
		printf 'pi: sandbox unavailable (pisandbox or bwrap missing) — running unsandboxed\\n' >&2
		"$_pi_bin" "$@"
		return
	fi
	"$HOME/.pi/scripts/pisandbox" -- pi "$@"
}
# <<< pi sandbox <<<`;

// --- the pi binary -----------------------------------------------------------
// Installing pi is the default: pi is the thing this whole config exists to
// drive, so a run that ends with `'pi' not found on PATH` and exit 1 after every
// question was answered is a run that did the work and then stopped one step
// short. The decisions live here, not in the engines, so the install path, the
// setup question and the tests read one function.
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * piDiskCandidates — where a pi that is NOT on PATH may sit, in search order.
 * pnpm keeps its bin directory out of PATH on purpose, so a pi that npm or pnpm
 * installed is otherwise "missing" to a shell that never sourced the wrapper.
 * Both engines read this list, so setup and install agree on what missing means.
 */
export function piDiskCandidates({ home, plan = planFor(), env = {} } = {}) {
	const dirs = [path.join(env.PNPM_HOME || path.join(home, '.local', 'share', 'pnpm'), 'bin'), path.join(home, '.local', 'bin')];
	const names = plan.platform === 'win32' ? ['pi.cmd', 'pi.exe'] : ['pi'];
	return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

/** piInstallArgv — the one command line that installs pi, as argv. */
export function piInstallArgv(npmBin = 'npm') {
	return [npmBin, 'install', '-g', '--ignore-scripts', PI_PACKAGE];
}

/** piInstallCommand — the same line as text, for a question, a message or docs. */
export function piInstallCommand(npmBin = 'npm') {
	return piInstallArgv(npmBin).join(' ');
}

/**
 * nodePrereqHint — where this OS gets Node (and with it npm), in one line.
 * The commands are the ones docs/install.md#prerequisites-per-os carries, so a
 * person who reads the stop message is reading the page that fixes it.
 */
export function nodePrereqHint(plan = planFor()) {
	if (plan.platform === 'win32') return 'winget install --id OpenJS.NodeJS.LTS -e --source winget   (in PowerShell, then reopen the shell)';
	if (plan.platform === 'darwin') return 'brew install node@24   (or the Node 24 installer from nodejs.org), then reopen the terminal';
	return 'sudo apt-get install -y nodejs npm   (dnf/pacman one-liners in docs/install.md), then reopen the shell';
}

/**
 * piPreflight — what to do about the pi binary, decided as data.
 *
 * Order is the policy: a pi already on PATH is nothing to do; one found on disk
 * (pnpm keeps it out of PATH) is put on PATH; PI_ALLOW_MISSING_PI=1 is the CI
 * escape hatch and skips without failing; --no-install-pi is a person saying
 * "not here"; otherwise npm installs it; and with no npm at all the run stops
 * rather than half-installing a tree around a binary that cannot start.
 *
 * Returns { action, message, argv?, fix? } — 'present' | 'path' | 'skip' |
 * 'install' | 'stop'.
 */
export function piPreflight({ onPath = false, onDisk = null, npm = false, npmBin = 'npm', allowMissing = false, install = true, plan = planFor() } = {}) {
	if (onPath) return { action: 'present' };
	if (onDisk) return { action: 'path', message: `pi found on disk, added to PATH: ${onDisk}`, path: onDisk };
	if (allowMissing) return { action: 'skip', message: 'PI_ALLOW_MISSING_PI=1 — config only' };
	if (!install) return { action: 'skip', message: '--no-install-pi — pi is not installed; put it on PATH when you have it' };
	if (npm) return { action: 'install', message: `installing pi with npm (global): ${piInstallCommand(npmBin)}`, argv: piInstallArgv(npmBin) };
	return {
		action: 'stop',
		message: `no pi on PATH and no ${npmBin} to install it with — Node (npm ships with it) is a prerequisite`,
		fix: [nodePrereqHint(plan), `then re-run this installer: ${piInstallCommand(npmBin)}`],
	};
}

// --- the flags ---------------------------------------------------------------
// One table per engine, and the parser reads it. `--help` renders the same
// table, so a flag the code accepts cannot be a flag the help text forgets:
// scripts/tests/install-help.test.mjs asserts exactly that, and a new entry
// with no help line fails it (docs/install.md has the human copy).
//
// kind  'bool' sets `value` and takes no argument; 'list' splits on commas;
//       'text' keeps the string as written.
export const ENGINE_FLAGS = {
	install: [
		{ names: ['--install-pi'], key: 'installPi', kind: 'bool', value: true, default: true, help: 'install pi with npm when it is missing (the default; kept so old scripts keep working)' },
		{ names: ['--no-install-pi'], key: 'installPi', kind: 'bool', value: false, help: 'never install pi, carry on without it' },
		{ names: ['--skip-prereqs'], key: 'skipPrereqs', kind: 'bool', value: true, default: false, help: 'never check or install git, node and npm' },
		{ names: ['--dry-run'], key: 'dryRun', kind: 'bool', value: true, default: false, help: 'print the plan, change nothing' },
		{ names: ['--skills='], key: 'skills', kind: 'list', help: 'only these skills (comma-separated)' },
		{ names: ['--extensions='], key: 'extensions', kind: 'list', help: 'only these extensions (comma-separated, .ts optional)' },
		{ names: ['-h', '--help'], key: 'help', kind: 'bool', value: true, help: 'print this text and exit 0' },
	],
	setup: [
		{ names: ['-y', '--yes'], key: 'yes', kind: 'bool', value: true, default: false, help: 'accept every default (installs the full set)' },
		{ names: ['--skills='], key: 'skills', kind: 'list', help: 'only these skills (comma-separated), no question per skill' },
		{ names: ['--extensions='], key: 'extensions', kind: 'list', help: 'only these extensions (comma-separated, .ts optional)' },
		{ names: ['--rules='], key: 'rules', kind: 'text', help: 'all | none | keep:1,2 | drop:3,4 — the rule answers without a person' },
		{ names: ['--no-keys'], key: 'noKeys', kind: 'bool', value: true, default: false, help: 'never ask for a key' },
		{ names: ['--dry-run'], key: 'dryRun', kind: 'bool', value: true, default: false, help: 'print the plan, change nothing' },
		{ names: ['--reask'], key: 'reask', kind: 'bool', value: true, default: false, help: 'ask again about everything the state file records' },
		{ names: ['--no-apt'], key: 'doApt', kind: 'bool', value: false, default: true, help: 'never call sudo apt-get (Linux only)' },
		{ names: ['--skip-prereqs'], key: 'skipPrereqs', kind: 'bool', value: true, default: false, help: 'never check or install git, node and npm' },
		{ names: ['--no-verify'], key: 'verify', kind: 'bool', value: false, default: true, help: 'skip the verification block' },
		{ names: ['--force-key'], key: 'forceKey', kind: 'bool', value: true, default: false, help: 'replace an existing key file' },
		{ names: ['--with-ollama'], key: 'withOllama', kind: 'bool', value: true, default: false, help: 'pull the local model (~17 GB) without asking' },
		{ names: ['--with-dictation'], key: 'withDictation', kind: 'bool', value: true, default: false, help: 'build the whisper venv (~2.5 GB) without asking' },
		{ names: ['--install-pi'], key: 'installPi', kind: 'bool', value: true, default: true, help: 'install pi with npm when it is missing (the default; kept so old scripts keep working)' },
		{ names: ['--no-install-pi'], key: 'installPi', kind: 'bool', value: false, help: 'never install pi, and do not ask; carry on without it' },
		{ names: ['-h', '--help'], key: 'help', kind: 'bool', value: true, help: 'print this text and exit 0' },
	],
};

/**
 * parseFlags — argv in, options out, driven by ENGINE_FLAGS.
 * Throws on an option no table entry names, so the engine can print it and stop
 * instead of ignoring a typo and installing the defaults.
 */
export function parseFlags(engine, argv = []) {
	const table = ENGINE_FLAGS[engine];
	if (!table) throw new Error(`no flag table for engine "${engine}"`);
	const opts = {};
	for (const entry of table) if (entry.default !== undefined) opts[entry.key] = entry.default;
	for (const arg of argv) {
		const entry = table.find((e) => (e.kind === 'bool' ? e.names.includes(arg) : e.names.some((n) => n.endsWith('=') && arg.startsWith(n))));
		if (!entry) throw new Error(`unknown option: ${arg} (try --help)`);
		if (entry.kind === 'bool') {
			opts[entry.key] = entry.value === undefined ? true : entry.value;
			continue;
		}
		const prefix = entry.names.find((n) => n.endsWith('='));
		const value = arg.slice(prefix.length);
		opts[entry.key] = entry.kind === 'list' ? value.split(',') : value;
	}
	return opts;
}

/** helpText — the same table, as the text `--help` prints. */
export function helpText(engine, { command = `node ${engine}.mjs` } = {}) {
	const table = ENGINE_FLAGS[engine];
	if (!table) throw new Error(`no flag table for engine "${engine}"`);
	const names = table.map((e) => e.names.join(', '));
	const width = Math.max(...names.map((n) => n.length));
	const lines = [`Usage: ${command} [flags]`, '', 'Flags:'];
	table.forEach((entry, i) => lines.push(`  ${names[i].padEnd(width)}  ${entry.help}`));
	lines.push('', 'Environment overrides and what each writes: docs/install.md');
	return `${lines.join('\n')}\n`;
}

// --- files, names, hashes ---------------------------------------------------

/** sha256 — content hash used for "second run changes nothing" assertions. */
export function sha256(text) {
	return crypto.createHash('sha256').update(text).digest('hex');
}

/** skillNames — the skill directories in agent/skills, sorted. */
export function skillNames(dir, readdir) {
	return readdir(dir)
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

/** extensionNames — the *.ts files in agent/extensions, sorted, without the suffix. */
export function extensionNames(dir, readdir) {
	return readdir(dir)
		.filter((d) => d.isFile() && d.name.endsWith('.ts'))
		.map((d) => d.name.replace(/\.ts$/, ''))
		.sort();
}

/**
 * systemdUnitsIn — every unit in a directory, and whether it may be enabled.
 *
 * Read off the directory instead of a list in the installer: the timers were once
 * copied without the `.service` files their `Unit=` names, so an enabled
 * `pi-evals.timer` pointed at a unit that was not there. A list in install.mjs is
 * how that happens, and a directory listing is the fix — a fifth unit is copied
 * the day someone drops it in `systemd/`.
 *
 * `enable` comes from the unit itself: `systemctl enable` accepts only a unit with
 * an `[Install]` section, and a oneshot backing a timer has none — the timer's
 * `Unit=` pulls it in. `now` is for timers, which start on enable.
 */
export function systemdUnitsIn(dir, { readdirSync, readFileSync }) {
	return readdirSync(dir)
		.filter((name) => /\.(service|timer)$/.test(name))
		.sort()
		.map((name) => {
			const text = readFileSync(path.join(dir, name), 'utf8');
			const installable = /^\[Install\]/m.test(text);
			return { name, text, enable: installable, now: installable && name.endsWith('.timer') };
		});
}

/**
 * RUNTIME_STATE_FILES — files a running pi writes into the repo's own folders.
 *
 * `scripts/agent-pane.sh` keeps its slug -> pane map in
 * `scripts/.agent-panes.json`: gitignored, machine-local, and different on every
 * machine that has opened a pane. Copying it hands a fresh HOME panes that were
 * never opened there; copying it and deleting it afterwards (the shape before
 * this list) also counted a written file on every run, because the copy wrote it
 * and the delete made the next run write it again — so `== done — 0 change(s)
 * written` was unreachable on any machine that had used agent-pane, and
 * `scripts/tests/git-paths-install.test.mjs` ("a second run ... is still 0
 * changes") failed there while passing on a clean CI clone.
 */
export const RUNTIME_STATE_FILES = ['.agent-panes.json'];

/** isRuntimeState — true for a path a directory copy must not carry over. */
export function isRuntimeState(file) {
	return RUNTIME_STATE_FILES.includes(path.basename(file));
}

/** pickNames — "all" when nothing is given, the named subset otherwise. */
export function pickNames(all, wanted) {
	if (!wanted || wanted.length === 0) return [...all];
	const keep = new Set(wanted.map((w) => String(w).trim()).filter(Boolean));
	return all.filter((n) => keep.has(n));
}

/**
 * parseRuleSelection — `all`, `none`, `keep:1,4,7` or `drop:2,3` into an answer
 * map keyed by index. Used by --rules= in CI, where nothing can be typed.
 */
export function parseRuleSelection(spec, ruleCount) {
	const answers = new Map();
	if (spec === undefined || spec === null || spec === '' || spec === 'all') return answers;
	const all = Array.from({ length: ruleCount }, (_, i) => i + 1);
	if (spec === 'none') {
		for (const i of all) answers.set(i, false);
		return answers;
	}
	const m = /^(keep|drop):(.*)$/.exec(String(spec).trim());
	if (!m) throw new Error(`--rules wants all, none, keep:1,2 or drop:1,2 — got ${spec}`);
	const picked = m[2]
		.split(/[,\s]+/)
		.map((s) => Number.parseInt(s, 10))
		.filter((n) => Number.isInteger(n) && n >= 1);
	for (const i of all) {
		if (m[1] === 'keep') answers.set(i, picked.includes(i));
		else answers.set(i, !picked.includes(i));
	}
	return answers;
}

/**
 * samePath — do two strings name the same path on this platform?
 * Needed because `git config` echoes back what a shell gave it: on Windows the
 * value set from bash is `/c/Users/me/.pi/git-hooks` and the one node computes is
 * `C:\\Users\\me\\.pi\\git-hooks`. Same directory, different spelling.
 */
export function samePath(a, b, platform = process.platform) {
	if (!a || !b) return false;
	const msys = (p) => {
		const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
		return m ? `${m[1]}:\\${m[2]}` : p;
	};
	const norm = (p) => {
		let out = msys(String(p).trim()).replace(/\\/g, '/').replace(/\/+$/, '');
		if (platform === 'win32') out = out.toLowerCase();
		return out;
	};
	return norm(a) === norm(b);
}

// --- the node pin (mise.toml) ------------------------------------------------
/**
 * pinnedNodeMajor — the node major mise.toml pins, read with a regex rather than
 * a TOML parser: four lines do not need a dependency (blip 68, mise, Adopt).
 * A missing, unreadable or silent file falls back to 24, which is what setup
 * printed before the pin existed.
 */
export function pinnedNodeMajor(root, readFileSync) {
	try {
		const raw = readFileSync(path.join(root, 'mise.toml'), 'utf8');
		const m = /^\s*node\s*=\s*["']?([0-9][0-9.]*)/m.exec(raw);
		return m ? Number.parseInt(m[1], 10) : 24;
	} catch {
		return 24;
	}
}

/**
 * nodePreflight — the one place the node version message is written.
 * `nodeVersion` is what the shell prints (v22.1.0), `nodeMajor` the parsed major
 * and `pin` mise.toml's. Returns { level: 'ok' | 'warn' | 'die', message }.
 */
export function nodePreflight({ pin, nodeVersion, nodeMajor }) {
	if (nodeVersion === undefined || nodeMajor === undefined || nodeMajor === null) {
		return { level: 'die', message: `node is not installed (pi needs Node ${pin} or newer)` };
	}
	if (nodeMajor < pin) {
		return { level: 'warn', message: `node ${nodeVersion} is older than ${pin}; pi 1.5.x expects ${pin} or 26` };
	}
	return { level: 'ok', message: `node ${nodeVersion}, mise.toml pins ${pin}` };
}

// --- prerequisites -----------------------------------------------------------
/**
 * The install used to start by telling a person to install git and Node by hand
 * (`INSTALL.md` carried the by-hand lines) and `setup.sh` was `exec node …`,
 * which made node a precondition for installing node. The two bootstrap
 * scripts (`setup.sh`, `setup.ps1`) and the engine's prerequisites step read the
 * table below, so the command a person is shown and the command the engine runs
 * cannot drift apart.
 *
 * Everything here is pure: `has` is a caller-supplied `command -v`, so a test can
 * plan for winget, brew, apt-get, dnf, pacman and mise on any host.
 */

/** The tools the installer needs. `gh` is checked, never required. */
export const PREREQ_TOOLS = ['git', 'node', 'npm'];
export const PREREQ_OPTIONAL = ['gh'];

/**
 * The package managers to try, per platform, in order. `mise` is last because it
 * installs node and nothing else (Radar Vol. 35 blip 68, mise, Adopt), so it is
 * a node answer for a machine that has no system package manager at all.
 */
export const PACKAGE_MANAGERS = {
	linux: ['apt-get', 'dnf', 'pacman', 'brew', 'mise'],
	darwin: ['brew', 'mise'],
	win32: ['winget', 'mise'],
};

/**
 * What each manager calls each package. `null` means that manager has nothing
 * for the tool — npm ships with node on brew and winget, and mise installs node
 * only. `${pin}` is the node major `mise.toml` pins, substituted by
 * prereqPackage().
 */
export const PREREQ_PACKAGES = {
	git: { 'apt-get': 'git', dnf: 'git', pacman: 'git', brew: 'git', winget: 'Git.Git', mise: null },
	node: { 'apt-get': 'nodejs', dnf: 'nodejs', pacman: 'nodejs', brew: 'node@${pin}', winget: 'OpenJS.NodeJS.LTS', mise: 'node' },
	npm: { 'apt-get': 'npm', dnf: 'npm', pacman: 'npm', brew: null, winget: null, mise: null },
	gh: { 'apt-get': 'gh', dnf: 'gh', pacman: 'github-cli', brew: 'gh', winget: 'GitHub.cli', mise: null },
};

/** pickPackageManager — the first manager on PATH for this platform, or null. */
export function pickPackageManager({ platform = process.platform, has = () => false } = {}) {
	for (const manager of PACKAGE_MANAGERS[platform] || PACKAGE_MANAGERS.linux) {
		if (has(manager)) return manager;
	}
	return null;
}

/** prereqPackage — the package name for one tool, or null when the manager has none. */
export function prereqPackage(tool, manager, pin = 24) {
	const row = PREREQ_PACKAGES[tool];
	if (!row) return null;
	const value = row[manager];
	if (typeof value !== 'string') return null;
	return value.replace('${pin}', String(pin));
}

/**
 * installCommand — the argv one package install needs, as data.
 *
 * `sudo` is a field, not a spelling: apt-get, dnf and pacman need root and the
 * step says so before it runs anything, while `brew` and `winget` must not run
 * as root. winget's two `--accept-*` flags are what keep it from opening a
 * prompt nobody sees on a bare machine.
 */
export function installCommand(manager, pkg, { pin = 24 } = {}) {
	switch (manager) {
		case 'apt-get':
			return { file: 'sudo', args: ['apt-get', 'install', '-y', pkg], sudo: true };
		case 'dnf':
			return { file: 'sudo', args: ['dnf', 'install', '-y', pkg], sudo: true };
		case 'pacman':
			return { file: 'sudo', args: ['pacman', '-S', '--needed', '--noconfirm', pkg], sudo: true };
		case 'brew':
			return { file: 'brew', args: ['install', pkg], sudo: false };
		case 'winget':
			return {
				file: 'winget',
				args: ['install', '--id', pkg, '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'],
				sudo: false,
			};
		case 'mise':
			// mise installs node and nothing else; asking it for another tool would
			// print a command that cannot work.
			return pkg === 'node' ? { file: 'mise', args: ['use', '-g', `node@${pin}`], sudo: false } : null;
		default:
			return null;
	}
}

/**
 * prereqPlan — every missing tool, with the command that installs it.
 *
 * `skip` is `PI_SKIP_PREREQS=1` / `--skip-prereqs`: the CI matrix already has
 * git and node and must never call a package manager, so the plan comes back
 * empty instead of being computed and then ignored.
 * `unresolved` is the honest half: a tool is missing and no manager here has a
 * command for it (npm on brew, git with only mise), so the step prints the
 * manual line instead of pretending.
 */
export function prereqPlan({ platform = process.platform, has = () => false, pin = 24, skip = false, optional = [] } = {}) {
	const tools = [...PREREQ_TOOLS, ...optional];
	const missing = tools.filter((tool) => !has(tool));
	if (skip) return { manager: null, missing, steps: [], unresolved: [] };
	const manager = missing.length === 0 ? null : pickPackageManager({ platform, has });
	const steps = [];
	const unresolved = [];
	for (const tool of missing) {
		const pkg = manager ? prereqPackage(tool, manager, pin) : null;
		const command = pkg ? installCommand(manager, pkg, { pin }) : null;
		if (!command) {
			unresolved.push({ tool, manager });
			continue;
		}
		steps.push({ tool, package: pkg, manager, ...command, line: [command.file, ...command.args].join(' ') });
	}
	return { manager, missing, steps, unresolved };
}

/**
 * prereqNodePin — the node major `.node-version` pins.
 *
 * `.node-version` is the file `actions/setup-node` and every bootstrap reads (it
 * is a projection of mise.toml, held together by scripts/tests/mise-ci.test.mjs);
 * the fallback keeps a tree without one working.
 */
export function prereqNodePin(root, readFileSync, fallback = 24) {
	try {
		const raw = readFileSync(path.join(root, '.node-version'), 'utf8').trim();
		const m = /^v?([0-9]+)/.exec(raw);
		return m ? Number.parseInt(m[1], 10) : fallback;
	} catch {
		return fallback;
	}
}

/** shellQuote — a command line the summary can print for any OS. */
export function shellQuote(arg) {
	return /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * windowsNeedsCmd — is this command one that only a shell can find?
 *
 * CreateProcess resolves a bare name by appending `.exe` and nothing else; the
 * `.cmd`/`.bat` half of PATHEXT is a shell feature. So `npm` — a .cmd shim on
 * Windows, no npm.exe next to it — cannot be exec'd from node at all, and the
 * same holds for anything else that only ships a shim. Only a command that
 * names a real executable (`.exe`) is spawned directly there. That is what
 * `run(NPM, …)` on `--install-pi` needs: with the shell option gone it would
 * otherwise look for npm.exe and fail. `NPM` is `PLAN.npmBin`, which is
 * `npm.cmd` on Windows — never the `.ps1` the default execution policy blocks.
 */
function windowsNeedsCmd(cmd) {
	if (/\.exe$/i.test(cmd)) return false;
	// An explicit path is taken at its word unless it is a shim by name.
	if (/[\\/]/.test(cmd)) return /\.(cmd|bat)$/i.test(cmd);
	return true;
}

/**
 * cmdQuote — one argument spelled the way cmd.exe needs it.
 *
 * cmd.exe splits on whitespace and reads & | < > ^ ( ) as operators, so an
 * argument carrying any of those is wrapped in double quotes. A quote inside
 * the argument is doubled, which is the only escape cmd.exe honours inside a
 * quoted string. % and ! expand before the program sees them — quoting does not
 * stop that, so an argument holding them is marked as quoted and the comment
 * here is the honest limit of this function.
 */
export function cmdQuote(arg) {
	const s = String(arg);
	if (s !== '' && !/[\s"&|<>^()%!]/.test(s)) return s;
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * spawnPlan — the argv for one command, as data, before spawnSync sees it.
 *
 * Windows ships npm, gh and every other node tool as a .cmd shim, and node
 * cannot exec a .cmd directly. The obvious answer — hand the command line to a
 * shell — is the thing security scanners refuse (`shell: true` turns argv into
 * a string one injection away from a second command). So the same effect is
 * spelled out instead: cmd.exe in front of it, /d to skip AutoRun, /s so cmd
 * keeps the outer quotes as written, /c to run the line, and the line built
 * from argv with only the quoting cmd.exe actually requires. spawnSync is then
 * called with shell: false, on every platform, for every command.
 *
 * Everything else — an `.exe` on Windows, every command on Linux and macOS — is
 * spawned directly, with argv untouched.
 */
export function spawnPlan(cmd, args = [], { platform = process.platform, comspec = process.env.ComSpec } = {}) {
	if (platform !== 'win32' || !windowsNeedsCmd(cmd)) return { file: cmd, args: [...args], windowsVerbatimArguments: false };
	const line = [cmd, ...args].map(cmdQuote).join(' ');
	return {
		file: comspec || 'cmd.exe',
		args: ['/d', '/s', '/c', `"${line}"`],
		// Verbatim because the quotes above are already the ones cmd.exe must
		// receive; node quoting them a second time is what breaks .cmd shims.
		windowsVerbatimArguments: true,
	};
}

/** describeSkip — one line when a section does not apply to this OS. */
export function describeSkip(plan, what) {
	return `== ${what}: not available on ${plan.platform} — skipped`;
}
