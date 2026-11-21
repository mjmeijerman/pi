#!/usr/bin/env node
/**
 * jev — the decision model.
 *
 * Radar Vol. 35, "Beyond frontier models": decision models like Jev, and model routing instead
 * of blanket frontier usage. This is that idea at its smallest useful size: one typed question
 * per call, a calibrated probability, and an explicit "unsure" that sends the question to the
 * human instead of guessing.
 *
 * The model is TypeSafe's Jev (api.typesafe.ai, POST /v1/systemone). It answers typed questions
 * with a probability for every option, in about 150 ms, so a decision is a number the caller can
 * read instead of a sentence it has to trust. One POST answers all the questions it is given, so
 * the four questions a spawn asks are one request, one latency and one usage line.
 *
 *   jev ask "<question>"      yes | no | unsure
 *   jev permit "<request>"    allow a sandbox permission request, deny it, or escalate it
 *   jev mode "<worker task>"  bare | sandboxed | no-net
 *   jev count "<task>"        1..4 workers
 *   jev route "<task>"        local | remote
 *   jev thinking "<task>"     low | medium | high — how much effort the worker needs
 *   jev plan "<task>"         count + mode + route + thinking in one call
 *
 * The rules do not relax with the transport: every answer is checked against the options that
 * were offered, and against JEV_MIN_CONFIDENCE (bin/jev-model.mjs) on the probability of the
 * chosen option. The two checks fail differently on purpose. An option we did not offer is a
 * broken answer, not a weak one: exit 3, and the field is named. An offered option below the
 * threshold is a weak answer, so plan takes the conservative default for that field (DEFAULTS
 * below), names the field and its probability on stderr, and still exits 0 — a weak count should
 * cost one worker, not the spawn. Every other subcommand keeps the stricter reading: ask, permit,
 * mode, count, route and thinking are exit 3 at low confidence, because a default there would
 * answer a question nobody asked. Route is read from the answer (0 local, 1 remote, and a local
 * route is still a refusal made by the caller); 3 means unsure, no key or the model is
 * unreachable; 2 usage. --json prints {"decision":…,"reason":…,"defaults":[…]} instead of one
 * line.
 *
 * "thinking" answers an abstract effort, never a pi level name: which levels the concrete model
 * supports is a fact about that model, so the caller does the mapping (bin/delegate reads the
 * model catalogue and picks the nearest supported level).
 *
 * The key is a secret: it is read from TYPESAFE_API_KEY, or the TYPESAFE_API_KEY= line of
 * JEV_KEY_FILE (default ~/.pi/agent/env.secret). It is never printed, never logged, and no error
 * line repeats it; the key file's own path is the most an error says.
 *
 * Every call is recorded in state/usage.jsonl (see bin/usage.mjs): kind "jev", the subcommand,
 * the model that answered (the concrete id from the response, not the alias), the latency and
 * whether it answered at all. A caller that has one sets PI_BOSS_CONTEXT (delegate sets the
 * slug), which lands on the line too.
 */
import fs from "node:fs";
import process from "node:process";
import { ENDPOINT, MODEL, TIMEOUT, MIN_CONFIDENCE, KEY_ENV, KEY_FILE } from "./jev-model.mjs";
import { logUsage, logDecision, context } from "./usage.mjs";

// Wall clock for the usage line: a decision model that takes 40s is a fact worth having.
const started = Date.now();
let command = "";
// The concrete model the last response named (e.g. jev-1.14.0), which is what actually answered.
let answeredBy = "";

// record — one usage line for this call, ok or not. Callers exit straight after.
function record(ok, errorMsg) {
	if (!command) return;
	logUsage({
		kind: "jev",
		command,
		model: answeredBy || MODEL,
		started,
		latency_ms: Date.now() - started,
		ok,
		error: errorMsg,
		context: context(),
		task: opts.text,
	});
}

// fail — the call did not produce a decision. The reason goes to stderr, one line, and never
// carries the key: only the endpoint and the key file's path are addresses, not secrets.
function fail(message, code = 3, errorClass = "unreachable") {
	record(false, errorClass);
	process.stderr.write(`jev: ${message}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const opts = { json: false, kind: "", text: "" };
	const rest = [];
	for (const arg of argv) {
		if (arg === "--json") opts.json = true;
		else if (!opts.kind && ["ask", "permit", "mode", "count", "route", "thinking", "plan"].includes(arg))
			opts.kind = arg;
		else rest.push(arg);
	}
	opts.text = rest.join(" ").trim();
	return opts;
}

/** apiKey — the key from the environment, else the TYPESAFE_API_KEY line of the key file. */
function apiKey() {
	const fromEnv = String(process.env[KEY_ENV] || "").trim();
	if (fromEnv) return fromEnv;
	let text;
	try {
		text = fs.readFileSync(KEY_FILE, "utf8");
	} catch (error) {
		fail(
			`no API key: ${KEY_ENV} is unset and the key file is unreadable (${KEY_FILE}: ${error.code || error.message}) — set ${KEY_ENV} or write ${KEY_ENV}=… there`,
			3,
			"no-key",
		);
	}
	for (const line of text.split("\n")) {
		const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const value = match[1].trim().replace(/^["']|["']$/g, "");
		if (value) return value;
	}
	fail(`no API key: the key file has no ${KEY_ENV}= line (${KEY_FILE}) — add one or set ${KEY_ENV}`, 3, "no-key");
}

// The options every Choice question offers, with the policy that separates them. TypeSafe reads
// both the option name and its description, so the description is where the standing rule lives.
const OPTIONS = {
	mode: {
		bare: "Needs host access the sandbox refuses: Herdr control sockets, a GUI, docker. Publishing is never a reason: a worker commits and the boss publishes",
		sandboxed: "The default. Read-only analysis, small edits, tests in a normal repository",
		"no-net": "Runs untrusted repository scripts and needs no network. A worker that needs a model cannot use this: no network means no model",
	},
	count: {
		1: "The task is a single thread of work. Do not inflate the count",
		2: "Two independent pieces of work that can run side by side",
		3: "Three independent pieces of work",
		4: "Four or more independent pieces. Four is the review ceiling: past it the human cannot read the output",
	},
	route: {
		local: "Summarise, classify, extract, tidy, translate, format, or a short mechanical rewrite: no repo knowledge, no tools",
		remote: "Code changes, debugging, design decisions, multi-file reasoning, or anything that needs tools, tests or the repo",
	},
	thinking: {
		low: "Mechanical edits, renames, formatting, single-file tweaks",
		medium: "Ordinary work that needs some judgement",
		high: "Hard debugging, multi-file design, migrations, security-sensitive work",
	},
};

// Radar Vol. 35, blip 62 (decision models): the probability is recorded so a weak answer can be
// seen as weak, and this is what a weak one does. A plan field jev is not sure about takes the
// conservative value on the line for it — one worker, the sandbox, the remote route, medium
// effort — the plan continues, and the caller is told which field defaulted. Stopping a spawn on
// "probably one worker" is a queue, not a gate; the caller can still overrule the whole call.
const DEFAULTS = { count: 1, mode: "sandboxed", route: "remote", thinking: "medium" };

const INSTRUCTIONS = {
	mode: "A worker will be started for this task. Which mode should it run in?",
	count: "How many parallel workers does this task need? Answer with an integer from 1 to 4.",
	route:
		"Should this task run local (a small local model on this machine, no repo and no tools) or remote (a coding agent with the repo and tools)? When in doubt, remote.",
	thinking:
		"How much thinking effort does this task need? The lowest effort that still does the task, and the effort the task needs, not a model's level name.",
	plan: {
		count: "How many parallel workers does this task need? Answer with an integer from 1 to 4.",
		mode: "Which mode should this worker run in?",
		route:
			"Should this task run local (a small local model on this machine, no repo and no tools) or remote (a coding agent with the repo and tools)? When in doubt, remote.",
		thinking:
			"How much thinking effort does this task need? The lowest effort that still does the task.",
	},
};

const ASK_INSTRUCTIONS = (text) =>
	`${text}\n\nShould this go ahead? Answer yes when it is safe and wanted, no when it is not. If the question is ambiguous or answering it would be a guess, give a probability near 0.5 and a human will take it.`;
const PERMIT_INSTRUCTIONS = (text) =>
	`A sandboxed worker asks for this permission:\n${text}\n\nShould the harness allow it, deny it, or ask the human? Allow when it is read-only, or a write inside the directory the worker was given, or a path the sandbox simply did not mount and the task needs. Deny for credentials, ssh keys, cloud configs, writes outside the worker's directory, destructive commands, or network access to hosts the task does not need. Ask when neither is clear.`;

const choice = (instructions, options) => ({ type: "choice", instructions, criteria: options });

/** questions — the typed questions for one subcommand, as one request body fragment. */
function questions(kind, text) {
	if (kind === "ask") {
		return {
			decision: {
				type: "noul",
				instructions: ASK_INSTRUCTIONS(text),
				criteria: { true: "The request is safe and wanted", false: "The request should not go ahead" },
			},
		};
	}
	if (kind === "permit") {
		return {
			permission: choice(PERMIT_INSTRUCTIONS(text), {
				allow: "Read-only, a write inside the worker's own directory, or a needed path the sandbox did not mount",
				deny: "Credentials, ssh keys, cloud configs, a write outside the worker's directory, a destructive command, or unneeded network",
				ask: "Neither: a human should decide",
			}),
		};
	}
	if (kind === "plan") {
		return {
			count: choice(INSTRUCTIONS.plan.count, OPTIONS.count),
			mode: choice(INSTRUCTIONS.plan.mode, OPTIONS.mode),
			route: choice(INSTRUCTIONS.plan.route, OPTIONS.route),
			thinking: choice(INSTRUCTIONS.plan.thinking, OPTIONS.thinking),
		};
	}
	return { [kind]: choice(INSTRUCTIONS[kind], OPTIONS[kind]) };
}

/** request — one POST, every question at once. Returns the answers map or fails. */
async function request(kind, text) {
	const key = apiKey();
	const body = { model: MODEL, state: { task: text }, questions: questions(kind, text) };
	let response;
	try {
		response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT),
		});
	} catch (error) {
		const why = error?.name === "TimeoutError" ? `timed out after ${TIMEOUT} ms` : error.message;
		fail(`decision model unreachable (${ENDPOINT}): ${why} — ask the user`, 3, "unreachable");
	}
	// A refused key is the one failure a retry cannot fix, and the one worth naming precisely.
	if (response.status === 401 || response.status === 403) {
		fail(
			`decision model refused the API key (HTTP ${response.status}) — check ${KEY_ENV}, or the ${KEY_ENV}= line in ${KEY_FILE}`,
			3,
			"auth",
		);
	}
	if (!response.ok) fail(`decision model returned HTTP ${response.status} — ask the user`, 3, "http");

	let payload;
	try {
		payload = await response.json();
	} catch {
		fail("decision model answered outside JSON — ask the user", 3, "non-json");
	}
	if (payload && typeof payload.model === "string" && payload.model) answeredBy = payload.model;
	const answers = payload && typeof payload.answers === "object" ? payload.answers : null;
	if (!answers) fail("decision model returned nothing usable (no answers in the response) — ask the user", 3, "empty");
	return answers;
}

/**
 * pick — one Choice answer as {value, probability, raw}. `probability` is the chosen option's own
 * probability, which is the number a caller acts on; a missing or non-numeric probability is
 * null. `value` is empty when jev answered something we did not offer (`raw` keeps what it said),
 * and that is a broken answer rather than a weak one: see the plan branch below.
 */
function pick(answers, id, offered) {
	const answer = answers?.[id];
	if (!answer || answer.type !== "choice") return { value: "", probability: null, raw: "" };
	const raw = answer.choice === undefined || answer.choice === null ? "" : String(answer.choice);
	const value = offered.some((option) => option === raw) ? raw : "";
	const fromDistribution = answer.probabilities ? answer.probabilities[raw] : undefined;
	const probability =
		typeof fromDistribution === "number"
			? fromDistribution
			: typeof answer.confidence === "number"
				? answer.confidence
				: null;
	return { value, probability, raw };
}

/** noul — one Noul answer's probability of yes, 0..1. */
function noul(answers, id) {
	const answer = answers?.[id];
	if (!answer || answer.type !== "noul") return null;
	return typeof answer.noul === "number" ? answer.noul : null;
}

const usable = (field) => field.value !== "" && typeof field.probability === "number" && field.probability >= MIN_CONFIDENCE;
const asNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

/** reasonOf — the probabilities in words, so a decision line carries its own evidence. */
function reasonOf(fields) {
	const parts = [];
	for (const [name, field] of Object.entries(fields)) parts.push(`${name} ${asNumber(field.probability) ?? "?"}`);
	return parts.join(", ");
}

function emit(line, payload, code) {
	// The model answered, whatever the harness makes of the answer: exit 3 for "unsure" is a
	// decision, not a failure of the decision path.
	record(true);
	if (opts.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
	else process.stdout.write(`jev: ${line}\n`);
	process.exit(code);
}

const opts = parseArgs(process.argv.slice(2));
command = opts.kind;
if (!opts.kind) fail("usage: jev ask|permit|mode|count|route|thinking|plan <text> [--json]", 2, "usage");
if (!opts.text) fail(`jev ${opts.kind}: needs the question text`, 2, "usage");

const answers = await request(opts.kind, opts.text);

if (opts.kind === "plan") {
	// Four questions, one request, one usage line. Each field is checked against the options it
	// was offered and against its own probability, and the two failures are not the same failure:
	// an option we did not offer is a broken answer and stops the plan (exit 3, the field null and
	// named), while an offered option that is only weakly probable takes DEFAULTS[field] and the
	// plan still succeeds. That is the whole point of a probability: one weak count costs one
	// worker, not a spawn, and the caller is told exactly which field it was.
	const fields = {
		count: pick(answers, "count", ["1", "2", "3", "4"]),
		mode: pick(answers, "mode", ["bare", "sandboxed", "no-net"]),
		route: pick(answers, "route", ["local", "remote"]),
		thinking: pick(answers, "thinking", ["low", "medium", "high"]),
	};
	const reason = reasonOf(fields);
	const weakest = Math.min(
		...Object.values(fields).map((field) => (typeof field.probability === "number" ? field.probability : 0)),
	);
	const confidence = Math.round(weakest * 100) / 100;
	// Unoffered, or no answer at all: the options are the contract, so this is not a weak answer.
	// The field is null and named; the fields that did answer keep their answers, because a
	// refusal should carry what was usable as well as what was not.
	const bad = Object.entries(fields)
		.filter(([, field]) => field.value === "")
		.map(([name]) => name);
	const raw = (name) => (bad.includes(name) ? null : name === "count" ? Number(fields.count.value) : fields[name].value);
	if (bad.length)
		emit(`unsure how to plan this spawn (${bad.join(", ")} unusable) — ask the user`, {
			count: raw("count"),
			mode: raw("mode"),
			route: raw("route"),
			thinking: raw("thinking"),
			defaults: [],
			reason,
			confidence,
		}, 3);
	const defaults = Object.entries(fields)
		.filter(([, field]) => !(typeof field.probability === "number" && field.probability >= MIN_CONFIDENCE))
		.map(([name]) => name);
	const value = (name) => (defaults.includes(name) ? DEFAULTS[name] : fields[name].value);
	// What jev itself answered for each defaulted field, so a caller can record the answer and the
	// default separately instead of writing the default down as jev's own judgement.
	const answered = {};
	for (const name of defaults) answered[name] = fields[name].value;
	const payload = {
		count: Number(value("count")),
		mode: value("mode"),
		route: value("route"),
		thinking: value("thinking"),
		defaults,
		answered,
		reason,
		confidence,
	};
	if (defaults.length) {
		// One line, every defaulted field with the probability that made it weak, and the values
		// that stand in for them. It goes to stderr so stdout stays the decision.
		const named = defaults.map((name) => `${name} ${asNumber(fields[name].probability) ?? "?"}`).join(", ");
		process.stderr.write(
			`jev: defaulted ${named} (below ${MIN_CONFIDENCE}) — using count=${payload.count} mode=${payload.mode} route=${payload.route} thinking=${payload.thinking}\n`,
		);
	}
	emit(
		`count=${payload.count} mode=${payload.mode} route=${payload.route} thinking=${payload.thinking}`,
		payload,
		0,
	);
}

if (opts.kind === "mode") {
	const field = pick(answers, "mode", ["bare", "sandboxed", "no-net"]);
	const payload = { mode: usable(field) ? field.value : null, reason: reasonOf({ mode: field }), confidence: asNumber(field.probability) };
	if (payload.mode === null) emit("unsure which mode — ask the user", payload, 3);
	emit(payload.mode, payload, 0);
}

if (opts.kind === "count") {
	const field = pick(answers, "count", ["1", "2", "3", "4"]);
	const payload = { count: usable(field) ? Number(field.value) : null, reason: reasonOf({ count: field }), confidence: asNumber(field.probability) };
	if (payload.count === null) emit("unsure how many workers — ask the user", payload, 3);
	emit(String(payload.count), payload, 0);
}

if (opts.kind === "route") {
	const field = pick(answers, "route", ["local", "remote"]);
	const payload = { route: usable(field) ? field.value : null, reason: reasonOf({ route: field }), confidence: asNumber(field.probability) };
	if (payload.route === null) emit("unsure which route — ask the user", payload, 3);
	if (payload.route === "local") emit("local", payload, 0);
	emit("remote", payload, 1);
}

if (opts.kind === "thinking") {
	const field = pick(answers, "thinking", ["low", "medium", "high"]);
	const payload = {
		thinking: usable(field) ? field.value : null,
		reason: reasonOf({ thinking: field }),
		confidence: asNumber(field.probability),
	};
	if (payload.thinking === null) emit("unsure how much thinking this needs — ask the user", payload, 3);
	emit(payload.thinking, payload, 0);
}

// permit: one Choice with an explicit "ask", so an unreadable request has somewhere to go that
// is not a coin flip. A chosen option below the threshold is unsure too, whatever it reads.
if (opts.kind === "permit") {
	const field = pick(answers, "permission", ["allow", "deny", "ask"]);
	const reason = reasonOf({ permission: field });
	const confidence = asNumber(field.probability);
	// A permit answer is the highest-consequence decision jev makes, so it gets a row in
	// state/decisions.jsonl like every spawn decision: without one, `delegate stats` can never
	// say how many permission calls there were or how they went. `decision` is jev's answer — no
	// person's counter-answer exists yet, which is why the scorecard calls permit recorded-but-
	// unscored rather than claiming an agreement rate for it.
	const verdict = !usable(field) || field.value === "ask" ? "unsure" : field.value === "allow" ? "allow" : "deny";
	logDecision({
		command: "permit",
		task: opts.text,
		decision: verdict,
		reason,
		overridden: false,
		slug: process.env.AGENT_SLUG || context(),
		jev: verdict,
		extra: { confidence },
	});
	if (!usable(field) || field.value === "ask")
		emit("unsure — ask the user", { decision: "unsure", reason, confidence }, 3);
	if (field.value === "allow") emit("yes", { decision: "yes", reason, confidence }, 0);
	emit("no", { decision: "no", reason, confidence }, 1);
}

// ask: one Noul, whose number is the probability of yes. A Noul carries no `confidence`, so the
// threshold is applied to |2p-1| — the documented confidence for a yes/no answer — which is the
// same number in every case: how far the answer is from a coin flip.
const probability = noul(answers, "decision");
const confidence = typeof probability === "number" ? asNumber(Math.abs(2 * probability - 1)) : null;
const reason = `decision ${asNumber(probability) ?? "?"}`;
if (typeof probability !== "number" || confidence === null || confidence < MIN_CONFIDENCE)
	emit("unsure — ask the user", { decision: "unsure", reason, confidence }, 3);
if (probability > 0.5) emit("yes", { decision: "yes", reason, confidence }, 0);
emit("no", { decision: "no", reason, confidence }, 1);
