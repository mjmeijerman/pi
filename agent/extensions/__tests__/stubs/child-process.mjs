/**
 * Test double for `node:child_process`.
 *
 * Everything is the real module except `spawn`: when the test sets
 * `globalThis.__piTestSpawn` the fake is used instead, so dictation.ts can be
 * driven without launching arecord/whisper.
 */
import real from "node:child_process";

export const execFile = real.execFile;
export const execFileSync = real.execFileSync;
export const exec = real.exec;
export const execSync = real.execSync;
export const spawnSync = real.spawnSync;
export const fork = real.fork;

export function spawn(...args) {
	const fake = globalThis.__piTestSpawn;
	if (typeof fake === "function") return fake(...args);
	return real.spawn(...args);
}

export default { ...real, spawn };
