/**
 * Secret Guard — always-on protection for secrets.
 *
 * Radar basis: #20 stateful guardrails, #22 toxic flow analysis for AI,
 * #1 agent sandboxing (Adopt).
 *
 * Layers:
 *  1. input       — redacts secret values from user input before they reach the model
 *  2. tool_call   — blocks reading secret files, commands carrying secret values,
 *                   and writing secret values into files
 *  3. tool_result — redacts secret values from tool output before the model sees it
 *  4. before_agent_start — always-on guard rules injected into the system prompt
 *
 * Escape hatches (explicit user intent only):
 *  - /secretguard allow|block   (session-scoped, reset on session start)
 *  - env SECRET_GUARD_PASSTHROUGH=1
 *
 * Audit log: <agent-dir>/secret-guard.log  (counts and pattern names only — never values)
 */
import { appendFile } from "node:fs/promises";
import {
	type ExtensionAPI,
	getAgentDir,
	isBashToolResult,
	isToolCallEventType,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const LOG_FILE = `${getAgentDir()}/secret-guard.log`;

// ---------------------------------------------------------------------------
// High-confidence secret patterns. Detection = block; redaction = replace value.
// ---------------------------------------------------------------------------
const PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "private-key", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
	{ name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ name: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: "stripe-key", re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g },
	{ name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	{ name: "db-uri", re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/gi },
	{ name: "secret-assignment", re: /(?:password|passwd|pwd|secret|api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token|aws[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key)|db[_-]?password)\s*[=:]\s*["'][^"'\n]{6,}["']/gi },
	{ name: "secret-assignment", re: /(?:password|secret|api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token|aws[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key)|db[_-]?password)\s*[=:]\s*[A-Za-z0-9_\-./+]{16,}\b/gi },
];

const SECRET_FILE_RE =
	/(^|[\/\\'"\s])(\.env(\.[a-zA-Z0-9_-]+)?|\.git-credentials|\.netrc|\.pypirc|\.npmrc|id_rsa|id_ed25519|id_dsa|id_ecdsa|credentials\.(json|ya?ml|toml)|secrets\.(json|ya?ml|toml)|kubeconfig|auth\.json)([\/\\'"\s]|$)|(^|[\/\\'"\s])[^\/\\'"\s]*\.(pem|p12|pfx|jks|keystore|key)([\/\\'"\s]|$)|(^|[\/\\'"\s])(\.aws|\.ssh|\.gnupg|\.kube)([\/\\]|$)|\.config[\/\\]gcloud/gi;

const SAFE_RE = /example|sample|template|fixture|mock|dummy|placeholder|changeme/i;

/** Assignment values that point at the environment instead of embedding a secret. */
const ENV_REF_RE = /^(?:process\.env|os\.environ|import\.meta\.env|Deno\.env|env\.|getenv\()/;

/** Tools that print or transfer file content (i.e. that would leak content to the model or network). */
const READER_RE =
	/(^|[;&|()\s])(cat|bat|sed|head|tail|base64|xxd|od|strings|diff|expand|awk|grep|rg|scp|rsync|curl|wget)\b|git\s+(show|cat-file|checkout|diff|restore)\b/i;

let passthrough = process.env.SECRET_GUARD_PASSTHROUGH === "1";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hasMatch(re: RegExp, s: string): boolean {
	re.lastIndex = 0;
	const m = re.exec(s);
	re.lastIndex = 0;
	return !!m;
}

function redactText(input: string): { text: string; count: number } {
	let text = input;
	let count = 0;
	for (const p of PATTERNS) {
		text = text.replace(p.re, (m) => {
			if (hasMatch(SAFE_RE, m)) return m;
			count++;
			return `[REDACTED:${p.name}]`;
		});
	}
	return { text, count };
}

function isSecretPath(path: string): boolean {
	return hasMatch(SECRET_FILE_RE, path) && !hasMatch(SAFE_RE, path);
}

/** Shell-ish word split, tracking which words were quoted. */
function shellWords(command: string): { text: string; quoted: boolean }[] {
	const words: { text: string; quoted: boolean }[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		if (m[0] === "") {
			re.lastIndex += 1;
			continue;
		}
		const text = m[1] ?? m[2] ?? m[3] ?? "";
		words.push({ text, quoted: m[1] !== undefined || m[2] !== undefined });
	}
	return words;
}

/**
 * True when the command hands a secret file to a reader or transfer tool.
 *
 * A secret path only counts as an argument. Mentioning a name inside quoted
 * code (a grep of a script, an inline `node -e`) must not trip the guard, while
 * `cat .env` or `cat "$HOME/.ssh/id_rsa"` still must.
 */
function leaksSecretFile(command: string): boolean {
	if (!hasMatch(READER_RE, command)) return false;
	for (const word of shellWords(command)) {
		if (!hasMatch(SECRET_FILE_RE, word.text)) continue;
		if (hasMatch(SAFE_RE, word.text)) continue;
		if (!word.quoted) return true;
		// Quoted: only a path-shaped token is an argument, a bare name is prose.
		if (/[\/~]|^\.|^\$/.test(word.text)) return true;
	}
	return false;
}

/**
 * The candidate value of an assignment match: the text after `=` / `:`, unquoted.
 * Keeps a placeholder key name (`mock_api_key`) from whitelisting a real value.
 */
function assignmentValue(match: string): string {
	const m = /^\s*[^=:]*[=:]\s*["']?([\s\S]*?)["']?\s*$/.exec(match);
	return m?.[1] ?? match;
}

function findSecretValue(input: string, patterns = PATTERNS): string | null {
	for (const p of patterns) {
		p.re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = p.re.exec(input)) !== null) {
			if (m[0] === "") {
				p.re.lastIndex += 1;
				continue;
			}
			// Judge the match itself, never the surrounding text: a key sent to
			// evil.test must not pass because the command mentions "example", and a
			// placeholder *value* keeps its assignment writable.
			const candidate = p.name === "secret-assignment" ? assignmentValue(m[0]) : m[0];
			if (!hasMatch(SAFE_RE, candidate) && !hasMatch(ENV_REF_RE, candidate)) {
				p.re.lastIndex = 0;
				return p.name;
			}
		}
		p.re.lastIndex = 0;
	}
	return null;
}

async function log(line: string) {
	try {
		await withFileMutationQueue(LOG_FILE, async () => {
			await appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
		});
	} catch {
		/* logging must never break anything */
	}
}

const GUARD_RULES = `# Secret Guard (always active)

- Never read, print, transmit, or echo secret values or secret files (.env*, *.pem/*.key, credentials/secrets files, auth.json, ~/.aws, ~/.ssh, ~/.gnupg, ~/.kube, .npmrc, .netrc). The extension blocks most of this mechanically; do not try to bypass blocks.
- Never hardcode secrets in code or configs. Use environment variables, .env with a committed .env.example, or a secret manager.
- Never put secrets in git: not in files, diffs, or commit messages. If a secret was ever committed or shared, tell the user to rotate it immediately.
- If the user pastes a secret, warn and advise rotation; never repeat it. Only use it with explicit user intent after warning (/secretguard allow).
- Never send secrets over the network (curl, scp, rsync, etc.) or into URLs, logs, or pastebins.`;

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------
export default function secretGuard(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		passthrough = false;
	});

	// 1) Redact secrets from user input before the model sees it.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || passthrough) return { action: "continue" };
		const { text, count } = redactText(event.text);
		if (count > 0) {
			await log(`input: redacted ${count} secret(s)`);
			ctx.ui.notify(
				`secret-guard: redacted ${count} secret(s) from your input — they never reached the model. Use /secretguard allow if you intentionally need a secret processed (not recommended).`,
				"warning",
			);
			return { action: "transform", text };
		}
		return { action: "continue" };
	});

	// 2) Block dangerous tool calls.
	pi.on("tool_call", async (event, ctx) => {
		if (passthrough) return;

		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command;

			// a) command carries a secret value
			const value = findSecretValue(cmd);
			if (value) {
				await log(`tool_call bash: blocked command containing ${value}`);
				ctx.ui.notify(`secret-guard: blocked a command containing a ${value}`, "warning");
				return { block: true, reason: `secret-guard: blocked — command contains a likely ${value}. Use /secretguard allow if intentional.` };
			}

			// b) command reads/transfers a secret file
			if (leaksSecretFile(cmd)) {
				await log("tool_call bash: blocked read of secret file");
				ctx.ui.notify("secret-guard: blocked a command reading a secret file", "warning");
				return { block: true, reason: "secret-guard: blocked — command reads a secret file (.env, key, credentials, …). Use /secretguard allow if intentional." };
			}
		}

		if (isToolCallEventType("read", event)) {
			if (isSecretPath(event.input.path)) {
				await log(`tool_call read: blocked secret file ${event.input.path}`);
				ctx.ui.notify(`secret-guard: blocked reading secret file "${event.input.path}"`, "warning");
				return { block: true, reason: `secret-guard: blocked reading "${event.input.path}" — secret files must not reach the model. Use /secretguard allow if intentional.` };
			}
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			if (isSecretPath(event.input.path)) {
				await log(`tool_call ${event.toolName}: blocked write to secret file ${event.input.path}`);
				return { block: true, reason: `secret-guard: blocked writing to "${event.input.path}" — secret files stay out of the working tree. Use /secretguard allow if intentional.` };
			}
			const texts: string[] = [];
			if (isToolCallEventType("write", event)) texts.push(event.input.content ?? "");
			else if (isToolCallEventType("edit", event)) for (const e of event.input.edits ?? []) texts.push(e.oldText ?? "", e.newText ?? "");
			const value = texts.map((t) => findSecretValue(t)).find((v) => v !== null);
			if (value) {
				await log(`tool_call ${event.toolName}: blocked writing ${value} into file`);
				return { block: true, reason: `secret-guard: blocked — the file content contains a likely ${value}. Use env vars or placeholders instead. Use /secretguard allow if intentional.` };
			}
		}
	});

	// 3) Redact secrets from tool output before the model sees it.
	pi.on("tool_result", async (event) => {
		if (passthrough) return;
		let changed = false;
		let content = event.content;
		if (Array.isArray(content)) {
			content = content.map((part) => {
				if (part && part.type === "text") {
					const r = redactText(part.text);
					if (r.count > 0) {
						changed = true;
						return { ...part, text: r.text };
					}
				}
				return part;
			});
		}
		let details = event.details;
		if (isBashToolResult(event) && details) {
			const d = details as { stdout?: string; stderr?: string } & object;
			let stdout = d.stdout;
			let stderr = d.stderr;
			if (typeof stdout === "string") {
				const r = redactText(stdout);
				if (r.count > 0) {
					stdout = r.text;
					changed = true;
				}
			}
			if (typeof stderr === "string") {
				const r = redactText(stderr);
				if (r.count > 0) {
					stderr = r.text;
					changed = true;
				}
			}
			if (changed) details = { ...d, stdout, stderr };
		}
		if (changed) {
			await log(`tool_result ${event.toolName}: redacted output`);
			return { content, details };
		}
	});

	// 4) Always-on guard rules in the system prompt.
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${GUARD_RULES}`,
	}));

	// User runs bash directly (! command).
	pi.on("user_bash", async (event, ctx) => {
		if (passthrough) return;
		if (leaksSecretFile(event.command)) {
			await log("user_bash: blocked read of secret file");
			ctx.ui.notify("secret-guard: blocked your command — it reads a secret file", "warning");
			return { result: { output: "secret-guard: blocked — command reads a secret file.", exitCode: 1, cancelled: true, truncated: false } };
		}
	});

	// Control command.
	pi.registerCommand("secretguard", {
		description: "Secret guard: status | allow | block",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase();
			if (a === "allow") {
				passthrough = true;
				await log("command: passthrough ON");
				ctx.ui.notify("secret-guard: passthrough ON — secrets will be processed this session. Turn off with /secretguard block.", "warning");
			} else if (a === "block") {
				passthrough = false;
				await log("command: passthrough OFF");
				ctx.ui.notify("secret-guard: passthrough OFF — protection active.", "info");
			} else {
				ctx.ui.notify(`secret-guard: protection ${passthrough ? "OFF (passthrough)" : "ACTIVE"}`, passthrough ? "warning" : "info");
			}
		},
	});
}
