#!/usr/bin/env node
// Headless retro: `make retro` aggregates agent/suggestions.jsonl into a dated digest
// and writes agent/retro/last-run.txt, with no prompt, no UI and no model call.
//
// Why it exists: `/retro` in the pi session does the same aggregation, but only when a
// person types it. The suggestion box therefore grew to 207 entries nobody read
// (Radar Vol. 35 blips 25 and 11, harness quality evaluation blip 29). What runs this
// is a person: `make retro`, or `systemd/pi-retro.timer` where that unit is installed
// — this host has no user systemd bus, so no timer here. scripts/harness-check.sh warns
// when last-run.txt is more than RETRO_MAX_AGE_DAYS old (14), and
// agent/extensions/session-nudge.ts reads that same line to say at session start when
// the window has passed, because a machine that is not always on cannot be trusted to
// fire a schedule.
//
// Rules it keeps: it only reads the suggestion log (never deletes or rewrites an
// entry), it never touches the network, and when there is nothing to aggregate it says
// so in the run record instead of writing an empty digest.
//
// The aggregation itself is imported from the extension that owns it, so the scheduled
// digest and the `/retro` digest cannot drift apart.
//
// Usage:
//   make retro
//   node scripts/retro.mjs [--agent-dir DIR] [--now ISO]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? "" : process.argv[i + 1] || "";
}

const agentDir = path.resolve(arg("agent-dir") || process.env.PI_AGENT_DIR || path.join(repoRoot, "agent"));
const logPath = path.join(agentDir, "suggestions.jsonl");
const retroDir = path.join(agentDir, "retro");
const recordPath = path.join(retroDir, "last-run.txt");

const now = arg("now") ? new Date(arg("now")) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`retro: --now is not a date: ${arg("now")}`);
  process.exit(2);
}

// The extension reads PI_CODING_AGENT_DIR at import time for the digest's "Source log"
// line, so point it at the directory this run actually read before importing it.
process.env.PI_CODING_AGENT_DIR = agentDir;

const { aggregate, renderReport } = await import(
  new URL("../agent/extensions/feedback-flywheel.ts", import.meta.url).href
);

function readEntries() {
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.ts === "string" && typeof entry.signature === "string") out.push(entry);
    } catch {
      // A malformed line is not a reason to lose the rest; `/retro` skips it too.
    }
  }
  return out;
}

// The previous run's epoch is the only watermark that survives between runs, so "new"
// means "recorded after the last retro ran" and not "new signature".
function previousRunEpoch() {
  try {
    const raw = fs.readFileSync(recordPath, "utf8");
    const value = (raw.match(/^ran_epoch=(\d+)$/m) || [])[1];
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

const entries = readEntries();
const previous = previousRunEpoch();
const entriesNew = entries.filter((entry) => {
  const ts = Date.parse(entry.ts);
  return Number.isNaN(ts) ? false : previous === null || ts / 1000 > previous;
}).length;

fs.mkdirSync(retroDir, { recursive: true });

const groups = aggregate(entries);
let digest = "none";
let note = "no digest written";

if (entries.length === 0) {
  note = "no suggestions recorded yet — nothing to aggregate, no digest written";
} else {
  digest = path.join(retroDir, `${now.toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(digest, `${renderReport(groups, entries.length, now.toISOString().slice(0, 10))}\n`, "utf8");
  note = `${groups.length} signatures, ${entries.length} entries${previous === null ? " (first recorded run)" : `, ${entriesNew} since the last run`}`;
}

const lines = [
  "# written by `make retro` via scripts/retro.mjs — local state, gitignored",
  `ran_at=${now.toISOString()}`,
  `ran_epoch=${Math.floor(now.getTime() / 1000)}`,
  `entries_seen=${entries.length}`,
  `entries_new=${entriesNew}`,
  `digest=${digest}`,
  `note=${note}`,
];
fs.writeFileSync(recordPath, `${lines.join("\n")}\n`);
console.log(
  `retro: ${note} → ${path.relative(process.cwd(), recordPath)}`,
);
if (digest !== "none") console.log(`retro: digest ${path.relative(process.cwd(), digest)}`);
