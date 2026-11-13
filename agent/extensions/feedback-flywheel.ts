/**
 * Feedback flywheel + agent suggestion box.
 *
 * Radar basis: #11 feedback flywheel (Trial), #25 agent suggestion box (Assess),
 * #36 agent instruction bloat (Caution).
 *
 * Every failed tool call and every manual `/suggest` note is appended to
 * ~/.pi/agent/suggestions.jsonl. `/retro` aggregates them into a dated report so
 * harness edits are made from evidence instead of memory — and so rules can be
 * deleted, not only added.
 *
 * Nothing here changes model behavior; it only records what went wrong.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LOG = join(DIR, "suggestions.jsonl");
const RETRO_DIR = join(DIR, "retro");
/** Minimum gap between two logged occurrences of the same problem. */
const DEDUPE_MS = 60_000;

interface Suggestion {
	ts: string;
	kind: "tool-error" | "note";
	signature: string;
	tool?: string;
	context?: string;
	message: string;
}

const lastSeen = new Map<string, number>();

const SECRET_PATTERNS: [RegExp, string][] = [
	[/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "<redacted-key>"],
	[/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-token>"],
	[/\bAKIA[0-9A-Z]{12,}/g, "<redacted-aws-key>"],
	[/\bxox[abps]-[A-Za-z0-9-]{10,}/g, "<redacted-slack-token>"],
	[/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "<redacted-jwt>"],
	[/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)\S+/gi, "$1<redacted>"],
	[/\/\/[^/\s:]+:[^/\s@]+@/g, "//<redacted>@"],
];

/** Strip anything that looks like a credential before it touches disk. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function signatureOf(kind: string, tool: string, message: string): string {
	return createHash("sha1").update(`${kind}|${tool}|${clip(message, 160)}`).digest("hex").slice(0, 12);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.join("\n");
}

async function append(entry: Suggestion): Promise<void> {
	try {
		await mkdir(DIR, { recursive: true });
		await appendFile(LOG, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// Recording must never break the session.
	}
}

async function readAll(): Promise<Suggestion[]> {
	let raw: string;
	try {
		raw = await readFile(LOG, "utf8");
	} catch {
		return [];
	}
	const out: Suggestion[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Suggestion);
		} catch {
			// skip malformed line
		}
	}
	return out;
}

/** Group by signature, most frequent first. */
export function aggregate(entries: Suggestion[]): {
	signature: string;
	kind: Suggestion["kind"];
	tool: string;
	message: string;
	count: number;
	first: string;
	last: string;
}[] {
	const groups = new Map<string, ReturnType<typeof aggregate>[number]>();
	for (const entry of entries) {
		const existing = groups.get(entry.signature);
		if (existing) {
			existing.count += 1;
			if (entry.ts < existing.first) existing.first = entry.ts;
			if (entry.ts > existing.last) existing.last = entry.ts;
			continue;
		}
		groups.set(entry.signature, {
			signature: entry.signature,
			kind: entry.kind,
			tool: entry.tool ?? "-",
			message: entry.message,
			count: 1,
			first: entry.ts,
			last: entry.ts,
		});
	}
	return [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

function renderReport(groups: ReturnType<typeof aggregate>, total: number): string {
	const day = new Date().toISOString().slice(0, 10);
	const lines = [
		`# Harness retro — ${day}`,
		"",
		`${total} recorded problems in ${groups.length} distinct signatures.`,
		"",
		"| # | count | kind | tool | first seen | last seen | problem |",
		"| - | ----- | ---- | ---- | ---------- | --------- | ------- |",
	];
	groups.slice(0, 40).forEach((g, i) => {
		lines.push(
			`| ${i + 1} | ${g.count} | ${g.kind} | ${g.tool} | ${g.first.slice(0, 10)} | ${g.last.slice(0, 10)} | ${clip(g.message, 120).replace(/\|/g, "\\|")} |`,
		);
	});
	lines.push(
		"",
		"## How to use this",
		"",
		"1. Fix the environment problem when it is a missing tool or dependency; do not teach the agent a workaround.",
		"2. Turn repeated advice into a deterministic hook or check instead of more prose.",
		"3. Delete rules this report shows are never relevant. Adding is cheap, pruning is what keeps the harness fast.",
		"",
		`Source log: ${LOG}`,
	);
	return lines.join("\n");
}

export default function feedbackFlywheel(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (!event.isError) return;
		const message = clip(textFromContent(event.content), 400);
		if (!message) return;
		const tool = event.toolName ?? "unknown";
		const signature = signatureOf("tool-error", tool, message);
		const now = Date.now();
		const previous = lastSeen.get(signature);
		if (previous !== undefined && now - previous < DEDUPE_MS) return;
		lastSeen.set(signature, now);
		await append({
			ts: new Date(now).toISOString(),
			kind: "tool-error",
			signature,
			tool,
			context: clip(redact(JSON.stringify(event.input ?? {})), 200),
			message: redact(message),
		});
	});

	pi.registerCommand("suggest", {
		description: "Record a harness problem for the next retro: /suggest <what went wrong>",
		handler: async (args, ctx) => {
			const note = redact(args.trim());
			if (!note) {
				ctx.ui.notify("Usage: /suggest <what went wrong>", "warning");
				return;
			}
			await append({
				ts: new Date().toISOString(),
				kind: "note",
				signature: signatureOf("note", "user", note),
				message: clip(note, 400),
			});
			ctx.ui.notify(`Recorded: ${clip(note, 80)}`, "info");
		},
	});

	pi.registerCommand("retro", {
		description: "Aggregate recorded problems into a dated harness retro report",
		handler: async (args, ctx) => {
			const entries = await readAll();
			if (entries.length === 0) {
				ctx.ui.notify("No recorded problems yet. /suggest records one.", "info");
				return;
			}
			const groups = aggregate(entries);
			const report = renderReport(groups, entries.length);
			await mkdir(RETRO_DIR, { recursive: true });
			const path = join(RETRO_DIR, `${new Date().toISOString().slice(0, 10)}.md`);
			await writeFile(path, `${report}\n`, "utf8");
			const top = groups
				.slice(0, 3)
				.map((g) => `${g.count}× ${g.tool}: ${clip(g.message, 70)}`)
				.join(" · ");
			ctx.ui.notify(
				`${groups.length} signatures, ${entries.length} reports → ${path}\nTop: ${top}`,
				"info",
			);
			if (args.includes("--propose")) {
				pi.sendUserMessage(
					`Read ${path} and propose concrete edits to ~/.pi/agent/AGENTS.md and the skills in ~/.pi/agent/skills that would prevent the most frequent problems. Prefer deterministic checks over prose. Also name at least one existing rule worth deleting. Show diffs, do not apply them yet.`,
				);
			}
		},
	});
}
