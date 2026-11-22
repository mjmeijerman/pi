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
 *   PR #<n>: <rollup>, <mergeable|conflicts> — next: gh pr view <n>
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
}

/** Every decisions file worth reading: the state's own, then one per space. */
export function decisionFiles(state: string): string[] {
	const files = [join(state, "decisions.jsonl")];
	for (const space of spaceNames(state)) files.push(join(state, "spaces", space, "state", "decisions.jsonl"));
	return files;
}

/** Every pull request `delegate finish` recorded as published, smallest number first. */
export function prCandidates(state: string): PrCandidate[] {
	const seen = new Set<number>();
	for (const file of decisionFiles(state)) {
		for (const line of readText(file).split("\n")) {
			let row: any;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			const pr = Number(row.pr);
			if (!Number.isInteger(pr) || pr <= 0) continue;
			seen.add(pr);
		}
	}
	return [...seen].sort((a, b) => a - b).map((pr) => ({ pr }));
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

/** `gh pr view`'s answer, cached: a minute for an open pull request, a day once it is settled. */
export function prFact(probe: Probe, pr: number, cache: Record<string, PrFact>): PrFact | undefined {
	const now = probe.now?.() ?? Date.now();
	const known = cache[String(pr)];
	if (known) {
		const terminal = known.state === "MERGED" || known.state === "CLOSED";
		const ttl = terminal ? TERMINAL_MS : FRESH_MS;
		if (now - known.checkedAt < ttl) return known;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(probe.run("gh", ["pr", "view", String(pr), "--json", "number,state,mergeable,statusCheckRollup"]));
	} catch {
		return known;
	}
	const fact: PrFact = {
		checkedAt: now,
		state: String(parsed?.state ?? ""),
		mergeable: String(parsed?.mergeable ?? ""),
		rollup: rollupWord(parsed?.statusCheckRollup),
	};
	cache[String(pr)] = fact;
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
	for (const { pr } of candidates) {
		const fact = prFact(probe, pr, cache);
		if (!fact) continue;
		touched = true;
		if (fact.state !== "MERGED" && fact.state !== "CLOSED") {
			lines.push(`PR #${pr}: ${fact.rollup}, ${mergeableWord(fact.mergeable)} — next: gh pr view ${pr}`);
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
			return execFileSync(cmd, args, {
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
