// herdr-terminal: what a terminal's foreground argv means, in one place.
//
// Two programs ask the same question — `scripts/herdr-resume.mjs` before it types a line into a
// recovered tab, and `bin/guard` before it decides what an empty Boss tab is — and a second reading
// of one argv is how two answers start disagreeing. So the reading lives here and both import it:
// a shell is a shell, a pi launcher anywhere in the argv is a live Boss, and `hc`'s own `status.app`
// is the second witness when the first one lies.
//
// Nothing in this file runs, reads a terminal or touches a file: it is a judgement about facts
// `hc get <terminal> --json` returned, and the line that follows from them.
import { existsSync } from "node:fs";

/** Every word that is a plain shell at a prompt. Mirrors `isShellArgv` in agent/extensions/herdr-resume-map.ts. */
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "nu", "pwsh", "powershell", "elvish", "xonsh"]);

/**
 * Every word that means a pi session is the thing in the terminal: the bare launcher, the
 * sandbox wrappers `install.sh` puts on PATH, and `sandbox/pi-sandbox.sh` by name. A sandboxed
 * Boss is started as `bash ~/.pi/sandbox/pi-sandbox.sh -- pi --session …`, so `argv[0]` says
 * `bash` and only the *whole* argv says `pi` — that is how `exec …` was typed into a live Boss.
 */
export const PI_LAUNCHERS = new Set(["pi", "pi-bare", "pi-sandboxed", "pisandbox", "pi-sandbox.sh"]);

export function isShellArgv(argv) {
	if (!Array.isArray(argv) || argv.length === 0) return false;
	return SHELLS.has(programName(argv[0]));
}

/**
 * One word of an argv, as the kernel would name the program: no folder, no `.exe`.
 *
 * Both separators, always, and never `node:path`'s `basename`: that one answers in the *host's*
 * flavour, so on a Linux host `basename("C:\\WINDOWS\\…\\powershell.exe")` is the whole string and
 * a Windows tab classified as POSIX — six green cases on Windows and six red ones in CI
 * (PR #262, job `scripts tests`). The path's own spelling decides, not the host's.
 */
export function programName(word) {
	const text = String(word ?? "");
	const name = text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);
	return name.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Does any word of this argv name a pi launcher? The whole argv, not `argv[0]`: a sandboxed Boss
 * reads as `["bash", "…/pi-sandbox.sh", "--", "pi", "--session", …]`, and `argv[0]` alone
 * called that a plain shell.
 */
export function isPiArgv(argv) {
	return Array.isArray(argv) && argv.some((word) => PI_LAUNCHERS.has(programName(word)));
}

/**
 * The reason a terminal is busy because pi is in it, or `""`. Two witnesses, because either one
 * alone was fooled: the whole foreground argv (a wrapper in front of pi), and hc's own `status.app`
 * — a live Boss answered `status {app: "pi"}` while its `foreground.argv[0]` was `bash`.
 */
export function piWitness(facts) {
	const foreground = facts?.foreground?.argv;
	if (isPiArgv(foreground)) return `foreground ${foreground.join(" ")}`;
	const app = programName(facts?.status?.app ?? facts?.app ?? "");
	if (PI_LAUNCHERS.has(app)) return `app ${app}`;
	return "";
}

/** A plain shell at a prompt: recovery's outcome, and the only thing safe to type into. */
export function isQuietShell(facts) {
	return isShellArgv(facts?.foreground?.argv) && piWitness(facts) === "";
}

/** A word as the recovered shell should read it. */
export function shellQuote(word) {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
	return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

/** A word as a recovered PowerShell reads it: `'…'`, and a quote inside is `''`. */
export function psQuote(word) {
	return `'${String(word).replace(/'/g, "''")}'`;
}

/** A word as a recovered cmd.exe reads it. */
export function cmdQuote(word) {
	return `"${String(word).replace(/"/g, '""')}"`;
}

/**
 * A word neither shell will take apart: no space, no quote, no `@`, no sigil. Everything else is
 * quoted, which is what makes a `C:\Program Files\…` path and npm's `@earendil-works` folder work.
 */
export function plainWord(word) {
	return /^[A-Za-z0-9_+:,./\\-]+$/.test(String(word));
}

export function psWord(word) {
	return plainWord(word) ? String(word) : psQuote(word);
}

export function cmdWord(word) {
	return plainWord(word) ? String(word) : cmdQuote(word);
}

/**
 * Which shell owns a recovered terminal. herdr hands out `powershell.exe` on Windows, and
 * PowerShell has no `exec`: the POSIX line was typed there every boot and every boot it was a
 * `CommandNotFoundException` in the tab, so the Boss came back as a prompt full of red text
 * (measured 2026-11-24: `hc read t15`, the same four lines, one pair per attempt).
 */
export function shellFamily(argv) {
	const name = programName(argv?.[0]);
	if (name === "powershell" || name === "pwsh") return "powershell";
	if (name === "cmd") return "cmd";
	return "posix";
}

/**
 * launchLine(argv, facts) — the line that runs `argv` in the shell this terminal holds, in that
 * shell's own syntax.
 *
 * POSIX gets `exec …`: the shell is replaced, so the tab's program *is* pi and a second paste has
 * nothing to land in. Windows has no `exec`, so there the line runs pi inside the shell (`& …`)
 * and the prompt returns when pi exits — the only thing PowerShell can promise.
 *
 * `argv[0]` is `…/cli.js`, a script and not a program. A POSIX shell runs it through its shebang;
 * PowerShell and cmd would hand it to the file association, which is whatever that machine happens
 * to have, so the interpreter already running this script is named explicitly instead.
 *
 * Two callers ask for this line and ask for it once each: `herdr-resume` types it into a recovered
 * tab, `bin/guard` fills an empty Boss tab with it. One sentence, so the two cannot drift.
 */
export function launchLine(argv, facts) {
	const family = shellFamily(facts?.foreground?.argv);
	const words = Array.isArray(argv) ? argv.map(String) : [];
	if (family === "posix") return `exec ${words.map(shellQuote).join(" ")}`;
	const program = /\.[cm]?js$/i.test(String(words[0])) ? [process.execPath, ...words] : words;
	if (family === "powershell") return `& ${program.map(psWord).join(" ")}`;
	return program.map(cmdWord).join(" ");
}

/**
 * resumeLine(entry, facts) — `launchLine` for a resume entry: the entry's argv plus exactly one
 * `--session`, in the recovered shell's syntax.
 */
export function resumeLine(entry, facts) {
	return launchLine([...(Array.isArray(entry?.argv) ? entry.argv : []), "--session", entry?.session_path], facts);
}

/**
 * Is the foreground program still there? A reboot leaves hc reporting the dead
 * program for a moment after the terminal is live again; without this check that
 * stale pid reads as "busy" and the restore is skipped.
 */
export function programAlive(facts) {
	const pid = facts?.foreground?.pid;
	if (typeof pid !== "number") return true;
	if (!existsSync("/proc/self")) return true;
	return existsSync(`/proc/${pid}`);
}

/**
 * Is a real program in the foreground, alive enough to keep us out? A foreground
 * with no `argv` or no `pid` is a terminal that has not attached yet: nothing to
 * measure, so nothing to conclude.
 */
export function runningProgram(facts) {
	const foreground = facts?.foreground;
	if (!Array.isArray(foreground?.argv) || foreground.argv.length === 0) return false;
	if (typeof foreground.pid !== "number") return false;
	return programAlive(facts);
}

/**
 * The platform this one decision is made for, in one place, so both answers can be
 * asked on a host that is only one of them. Not a `PI_*` value: this is a fact about
 * the machine, not a setting to tune.
 */
export const IS_WIN = process.platform === "win32";

/**
 * Did the line we typed start something? A shell that is still the foreground
 * did not run it: a first-run prompt or a stray keystroke can swallow the start
 * of a pasted line, and without this check that failure would be recorded as a
 * restore. The pid cannot answer this — `exec` replaces the shell in place and
 * keeps its pid — so the check is "not a shell, and that process is alive".
 *
 * On Windows that check cannot be trusted alone, so pi announces itself instead.
 * herdr launches a tab as `powershell.exe -NoExit -Command "& '<program>'"`, and
 * hc sometimes keeps answering that launch program as the terminal's `foreground`
 * after the program has replaced the shell — measured 2026-11-24, a bash tab
 * running node answered `foreground {name: "bash.exe", pid: 5940}` from the first
 * poll to the last. A Windows pi is launched as `node …/cli.js`, and neither word
 * is in PI_LAUNCHERS, so a live Boss is recognised by its own report and not by
 * its argv: `status {app: "pi"}` while the foreground says `node.exe`. Without
 * that witness a resumed Windows tab read as "nothing started", and the second
 * attempt was typed into the pi the first attempt had started.
 *
 * That second witness is Windows-only, and off Windows it can only hurt: there hc
 * answers the real foreground, so a tab that came back as a shell whose status
 * still claims `app: pi` has *not* started — counting it as started would leave
 * the exec line untyped and the tab a plain shell, the exact failure this service
 * exists to end. So the platform picks the branch, and off Windows the pi witness
 * is never consulted. `onWindows` is a parameter only so both answers can be
 * exercised on one machine (`scripts/tests/herdr-resume-witness.test.mjs`).
 */
export function startedWitness(facts, onWindows = IS_WIN) {
	const foreground = facts?.foreground?.argv;
	const started = Array.isArray(foreground) && foreground.length > 0 && !isShellArgv(foreground) && programAlive(facts);
	if (onWindows) return started || piWitness(facts) !== "";
	return facts?.state === "live" && started;
}
