/**
 * The sandbox's bind and mask list, and the threat model that claims to describe it.
 *
 * docs/threat-model.md says it is the scope statement for sandbox/pi-sandbox.sh
 * and that "where the two disagree, the script is right and this doc is stale"
 * (Radar Vol. 35 blip 6, threat modelling; blip 29, the policy is only as good as
 * the check that it still holds). A stale scope statement is worse than none: a
 * reader audits the mask list they were shown, not the one the launcher runs.
 *
 * So this test holds the two lists together, in both directions:
 *   - every path masked in the script is in the doc, with the mount the doc claims
 *     and the reason the asset table gives it;
 *   - every path the doc says is masked is masked in the script.
 * Adding a mask to one side without the other fails here, by name.
 *
 * The lists are read out of the sources themselves — the script's `for rel in …`
 * loops and its `too_broad` case statement, the doc's §1 asset table and the §3
 * prose — because a copy of either list in this file would drift exactly like the
 * doc did. Where a marker is missing the failure names the marker, so a doc
 * rewrite reads as "the test needs this sentence", not as a mystery.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// The harness root is found, not assumed. `make mutate-full` copies only `agent/` into
// `.stryker-tmp/sandbox-*`, so a fixed `../../../` lands above the copy and this file
// throws ENOENT before a single assertion runs. The search climbs from this file and
// stops at the first ancestor holding both sources; when there is none it fails here,
// by name, instead of reading whatever the depth happened to point at.
const harnessRoot = (() => {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "sandbox/pi-sandbox.sh")) && existsSync(join(dir, "docs/threat-model.md"))) return dir;
		const up = resolve(dir, "..");
		if (up === dir)
			throw new Error(
				"sandbox-binds: no ancestor of this test holds both sandbox/pi-sandbox.sh and docs/threat-model.md",
			);
		dir = up;
	}
})();

const source = (path: string) => readFileSync(join(harnessRoot, path), "utf8");
const script = source("sandbox/pi-sandbox.sh");
const doc = source("docs/threat-model.md");

const lines = script.split("\n");
const bare = (path: string) => (path === "/" ? path : path.replace(/\/+$/, ""));
const backticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const homePaths = (text: string) => backticked(text).filter((token) => token.startsWith("~/")).map(bare);
const absolutePaths = (text: string) =>
	backticked(text)
		.filter((token) => token.startsWith("/") && !token.startsWith("//"))
		.map(bare);

/** `setA` minus `setB`, as a stable list for the assertion message. */
const missing = (from: Iterable<string>, inSet: Iterable<string>) => {
	const have = new Set(inSet);
	return [...new Set(from)].filter((item) => !have.has(item)).sort();
};

const sorted = (items: Iterable<string>) => [...new Set(items)].sort();

// --------------------------------------------------------------- the script

/**
 * The `for rel in a b c; do … args+=(<mount> "$home/$rel")` list: the script's
 * own statement of which paths get which mask. The marker is the mount line, so
 * a mask written some other way is simply not covered here — the point is that
 * the documented lists and these two loops agree.
 */
function maskedInScript(mount: string): string[] {
	const at = lines.findIndex((line) => line.includes(`args+=(${mount} "$home/$rel")`));
	assert.notEqual(
		at,
		-1,
		`sandbox/pi-sandbox.sh no longer has a mask loop mounting ${mount} over "$home/$rel" — ` +
			"update this test and docs/threat-model.md together",
	);
	let header = -1;
	for (let i = at; i >= 0; i -= 1) {
		if (/^\s*for rel in .+; do$/.test(lines[i])) {
			header = i;
			break;
		}
	}
	assert.notEqual(header, -1, `no "for rel in …; do" above the ${mount} mask loop`);
	const list = lines[header].trim().replace(/^for rel in /, "").replace(/; do$/, "");
	return list.split(/\s+/).map((rel) => bare(`~/${rel}`));
}

/** The paths `too_broad` refuses, split into the absolute ones and the $HOME-relative ones. */
function tooBroad(): { absolute: string[]; relative: string[] } {
	// Scoped to too_broad() itself: path_covered_ro() has its own `case $p in`
	// line, and matching that one would compare the doc against the wrong list.
	const start = lines.findIndex((line) => /^too_broad\(\) \{$/.test(line));
	assert.notEqual(start, -1, "sandbox/pi-sandbox.sh lost its too_broad() function");
	const end = lines.findIndex((line, index) => index > start && line === "}");
	const body = lines.slice(start, end === -1 ? undefined : end);

	const at = body.findIndex((line) => /case \$p in .+\) return 0 ;; esac/.test(line));
	assert.notEqual(at, -1, "too_broad() lost its `case $p in …) return 0 ;; esac` line");
	const cases = body[at]
		.trim()
		.replace(/^case \$p in /, "")
		.replace(/\) return 0 ;; esac$/, "")
		.split("|")
		.map((item) => item.trim());

	const loop = body.findIndex((line) => line.includes('for d in "$home/.local"'));
	assert.notEqual(loop, -1, "too_broad() lost its $HOME-relative directory loop");
	const loopLine = body[loop].trim().replace(/^for d in /, "").replace(/; do$/, "");
	return {
		absolute: cases.map(bare),
		relative: loopLine.split(/\s+/).map((word) => bare(word.replace(/^"\$home/, "~").replace(/"$/, ""))),
	};
}

/** A `for d in …; do` list from the script, by one of its members. */
function scriptList(member: string): string[] {
	const at = lines.findIndex((line) => /^\s*for d in .+; do$/.test(line) && line.includes(member));
	assert.notEqual(at, -1, `sandbox/pi-sandbox.sh no longer has a "for d in …; do" list containing ${member}`);
	return lines[at].trim().replace(/^for d in /, "").replace(/; do$/, "").split(/\s+/);
}

const tmpfsMasks = maskedInScript("--tmpfs");
const nullMasks = maskedInScript("--ro-bind /dev/null");
const broad = tooBroad();
const projectBinds = scriptList("projects").map((dir) => `~/${dir}`);
const systemBinds = scriptList("/usr");

// ------------------------------------------------------------------ the doc

/** §1 asset table: one row per asset, with the reason and the containment claim. */
interface Asset {
	paths: string[];
	reason: string;
	contained: string;
}

function assets(): Asset[] {
	const rows: Asset[] = [];
	let inTable = false;
	for (const line of doc.split("\n")) {
		if (line.startsWith("| Asset |")) {
			inTable = true;
			continue;
		}
		if (!inTable) continue;
		if (!line.startsWith("|")) break;
		const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
		if (cells.every((cell) => /^-+$/.test(cell.replace(/\s/g, "")))) continue;
		if (cells.length < 4) continue;
		rows.push({
			paths: homePaths(cells[1]),
			reason: cells[2],
			contained: cells[3],
		});
	}
	assert.ok(rows.length > 0, 'docs/threat-model.md §1 asset table ("| Asset | Path | Why it matters | Contained? |") is gone');
	return rows;
}

/** The row that claims to contain `path`, failing when none or several do. */
function assetFor(path: string): Asset {
	const claiming = assets().filter((asset) => asset.paths.includes(path));
	assert.equal(
		claiming.length,
		1,
		`docs/threat-model.md §1 must have exactly one row listing ${path}, found ${claiming.length} — ` +
			"a masked path without its reason is a mask nobody can audit",
	);
	return claiming[0];
}

/** The doc with its line wrapping flattened, so a marker can span two source lines. */
const flat = doc.replace(/\s+/g, " ");

/** The text of §3 between two markers, or null when the marker moved. */
function section(start: string, end: string): string | null {
	const from = flat.indexOf(start);
	if (from === -1) return null;
	const to = flat.indexOf(end, from + start.length);
	return to === -1 ? null : flat.slice(from + start.length, to);
}

/** The `Masks, applied last:` paragraph, as clauses: which mount, over which paths. */
function maskClauses(): { mount: string; paths: string[] }[] {
	const paragraph = section("Masks, applied last:", "Namespace:");
	assert.ok(paragraph, 'docs/threat-model.md §3 lost its "Masks, applied last: … Namespace:" paragraph');
	return paragraph
		.split(";")
		.map((clause) => {
			if (clause.includes("`--tmpfs`")) return { mount: "--tmpfs", paths: homePaths(clause) };
			if (clause.includes("`--ro-bind /dev/null`")) return { mount: "--ro-bind /dev/null", paths: homePaths(clause) };
			return { mount: "", paths: [] as string[] };
		})
		.filter((clause) => clause.mount !== "");
}

const documented = (mount: string) => {
	const clause = maskClauses().filter((item) => item.mount === mount);
	assert.equal(clause.length, 1, `docs/threat-model.md §3 must state the ${mount} mask list exactly once`);
	return clause[0].paths;
};

// ------------------------------------------------------------------- masks

describe("the mask list in docs/threat-model.md matches sandbox/pi-sandbox.sh", () => {
	for (const [mount, inScript] of [
		["--tmpfs", tmpfsMasks],
		["--ro-bind /dev/null", nullMasks],
	] as const) {
		test(`${mount}: every masked path is in the doc, and vice versa`, () => {
			const inDoc = documented(mount);
			const inTable = sorted(
				assets()
					.filter((asset) => asset.contained.includes(mount))
					.flatMap((asset) => asset.paths),
			);
			assert.deepEqual(
				missing(inScript, inDoc),
				[],
				`sandbox/pi-sandbox.sh masks these with ${mount} but docs/threat-model.md §3 does not list them`,
			);
			assert.deepEqual(
				missing(inDoc, inScript),
				[],
				`docs/threat-model.md §3 claims ${mount} on paths sandbox/pi-sandbox.sh does not mask`,
			);
			assert.deepEqual(
				missing(inScript, inTable),
				[],
				`sandbox/pi-sandbox.sh masks these with ${mount} but §1 has no row claiming it — they need a reason`,
			);
			assert.deepEqual(
				missing(inTable, inScript),
				[],
				`docs/threat-model.md §1 claims ${mount} on paths sandbox/pi-sandbox.sh does not mask`,
			);
		});
	}

	test("every masked path carries the reason the doc gives it", () => {
		for (const path of [...tmpfsMasks, ...nullMasks]) {
			const asset = assetFor(path);
			const reason = asset.reason.replace(/`/g, "").trim();
			assert.ok(
				reason.length >= 20 && !/^(-|n\/a|todo|tbd)$/i.test(reason),
				`docs/threat-model.md §1 row for ${path} has no usable reason ("${asset.reason}") — ` +
					"the mask exists to protect something specific; name it",
			);
			// The mount the code uses and the mount the doc claims are the same
			// statement, so a mask quietly downgraded from --tmpfs to /dev/null
			// (or to a read-only bind of the real directory) still fails here.
			const mount = tmpfsMasks.includes(path) ? "--tmpfs" : "--ro-bind /dev/null";
			assert.ok(
				asset.contained.includes(mount),
				`docs/threat-model.md §1 says ${path} is contained by "${asset.contained}", ` +
					`sandbox/pi-sandbox.sh uses ${mount}`,
			);
		}
	});

	test("the dotenv pattern list and the file cap are the documented ones", () => {
		const patterns = ["-name '.env'", "-name '.env.*'", "-name '*.env'"]
			.map((flag) => lines.find((line) => line.includes(flag)))
			.filter((line): line is string => line !== undefined)
			.flatMap((line) => [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]))
			.filter((pattern) => pattern.includes(".env"));
		assert.deepEqual(
			sorted(patterns),
			[".env", ".env.*", "*.env"].sort(),
			"sandbox/pi-sandbox.sh no longer masks exactly .env, .env.* and *.env",
		);
		const paragraph = section("Masks, applied last:", "Namespace:") ?? "";
		for (const pattern of [".env", ".env.*", "*.env"]) {
			assert.ok(
				backticked(paragraph).includes(pattern),
				`docs/threat-model.md §3 does not mention the ${pattern} mask`,
			);
		}
		const cap = lines.find((line) => /-ge [0-9]+/.test(line) && line.includes("mask_count"));
		assert.ok(cap, "sandbox/pi-sandbox.sh lost its dotenv mask cap");
		const capValue = cap.match(/-ge ([0-9]+)/)?.[1];
		assert.ok(
			capValue && paragraph.includes(capValue),
			`the dotenv cap is ${capValue} in sandbox/pi-sandbox.sh and "${paragraph.match(/up to ([0-9]+)/)?.[1]}" in docs/threat-model.md §3`,
		);
	});

	test("auth.json is still rewritten in flight, and the doc says so", () => {
		const authLine = lines.find((line) => /^auth_src="\$home\//.test(line.trim()));
		assert.ok(authLine, "sandbox/pi-sandbox.sh lost its auth_src assignment");
		const path = bare(`~/${authLine.trim().replace(/^auth_src="\$home\//, "").replace(/"$/, "")}`);
		const asset = assetFor(path);
		assert.match(
			asset.contained,
			/rewritten/,
			`docs/threat-model.md §1 says ${path} is contained by "${asset.contained}", ` +
				"but the script rebuilds it holding only PI_SANDBOX_AUTH_PROVIDERS",
		);
		assert.ok(
			script.includes("PI_SANDBOX_AUTH_PROVIDERS") && doc.includes("PI_SANDBOX_AUTH_PROVIDERS"),
			"the allow-list variable PI_SANDBOX_AUTH_PROVIDERS must appear in both the script and the doc",
		);
	});
});

// ------------------------------------------------------------------- binds

describe("the bind list and the refusals in docs/threat-model.md match sandbox/pi-sandbox.sh", () => {
	test("the read-write project trees are the documented four", () => {
		const paragraph = section("Read-write binds:", "The launcher refuses");
		assert.ok(paragraph, 'docs/threat-model.md §3 lost its "Read-write binds: … Masks, applied last:" text');
		const documented = homePaths(paragraph);
		const expected = ["~/.pi", "~/.gitconfig", "~/.gitignore_global", ...projectBinds];
		assert.deepEqual(
			sorted(documented),
			sorted(expected),
			`docs/threat-model.md §3 read-write binds and the script's list differ: ` +
				`script ${sorted(expected).join(" ")}, doc ${sorted(documented).join(" ")}`,
		);
	});

	test("the read-only system tree is the documented seven", () => {
		const paragraph = section("Read-only binds:", "Read-write binds:");
		assert.ok(paragraph, 'docs/threat-model.md §3 lost its "Read-only binds: … Read-write binds:" text');
		assert.deepEqual(
			sorted(absolutePaths(paragraph)),
			sorted(systemBinds),
			"docs/threat-model.md §3 read-only binds and the script's system tree differ",
		);
	});

	test("the too_broad refusal list is the documented one", () => {
		const paragraph = section("target is too broad —", "Masks, applied last:");
		assert.ok(paragraph, 'docs/threat-model.md §3 lost its "refuses to start … too broad —" sentence');
		assert.deepEqual(
			sorted(absolutePaths(paragraph)),
			sorted(broad.absolute),
			"docs/threat-model.md §3 refusal list and to_broad() differ in the absolute paths",
		);
		assert.deepEqual(
			sorted(homePaths(paragraph)),
			sorted(broad.relative),
			"docs/threat-model.md §3 refusal list and to_broad() differ in the $HOME-relative paths",
		);
		assert.ok(
			paragraph.includes("$HOME") && script.includes('[ "$p" = "$home" ]'),
			"both sides must still refuse $HOME itself",
		);
	});
});
