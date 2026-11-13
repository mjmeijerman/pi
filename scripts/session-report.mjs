#!/usr/bin/env node
/**
 * session-report — per-project token, cost and disk report for pi sessions.
 *
 * Reads the JSONL session store (~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl),
 * aggregates usage per project directory, and reports the most expensive
 * sessions plus stale sessions that can be reclaimed.
 *
 * No external dependencies. Node >= 20 (uses only core modules).
 *
 * Usage:
 *   node session-report.mjs [--since 30d] [--top 10] [--json]
 *
 * Flags:
 *   --since <dur|date>  Staleness window. Accepts 30d, 12h, 2w, 6mo, 1y or an
 *                       ISO date (2026-01-01). Default: 30d. Sessions whose
 *                       last activity is older than this are "stale".
 *   --top <n>           How many entries in the "most expensive" list. Default 10.
 *   --json              Machine-readable output (single JSON document on stdout).
 *   --sessions <dir>    Override the session store directory.
 *   --models <file>     Override the models.json pricing file.
 *   --help              Show this help.
 *
 * Cost model (mirrors extensions/usage-footer.ts):
 *   - deepseek*  : always recomputed from timestamped peak/off-peak rates,
 *                  because recorded `usage.cost` in older sessions is stale.
 *   - other ids  : trust provider-recorded `usage.cost`, else compute from the
 *                  static rates in models.json. Unpriced models cost $0.
 *
 * Counting rule: assistant `message` entries and `compaction` entries carry
 * usage; `toolResult` entries in this store carry none (verified on real data).
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
const DEFAULT_SESSIONS = process.env.PI_SESSIONS_DIR || join(AGENT_DIR, "sessions");
const DEFAULT_MODELS = process.env.PI_MODELS_PATH || join(AGENT_DIR, "models.json");

// ---------------------------------------------------------------- pricing ----

/** DeepSeek flash rates, USD per 1M tokens. Peak hours 01–04 and 06–10 UTC. */
const DEEPSEEK_OFFPEAK = { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 };
const DEEPSEEK_PEAK = { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 };

function isPeakHour(timestampMs) {
  const h = new Date(timestampMs).getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Multiply a usage record by per-million rates. Never mutates its input. */
function multiply(usage, rates) {
  const input = ((usage.input || 0) / 1e6) * rates.input;
  const output = ((usage.output || 0) / 1e6) * rates.output;
  const cacheRead = ((usage.cacheRead || 0) / 1e6) * rates.cacheRead;
  const cacheWrite = ((usage.cacheWrite || 0) / 1e6) * rates.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function loadModels(path) {
  const byId = new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    for (const provider of Object.values(raw.providers || {})) {
      for (const m of provider.models || []) {
        if (!m || typeof m.id !== "string") continue;
        byId.set(m.id.toLowerCase(), {
          id: m.id,
          cost: m.cost && typeof m.cost === "object" ? m.cost : null,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 0,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`warning: could not read models.json (${path}): ${err.message}\n`);
  }
  return byId;
}

/**
 * Exact id, then longest prefix match in either direction (deepseek-flash →
 * deepseek-v4-flash), then longest shared leading token (>= 4 chars) so a
 * renamed family member still inherits contextWindow / rates.
 */
function lookupModel(id, models) {
  if (!id) return null;
  const lower = id.toLowerCase();
  const exact = models.get(lower);
  if (exact) return exact;
  let best = null;
  for (const [key, entry] of models) {
    if (lower.startsWith(key) || key.startsWith(lower)) {
      if (!best || key.length > best.key.length) best = { key, entry };
    }
  }
  if (best) return best.entry;
  let shared = null;
  for (const [key, entry] of models) {
    let i = 0;
    while (i < key.length && i < lower.length && key[i] === lower[i]) i++;
    if (i >= 4 && (!shared || i > shared.len)) shared = { len: i, entry };
  }
  return shared ? shared.entry : null;
}

function computeCost(modelId, usage, timestampMs, models) {
  const lower = (modelId || "").toLowerCase();
  if (lower.startsWith("deepseek")) {
    return multiply(usage, isPeakHour(timestampMs) ? DEEPSEEK_PEAK : DEEPSEEK_OFFPEAK);
  }
  const reported = usage.cost;
  if (reported && (reported.total || reported.input || reported.output || reported.cacheRead || reported.cacheWrite)) {
    return {
      input: reported.input || 0,
      output: reported.output || 0,
      cacheRead: reported.cacheRead || 0,
      cacheWrite: reported.cacheWrite || 0,
      total: reported.total || (reported.input || 0) + (reported.output || 0) + (reported.cacheRead || 0) + (reported.cacheWrite || 0),
    };
  }
  const entry = lookupModel(modelId, models);
  if (entry?.cost) return multiply(usage, entry.cost);
  return { ...ZERO_COST };
}

// ------------------------------------------------------------ arg parsing ----

function parseArgs(argv) {
  const opts = { sinceMs: 30 * 864e5, sinceLabel: "30d", top: 10, json: false, sessions: DEFAULT_SESSIONS, models: DEFAULT_MODELS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--since": {
        const v = next();
        const parsed = parseSince(v);
        if (!parsed) fail(`invalid --since value: ${v} (use 30d, 12h, 2w, 6mo, 1y or 2026-01-01)`);
        opts.sinceMs = parsed.ms;
        opts.sinceLabel = v;
        break;
      }
      case "--top": {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) fail(`invalid --top value: ${a}`);
        opts.top = n;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      case "--sessions":
        opts.sessions = next();
        break;
      case "--models":
        opts.models = next();
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        fail(`unknown argument: ${a} (try --help)`);
    }
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function parseSince(value) {
  const m = /^(\d+(?:\.\d+)?)\s*(mo|[dhwmy])?$/i.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] || "d").toLowerCase();
    const day = 864e5;
    const mult = { h: day / 24, d: day, w: day * 7, mo: day * 30, m: day * 30, y: day * 365 }[unit];
    if (!mult) return null;
    return { ms: n * mult };
  }
  const t = Date.parse(value);
  if (!Number.isNaN(t)) return { ms: Date.now() - t };
  return null;
}

// -------------------------------------------------------------- formatting ----

function fmtTokens(count) {
  if (!Number.isFinite(count) || count === 0) return "0";
  if (count < 1000) return `${count}`;
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

function fmtCost(n) {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

function fmtDate(ms) {
  if (!ms) return "-";
  return new Date(ms).toISOString().slice(0, 10);
}

function num(n, width, decimals = 0) {
  return n.toFixed(decimals).padStart(width);
}

function str(s, width, align = "left") {
  const v = String(s);
  if (v.length > width) return v.slice(0, Math.max(0, width - 1)) + "…";
  return align === "right" ? v.padStart(width) : v.padEnd(width);
}

/** Render a simple aligned table with a header and rule. */
function table(headers, aligns, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length), 0));
  const render = (cells) => cells.map((c, i) => str(c, widths[i], aligns[i])).join("  ").trimEnd();
  const lines = [render(headers), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) lines.push(render(r));
  return lines.join("\n");
}

// ------------------------------------------------------------------ scanning ----

function parseTs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** Project directory name → readable cwd. Authoritative cwd comes from the session header. */
function cwdFromSlug(slug) {
  // --home-mark-escaperoom--  →  /home/mark/escaperoom
  if (slug.startsWith("--") && slug.endsWith("--")) return "/" + slug.slice(2, -2).replace(/-/g, "/");
  return slug;
}

async function scanSessionFile(filePath, projectSlug, models) {
  const size = (await stat(filePath)).size;
  const session = {
    file: filePath,
    project: projectSlug,
    cwd: cwdFromSlug(projectSlug),
    id: null,
    bytes: size,
    startedAt: 0,
    lastActivity: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: ZERO_COST.total,
    costParts: { ...ZERO_COST },
    assistantMessages: 0,
    compactions: 0,
    models: new Set(),
    lastPromptTokens: 0,
    peakPromptTokens: 0,
    contextWindow: 0,
    badLines: 0,
    lines: 0,
  };

  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    session.lines++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      session.badLines++;
      continue;
    }
    if (!entry || typeof entry !== "object") {
      session.badLines++;
      continue;
    }

    if (entry.type === "session") {
      if (typeof entry.id === "string") session.id = entry.id;
      if (typeof entry.cwd === "string" && entry.cwd) session.cwd = entry.cwd;
      const t = parseTs(entry.timestamp);
      if (t && (!session.startedAt || t < session.startedAt)) session.startedAt = t;
      if (t > session.lastActivity) session.lastActivity = t;
      continue;
    }

    let usage = null;
    let modelId = null;
    let ts = 0;

    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message;
      ts = parseTs(msg.timestamp) || parseTs(entry.timestamp);
      if (msg.role === "assistant") {
        session.assistantMessages++;
        if (typeof msg.model === "string") modelId = msg.model;
        if (msg.usage && typeof msg.usage === "object") usage = msg.usage;
      } else if (msg.role === "toolResult" && msg.usage && typeof msg.usage === "object") {
        usage = msg.usage; // this store has none, but stay compatible
      }
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      ts = parseTs(entry.timestamp);
      if (entry.type === "compaction") session.compactions++;
      if (entry.usage && typeof entry.usage === "object") usage = entry.usage;
      if (typeof entry.model === "string") modelId = entry.model;
    } else {
      ts = parseTs(entry.timestamp);
    }

    if (ts > session.lastActivity) session.lastActivity = ts;

    if (!usage) continue;

    const input = usage.input || 0;
    const output = usage.output || 0;
    const cacheRead = usage.cacheRead || 0;
    const cacheWrite = usage.cacheWrite || 0;
    session.input += input;
    session.output += output;
    session.cacheRead += cacheRead;
    session.cacheWrite += cacheWrite;

    const cost = computeCost(modelId, usage, ts || session.lastActivity || Date.now(), models);
    session.cost += cost.total;
    session.costParts.input += cost.input;
    session.costParts.output += cost.output;
    session.costParts.cacheRead += cost.cacheRead;
    session.costParts.cacheWrite += cost.cacheWrite;

    if (modelId) session.models.add(modelId);
    const entryModel = modelId ? lookupModel(modelId, models) : null;
    if (entryModel?.contextWindow) session.contextWindow = entryModel.contextWindow;
    const promptTokens = input + cacheRead + cacheWrite;
    if (promptTokens > 0) {
      session.lastPromptTokens = promptTokens;
      if (promptTokens > session.peakPromptTokens) session.peakPromptTokens = promptTokens;
    }
  }

  if (!session.startedAt) session.startedAt = session.lastActivity;
  session.models = [...session.models];
  return session;
}

async function scanAll(sessionsDir, models) {
  const projects = [];
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read session directory ${sessionsDir}: ${err.message}`);
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const projectPath = join(sessionsDir, dirent.name);
    let files;
    try {
      files = (await readdir(projectPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const sessions = [];
    for (const file of files) {
      try {
        sessions.push(await scanSessionFile(join(projectPath, file), dirent.name, models));
      } catch (err) {
        process.stderr.write(`warning: skipped unreadable file ${file}: ${err.message}\n`);
      }
    }
    if (sessions.length) projects.push({ slug: dirent.name, sessions });
  }
  return projects;
}

// ------------------------------------------------------------------ report ----

function emptyAgg() {
  return {
    sessions: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    bytes: 0,
    badLines: 0,
    lines: 0,
    contextFillSum: 0,
    contextFillCount: 0,
    lastActivity: 0,
  };
}

function addToAgg(agg, s) {
  agg.sessions++;
  agg.input += s.input;
  agg.output += s.output;
  agg.cacheRead += s.cacheRead;
  agg.cacheWrite += s.cacheWrite;
  agg.cost += s.cost;
  agg.costParts.input += s.costParts.input;
  agg.costParts.output += s.costParts.output;
  agg.costParts.cacheRead += s.costParts.cacheRead;
  agg.costParts.cacheWrite += s.costParts.cacheWrite;
  agg.bytes += s.bytes;
  agg.badLines += s.badLines;
  agg.lines += s.lines;
  if (s.contextWindow > 0 && s.lastPromptTokens > 0) {
    agg.contextFillSum += (s.lastPromptTokens / s.contextWindow) * 100;
    agg.contextFillCount++;
  }
  if (s.lastActivity > agg.lastActivity) agg.lastActivity = s.lastActivity;
}

function hitRate(agg) {
  const prompt = agg.input + agg.cacheRead + agg.cacheWrite;
  return prompt > 0 ? (agg.cacheRead / prompt) * 100 : null;
}

function sessionLabel(s) {
  const base = s.file.split("/").pop() || s.file;
  const id = base.replace(/\.jsonl$/, "").split("_").pop() || "";
  return id.slice(0, 8);
}

function run() {
  return main();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const header = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0];
    const body = header
      .replace(/^#![^\n]*\n/, "")
      .replace(/^\/\*\*?\n/, "")
      .replace(/^ \* ?/gm, "")
      .trimEnd();
    process.stdout.write(body + "\n");
    return;
  }

  const models = loadModels(opts.models);
  const projects = await scanAll(opts.sessions, models);
  const now = Date.now();
  const cutoff = now - opts.sinceMs;

  const projectAggs = [];
  const allSessions = [];
  const totals = emptyAgg();

  for (const project of projects) {
    const agg = emptyAgg();
    agg.slug = project.slug;
    agg.cwd = project.sessions[0]?.cwd || cwdFromSlug(project.slug);
    for (const s of project.sessions) {
      addToAgg(agg, s);
      addToAgg(totals, s);
      allSessions.push(s);
    }
    projectAggs.push(agg);
  }

  projectAggs.sort((a, b) => b.cost - a.cost || b.bytes - a.bytes);
  const byCost = [...allSessions].sort((a, b) => b.cost - a.cost).slice(0, opts.top);
  const stale = allSessions.filter((s) => s.lastActivity < cutoff).sort((a, b) => b.bytes - a.bytes);
  const staleBytes = stale.reduce((n, s) => n + s.bytes, 0);
  const activeBytes = totals.bytes - staleBytes;

  // Sessions inside the window, for the "recent spend" line.
  const windowAgg = emptyAgg();
  for (const s of allSessions) if (s.lastActivity >= cutoff) addToAgg(windowAgg, s);

  if (opts.json) {
    const projectRows = projectAggs.map((a) => ({
      project: a.slug.replace(/^-+|-+$/g, "") || a.slug,
      cwd: a.cwd,
      sessions: a.sessions,
      input: a.input,
      output: a.output,
      cacheRead: a.cacheRead,
      cacheWrite: a.cacheWrite,
      cost: round(a.cost, 6),
      costBreakdown: {
        input: round(a.costParts.input, 6),
        output: round(a.costParts.output, 6),
        cacheRead: round(a.costParts.cacheRead, 6),
        cacheWrite: round(a.costParts.cacheWrite, 6),
      },
      cacheHitRate: round(hitRate(a) ?? 0, 2),
      avgContextPct: round(a.contextFillCount ? a.contextFillSum / a.contextFillCount : 0, 1),
      bytes: a.bytes,
      lastActivity: a.lastActivity ? new Date(a.lastActivity).toISOString() : null,
      malformedLines: a.badLines,
    }));
    // Keep the JSON internally consistent: totals are the sum of the rounded
    // per-project rows, so `jq '[.projects[].cost] | add'` matches exactly.
    const totalCost = round(projectRows.reduce((n, p) => n + p.cost, 0), 6);
    const breakdown = (key) => round(projectRows.reduce((n, p) => n + p.costBreakdown[key], 0), 6);
    const out = {
      generatedAt: new Date(now).toISOString(),
      sessionsDir: opts.sessions,
      window: { since: opts.sinceLabel, sinceMs: opts.sinceMs, cutoff: new Date(cutoff).toISOString() },
      totals: {
        projects: projectAggs.length,
        sessions: totals.sessions,
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        cost: totalCost,
        costBreakdown: {
          input: breakdown("input"),
          output: breakdown("output"),
          cacheRead: breakdown("cacheRead"),
          cacheWrite: breakdown("cacheWrite"),
        },
        cacheHitRate: round(hitRate(totals) ?? 0, 2),
        avgContextPct: round(totals.contextFillCount ? totals.contextFillSum / totals.contextFillCount : 0, 1),
        bytes: totals.bytes,
        lastActivity: totals.lastActivity ? new Date(totals.lastActivity).toISOString() : null,
        malformedLines: totals.badLines,
        scannedLines: totals.lines,
      },
      window_totals: {
        sessions: windowAgg.sessions,
        cost: round(windowAgg.cost, 6),
        input: windowAgg.input,
        output: windowAgg.output,
        cacheRead: windowAgg.cacheRead,
        cacheWrite: windowAgg.cacheWrite,
      },
      projects: projectRows,
      topSessions: byCost.map((s) => ({
        id: sessionLabel(s),
        project: s.project,
        cwd: s.cwd,
        file: s.file,
        models: s.models,
        input: s.input,
        output: s.output,
        cacheRead: s.cacheRead,
        cacheWrite: s.cacheWrite,
        cost: round(s.cost, 6),
        bytes: s.bytes,
        startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
        lastActivity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null,
        stale: s.lastActivity < cutoff,
      })),
      stale: {
        count: stale.length,
        bytes: staleBytes,
        olderThan: opts.sinceLabel,
        sessions: stale.map((s) => ({
          id: sessionLabel(s),
          project: s.project,
          file: s.file,
          bytes: s.bytes,
          lastActivity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null,
          cost: round(s.cost, 6),
        })),
      },
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  // ---- human report ----
  const out = [];
  const line = (s = "") => out.push(s);

  line(`pi session report — ${opts.sessions}`);
  line(
    `generated ${new Date(now).toISOString().replace("T", " ").slice(0, 16)} UTC · ` +
      `${fmtBytes(totals.bytes)} on disk · ${totals.sessions} sessions in ${projectAggs.length} projects · ` +
      `stale window ${opts.sinceLabel}`,
  );
  line("");

  line("PER PROJECT");
  const rows = projectAggs.map((a) => [
    a.slug.replace(/^-+|-+$/g, "") || a.slug,
    String(a.sessions),
    fmtTokens(a.input),
    fmtTokens(a.output),
    fmtTokens(a.cacheRead),
    fmtTokens(a.cacheWrite),
    fmtCost(a.cost),
    hitRate(a) === null ? "-" : `${hitRate(a).toFixed(0)}%`,
    a.contextFillCount ? `${(a.contextFillSum / a.contextFillCount).toFixed(0)}%` : "-",
    fmtBytes(a.bytes),
    fmtDate(a.lastActivity),
  ]);
  rows.push([
    "TOTAL",
    String(totals.sessions),
    fmtTokens(totals.input),
    fmtTokens(totals.output),
    fmtTokens(totals.cacheRead),
    fmtTokens(totals.cacheWrite),
    fmtCost(totals.cost),
    hitRate(totals) === null ? "-" : `${hitRate(totals).toFixed(0)}%`,
    totals.contextFillCount ? `${(totals.contextFillSum / totals.contextFillCount).toFixed(0)}%` : "-",
    fmtBytes(totals.bytes),
    fmtDate(totals.lastActivity),
  ]);
  line(
    table(
      ["project", "sess", "input", "output", "cache-r", "cache-w", "cost", "hit", "ctx", "disk", "last"],
      ["left", "right", "right", "right", "right", "right", "right", "right", "right", "right", "right"],
      rows,
    ),
  );
  line("");
  line(
    `cost split: input ${fmtCost(totals.costParts.input)} · output ${fmtCost(totals.costParts.output)} · ` +
      `cache read ${fmtCost(totals.costParts.cacheRead)} · cache write ${fmtCost(totals.costParts.cacheWrite)}`,
  );
  line("");

  line(`TOP ${byCost.length} MOST EXPENSIVE SESSIONS`);
  line(
    table(
      ["session", "project", "date", "cost", "input", "output", "cache-r", "disk"],
      ["left", "left", "left", "right", "right", "right", "right", "right"],
      byCost.map((s) => [
        sessionLabel(s),
        s.project.replace(/^-+|-+$/g, ""),
        fmtDate(s.startedAt),
        fmtCost(s.cost),
        fmtTokens(s.input),
        fmtTokens(s.output),
        fmtTokens(s.cacheRead),
        fmtBytes(s.bytes),
      ]),
    ),
  );
  line("");

  line(`STALE SESSIONS (untouched > ${opts.sinceLabel}) — ${stale.length} sessions, ${fmtBytes(staleBytes)} reclaimable`);
  if (stale.length === 0) {
    line("  none");
  } else {
    for (const s of stale.slice(0, 15)) {
      line(
        `  ${fmtBytes(s.bytes).padStart(8)}  ${fmtDate(s.lastActivity)}  ` +
          `${sessionLabel(s)}  ${s.project.replace(/^-+|-+$/g, "")}`,
      );
    }
    if (stale.length > 15) line(`  … and ${stale.length - 15} more (--json lists all)`);
    line(`  prune with: ./prune-sessions.sh --older-than ${opts.sinceLabel}   (add --apply to move)`);
  }
  line("");

  line(
    `Within the last ${opts.sinceLabel}: ${windowAgg.sessions} of ${totals.sessions} sessions, ` +
      `${fmtCost(windowAgg.cost)} of ${fmtCost(totals.cost)} total cost, ${fmtBytes(activeBytes)} of ${fmtBytes(totals.bytes)} disk.`,
  );
  if (totals.badLines > 0) {
    line(`Skipped ${totals.badLines} malformed line(s) out of ${totals.lines} scanned — report excludes them.`);
  }
  const unpricedModels = new Set();
  for (const s of allSessions) {
    for (const id of s.models) {
      const entry = lookupModel(id, models);
      if (!entry?.cost) unpricedModels.add(id);
    }
  }
  line(
    `Costs from models.json (${models.size} known models) + DeepSeek peak/off-peak recomputation.` +
      (unpricedModels.size ? ` Unpriced (local/free, shown as $0): ${[...unpricedModels].join(", ")}.` : ""),
  );

  process.stdout.write(out.join("\n") + "\n");
}

function round(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

run().catch((err) => {
  process.stderr.write(`error: ${err?.stack || err}\n`);
  process.exit(1);
});
