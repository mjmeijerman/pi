/**
 * Local LLM routing — sends narrow, high-frequency text tasks to a local
 * open-weight model instead of the paid provider.
 *
 * Radar basis: #30 local coding models, #19 small language models,
 * #40 blanket frontier model usage (Caution).
 *
 * Exposes one tool, `local_llm`, that talks to an Ollama OpenAI-compatible
 * endpoint. Nothing is routed automatically: the agent picks it for tasks that
 * need no reasoning, and `/local` proves the endpoint is up.
 *
 * Env:
 *   PI_OLLAMA_URL        default http://localhost:11434
 *   PI_LOCAL_MODEL       default qwen3.8:27b
 *   PI_LOCAL_TIMEOUT_MS  default 120000
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE_URL = (process.env.PI_OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
const MODEL = process.env.PI_LOCAL_MODEL ?? "qwen3.8:27b";
const TIMEOUT_MS = Number(process.env.PI_LOCAL_TIMEOUT_MS ?? 120_000);
const MAX_INPUT_CHARS = 60_000;

const TASKS = ["summarize", "classify", "extract", "tidy", "translate"] as const;
type Task = (typeof TASKS)[number];

const SYSTEM: Record<Task, string> = {
	summarize:
		"Summarize the text the user provides. Keep every fact, number and name. Drop repetition and filler. Use short paragraphs or a flat bullet list. Do not add interpretation.",
	classify:
		"Classify the text the user provides. Answer with one line: the label, then an em dash and a one-sentence justification. If the user names the allowed labels, use exactly one of them.",
	extract:
		"Extract the requested fields from the text as compact JSON. Use only values present in the text. Use null for absent fields. Output JSON only, no prose.",
	tidy:
		"Rewrite the text for clarity and concision without changing meaning, facts or technical terms. Keep the original structure and language. Output only the rewritten text.",
	translate:
		"Translate the text as instructed. Preserve technical terms, code identifiers and markdown formatting. Output only the translation.",
};

interface ChatResponse {
	choices?: { message?: { content?: string } }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
	error?: { message?: string } | string;
}

async function chat(
	body: { messages: { role: string; content: string }[] },
	signal: AbortSignal,
): Promise<ChatResponse> {
	const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL, temperature: 0.2, stream: false, ...body }),
		signal,
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 300);
		throw new Error(`local model HTTP ${res.status}: ${detail}`);
	}
	return (await res.json()) as ChatResponse;
}

function textOf(data: ChatResponse): string {
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.trim() === "") {
		throw new Error("local model returned an empty response");
	}
	return content.trim();
}

export default function localLlm(pi: ExtensionAPI) {
	pi.registerTool({
		name: "local_llm",
		label: "Local LLM",
		description:
			"Run a narrow text task on a local open-weight model: summarize a fetched page or log, classify, extract fields as JSON, tidy or translate text. Costs no API tokens and stays on this machine.",
		promptSnippet: "Narrow text tasks (summarize/classify/extract/tidy/translate) on a local model",
		promptGuidelines: [
			"Use local_llm for text-only chores that need no reasoning about code: summarizing fetched pages or long logs, classifying or extracting fields, tidying notes, translating. It runs locally and costs nothing.",
			"Do not use local_llm when the answer needs codebase knowledge, multi-step reasoning, or a change to files; use the normal tools for those.",
		],
		parameters: Type.Object({
			task: StringEnum(TASKS),
			text: Type.String({ description: "The input text. Long inputs are truncated." }),
			instruction: Type.Optional(
				Type.String({ description: "Extra instruction, e.g. the allowed labels or fields to extract." }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const input =
				params.text.length > MAX_INPUT_CHARS
					? `${params.text.slice(0, MAX_INPUT_CHARS)}\n\n[truncated at ${MAX_INPUT_CHARS} characters]`
					: params.text;
			const prompt = params.instruction ? `${params.instruction}\n\n---\n\n${input}` : input;
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

			try {
				const data = await chat(
					{
						messages: [
							{ role: "system", content: SYSTEM[params.task] },
							{ role: "user", content: prompt },
						],
					},
					combined,
				);
				return {
					content: [{ type: "text" as const, text: textOf(data) }],
					details: {
						model: MODEL,
						task: params.task,
						promptTokens: data.usage?.prompt_tokens ?? null,
						completionTokens: data.usage?.completion_tokens ?? null,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: `local_llm unavailable (${MODEL} at ${BASE_URL}): ${message}\nDo the task with the normal tools instead.`,
						},
					],
					details: { model: MODEL, task: params.task, error: message },
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("local", {
		description: "Check the local model endpoint and list installed models",
		handler: async (_args, ctx) => {
			const started = Date.now();
			try {
				const res = await fetch(`${BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as { models?: { name: string }[] };
				const names = (data.models ?? []).map((m) => m.name);
				const present = names.includes(MODEL);
				ctx.ui.notify(
					`${present ? "ready" : "MISSING"} ${MODEL} · ${Date.now() - started}ms · installed: ${names.join(", ") || "none"}`,
					present ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(
					`local model unreachable at ${BASE_URL}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
