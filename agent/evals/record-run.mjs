#!/usr/bin/env node
// Writes the eval run record that `make evals` leaves behind.
//
// Why a file: the eval suite is the only check here that grades the model instead
// of the repo, so nothing notices when it silently stops running. `harness-check.sh`
// reads this record and warns when the last run is older than 14 days (Radar Vol. 35
// blip 29 and blip 110).
//
// Usage: make evals (this runs it), or manually
//   node agent/evals/record-run.mjs [path-to-promptfoo-json]
//
// The record is local state, not a review artefact: it is gitignored, so a fresh
// clone reports "no eval run recorded" instead of inheriting someone else's pass.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const record = path.join(here, "last-run.txt");
const results = process.argv[2] || path.join(here, ".last-run.json");

let passed = 0;
let failed = 0;
let total = 0;
let complete = false;
let note = "no results file — promptfoo did not write one";

if (fs.existsSync(results)) {
  try {
    const data = JSON.parse(fs.readFileSync(results, "utf8"));
    const rows = data?.results?.results ?? [];
    total = rows.length;
    passed = rows.filter((row) => row?.success).length;
    failed = total - passed;
    complete = total > 0;
    note = `${passed}/${total} passed, ${failed} failed`;
  } catch (error) {
    note = `unreadable results: ${error.message}`;
  }
}

const now = new Date();
const lines = [
  "# written by `make evals` via agent/evals/record-run.mjs — local state, gitignored",
  `ran_at=${now.toISOString()}`,
  `ran_epoch=${Math.floor(now.getTime() / 1000)}`,
  `total=${total}`,
  `passed=${passed}`,
  `failed=${failed}`,
  `complete=${complete}`,
  `note=${note}`,
];
fs.writeFileSync(record, `${lines.join("\n")}\n`);
console.log(`evals: recorded ${note} in ${path.relative(process.cwd() || here, record)}`);
