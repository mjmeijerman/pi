// ============================================================================
// install-lib.mjs — the pure half of the installer.
//
// install.mjs (the engine) and setup.mjs (the interactive pass) both import this
// file, and `node --test scripts/tests/install-lib.test.mjs` tests it without a
// filesystem, a network or a host: every function here is input -> output.
//
// Two things live here on purpose:
//   1. the per-OS plan, as ONE table. A cross-platform installer fails when the
//      `if (win32)` branches spread through the code, so the differences between
//      Linux, macOS and Windows are data (OS_PLAN) and the engine reads a plan.
//   2. the AGENTS.md rule parser, because "keep 12 of 17 rules" has to reproduce
//      the other 12 byte for byte, and that is a property, not a habit.
//
// Radar basis (Vol. 35): #1 agent sandboxing (Adopt) — the wrapper survives the
// port; #68 mise, Adopt — mise.toml stays the one place the node major is written;
// #99 Safe Chain — the npm quarantine is set by the installer, not remembered.
// ============================================================================

import crypto from 'node:crypto';
import path from 'node:path';

// The two vendor installers, named once so a moving URL is one edit.
export const HERDR_INSTALL_SH = 'https://releases.herdr.dev/app/install.sh';
export const HERDR_INSTALL_PS1 = 'https://releases.herdr.dev/app/install.ps1';
export const MISE_INSTALL_SH = 'https://mise.run';
export const HERDR_INSTALLED_POSIX = path.join('.local', 'share', 'herdr-app', 'herdr-app');
export const HERDR_INSTALLED_WIN = { dir: 'herdr-app', file: 'herdr-app.exe' };

// --- the one per-OS table ---------------------------------------------------
// linkMode     how a bin entry is created: 'symlink' or 'copy' (Windows needs
//              elevation or Developer Mode for a symlink, so it copies).
// service      which init system the guard/units target.
// herdrInstall how the vendor installer is invoked.
// sandbox      bubblewrap exists only on Linux; the other two say so in one line.
export const OS_PLAN = {
	linux: {
		platform: 'linux',
		binSubdir: path.join('.local', 'bin'),
		linkMode: 'symlink',
		service: 'systemd',
		serviceDir: path.join('.config', 'systemd', 'user'),
		herdrConfigSubdir: path.join('.config', 'herdr-app'),
		herdrInstall: 'sh',
		herdrInstalled: HERDR_INSTALLED_POSIX,
		rcFiles: ['.bashrc', '.zshrc'],
		sandbox: true,
		services: true,
	},
	darwin: {
		platform: 'darwin',
		binSubdir: path.join('.local', 'bin'),
		linkMode: 'symlink',
		service: 'launchd',
		serviceDir: path.join('Library', 'LaunchAgents'),
		herdrConfigSubdir: path.join('.config', 'herdr-app'),
		herdrInstall: 'sh',
		herdrInstalled: HERDR_INSTALLED_POSIX,
		rcFiles: ['.zshrc', '.bashrc'],
		sandbox: false,
		services: true,
	},
	win32: {
		platform: 'win32',
		binSubdir: path.join('.local', 'bin'),
		linkMode: 'copy',
		service: 'schtasks',
		serviceDir: null,
		herdrConfigSubdir: path.join('.config', 'herdr-app'),
		herdrInstall: 'powershell',
		herdrInstalled: null,
		rcFiles: [],
		sandbox: false,
		services: true,
	},
};

/** planFor — the OS plan, defaulting to the platform the process runs on. */
export function planFor(platform = process.platform, env = process.env) {
	const plan = OS_PLAN[platform] || OS_PLAN.linux;
	if (plan.platform === 'win32') {
		const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || '', 'AppData', 'Local');
		return { ...plan, herdrInstalled: path.join(local, HERDR_INSTALLED_WIN.dir, HERDR_INSTALLED_WIN.file) };
	}
	return { ...plan };
}

/**
 * homePaths — every absolute path the installer writes, derived from $HOME (and
 * PI_AGENT_DIR, which is how a throwaway HOME is pointed at a temp directory).
 */
export function homePaths({ home, agentDir, plan }) {
	const piHome = dirname(agentDir);
	const herdrInstalled = plan.herdrInstalled;
	return {
		home,
		piHome,
		agentDir,
		binDir: path.join(home, plan.binSubdir),
		gitHooksDir: path.join(piHome, 'git-hooks'),
		gitTemplatesDir: path.join(home, '.git-templates'),
		gitignoreGlobal: path.join(piHome, 'gitignore_global'),
		herdrConfigDir: path.join(home, plan.herdrConfigSubdir),
		serviceDir: plan.serviceDir ? path.join(home, plan.serviceDir) : null,
		stateFile: path.join(piHome, 'state', 'setup.json'),
		herdrInstalled,
	};
}

function dirname(p) {
	return path.dirname(p);
}

// --- AGENTS.md rules --------------------------------------------------------

/** ruleSlug — a stable id for a rule: its first six words, lowercased. */
export function ruleSlug(text) {
	const words = String(text)
		.toLowerCase()
		.replace(/[`*_()[\]{}#]/g, ' ')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6);
	return words
		.join('-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

/**
 * parseAgentsMd — turns the rule file into items (headings, rules, text) plus a
 * flat rule list. A rule owns the indented continuation lines that follow it, so
 * a dropped rule takes its whole paragraph with it.
 */
export function parseAgentsMd(text) {
	const lines = String(text).split('\n');
	const items = [];
	const rules = [];
	let section = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^#{1,6}\s/.test(line)) {
			section = line.replace(/^#+\s*/, '').trim();
			items.push({ kind: 'heading', line });
			continue;
		}
		if (/^\s*[-*]\s+\S/.test(line) && !/^\s+/.test(line)) {
			const body = [line];
			let j = i + 1;
			while (j < lines.length && /^[ \t]+\S/.test(lines[j])) {
				body.push(lines[j]);
				j++;
			}
			const rule = {
				index: rules.length + 1,
				section,
				text: line.replace(/^\s*[-*]\s+/, ''),
				lines: body,
			};
			rule.slug = ruleSlug(rule.text);
			rules.push(rule);
			items.push({ kind: 'rule', rule });
			i = j - 1;
			continue;
		}
		items.push({ kind: 'text', line });
	}
	return { items, rules };
}

/** ruleIds — index -> slug, the map the state file records answers against. */
export function ruleIds(parsed) {
	return parsed.rules.map((r) => ({ index: r.index, slug: r.slug, section: r.section, text: r.text }));
}

/**
 * filterAgentsMd — keep the rules `keep(rule)` says yes to and reproduce every
 * other byte. Keeping all rules returns the input verbatim, which is the
 * property that makes an unfiltered install a no-op.
 * A `##` section whose rules are all dropped loses its heading too: a heading is
 * an instruction, and an empty one is a rule nobody can follow.
 */
export function filterAgentsMd(text, keep) {
	const source = String(text);
	if (typeof keep !== 'function') {
		const set = new Set(keep || []);
		keep = (rule) => set.has(rule.index) || set.has(rule.slug);
	}
	const { items } = parseAgentsMd(source);
	const kept = [];
	for (const item of items) {
		if (item.kind === 'rule') {
			if (keep(item.rule)) kept.push(item);
			continue;
		}
		if (item.kind === 'heading' && item.line.startsWith('## ')) {
			kept.push({ ...item, pending: true });
			continue;
		}
		kept.push(item);
	}
	const out = [];
	for (let i = 0; i < kept.length; i++) {
		const item = kept[i];
		if (item.kind === 'heading' && item.pending) {
			let hasRule = false;
			for (let j = i + 1; j < kept.length; j++) {
				if (kept[j].kind === 'heading') break;
				if (kept[j].kind === 'rule') {
					hasRule = true;
					break;
				}
			}
			if (!hasRule) {
				// Drop the heading and the blank lines it left behind.
				while (i + 1 < kept.length && kept[i + 1].kind === 'text' && kept[i + 1].line.trim() === '') i++;
				continue;
			}
		}
		if (item.kind === 'rule') out.push(...item.rule.lines);
		else out.push(item.line);
	}
	// One blank line between blocks, one newline at the end.
	const squeezed = [];
	for (const line of out) {
		if (line.trim() === '' && (squeezed.length === 0 || squeezed[squeezed.length - 1].trim() === '')) continue;
		squeezed.push(line);
	}
	while (squeezed.length && squeezed[squeezed.length - 1].trim() === '') squeezed.pop();
	return `${squeezed.join('\n')}\n`;
}

/** ruleAnswer — the recorded answer for a rule, or undefined when never asked. */
export function ruleAnswer(state, slug) {
	const rules = (state && state.rules) || {};
	return Object.prototype.hasOwnProperty.call(rules, slug) ? rules[slug] : undefined;
}

// --- managed blocks (the pi wrapper) ---------------------------------------

/**
 * spliceManagedBlock — replace the marked block in a shell rc file, keeping
 * everything outside it and appending when it is not there yet. Re-running it
 * with the same block is a no-op, which is what makes install idempotent.
 */
export function spliceManagedBlock(text, begin, end, block) {
	const lines = String(text).split('\n');
	const out = [];
	let inside = false;
	for (const line of lines) {
		if (line === begin) {
			inside = true;
			continue;
		}
		if (line === end) {
			inside = false;
			continue;
		}
		if (!inside) out.push(line);
	}
	while (out.length && out[out.length - 1].trim() === '') out.pop();
	const tail = block.endsWith('\n') ? block.slice(0, -1).split('\n') : block.split('\n');
	out.push(...tail);
	return `${out.join('\n')}\n`;
}

// The sandbox is the default for `pi` on purpose: a wrapper you have to remember
// to type is willpower, not a default (blip 1, Adopt). PI_BARE=1 is the escape
// hatch, and a missing sandbox falls back to the plain binary — a broken sandbox
// must never make pi unusable.
export const PI_WRAPPER_BEGIN = '# >>> pi sandbox >>>';
export const PI_WRAPPER_END = '# <<< pi sandbox <<<';

export const PI_WRAPPER_BLOCK = `# >>> pi sandbox >>>
# Managed by ~/.pi/install.mjs — edit there, not here; re-run it to refresh.
# Radar blip 1 (Adopt, agent sandboxing): plain \`pi\` is sandboxed, so safety
# does not depend on remembering a prefix. Bypass one session: PI_BARE=1 pi
pi() {
	local _pi_bin="\${PI_BIN:-$HOME/.local/share/pnpm/bin/pi}"
	[ -x "$_pi_bin" ] || _pi_bin="$HOME/.local/bin/pi"
	if [ ! -x "$_pi_bin" ]; then
		printf 'pi: binary not found (set PI_BIN=/path/to/pi)\\n' >&2
		return 127
	fi
	# A bash login shell carries no PNPM_HOME, and pisandbox refuses to start
	# when it cannot find pi on PATH: put the shim's directory on PATH first.
	case ":$PATH:" in
	*":\${_pi_bin%/*}:"*) ;;
	*) PATH="\${_pi_bin%/*}:$PATH" ;;
	esac
	export PATH
	if [ "\${PI_BARE:-}" = 1 ]; then
		"$_pi_bin" "$@"
		return
	fi
	if [ ! -x "$HOME/.pi/scripts/pisandbox" ] || ! command -v bwrap >/dev/null 2>&1; then
		printf 'pi: sandbox unavailable (pisandbox or bwrap missing) — running unsandboxed\\n' >&2
		"$_pi_bin" "$@"
		return
	fi
	"$HOME/.pi/scripts/pisandbox" -- pi "$@"
}
# <<< pi sandbox <<<`;

// --- files, names, hashes ---------------------------------------------------

/** sha256 — content hash used for "second run changes nothing" assertions. */
export function sha256(text) {
	return crypto.createHash('sha256').update(text).digest('hex');
}

/** skillNames — the skill directories in agent/skills, sorted. */
export function skillNames(dir, readdir) {
	return readdir(dir)
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

/** extensionNames — the *.ts files in agent/extensions, sorted, without the suffix. */
export function extensionNames(dir, readdir) {
	return readdir(dir)
		.filter((d) => d.isFile() && d.name.endsWith('.ts'))
		.map((d) => d.name.replace(/\.ts$/, ''))
		.sort();
}

/** pickNames — "all" when nothing is given, the named subset otherwise. */
export function pickNames(all, wanted) {
	if (!wanted || wanted.length === 0) return [...all];
	const keep = new Set(wanted.map((w) => String(w).trim()).filter(Boolean));
	return all.filter((n) => keep.has(n));
}

/**
 * parseRuleSelection — `all`, `none`, `keep:1,4,7` or `drop:2,3` into an answer
 * map keyed by index. Used by --rules= in CI, where nothing can be typed.
 */
export function parseRuleSelection(spec, ruleCount) {
	const answers = new Map();
	if (spec === undefined || spec === null || spec === '' || spec === 'all') return answers;
	const all = Array.from({ length: ruleCount }, (_, i) => i + 1);
	if (spec === 'none') {
		for (const i of all) answers.set(i, false);
		return answers;
	}
	const m = /^(keep|drop):(.*)$/.exec(String(spec).trim());
	if (!m) throw new Error(`--rules wants all, none, keep:1,2 or drop:1,2 — got ${spec}`);
	const picked = m[2]
		.split(/[,\s]+/)
		.map((s) => Number.parseInt(s, 10))
		.filter((n) => Number.isInteger(n) && n >= 1);
	for (const i of all) {
		if (m[1] === 'keep') answers.set(i, picked.includes(i));
		else answers.set(i, !picked.includes(i));
	}
	return answers;
}

/**
 * samePath — do two strings name the same path on this platform?
 * Needed because `git config` echoes back what a shell gave it: on Windows the
 * value set from bash is `/c/Users/me/.pi/git-hooks` and the one node computes is
 * `C:\\Users\\me\\.pi\\git-hooks`. Same directory, different spelling.
 */
export function samePath(a, b, platform = process.platform) {
	if (!a || !b) return false;
	const msys = (p) => {
		const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
		return m ? `${m[1]}:\\${m[2]}` : p;
	};
	const norm = (p) => {
		let out = msys(String(p).trim()).replace(/\\/g, '/').replace(/\/+$/, '');
		if (platform === 'win32') out = out.toLowerCase();
		return out;
	};
	return norm(a) === norm(b);
}

// --- the node pin (mise.toml) ------------------------------------------------
/**
 * pinnedNodeMajor — the node major mise.toml pins, read with a regex rather than
 * a TOML parser: four lines do not need a dependency (blip 68, mise, Adopt).
 * A missing, unreadable or silent file falls back to 24, which is what setup
 * printed before the pin existed.
 */
export function pinnedNodeMajor(root, readFileSync) {
	try {
		const raw = readFileSync(path.join(root, 'mise.toml'), 'utf8');
		const m = /^\s*node\s*=\s*["']?([0-9][0-9.]*)/m.exec(raw);
		return m ? Number.parseInt(m[1], 10) : 24;
	} catch {
		return 24;
	}
}

/**
 * nodePreflight — the one place the node version message is written.
 * `nodeVersion` is what the shell prints (v22.1.0), `nodeMajor` the parsed major
 * and `pin` mise.toml's. Returns { level: 'ok' | 'warn' | 'die', message }.
 */
export function nodePreflight({ pin, nodeVersion, nodeMajor }) {
	if (nodeVersion === undefined || nodeMajor === undefined || nodeMajor === null) {
		return { level: 'die', message: `node is not installed (pi needs Node ${pin} or newer)` };
	}
	if (nodeMajor < pin) {
		return { level: 'warn', message: `node ${nodeVersion} is older than ${pin}; pi 1.5.x expects ${pin} or 26` };
	}
	return { level: 'ok', message: `node ${nodeVersion}, mise.toml pins ${pin}` };
}

/** shellQuote — a command line the summary can print for any OS. */
export function shellQuote(arg) {
	return /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** describeSkip — one line when a section does not apply to this OS. */
export function describeSkip(plan, what) {
	return `== ${what}: not available on ${plan.platform} — skipped`;
}
