// Which `space` (or `guard`) the durable mod runs — and the only place that file is chosen.
//
// `bin/space` is a bash program. Windows reads no shebang, so the extensionless file under
// `~/.pi/bin` dies with "not a valid Win32 application (os error 193)"; the installer writes
// a `.cmd` shim beside each wrapper it puts on PATH, in `~/.local/bin`, and that shim is the
// only spelling Windows can start. So the rule is: on a Windows home, the `.cmd` in the bin
// directory — but only when it is really on disk, never a guess; otherwise the POSIX wrapper
// the mod has always used; and when neither is there, one refusal that names both paths.
//
// Plain JavaScript with no herdr and no node import, so `scripts/tests/test-durable-space-
// path.test.mjs` can call it under plain node: existence arrives as a function, because a
// mod asks the app (`readTextFile`) and a test asks the filesystem.

/** A Windows home is a drive letter or a backslash anywhere in the path. It is the only
 * platform answer a mod has: the app hands it `home()` and nothing else. */
export function windowsHome(home) {
	const h = String(home ?? "");
	return /^[A-Za-z]:[\\/]/.test(h) || h.includes("\\");
}

/** The paths this mod looks at, in the order it looks, for one tool name. */
export function programCandidates({ home, name } = {}) {
	const h = String(home ?? "").replace(/[\\/]+$/, "");
	if (!h) throw new Error("no home folder: the mod needs home() to find its programs");
	if (!name) throw new Error("no program name: the mod needs the tool it runs");
	// On Windows the `.cmd` first, and forward slashes for the fallback: bash.exe and
	// cmd.exe both read them, and one spelling keeps the message short.
	if (windowsHome(h)) return [`${h}\\.local\\bin\\${name}.cmd`, `${h}/.pi/bin/${name}`];
	return [`${h}/.pi/bin/${name}`];
}

/**
 * toolProgram — the file to run for `name`, or an Error naming what is missing.
 *
 * `exists(file)` answers whether a path is there; a throw from it counts as "not there".
 */
export function toolProgram({ home, name, exists } = {}) {
	if (typeof exists !== "function") throw new Error("toolProgram needs exists(file): nothing here reads the disk");
	const tried = programCandidates({ home, name });
	const found = tried.find((file) => {
		try {
			return Boolean(exists(file));
		} catch {
			return false;
		}
	});
	if (found) return found;
	throw new Error(
		`${name} is not where this mod looks: ${tried.join(" and ")} — re-run the installer, which writes ${name}.cmd beside the wrapper on Windows`,
	);
}

/**
 * shimLaunch — the two paths a `.cmd` shim carries: the bash.exe that starts it, and the wrapper
 * it starts. `cmdShim()` in ~/.pi/scripts/install-lib.mjs writes exactly this line:
 *
 *     "C:\Program Files\Git\usr\bin\bash.exe" "C:/Users/mj/.local/bin/space" %*
 *
 * and it is the only place this mod can learn where bash is. A `.cmd` is not a program a process
 * can spawn: measured 2026-11-25, `spawnSync("<shim>.cmd", ["list"])` answers EINVAL on Windows,
 * and the panel alt-shift-n opens said `no C:\Users\markm\.local\bin\space.cmd — is pi installed?`
 * while that file was right there. Reading the shim keeps one source for the path: the installer.
 */
export function shimLaunch(text) {
	const m = /^\s*"([^"]*\bbash(?:\.exe)?)"\s+"([^"]+)"/im.exec(String(text ?? ""));
	if (!m) return null;
	return { program: m[1], wrapper: m[2] };
}

/**
 * toolPlan — what to spawn for a tool name: the `program`, the `prefix` to put in front of the
 * tool's own argv, and the `shown` path a person reads in the panel.
 *
 * Asynchronous because it reads the shim it found. On a POSIX home the prefix is empty and the
 * program is the wrapper itself; on Windows it is the bash.exe the shim names, and the wrapper
 * as the first argument — the same process the shim would have started, without cmd.exe.
 */
export async function toolPlan({ home, name, exists, read } = {}) {
	const found = toolProgram({ home, name, exists });
	if (!/\.(cmd|bat)$/i.test(found)) return { program: found, prefix: [], shown: found };
	let launch = null;
	try {
		launch = shimLaunch(await read?.(found));
	} catch {
		launch = null;
	}
	if (!launch) return { program: found, prefix: [], shown: found };
	return { program: launch.program, prefix: [launch.wrapper], shown: found };
}
