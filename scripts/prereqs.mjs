// ============================================================================
// prereqs.mjs — the prerequisites step, shared by setup.mjs and install.mjs.
//
// The install claimed to be one command and was not: `setup.sh` was `exec node
// setup.mjs`, so node had to be installed by hand first, and `INSTALL.md` was
// the only place that said so. This module is the step that installs git, node
// and npm when they are missing, before the first question, so `install.mjs`
// alone works on a machine where nobody read INSTALL.md.
//
// The planning is pure and lives in scripts/install-lib.mjs (prereqPlan, one
// table per package manager, tested per platform). This file only does the part
// that needs a process: announce, run, report, and keep going.
//
// Rules that are behaviour, not style:
//   - every install is announced with the exact command before it runs;
//   - an install that needs root says so in its own line first;
//   - a failed install prints the manual command and moves on to the next
//     prerequisite, so one missing package manager cannot stop the tree;
//   - PI_SKIP_PREREQS=1 (and --skip-prereqs) turns the whole step into skip
//     lines: the CI matrix already has git and node, and a runner must never
//     call a package manager.
// ============================================================================

import { PREREQ_OPTIONAL, PREREQ_TOOLS, nodePreflight, prereqPackage, prereqPlan } from './install-lib.mjs';

/** The env var the CI matrix sets, and the docs name. */
export const PREREQ_SKIP_ENV = 'PI_SKIP_PREREQS';

/** prereqsSkipped — is the step off, by flag or by environment? */
export function prereqsSkipped({ skipPrereqs = false, env = process.env } = {}) {
	return skipPrereqs === true || env[PREREQ_SKIP_ENV] === '1';
}

/**
 * manualCommand — what a person types when the automatic install did not work.
 * One line, the same spelling the step would have run, minus sudo when the
 * manager does not need it.
 */
export function manualCommand(tool, manager, pin = 24) {
	const table = {
		'apt-get': `sudo apt-get install -y ${tool}`,
		dnf: `sudo dnf install -y ${tool}`,
		pacman: `sudo pacman -S --needed ${tool}`,
		brew: `brew install ${tool}`,
		winget: `winget install --id ${tool} -e --source winget`,
	};
	return table[manager] || `install ${tool} with your OS package manager (apt-get, dnf, pacman, brew or winget) — or the lines in docs/install.md#prerequisites-per-os`;
}

/**
 * stepPrereqs — check, announce, install, report. Never throws and never exits:
 * the caller decides what a still-missing tool means.
 *
 * `io` is the four output functions plus `have` and `run`, because the two
 * engines print with different prefixes and run through their own spawnPlan.
 * `nodeVersion`/`nodeMajor` are what `node -v` printed; a major below the pin is
 * a warning with the exact upgrade line, never an exit — pi usually works on the
 * node that is already there, and stopping the install over it helps nobody.
 */
export function stepPrereqs({
	platform = process.platform,
	pin = 24,
	skipPrereqs = false,
	env = process.env,
	io = {},
	nodeVersion,
	nodeMajor,
	optional = PREREQ_OPTIONAL,
} = {}) {
	const { have, run, say, note, warn } = io;
	const result = { skipped: false, installed: [], failed: [], unresolved: [], skippedTools: [], missing: [] };

	if (prereqsSkipped({ skipPrereqs, env })) {
		result.skipped = true;
		say(`== prerequisites: ${PREREQ_SKIP_ENV}=1 — nothing checked, nothing installed`);
		return result;
	}

	const plan = prereqPlan({ platform, has: have, pin, optional });
	result.missing = plan.missing;
	if (plan.missing.length === 0) {
		note(`prerequisites: git, node and npm are on PATH — nothing to install (${optional.join(', ')} optional)`);
		// A present node can still be the wrong major, and that is the one thing
		// worth a line here: the install works, the pin does not match.
		const verdict = nodePreflight({ pin, nodeVersion, nodeMajor });
		if (verdict.level === 'warn') warn(`${verdict.message} — docs/install.md#troubleshooting`);
		return result;
	}

	const manager = plan.manager;
	for (const tool of plan.missing) {
		const step = plan.steps.find((s) => s.tool === tool);
		if (!step) {
			const entry = plan.unresolved.find((u) => u.tool === tool);
			result.unresolved.push(tool);
			// Two different silences, and only one of them has a line to print: a
			// manager that carries the tool has a command, so reaching here means it
			// carries nothing (npm on brew and winget, git with only mise) — and
			// printing "install it by hand: install npm" under "node carries it"
			// contradicts the line above it. No manager at all is the case that needs
			// the by-hand line, and it names the tool it is about.
			const pkg = prereqPackage(tool, manager, pin);
			if (manager && !pkg) {
				const why =
					tool === 'npm'
						? `node carries it, so the ${manager} node install brings it in`
						: `${manager} has no package for it`;
				note(`${tool}: missing, and ${why}`);
				continue;
			}
			const why =
				pkg && entry && entry.manager
					? `${entry.manager} has no command for it`
					: 'no package manager here installs it';
			note(`${tool}: missing, and ${why}`);
			note(`   install it by hand: ${manualCommand(pkg || tool, manager, pin)}`);
			continue;
		}
		note(`${tool}: missing — installing with ${step.manager}`);
		note(`   run: ${step.line}`);
		if (step.sudo) note('   note: sudo — this asks for your password');
		const status = run(step.file, step.args, { allowFail: true });
		if (status === 0) {
			result.installed.push(tool);
			// A fresh install lands in a directory this shell inherited a PATH
			// without: `command -v` is the check that says whether it is usable
			// here and now, which is the wall docs/install.md documents.
			if (have(tool)) note(`${tool}: installed and on PATH`);
			else note(`${tool}: installed, but not on PATH in this shell yet — reopen the terminal if a later step cannot find it`);
			continue;
		}
		result.failed.push(tool);
		warn(`${tool}: the install failed (exit ${status}) — continuing with the rest`);
		note(`   install it by hand: ${manualCommand(step.package, step.manager, pin)}`);
	}

	for (const tool of PREREQ_TOOLS) {
		if (!plan.missing.includes(tool)) result.skippedTools.push(tool);
	}
	say(
		`== prerequisites: ${result.installed.length} installed, ${result.failed.length} failed, ${result.unresolved.length} without a command, ${result.missing.length} missing`,
	);
	const verdict = nodePreflight({ pin, nodeVersion, nodeMajor });
	if (verdict.level === 'warn') warn(`${verdict.message} — docs/install.md#troubleshooting`);
	return result;
}
