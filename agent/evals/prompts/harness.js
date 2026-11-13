// Prompt builder for the harness evals.
//
// Every test case gets the same shape: the real harness instructions that would
// be in context (agent/AGENTS.md, plus one skill file when the case is about a
// skill) and a single user request. The model is asked to answer as pi would.
// Files are read at eval time, so the suite tests what is on disk today, not a
// copy pasted into a prompt.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

function readIfExists(rel) {
  const p = path.join(repo, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
}

// Minimal ground truth so the model does not have to invent repo facts: the real
// test command, the real make targets, the real trunk branch name.
function repoFacts() {
  const pkg = readIfExists("package.json");
  const testScript = (pkg.match(/"test":\s*"([^"]+)"/) || [])[1] || "unknown";
  const makefile = readIfExists("Makefile");
  const phony = (makefile.match(/^\.PHONY:\s*(.+)$/m) || [])[1] || "";
  return [
    `repo root: ${repo}`,
    "trunk branch is `trunk`, not `main`; work lands via a branch plus a pull request",
    `extension tests: cd agent && ${testScript}`,
    `make targets: ${phony}`,
    "skills live in agent/skills/<name>/SKILL.md; extensions in agent/extensions/",
  ].join("\n");
}

export default async function ({ vars }) {
  const agentMd = readIfExists("AGENTS.md");
  const skill = vars.skill ? readIfExists(`skills/${vars.skill}/SKILL.md`) : "";

  const system = [
    "You are pi, a coding agent running on Mark's machine. The instructions below are your standing instructions for this session. Follow them.",
    "",
    "--- BEGIN REPO FACTS (what tool calls would have told you) ---",
    repoFacts(),
    "--- END REPO FACTS ---",
    "",
    "--- BEGIN AGENTS.md ---",
    agentMd,
    "--- END AGENTS.md ---",
    skill
      ? [`--- BEGIN skills/${vars.skill}/SKILL.md ---`, skill, `--- END skills/${vars.skill}/SKILL.md ---`].join("\n")
      : "",
    "",
    "No tools are available in this turn. Reply with the single message you would actually send the user: the commands, file paths, branch names and questions you would have used, written out. Do not narrate what you are about to do and do not include a thinking-out-loud section — start with what the user sees.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: vars.request },
  ];
}
