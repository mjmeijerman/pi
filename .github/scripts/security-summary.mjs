#!/usr/bin/env node
/**
 * Turn the security-scan job's JSON output into a step summary.
 *
 * Radar Vol. 35, blip 29 (harness quality evaluation): a green check is only
 * worth what a reader can verify. "semgrep passed" says nothing; "semgrep 1.185.0
 * read 59 files with p/default + p/typescript + semgrep-rules bash@a5ad171 and
 * found 0" can be checked, and a run that scanned nothing shows up as 0 files
 * instead of as a pass. Blip 89 (Deepsec) puts the scanner in the pipeline; this
 * file is what keeps the pipeline honest about what it looked at.
 *
 * Inputs are the scanners' own JSON: semgrep's `--json-output`, and the two
 * `trivy fs --format json` reports (vulnerabilities, then secrets + config).
 * A missing file is reported as missing, never as zero findings: a scanner that
 * crashed must not read as a clean scan.
 *
 * Usage: node .github/scripts/security-summary.mjs <semgrep.json> <vuln.json> <secrets.json>
 * Env: SEMGREP_VERSION, SEMGREP_RULES_SHA, TRIVY_VERSION, SCANNED_FILES
 */
import { readFileSync } from "node:fs";

const [semgrepPath, vulnPath, restPath] = process.argv.slice(2);
if (!semgrepPath || !vulnPath || !restPath) {
	console.error("usage: security-summary.mjs <semgrep.json> <trivy-vuln.json> <trivy-secrets.json>");
	process.exit(2);
}

const env = process.env;
const version = (name, fallback) => (env[name] && env[name].length > 0 ? env[name] : fallback);

/** Read a scanner report; null means "the scanner did not write one". */
function report(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

const semgrep = report(semgrepPath);
const vuln = report(vulnPath);
const rest = report(restPath);

const results = semgrep?.results ?? [];
const scannedFiles = semgrep?.paths?.scanned ?? [];
const semgrepErrors = semgrep?.errors ?? [];

const vulnResults = vuln?.Results ?? [];
const vulns = vulnResults.flatMap((r) => r.Vulnerabilities ?? []);
const packages = vulnResults.reduce((n, r) => n + (r.Packages?.length ?? 0), 0);

const restResults = rest?.Results ?? [];
const secrets = restResults.flatMap((r) => r.Secrets ?? []);
const misconfigs = restResults.flatMap((r) => r.Misconfigurations ?? []);

const findings = results.length + vulns.length + secrets.length + misconfigs.length;
const shortSha = version("SEMGREP_RULES_SHA", "unpinned").slice(0, 7);

const cell = (report_) =>
	report_ === null ? "**not written — the scanner failed before it reported**" : null;

const lines = [
	`### security scan: ${findings === 0 ? "clean" : `${findings} finding(s)`}`,
	"",
	"| scanner | pinned | what it read | findings |",
	"| --- | --- | --- | --- |",
	`| semgrep | ${version("SEMGREP_VERSION", "?")} | ${cell(semgrep) ?? `${scannedFiles.length} files, p/default + p/typescript + semgrep-rules bash@${shortSha}`} | ${cell(semgrep) ?? results.length} |`,
	`| trivy (dependencies) | ${version("TRIVY_VERSION", "?")} | ${cell(vuln) ?? `${packages} packages in the lockfiles`} | ${cell(vuln) ?? vulns.length} |`,
	`| trivy (secrets, config) | ${version("TRIVY_VERSION", "?")} | ${cell(rest) ?? `${version("SCANNED_FILES", "?")} tracked files`} | ${cell(rest) ?? secrets.length + misconfigs.length} |`,
	"",
];

/** A finding list, capped: the log keeps the rest, the summary stays readable. */
function details(title, items, format) {
	if (items.length === 0) return;
	lines.push(`<details><summary>${title} (${items.length})</summary>`, "");
	for (const item of items.slice(0, 20)) lines.push(`- ${format(item)}`);
	if (items.length > 20) lines.push(`- ... and ${items.length - 20} more in the job log`);
	lines.push("", "</details>", "");
}

details("semgrep findings", results, (r) => `\`${r.check_id}\` ${r.path}:${r.start?.line}`);
details("dependency findings", vulns, (r) => `\`${r.VulnerabilityID}\` ${r.PkgName} ${r.InstalledVersion} (${r.Severity})`);
details("secret findings", secrets, (r) => `\`${r.RuleID}\` ${r.Target}:${r.StartLine}`);
details("configuration findings", misconfigs, (r) => `\`${r.ID}\` ${r.Target}:${r.StartLine}`);

// A file semgrep could not parse is a file the scan did not cover. Silence
// here would turn a partial scan into a green check, so it is always printed.
if (semgrep === null) {
	lines.push("semgrep wrote no JSON report — treat this run as a failed scan, not a clean one.", "");
} else if (semgrepErrors.length > 0) {
	lines.push(
		`<details><summary>semgrep could not parse ${semgrepErrors.length} file(s) — those files are not covered by this scan</summary>`,
		"",
	);
	for (const error of semgrepErrors.slice(0, 10)) {
		const where = error.path ?? String(error.message ?? "").split("\n")[0];
		lines.push(`- ${where}`);
	}
	lines.push("", "</details>", "");
}

const empty = scannedFiles.length === 0 && results.length === 0;
if (semgrep !== null && empty) {
	lines.push("semgrep scanned 0 files: the target list was empty, so this run proves nothing.", "");
}

process.stdout.write(`${lines.join("\n")}\n`);
