/**
 * Open work — the prompt names what is unfinished, every turn, until it is finished.
 *
 * Why this exists. Twice in one session the boss read `bin/delegate status` as `reported`, stopped,
 * and left a branch unpublished until a person noticed. The rule was in `AGENTS.md` and in context,
 * and was skipped anyway: a rule you have to remember is not a control. So the check becomes part of
 * the prompt instead of part of the advice — one line per open item, and nothing at all when
 * nothing is open.
 *
 *   worker <slug>: <word>, report at <path> — next: bin/delegate finish <slug>
 *   PR #<n> (<owner/name>): <rollup>, <mergeable|conflicts> — next: gh pr view <n> -R <owner/name>
 *
 * The repository is carried with the number. A number alone means nothing to `gh` outside the repo
 * that owns it: the probe used to run in whatever checkout the agent sat in and printed GitHub's
 * GraphQL refusal in the pane at every start. The row `delegate finish` writes keeps its `repo`,
 * and a space's `space.json` names the remote for a row that does not.
 *
 * The worker word is not guessed here. It is `bin/delegate status --json`'s own word, so the line
 * and `delegate list` can never disagree about the same worker (`bin/delegate` is the one place
 * that word is computed). That call is only made for a worker whose report file exists at all, so a
 * turn with no workers costs one directory read and no process at all.
 *
 * The PR half costs nothing until a pull request is already known to be open: `delegate finish`
 * records `{"pr":n,"sha":…}` in the space's decisions when it publishes, and only those numbers are
 * asked of `gh`, with the answer cached for a minute (`state/cache/open-prs.json`). A merged or
 * closed pull request is cached for a day and never produces a line again.
 *
 * Radar basis: #20 stateful guardrails — a rule that lives in prose is not a control; the state has
 * to be read from the record and pushed in front of the agent on every turn.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRESH_MS = 60_000;
const TERMINAL_MS = 24 * 3600_000;
const BOM = 0xfeff;

/** The checkout this lives in, resolved exactly the way `bin/delegate` resolves its root. */
export function piRoot(): string {
	return (
		process.env.PI_BOSS_ROOT ||
		process.env.PI_MASTER_ROOT ||
		process.env.PI_HOME ||
		TREE
	);
}

export interface Probe {
	/** `<root>/state` — the record every line is read from. */
	state: string;
	/** `<root>/bin/delegate` — the one tool that decides a worker's state word. */
	delegate: string;
	run(cmd: string, args: string[]): string;
	now?: () => number;
}

interface Worker {
	slug: string;
	report: string;
}

/**
 * A record file's text, or `""` when it cannot be read. A leading BOM is dropped: a record saved by
 * an editor that writes one still has to parse, and `JSON.parse` refuses the BOM itself.
 */
export function readText(file: string): string {
	try {
		const text = readFileSync(file, "utf8");
		return text.charCodeAt(0) === BOM ? text.slice(1) : text;
	} catch {
		return "";
	}
}

/** The spaces under `state`, or none when the state has no `spaces/` yet. */
function spaceNames(state: string): string[] {
	try {
		return readdirSync(join(state, "spaces"));
	} catch {
		return [];
	}
}

/** Every delegations record worth reading: the state's own, then one per space. */
export function delegationFiles(state: string): string[] {
	const files = [join(state, "delegations.json")];
	for (const space of spaceNames(state)) files.push(join(state, "spaces", space, "delegations.json"));
	return files;
}

/** A report's size in bytes, 0 when there is no such file. */
export function reportSize(file: string): number {
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		size = 0;
	}
	return size;
}

/** Every worker whose report file exists and is not empty — the only ones worth a status call. */
export function workersWithReports(state: string): Worker[] {
	const out: Worker[] = [];
	for (const file of delegationFiles(state)) {
		const text = readText(file);
		let entries: Record<string, any>;
		try {
			entries = JSON.parse(text);
		} catch {
			continue;
		}
		for (const [slug, entry] of Object.entries(entries)) {
			if (!slug || !entry || typeof entry !== "object") continue;
			const report =
				typeof entry.report === "string" && entry.report
					? entry.report
					: join(dirname(file), "reports", `${slug}.md`);
			if (reportSize(report) > 0) out.push({ slug, report });
		}
	}
	return out;
}

/** The word `bin/delegate status` gives a worker, and the report it names. */
export function statusWord(probe: Probe, slug: string, report: string): { word: string; report: string } {
	try {
		const out = probe.run(probe.delegate, ["status", slug, "--json"]).trim();
		const lines = out.split("\n");
		const parsed = JSON.parse(lines[lines.length - 1]);
		return { word: String(parsed.status ?? ""), report: String(parsed.report || report) };
	} catch {
		return { word: "", report };
	}
}

interface PrCandidate {
	pr: number;
	/** `owner/name` of the repository that owns the number: `gh -R` needs it, the cwd cannot say it. */
	repo: string;
}

/**
 * `owner/name` from a remote url or a bare slug — the shape `gh -R` takes, `""` when it cannot be
 * one. A probe without a repo is a probe in the wrong repository: the number is global to GitHub
 * only within a repo, so `gh pr view 262` in a checkout that does not own it answers with an error
 * that lands in the pane.
 */
export function repoSlug(remote: unknown): string {
	let url = typeof remote === "string" ? remote.trim() : "";
	url = url.replace(/\/+$/, "").replace(/\.git$/i, "");
	if (url.includes("://")) {
		url = url.slice(url.indexOf("://") + 3);
		const at = url.indexOf("@");
		if (at >= 0) url = url.slice(at + 1);
		const slash = url.indexOf("/");
		url = slash >= 0 ? url.slice(slash + 1) : "";
	} else if (url.includes("@")) {
		url = url.slice(url.indexOf("@") + 1);
		const colon = url.indexOf(":");
		url = colon >= 0 ? url.slice(colon + 1) : "";
	}
	url = url.replace(/\/+$/, "");
	const parts = url.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	return url;
}

/** A decisions file and the space that owns it: the space's `space.json` names its remote. */
export interface DecisionSource {
	file: string;
	space: string;
}

/** Every decisions file worth reading: the state's own, then one per space. */
export function decisionSources(state: string): DecisionSource[] {
	const out: DecisionSource[] = [{ file: join(state, "decisions.jsonl"), space: "" }];
	for (const space of spaceNames(state)) {
		out.push({ file: join(state, "spaces", space, "state", "decisions.jsonl"), space });
	}
	return out;
}

export function decisionFiles(state: string): string[] {
	return decisionSources(state).map((source) => source.file);
}

/** The `owner/name` a space's record names, or `""` when the record has no remote. */
function spaceRepo(state: string, space: string): string {
	if (!space) return "";
	try {
		const record = JSON.parse(readText(join(state, "spaces", space, "space.json")));
		return repoSlug(record?.remote);
	} catch {
		return "";
	}
}

/**
 * Every pull request `delegate finish` recorded as published, smallest number first, each with the
 * repository that owns it. A row that names neither a repo nor a space with a remote is skipped: a
 * guess here is the wrong-repo probe this file exists to stop, not a line.
 */
export function prCandidates(state: string): PrCandidate[] {
	const seen = new Map<string, PrCandidate>();
	for (const { file, space } of decisionSources(state)) {
		const fromSpace = spaceRepo(state, space);
		for (const line of readText(file).split("\n")) {
			let row: any;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			const pr = Number(row.pr);
			if (!Number.isInteger(pr) || pr <= 0) continue;
			const repo = repoSlug(row.repo) || fromSpace;
			if (!repo) continue;
			seen.set(`${repo}#${pr}`, { pr, repo });
		}
	}
	return [...seen.values()].sort((a, b) => a.pr - b.pr || a.repo.localeCompare(b.repo));
}

interface PrFact {
	checkedAt: number;
	state: string;
	mergeable: string;
	rollup: string;
}

export function cacheFile(state: string): string {
	return join(state, "cache", "open-prs.json");
}

export function readCache(state: string): Record<string, PrFact> {
	try {
		return JSON.parse(readText(cacheFile(state)));
	} catch {
		return {};
	}
}

export function writeCache(state: string, cache: Record<string, PrFact>): void {
	try {
		mkdirSync(dirname(cacheFile(state)), { recursive: true });
		writeFileSync(cacheFile(state), `${JSON.stringify(cache)}\n`);
	} catch {
		// A cache that cannot be written is a repeated `gh` call, never a missing line.
	}
}

/**
 * `gh pr view`'s answer, cached under `<repo>#<pr>`: a minute for an open pull request, a day once
 * it is settled. A cache written by the numeric key of an earlier version is not read — the number
 * alone never said which repo answered it, so it was never known in the first place.
 */
export function prFact(probe: Probe, pr: number, repo: string, cache: Record<string, PrFact>): PrFact | undefined {
	const now = probe.now?.() ?? Date.now();
	const key = `${repo}#${pr}`;
	const known = cache[key];
	if (known) {
		const terminal = known.state === "MERGED" || known.state === "CLOSED";
		const ttl = terminal ? TERMINAL_MS : FRESH_MS;
		if (now - known.checkedAt < ttl) return known;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(
			probe.run("gh", ["pr", "view", String(pr), "-R", repo, "--json", "number,state,mergeable,statusCheckRollup"]),
		);
	} catch {
		return known;
	}
	const fact: PrFact = {
		checkedAt: now,
		state: String(parsed?.state ?? ""),
		mergeable: String(parsed?.mergeable ?? ""),
		rollup: rollupWord(parsed?.statusCheckRollup),
	};
	cache[key] = fact;
	return fact;
}

/** The rollup in one word: red if any check failed, pending while any is unfinished, else green. */
export function rollupWord(checks: any): string {
	if (!Array.isArray(checks) || checks.length === 0) return "no checks";
	let pending = false;
	for (const check of checks) {
		const conclusion = String(check?.conclusion ?? "").toUpperCase();
		const state = String(check?.state ?? "").toUpperCase();
		const status = String(check?.status ?? "").toUpperCase();
		if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].includes(conclusion) ||
			["FAILURE", "ERROR"].includes(state)) {
			return "red";
		}
		if (!conclusion && !state && !status) {
			// A check with nothing in it yet has not succeeded; it is still on its way.
			pending = true;
			continue;
		}
		if ((status && status !== "COMPLETED") || (state && state !== "SUCCESS")) {
			pending = true;
		}
	}
	return pending ? "pending" : "green";
}

export function mergeableWord(mergeable: string): string {
	const word = mergeable.toUpperCase();
	if (word === "MERGEABLE") return "mergeable";
	if (word === "CONFLICTING") return "conflicts";
	return "unknown";
}

/** The lines one turn gets: one per open item, and nothing when nothing is open. */
export function openLines(probe: Probe): string[] {
	const lines: string[] = [];
	for (const worker of workersWithReports(probe.state)) {
		const fact = statusWord(probe, worker.slug, worker.report);
		if (fact.word === "reported") {
			lines.push(`worker ${worker.slug}: reported, report at ${fact.report} — next: bin/delegate finish ${worker.slug}`);
		}
	}
	const candidates = prCandidates(probe.state);
	const cache = readCache(probe.state);
	let touched = false;
	for (const { pr, repo } of candidates) {
		const fact = prFact(probe, pr, repo, cache);
		if (!fact) continue;
		touched = true;
		if (fact.state !== "MERGED" && fact.state !== "CLOSED") {
			lines.push(
				`PR #${pr} (${repo}): ${fact.rollup}, ${mergeableWord(fact.mergeable)} — next: gh pr view ${pr} -R ${repo}`,
			);
		}
	}
	if (touched) writeCache(probe.state, cache);
	return lines;
}

/** The checkout's own probe: `bin/delegate` for the word, `gh` for the pull request. */
export function defaultProbe(): Probe {
	const root = piRoot();
	return {
		state: join(root, "state"),
		delegate: join(root, "bin", "delegate"),
		run(cmd, args) {
			// stderr is piped and dropped: a probe that fails has nothing to say in the pane. `gh`
			// prints its GraphQL refusal for a number the cwd does not own, and execFileSync's
			// default hands that text to the parent, at every agent start, in every space.
			return execFileSync(cmd, args, {
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				timeout: 5000,
			});
		},
	};
}

export default function openWork(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const lines = openLines(defaultProbe());
		if (lines.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});
}
