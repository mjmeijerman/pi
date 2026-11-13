/**
 * Locates the real @earendil-works/pi-* packages on disk.
 *
 * They live in the pnpm store and are not resolvable from ~/.pi/agent, so the
 * unit-test stubs delegate to the real implementations when they can be found
 * (that is what makes calculateCost / visibleWidth / truncateToWidth faithful).
 * If they cannot be found, the stubs fall back to local reimplementations.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LINKS_ROOT = join(
	process.env.PI_PNPM_LINKS ?? join(homedir(), ".local", "share", "pnpm", "store", "v11", "links"),
	"@earendil-works",
	"pi-coding-agent",
);

/** @returns {string[]} candidate dirs containing @earendil-works/* packages */
function candidateDirs() {
	const dirs = [];
	if (process.env.PI_REAL_PACKAGES_DIR) dirs.push(process.env.PI_REAL_PACKAGES_DIR);
	let versions = [];
	try {
		versions = readdirSync(LINKS_ROOT);
	} catch {
		versions = [];
	}
	// newest version first (string sort is enough for 1.5.2-style versions)
	versions.sort().reverse();
	for (const version of versions) {
		let hashes = [];
		try {
			hashes = readdirSync(join(LINKS_ROOT, version));
		} catch {
			continue;
		}
		for (const hash of hashes) dirs.push(join(LINKS_ROOT, version, hash, "node_modules", "@earendil-works"));
	}
	return dirs;
}

/** @param {"pi-ai" | "pi-tui" | "pi-coding-agent"} name */
function entryPoint(dir, name) {
	const pkgDir = join(dir, name);
	const pkgJson = join(pkgDir, "package.json");
	if (!existsSync(pkgJson)) return undefined;
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
	} catch {
		return undefined;
	}
	const exported = pkg.exports?.["."];
	const rel = (typeof exported === "string" ? exported : exported?.import) ?? pkg.main;
	if (!rel) return undefined;
	const file = join(pkgDir, rel);
	return existsSync(file) ? file : undefined;
}

/**
 * @param {"pi-ai" | "pi-tui" | "pi-coding-agent"} name
 * @returns {Promise<Record<string, any> | undefined>}
 */
export async function loadRealPackage(name) {
	for (const dir of candidateDirs()) {
		const file = entryPoint(dir, name);
		if (!file) continue;
		try {
			return await import(pathToFileURL(file).href);
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

/** Import a concrete file inside a package, e.g. ("pi-tui", "dist/utils.js"). */
export async function loadRealModule(name, subpath) {
	for (const dir of candidateDirs()) {
		const file = join(dir, name, subpath);
		if (!existsSync(file)) continue;
		try {
			return await import(pathToFileURL(file).href);
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}
