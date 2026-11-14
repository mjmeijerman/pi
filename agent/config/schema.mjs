/**
 * schema.mjs — the shape of the config files pi reads on every start.
 *
 * Radar basis: #102 Varlock (Assess) — validate config, do not hope.
 * #42 human-in-the-loop theater (Caution): a typo in a key name is not an
 * error to pi, it is a silently ignored key, so a route "works" until the day
 * it falls back to the provider default. This file turns that silence into a
 * line that names the file, the path inside it and what was expected.
 *
 * One description per file, plain objects in JSON-schema shape (a subset:
 * type, properties, required, additionalProperties, items, enum, minLength,
 * minItems). No dependency, no network, no writes: `--verify-config` is a read
 * of three small files, measured in single-digit milliseconds.
 *
 * Two rules the code keeps on purpose:
 *  - keys.json is validated by shape and presence only. No issue ever carries a
 *    value, so a secret cannot reach a log, a notification or a test fixture.
 *  - Unknown keys are errors, not warnings: that is the whole point. A new
 *    package's settings block is one line in SETTINGS_EXTENSION_KEYS away.
 *
 * Usage (the harness check and the session-start guard both call this):
 *   node agent/config/schema.mjs --root .          # tab-separated PASS/FAIL
 *   node agent/config/schema.mjs --root . --json   # one JSON document
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Superset of pi's thinking levels; `off` is legal in a route, not as a map key. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function obj(properties, required = []) {
	return { type: "object", properties, required, additionalProperties: false };
}

/** An object whose keys are arbitrary names and whose values share one shape. */
function mapOf(values) {
	return { type: "object", additionalProperties: values };
}

function arr(items) {
	return { type: "array", items };
}

/** `{ provider, id }`: the two fields that make a route a route. */
const MODEL_ROUTE = obj(
	{
		provider: { type: "string", minLength: 1 },
		id: { type: "string", minLength: 1 },
		thinking: { enum: THINKING_LEVELS },
	},
	["provider", "id"],
);

const COST = obj(
	{
		input: { type: "number" },
		output: { type: "number" },
		cacheRead: { type: "number" },
		cacheWrite: { type: "number" },
	},
	["input", "output", "cacheRead", "cacheWrite"],
);

const THINKING_MAP = obj(
	Object.fromEntries(
		THINKING_LEVELS.filter((level) => level !== "off").map((level) => [
			level,
			{ type: ["string", "null"] },
		]),
	),
);

const MODEL = obj(
	{
		id: { type: "string", minLength: 1 },
		name: { type: "string", minLength: 1 },
		api: { type: "string", minLength: 1 },
		baseUrl: { type: "string", minLength: 1 },
		reasoning: { type: "boolean" },
		thinkingLevelMap: THINKING_MAP,
		input: arr({ enum: ["text", "image"] }),
		inputLimits: { type: "object" },
		cost: COST,
		promptCache: { type: "object" },
		contextWindow: { type: "number" },
		maxTokens: { type: "number" },
		samplingParams: { type: "object" },
		samplingParamsByThinkingLevel: { type: "object" },
		headers: mapOf({ type: "string" }),
		compat: { type: "object" },
	},
	["id"],
);

const PROVIDER = obj(
	{
		name: { type: "string" },
		baseUrl: { type: "string", minLength: 1 },
		// A literal key, "$ENV_NAME" or "!command": all three are strings, and the
		// value is never read out loud, only typed.
		apiKey: { type: "string", minLength: 1 },
		api: { type: "string", minLength: 1 },
		oauth: { enum: ["radius"] },
		headers: mapOf({ type: "string" }),
		compat: { type: "object" },
		authHeader: { type: "boolean" },
		models: arr(MODEL),
		modelOverrides: { type: "object" },
	},
);

/**
 * pi's own top-level settings, typed from the editor's generated schema
 * (pi-coding-agent 1.5.2, schemas/settings.schema.json). A key that lands in a
 * newer pi shows up here as an unknown key, which is the loud failure we want:
 * one line to add, instead of a setting that quietly does nothing.
 */
const SETTINGS_PI_KEYS = {
	$schema: { type: "string" },
	lastChangelogVersion: { type: "string" },
	extensionChangelogVersions: mapOf({ type: "string" }),
	defaultProvider: { type: "string", minLength: 1 },
	defaultModel: { type: "string", minLength: 1 },
	defaultThinkingLevel: { enum: THINKING_LEVELS },
	modelThinkingLevels: mapOf({ enum: THINKING_LEVELS }),
	transport: { enum: ["auto", "sse", "websocket", "websocket-cached"] },
	sessionShareDestination: { enum: ["auto", "gist", "radius"] },
	steeringMode: { enum: ["all", "one-at-a-time"] },
	followUpMode: { enum: ["all", "one-at-a-time"] },
	theme: { type: "string" },
	compaction: { type: "object" },
	branchSummary: { type: "object" },
	retry: { type: "object" },
	hideThinkingBlock: { type: "boolean" },
	showCacheMissNotices: { type: "boolean" },
	externalEditor: { type: "string" },
	shellPath: { type: "string" },
	quietStartup: { type: ["boolean", "string"] },
	defaultProjectTrust: { enum: ["ask", "always", "never"] },
	shellCommandPrefix: { type: "string" },
	npmCommand: arr({ type: "string" }),
	selfUpdateCommand: arr({ type: "string" }),
	collapseChangelog: { type: "boolean" },
	enableInstallTelemetry: { type: "boolean" },
	enableAnalytics: { type: "boolean" },
	trackingId: { type: "string" },
	packages: arr({ type: "string" }),
	extensions: arr({ type: "string" }),
	deviceId: { type: "string" },
	skills: { type: ["array", "object"] },
	prompts: arr({ type: "string" }),
	themes: arr({ type: "string" }),
	enableSkillCommands: { type: "boolean" },
	terminal: { type: "object" },
	images: { type: "object" },
	enabledModels: arr({ type: "string" }),
	defaultTools: arr({ type: "string" }),
	doubleEscapeAction: { enum: ["fork", "tree", "none"] },
	treeFilterMode: { enum: ["default", "no-tools", "user-only", "labeled-only", "all"] },
	thinkingBudgets: { type: "object" },
	editorPaddingX: { type: "number" },
	outputPad: { type: "number" },
	autocompleteMaxVisible: { type: "number" },
	showHardwareCursor: { type: "boolean" },
	markdown: { type: "object" },
	warnings: { type: "object" },
	codemode: { type: "object" },
	sessionDir: { type: "string" },
	httpProxy: { type: "string" },
	httpIdleTimeoutMs: { type: ["number", "string"] },
	cacheWarming: { enum: ["off", "streaming", "idle"] },
	websocketConnectTimeoutMs: { type: ["number", "string"] },
	tuiMode: { enum: ["regular", "fullscreen"] },
	fullscreenExitOutput: { enum: ["transcript", "resume-hint"] },
	fullscreenScrollbar: { enum: ["auto", "always", "hidden"] },
	fullscreenCopyOnSelect: { type: "boolean" },
	fullscreenWheelScrollLines: { type: ["number", "string"] },
	queueMode: { enum: ["all", "one-at-a-time"] },
	websockets: { type: "boolean" },
};

/**
 * Settings blocks owned by an extension rather than by pi. Each one is a shape
 * pi itself would ignore, typed here because a typo inside it is exactly the
 * silent fallback this check exists for.
 */
const SETTINGS_EXTENSION_KEYS = {
	"observational-memory": obj({
		compactAtContextTokens: { type: "number" },
		tailTokens: { type: "number" },
		maxTailTokens: { type: "number" },
		debugLog: { type: "boolean" },
		models: mapOf(MODEL_ROUTE),
	}),
};

export const settingsSchema = obj({ ...SETTINGS_PI_KEYS, ...SETTINGS_EXTENSION_KEYS });

export const modelsSchema = obj(
	{
		$schema: { type: "string" },
		providers: mapOf(PROVIDER),
	},
	["providers"],
);

/**
 * keys.json: provider name → key. Shape and presence only — the validator
 * reports the path and the expected type and never the value, so this file can
 * be checked without its contents reaching a line of output.
 */
export const keysSchema = mapOf({ type: "string", minLength: 1 });

export const SCHEMAS = {
	settings: { label: "agent/settings.json", schema: settingsSchema, required: true },
	models: { label: "agent/models.json", schema: modelsSchema, required: true },
	keys: { label: "agent/keys.json", schema: keysSchema, required: false, secret: true },
};

// ------------------------------------------------------------------ validate --

/** A schema type name for a value, used in messages ("found object"). */
export function typeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

/** Damerau–Levenshtein distance, capped: only "one edit away" matters here. */
export function editDistance(a, b, cap = 2) {
	if (Math.abs(a.length - b.length) > cap) return cap + 1;
	const rows = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
			// A swapped pair is one edit, not two: `modle` is a typo for `model`.
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
			}
		}
	}
	return rows[a.length][b.length];
}

/** The known key one edit away from `key`, if there is exactly one. */
export function didYouMean(key, candidates) {
	const hits = [...candidates].filter((candidate) => editDistance(key, candidate, 1) <= 1);
	return hits.length === 1 ? hits[0] : null;
}

function expectedText(schema) {
	if (schema.enum) return `one of: ${schema.enum.join(", ")}`;
	const type = schema.type;
	return Array.isArray(type) ? type.join(" or ") : String(type ?? "value");
}

function push(out, path, message, suggestion) {
	out.push({ path, message, suggestion: suggestion ?? null });
}

/**
 * Walk one parsed document against its schema. Returns issues in document
 * order; nothing here reads a file or a clock, so a test can call it directly.
 */
export function validateValue(value, schema, basePath = "", out = []) {
	const found = typeOf(value);
	const allowed = schema.type === undefined ? null : [].concat(schema.type);
	const matches =
		allowed === null ||
		allowed.some((type) => (type === "number" ? found === "number" || found === "integer" : type === found));
	if (!matches) {
		push(out, basePath, `expected ${expectedText(schema)}, found ${found}`);
		return out;
	}

	if (schema.enum && !schema.enum.includes(value)) {
		push(out, basePath, `expected ${expectedText(schema)}, found another value`);
	}

	if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
		push(out, basePath, `expected ${schema.minLength} or more characters, found ${value.length}`);
	}

	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			push(out, basePath, `expected at least ${schema.minItems} item(s), found ${value.length}`);
		}
		if (schema.items) {
			value.forEach((item, index) => validateValue(item, schema.items, `${basePath}[${index}]`, out));
		}
		return out;
	}

	if (found === "object") {
		const properties = schema.properties ?? {};
		const known = Object.keys(properties);
		for (const key of known) {
			if (value[key] === undefined) continue;
			validateValue(value[key], properties[key], basePath ? `${basePath}.${key}` : key, out);
		}
		for (const key of schema.required ?? []) {
			if (value[key] === undefined) {
				const path = basePath ? `${basePath}.${key}` : key;
				push(out, path, `missing required key: expected ${expectedText(properties[key] ?? {})}`);
			}
		}
		const extra = schema.additionalProperties;
		for (const [key, child] of Object.entries(value)) {
			const path = basePath ? `${basePath}.${key}` : key;
			if (Object.hasOwn(properties, key)) continue;
			if (extra === false) {
				const where = basePath ? "unknown key" : "unknown top-level key";
				const hint = didYouMean(key, known);
				push(
					out,
					path,
					hint
						? `${where}; did you mean "${hint}"?`
						: `${where}: expected one of ${known.length} known key(s) here`,
				);
			} else if (extra && typeof extra === "object") {
				validateValue(child, extra, path, out);
			}
		}
	}
	return out;
}

/** One line: the file, the path inside it, and what was expected. */
export function formatIssue(label, issue) {
	return `${label}: ${issue.path || "(root)"} — ${issue.message}`;
}

/** Read one file and validate it. Returns `{ issues, absent }`. */
export function validateFile(name, filePath) {
	const entry = SCHEMAS[name];
	const issues = [];
	let raw;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return { issues, absent: true };
		return { issues: [{ path: "(file)", message: `cannot be read: ${error.code ?? error.message}`, suggestion: null }], absent: false };
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { issues: [{ path: "(file)", message: `is not valid JSON: ${error.message}`, suggestion: null }], absent: false };
	}
	validateValue(parsed, entry.schema, "", issues);
	return { issues, absent: false };
}

/**
 * Validate every config file in `dir`, in a fixed order, and return the lines
 * both callers print: `{ status: "PASS" | "FAIL", where, message }`.
 * `requireSecrets: false` keeps a missing keys.json out of the way — it is an
 * optional file, and its absence is not a shape error.
 */
export function checkConfigDir(dir, options = {}) {
	const lines = [];
	for (const [name, entry] of Object.entries(SCHEMAS)) {
		const { issues, absent } = validateFile(name, join(dir, entry.label.split("/").pop()));
		if (absent) {
			lines.push({
				status: "PASS",
				where: entry.label,
				message: entry.required ? "absent — expected a config file here" : "absent — nothing to validate",
			});
			continue;
		}
		if (issues.length === 0) {
			lines.push({ status: "PASS", where: entry.label, message: "shape ok" });
			continue;
		}
		for (const issue of issues) {
			lines.push({
				status: "FAIL",
				where: `${entry.label}: ${issue.path || "(root)"}`,
				message: issue.message,
			});
		}
	}
	return lines;
}

// ----------------------------------------------------------------------- cli --

function cli(argv) {
	let root = process.cwd();
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--root") root = argv[++i] ?? root;
		else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write("usage: node agent/config/schema.mjs [--root DIR] [--json]\n");
			return 0;
		}
	}
	const lines = checkConfigDir(join(resolve(root), "agent"));
	const failed = lines.filter((line) => line.status === "FAIL").length;
	if (json) {
		process.stdout.write(`${JSON.stringify({ pass: lines.length - failed, fail: failed, results: lines }, null, 1)}\n`);
	} else {
		for (const line of lines) process.stdout.write(`${line.status}\t${line.where}\t${line.message}\n`);
	}
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = cli(process.argv.slice(2));
}
