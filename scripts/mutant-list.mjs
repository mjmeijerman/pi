#!/usr/bin/env node
// ============================================================================
// mutant-list.mjs — how many mutants a set of `--mutate` values really creates.
//
// `scripts/mutate-changed.sh --cap N` needs two numbers before it can budget a
// run: how many mutants the changed lines hold, and which of them come first.
// The stryker CLI reports neither before it mutates (--dryRunOnly stops before
// mutants are tested and reports none of them), so this enumerates them with
// the same instrumenter stryker itself calls — same package, same version, same
// options from agent/stryker.conf.json — so the count cannot drift from what
// `stryker run --mutate ...` would actually do.
//
// Why not a hand-rolled babel pass: a count that disagrees with stryker's is a
// cap that lies, and the only way two toolchains agree is to be one toolchain.
//
// Usage: node scripts/mutant-list.mjs [--cap N] [--mutants-file FILE] [--config FILE] <mutate spec>...
//   <mutate spec>   what `--mutate` accepts and what mutate-changed.sh emits:
//                   `path` or `path:start-end`, relative to agent/ (stryker's cwd).
//   --cap N         print the first N mutants as `path:start-end` ranges instead
//                   of the mutant list, and name the deferred count on stderr.
//                   N = 0 means no cap. Order is file, then line; a line is
//                   taken whole or not at all, so N is a ceiling, never a floor.
//   --mutants-file  read the enumeration from FILE (JSON lines, one mutant per
//                   line) instead of instrumenting: the test seam.
//   --config        stryker config to read mutator options from (default
//                   agent/stryker.conf.json).
// Output: one JSON object per mutant on stdout (`{"file","line","column",
//   "mutatorName","replacement"}`), 1-based line, sorted; or the capped ranges.
// ============================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, '..', 'agent');

let configFile = path.join(AGENT, 'stryker.conf.json');
let cap = 0;
let mutantsFile = '';
const specs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	switch (argv[i]) {
		case '--cap':
			cap = Number(argv[++i]);
			if (!Number.isInteger(cap) || cap < 0) {
				process.stderr.write(`mutant-list: --cap needs a whole number, not "${argv[i]}"\n`);
				process.exit(2);
			}
			break;
		case '--mutants-file':
			mutantsFile = argv[++i];
			break;
		case '--config':
			configFile = argv[++i];
			break;
		case '-h':
		case '--help':
			process.stdout.write('usage: mutant-list.mjs [--cap N] [--mutants-file FILE] [--config FILE] <mutate spec>...\n');
			process.exit(0);
			break;
		default:
			specs.push(argv[i]);
	}
}

// sort_key — the cap's order, and the only thing the cap depends on. File, then
// line, then column, then mutator name and replacement so two mutants on one
// line always sort the same way twice.
function sort_key(m) {
	return [m.file, m.line, m.column, m.mutatorName, m.replacement];
}

function ordered(mutants) {
	return [...mutants].sort((a, b) => {
		const [ka, kb] = [sort_key(a), sort_key(b)];
		for (let i = 0; i < ka.length; i++) {
			if (ka[i] < kb[i]) return -1;
			if (ka[i] > kb[i]) return 1;
		}
		return 0;
	});
}

// read_mutants_file — the JSON lines this script prints, so a test can pin the
// cap's arithmetic without instrumenting TypeScript.
function read_mutants_file(file) {
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line))
		.map((m) => ({
			file: m.file,
			line: Number(m.line),
			column: Number(m.column ?? 0),
			mutatorName: m.mutatorName ?? '',
			replacement: m.replacement ?? '',
		}));
}

// enumerate — mutants for the same specs `stryker run --mutate` would use.
async function enumerate() {
	// Resolved from agent/node_modules, not from this file: scripts/ has no
	// node_modules of its own.
	const { Instrumenter } = await import(
		pathToFileURL(path.join(AGENT, 'node_modules', '@stryker-mutator', 'instrumenter', 'dist', 'src', 'index.js')).href
	);

	// A spec is `path` or `path:start-end`, 1-based and inclusive, which is what
	// stryker's own --mutate parsing divides down to 0-based positions.
	const files = new Map();
	for (const spec of specs) {
		const match = /^(.*?):(\d+)-(\d+)$/.exec(spec);
		if (!match) {
			files.set(spec, true);
			continue;
		}
		const ranges = files.get(match[1]) ?? [];
		if (ranges === true) continue;
		ranges.push({
			start: { line: Number(match[2]) - 1, column: 0 },
			end: { line: Number(match[3]) - 1, column: Number.MAX_SAFE_INTEGER },
		});
		files.set(match[1], ranges);
	}

	const config = JSON.parse(readFileSync(configFile, 'utf8'));
	const options = {
		plugins: null,
		ignorers: [],
		excludedMutations: config.mutator?.excludedMutations ?? [],
	};
	const logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		trace() {},
		isDebugEnabled: () => false,
	};

	const instrumenter = new Instrumenter(logger);
	const toInstrument = [...files].map(([name, mutate]) => ({
		name: path.resolve(AGENT, name),
		content: readFileSync(path.resolve(AGENT, name), 'utf8'),
		mutate,
	}));
	return (await instrumenter.instrument(toInstrument, options)).mutants.map((mutant) => ({
		file: path.relative(AGENT, mutant.fileName),
		// +1: the instrumenter hands out 0-based lines, --mutate and the diff
		// that produced it speak 1-based ones.
		line: mutant.location.start.line + 1,
		column: mutant.location.start.column,
		mutatorName: mutant.mutatorName,
		replacement: mutant.replacement,
	}));
}

// cap_ranges — the first `cap` mutants as mutate ranges, whole lines only.
//
// A line is the smallest thing `--mutate` can select, so a line is taken
// entirely or not at all: the run never exceeds `cap`, and never silently
// reorders. Returns the ranges plus the numbers the caller reports.
function cap_ranges(rows, limit) {
	const lines = [];
	for (const row of rows) {
		const last = lines[lines.length - 1];
		if (last && last.file === row.file && last.line === row.line) last.count++;
		else lines.push({ file: row.file, line: row.line, count: 1 });
	}

	const kept = [];
	let selected = 0;
	for (const group of lines) {
		if (selected + group.count > limit) break;
		kept.push(group);
		selected += group.count;
	}

	const ranges = [];
	for (const group of kept) {
		const last = ranges[ranges.length - 1];
		if (last && last.file === group.file && last.end === group.line - 1) last.end = group.line;
		else ranges.push({ file: group.file, end: group.line, start: group.line });
	}
	return { ranges: ranges.map((r) => `${r.file}:${r.start}-${r.end}`), selected, total: rows.length, lines: kept.length };
}

const mutants = mutantsFile ? read_mutants_file(mutantsFile) : await enumerate();
const rows = ordered(mutants);

if (cap > 0) {
	const { ranges, selected, total } = cap_ranges(rows, cap);
	process.stderr.write(
		`mutation: ${selected} of ${total} mutants on changed lines (${total - selected} deferred to the weekly full run)\n`,
	);
	if (ranges.length > 0) process.stdout.write(`${ranges.join('\n')}\n`);
	process.exit(0);
}

for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
