#!/usr/bin/env node
/**
 * local-run — do a local job on the local model, headless.
 *
 * The other half of routing (jev route): a task jev calls "local" runs here instead of in a
 * worker space. One prompt in, the answer on stdout, no Herdr space, no state file, no
 * decisions.jsonl line, no spec, no report. Its own model and endpoint (bin/local-model.mjs):
 * jev is a remote decision model now, and this half still runs on the local ollama model, with
 * no network and no key.
 *
 *   local-run "summarise reports/x.md in three bullets"
 *   cat task.txt | local-run
 *
 * Exit 0 = the model answered (answer on stdout). Exit 1 = no answer (reason on stderr).
 *
 * Every request asks ollama to keep the model resident for KEEP_ALIVE (bin/local-model.mjs), so a
 * local task after an idle gap does not pay the model load again. An endpoint that refuses the
 * field with 400 gets one retry without it, announced on stderr.
 *
 * Every invocation is recorded in state/usage.jsonl (see bin/usage.mjs): kind "local-run",
 * model, latency, ok/error, and the task clipped to 200 characters. The answer itself is not
 * logged. PI_BOSS_CONTEXT, when the caller sets it, lands on the line as context.
 */
import process from "node:process";
import { MODEL, ENDPOINT, TIMEOUT, KEEP_ALIVE } from "./local-model.mjs";
import { logUsage, context } from "./usage.mjs";

const started = Date.now();
let taskForLog = "";

const SYSTEM = `You are the local worker of a coding-agent harness. You get one self-contained
task and you answer it in plain text on stdout. You have no file system, no shell, no network
and no tools, so work only from the text you are given and say so if the task needs something
you cannot see. No preamble, no sign-off, no markdown headings: the answer itself.`;

function fail(message, code = 1, errorClass = "unreachable") {
	logUsage({
		kind: "local-run",
		command: "run",
		model: MODEL,
		started,
		latency_ms: Date.now() - started,
		ok: false,
		error: errorClass,
		context: context(),
		task: taskForLog,
	});
	process.stderr.write(`local-run: ${message}\n`);
	process.exit(code);
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
let task = argv.join(" ").trim();
if (!task && !process.stdin.isTTY) task = (await readStdin()).trim();
if (!task) fail('usage: local-run "<task>" (or pipe the task on stdin): no task text', 1, "usage");
taskForLog = task;

async function post(body) {
	try {
		return await fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT),
		});
	} catch (error) {
		fail(`local model unreachable (${ENDPOINT}): ${error.message}`, 1, "unreachable");
	}
}

const body = {
	model: MODEL,
	stream: false,
	keep_alive: KEEP_ALIVE,
	options: { temperature: 0.2, num_ctx: 8192 },
	messages: [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: task },
	],
};

let response = await post(body);
// An endpoint that does not know keep_alive refuses the whole request with 400. One retry
// without the field, and say so: the answer matters, the warm-up is the optimisation.
if (response.status === 400) {
	process.stderr.write(`local-run: endpoint refused keep_alive=${KEEP_ALIVE} (HTTP 400); retrying without it\n`);
	const bare = { ...body };
	delete bare.keep_alive;
	response = await post(bare);
}
if (!response.ok) fail(`local model returned HTTP ${response.status}`, 1, "http");

const payload = await response.json().catch(() => null);
const answer = payload?.message?.content;
if (!answer || !String(answer).trim()) fail("local model returned nothing", 1, "empty");
logUsage({
	kind: "local-run",
	command: "run",
	model: MODEL,
	started,
	latency_ms: Date.now() - started,
	ok: true,
	context: context(),
	task: taskForLog,
});
process.stdout.write(`${String(answer).trim()}\n`);
