# Harness conformance against the Thoughtworks Radar, Volume 35

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-02-15 — quarterly, see §6 below.
Re-measured 2026-11-13: 503 extension tests in 59 suites, 15 extensions, 9 skills,
`agent/AGENTS.md` 3041 bytes against the 3072-byte budget, 207 entries in
`~/.pi/agent/suggestions.jsonl` (measured 2026-11-13).

Audit date: 2026-11-13; threat-model pass 2026-11-13. Source: `werken-met-ai.pdf` (Radar Vol. 35, November 2026).
Scope: the 85 rows below, out of the 117 in `docs/radar-blips.tsv` — every Technique
(1–45), the three Platforms that touch a coding harness (57, 58, 62), all 36 Tools
(68–103, each with an explicit verdict, `n/a` included), and Promptfoo (110). The other 32
rows are Kubernetes, model serving, storage, networking, data contracts, Bayesian
optimization and other infrastructure, out of scope for a single-developer harness.

Status values:

- **done** — implemented and verifiable in this repo, with the file named as evidence.
- **partial** — exists but has a named gap.
- **missing** — not implemented; ranked below with a fix.
- **n/a** — meaningless at one-person scale; listed so the omission is deliberate.

## 1. Adopt ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 1. Agent sandboxing | done | `install.sh` §4b installs a managed `pi()` shell function into `~/.bashrc` and `~/.zshrc` → `scripts/pisandbox` → `sandbox/pi-sandbox.sh` (bubblewrap); `PI_BARE=1 pi` bypasses, `pisandbox --no-net -- pi` adds isolation. `scripts/pi-bare` (symlinked into `~/.local/bin`, listed as "Pi (bare)" in Herdr's new-agent menu via `sandbox/herdr-programs.json`) is the sanctioned exit, so the choice is made before the session starts. `sandbox/pi-sandbox.sh` mounts `~/.local/bin`, `~/.local/share/pipx` and `~/.local/share/uv` read-only so `gh`, `uvx`, `gitleaks`, `semgrep`, `trivy` and `hc` exist inside, while `~/.config/gh` and the other credential directories stay masked — `gh` there reports "not logged in", which is the point. The launcher's `PI_SANDBOX_MODE`/`PI_SANDBOX_NET` markers show as the words `sandbox`/`bare` in front of the title (`agent/extensions/sandbox-badge.ts`) and in the footer status, so a contained session and a bare one are told apart at a glance (blip 42) | The wrapper is a shell function, so a launcher that skips the rc file (`env -i`, an IDE, cron) still gets the bare binary. Fallback prints one stderr line when `bwrap` is absent. |
| 2. Mutation testing | done | `agent/stryker.conf.json`, `.github/workflows/test.yml` (weekly `npx stryker run`), `make mutate-full` → **74.47%** (551 killed, 193 survived, 12 timeout, 0 uncovered; merge-guard 81.35%, secret-guard 69.77%) on 2026-11-13 | Below the 80% target: the survivors are `ConditionalExpression` and `EqualityOperator` mutants, i.e. tests that assert the string but not the branch. |
| 3. Path-to-production mapping | partial | `.github/workflows/{test,secret-scan}.yml`, PR-per-change | The path exists in CI config, not as a reviewed map. Review capacity per day is unmeasured. |
| 4. Post-quantum cryptography | n/a | — | Nothing here holds a long-lived key: model traffic terminates at the provider's TLS, and the only secrets in scope are API tokens rotated by the providers. Revisit if the harness ever stores keys it must keep for years. |
| 5. Progressive context disclosure | done | 9 skills load on demand; `agent/AGENTS.md` is 3041 bytes under the 3072-byte budget in `scripts/harness-check.sh` | — |
| 6. Threat modeling | done | `docs/threat-model.md` — assets (with `~/.ssh`, `~/.config/gh`, `~/.pi/agent/auth.json`, `~/.pi`, git remotes), attacker paths (fetched pages and PDFs, package installs, model-issued shell commands, malicious skills), the real binds and masks quoted from `sandbox/pi-sandbox.sh`, and an explicit "does not cover" list whose first item is bare mode and the bare big-boss-pi boss | The doc is a snapshot: nothing fails when `pi-sandbox.sh` and the mask list drift apart. Review date 2027-05-15 is the only trigger. |
| 68. mise | missing | — | Toolchains are host-installed and unpinned: no `mise.toml`, no `.tool-versions`, no `.nvmrc`, and `node -v` reports 22.23.4 by hand. Nothing here checks a toolchain bump against signatures or attestations either, which is the half of the blip that matters for supply chain. |
| 69. OpenAI Codex | n/a | — | pi is the harness (blip 84). A second CLI agent repeats what this repo already implements for pi — `sandbox/pi-sandbox.sh`, `merge-guard.ts`, the tier table in `agent/AGENTS.md:14` — and would sit outside all three. |
| 70. OpenCode | n/a | — | Same as 69: its headless/server mode is the enterprise-harness path, and the harness here is one person's pi with extensions. |

## 2. Trial ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 7. Agent plugin marketplace | partial | `agent/settings.json` → `packages` (git, npm and GitHub sources) | Distribution works, provenance does not: no curation and no record of what an upstream package may touch. |
| 8. Agent-maintained knowledge bases | partial | `agent/extensions/om-autostart.ts` + `pi-observational-memory` | Memory is per-session transcript compaction; nothing survives as a curated, cross-project base the agent maintains. |
| 9. Anchoring coding agents to a reference application | n/a | — | No reference application exists — the harness is the only codebase, and its conventions live in `AGENTS.md` and the skills. |
| 10. Coding harness for general-purpose agents | partial | `agent/skills/achterhoek-agenda/` runs research, not code | No non-coding workflow: research and writing inherit branch/PR/test rules that do not apply to them. |
| 11. Feedback flywheel | done | `agent/extensions/feedback-flywheel.ts` (`/suggest`, `/retro`, headless by `make retro` on `systemd/pi-retro.timer`) and `agent/extensions/self-learn.ts`: every compaction is judged by a separate pi session, which writes a proposal to `~/.pi/agent/proposals/` | The remove half still needs a human: the learner can propose a deletion, but the review is what lands it. |
| 12. Graph-grounded codebase reasoning | missing | — | Navigation is `rg` and whole-file reads; no code graph or AST index. |
| 13. Grilling | done | `/grill` → `agent/prompts/grill.md`; `agent/extensions/session-nudge.ts` nudges once per session after 4 distinct edited files with no `/grill` | The nudge is advice, not a gate: a session that ignores it still edits. |
| 14. Interactive visual plans with agents | n/a | — | Single-user, small changes; text plans suffice. |
| 15. Managed agents runtime | n/a | — | Local workstation is the runtime; nothing long-running. |
| 16. Open-weight models | partial | DeepSeek V4 Flash API, `qwen3.8:27b` local | No GLM-class open-weight model in the default route. |
| 17. Risk-tiered human oversight | done | `agent/AGENTS.md:14` (High/Medium/Low table), `agent/extensions/merge-guard.ts`, `.github/workflows/pr-tier.yml` | The check proves a tier is *stated* and that harness paths claim High. It cannot prove the human read the diff — that stays gap-ranked in §5. |
| 18. Self-improving harness | done | On `session_compact`, `self-learn.ts` gates on evidence (two identical failed-tool signatures, or one `/suggest` note) — no model call before the gate trips — then starts a learner in its own pi process (Herdr pane, else headless `pisandbox -- pi -p`) with `PI_SELF_LEARN=1`, so a reflection never stalls or pollutes the session that triggered it. `agent/prompts/learn.md` is the spec: check before prose, deletion before addition, "nothing" is a valid verdict | Applying a proposal is a High-tier review, by design (blip 17, blip 42): an agent rewriting its own prompt unread is the failure mode. No A/B scoring of competing rules. |
| 19. Small language models | done | `local_llm` tool → Ollama `qwen3.8:27b` | Nothing measures whether the local route is cheaper per finished task. |
| 20. Stateful guardrails | partial | `agent/extensions/secret-guard.ts` holds session state (`allow`/`block`) | Guards single actions, not conversation-level policy over turns. |
| 21. Subagents for better context management | missing | Parallel *sessions* instead (`scripts/agent-pane.sh` + Herdr) | Pi deliberately ships no subagents; exploration still lands in the main context. |
| 22. Toxic flow analysis for AI | partial | `agent/extensions/secret-guard.ts` (cites blip 22) | Guards a single value leaving a tool call, not multi-step flows where each step is harmless alone. |
| 71. Act | missing | — | CI only runs on GitHub: `pr-tier.yml` and `test.yml` cannot be executed before a push, so a failing gate costs a round trip. |
| 73. ast-grep | missing | — | Structural search is `rg` and regex; conventions that are syntactic (import order, hook shape) are checked by hand. |
| 74. Beads | missing | — | Task state lives in `/tmp` spec files and PR bodies; nothing survives the session as a queryable backlog. |
| 84. Pi | done | This repository: pi 1.5.2, 15 extensions, 503 tests in 59 suites, `/home/mark/.pi` | Pinned to 1.5.2; the extension API is exercised but an upgrade is untested until it happens. |
| 23. Unattended overnight agentic builds | missing | — | Blocked by the same three prerequisites the blip names: default sandboxing, spec-up-front, sensors that validate without line-by-line review. |
| 110. Promptfoo | partial | `agent/evals/` — 17 behaviour cases (11 harness, 6 adversarial) over `agent/AGENTS.md`, the skills and `agent/prompts/grill.md`; `make evals` (promptfoo 0.125.1, local `qwen3.8:27b`, zero cost) runs weekly from `systemd/pi-evals.timer`, writes `agent/evals/last-run.txt`, and `scripts/harness-check.sh` warns (`eval-freshness`) when that record is older than 14 days | Trial ring, and the grader is a 27B local model whose verdicts vary run to run — a red case is read, not obeyed. The adversarial set covers the fetched-page and hostile-skill paths (`docs/threat-model.md` §2.1, §2.4) but not the supply-chain path (§2.2), and there are no hook or red-team cases yet. |
| 75. Chaos Mesh | n/a | — | Fault injection as Kubernetes custom resources; there is no cluster. The failure surface is one workstation, and `scripts/harness-check.sh` covers it deterministically rather than by scheduled chaos. |
| 76. Cube Core | n/a | — | A semantic layer over an analytics warehouse; this repo has no warehouse, no metric definitions and no BI consumers. |
| 77. Figma Code Connect | n/a | — | No design system and no Figma file: the artefacts here are markdown skills and TypeScript extensions, not UI components built from frames. |
| 78. FluxMarkdown | n/a | — | A macOS QuickLook plugin; the host is Linux x86_64 and docs are read in the terminal or on GitHub, so rendered-markdown preview needs no tool. |
| 79. Git AI | missing | — | Nothing records which lines an agent wrote. `git log` carries PR-level provenance only (author, tier, PR body) — no commit trailer and no `git notes` attribution — so a line's origin is inferred from the PR it landed in. |
| 80. Linear | n/a | — | No team backlog: work arrives as one-shot spec files and PR bodies, and there is no second person to assign an issue to. |
| 81. mattpocock/skills | n/a | — | All 9 skills in `agent/skills/` are hand-written here (blip 37); importing a library is the cognitive-surrender path this blip itself warns about, not a gap. |
| 82. OpenSpec | missing | — | Specs are one-shot files (`/home/mark/big-boss-pi/specs/*.md`) written per task; there is no persistent source-of-truth spec and no delta/archive step, so a second change to the same area starts from nothing. |
| 83. OpenWiki | missing | — | `docs/` is hand-written and `scripts/harness-check.sh` only enforces an `Owner:`/`Review:` header. Nothing regenerates a doc when the code it describes changes, which is what the blip's checkpointing buys. |
| 85. Sourcebot | n/a | — | Self-hosted multi-repo code search; there is one repo, and `rg` answers without an index to maintain. |
| 86. Timefold Solver | n/a | — | A constraint solver for routing, rostering and task assignment. No such planning problem exists here, and nothing is written in Java or Kotlin. |


## 3. Assess ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 24. Agent pipeline responsibility | partial | `agent/extensions/merge-guard.ts` forces an explicit human yes per landing | Owner, reviewer and approver are the same person; nothing records who accepted an agent-built change beyond that yes. |
| 25. Agent suggestion box | done | `/suggest` → `agent/suggestions.jsonl` (207 entries, measured 2026-11-13), `/retro` dedupes by signature, and `make retro` runs headless every Monday from `systemd/pi-retro.timer`: digest to `agent/retro/<date>.md`, record in `agent/retro/last-run.txt`, and `scripts/harness-check.sh` warns (`retro-freshness`) when that record is older than 14 days | The digest is still read by a person: nothing acts on the top signatures automatically. |
| 26. Context profiling | done | `scripts/session-report.mjs` (cost, cache hit, context fill per project) | Profiling is after-the-fact; no per-turn attribution. |
| 27. Enterprise harness | n/a | — | One user; the "harness" is this repo. |
| 28. Foundation models for structured data | n/a | — | No tabular or warehouse workload; `local_llm` `extract` pulls fields out of prose, which is not the modelling this blip describes. |
| 29. Harness quality evaluation | partial | 503 tests in 59 suites (`cd agent && env -u PI_WORKER node --test "extensions/__tests__/*.test.ts"`), shell checks in `scripts/harness-check.sh`, 17 prompt evals in `agent/evals/` (`make evals`, weekly from `systemd/pi-evals.timer`, record in `agent/evals/last-run.txt`) | The instruction half is sampled, not proven: the prompts are fixed and the grader is a 27B local model, so a verdict varies run to run; hooks still have no nondeterministic evaluation. |
| 30. Local coding models | done | `agent/extensions/local-llm.ts`, `/local` health check | Route is manual, chosen by the model's own judgement. |
| 31. MITRE ATLAS | done | `docs/threat-model.md` §2 groups attacker paths by ATLAS tactic (prompt injection, Execution, Persistence, Defense Evasion, Exfiltration) and names `AML.T0051` for the fetched-page path | Tactic names only, no per-technique ID mapping and no ATLAS-driven detection: the taxonomy shapes the document, not a test. |
| 32. Production-aware coding agents | n/a | — | Nothing in production; project work is local. |
| 33. Programmatic tool calling | done | `codemode` available in every session (default `+codemode`) | — |
| 34. Semantic review of AI-edited prose | missing | — | Plans, ADRs and `AGENTS.md` diffs are reviewed as text diffs. |
| 35. Tests as data over tests as code | missing | — | Tests are TypeScript only. |
| 62. Decision models | done | `/home/mark/big-boss-pi/bin/jev` (local `qwen3.8:27b`, 0 = yes, 1 = no, 3 = unsure) and `agent/skills/jev/SKILL.md`, which says when to ask it: route, worker count, sandbox mode, permission requests | A decision model answering as prose is still a guess with a quote around it: no record of what it decided, and no scoring of its answers against the human's. |
| 57. Agent Client Protocol | n/a | — | No IDE integration wanted. |
| 58. Agent Plugins | n/a | — | Repo *is* the plugin set; distribution not a problem yet. |
| 72. Agent Package Manager | missing | Skills are copy-pasted by nature of being local | Acceptable at one user; note it fails the supply-chain audit trail (lock file, provenance, hidden-Unicode scan). |
| 87. AgentsView | done (equivalent) | `scripts/session-report.mjs` reads pi session JSONL | Local-first, but no search or browse of past sessions. |
| 90. DeepSeek Harness | n/a | — | — |
| 93. GLM | missing | — | Reasoning-effort tuning per complexity is unaddressed; `thinking` level is manual. |
| 95. Herdr | done | `~/.config/herdr/`, `~/.pi/herdr-mods`, `agent/extensions/herdr-agent-state.ts`, `scripts/agent-pane.sh`, `agent/extensions/herdr-resume-map.ts` + `scripts/herdr-resume.mjs` (sessions resume after a reboot) | Attention inbox not used as the review queue it could be. |
| 96. Hunk | missing | — | Agent diffs are read via `gh pr diff`. |
| 97. nono.sh | done (equivalent) | `sandbox/pi-sandbox.sh` via bubblewrap | Same class of tool: OS-level isolation, no VM or daemon. |
| 94. Habit Hooks | done (equivalent) | `git-hooks/pre-commit` runs the budget, skill-length and secret checks; `scripts/harness-check.sh` is the same ruleset on demand | Hooks fire on commit only, so an edit-and-never-commit session is unchecked. |
| 99. Safe Chain | done | `bash scripts/harness-check.sh --verify-release-age` → `PASS … npm 11.21.2, effective min-release-age=2 days ≥ 2 days`, measured bare on the host | The check reads the npm version *and* the effective value, and FAILs when either cannot be read: npm < 11 echoes the key from `.npmrc` without honouring it, and the sandbox masks the config, so neither passes silently. Unit: npm 11 reads a bare number as **days** (`<days>` in @npmcli/config, `Date.now() - 86400000 * value`), measured on npm 11.21.2 — `--min-release-age=2` refused a package published today and accepted one published two days ago, while `=2880` cut off at 2018 — so the value is 2 days (the playbook's 48 hours), not 1440 minutes. |
| 102. Varlock | missing | — | `agent/settings.json`, `keys.json` and the rc blocks are unvalidated: a typo is found when a feature silently stops working. |
| 103. zizmor | done | `.github/workflows/zizmor.yml` runs `uvx --from zizmor==1.32.0 zizmor --pedantic .` on PRs, trunk pushes and weekly → 0 findings (1 justified ignore, 2026-11-13: 4 low cleared); every action pinned by full SHA with `persist-credentials: false` | The gate fails the job on any finding, so a pin cannot drift back to a tag unnoticed. |
| 88. Apple container | n/a | — | macOS-only lightweight VMs on Apple silicon; the host is Linux x86_64 and process isolation is bubblewrap (blip 97). |
| 89. Deepsec | missing | — | The only code scanner wired into CI is gitleaks in `.github/workflows/secret-scan.yml`. Nothing does architecture-first, agent-driven vulnerability review; `semgrep` and `trivy` are mounted into the sandbox (blip 1) but no workflow or `harness-check` rule runs them. |
| 91. Entire CLI | missing | — | Sessions stay in `~/.pi` JSONL and are read locally by `scripts/session-report.mjs`; nothing writes a session into the repo next to its commit, so a session cannot be replayed from the branch it produced. |
| 92. FreeToken | n/a | — | An inference engine for MoE models larger than consumer GPU memory; the local model is `qwen3.8:27b` served by Ollama on the host, which fits. |
| 98. OpenResearch CLI (orx) | n/a | — | Runs parallel research experiments in isolated git worktrees with one pinned run command. There is no experiment workload here; the worktree discipline it automates is done by hand per worker. |
| 100. Swamp | missing | — | Operational jobs are ad-hoc shell invocations (`scripts/harness-check.sh`, `make audit`, `make mutate-full`) with no typed model of the systems they touch and no versioned run history to query later. |
| 101. Vale | missing | — | Docs are checked for headers by `scripts/harness-check.sh`, not for prose: no style rules, so generated-text tells and drift in `AGENTS.md` and `docs/*.md` go unchecked. |

## 4. Caution ring — are the warnings being respected?

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 36. Agent instruction bloat | respected | `AGENTS.md` 3041 bytes under the 3072-byte budget in `scripts/harness-check.sh`; 9 skills, each under the 150-line limit; `/retro` deletes rules | Watch: `cost-optimizer` and `secret-guard` inject always-on prompt text from extensions, the accumulation path this blip describes. |
| 37. Agent skill cognitive surrender | respected | All 9 skills in `agent/skills/` are hand-written here | `i-have-adhd` and `pi-web-access` come from packages — the only two not authored locally. |
| 38. AI-accelerated shadow IT | respected | Every change lands through CI and a PR (`.github/workflows/`, `merge-guard.ts`) | — |
| 39. AI-driven documentation sprawl | partial | `scripts/harness-check.sh` fails any `docs/*.md` without `Owner:` and `Review:` | No prune step: nothing deletes a doc whose review date passed. |
| 40. Blanket frontier model usage | respected | `agent/settings.json` default `deepseek-flash`; local model for chores | — |
| 41. Coding throughput as a metric | respected | `usage-footer` reports tokens and cost only | — |
| 42. Human-in-the-loop theater | partial | `merge-guard` guarantees the human is *asked*; risk tiers in `agent/AGENTS.md:14` | It cannot guarantee the human *can evaluate* the diff. |
| 43. Meat proxy | respected | Agent output is never forwarded without local verification; the habit to keep | — |
| 44. Naive context compression | partial | `agent/extensions/om-autostart.ts`, `observational-memory.compactAtContextTokens` 120000 | Compaction is `deepseek-flash` summarisation, exactly the pattern named; it runs at a threshold, not mid-task, which protects the cache prefix — keep it that way. |
| 45. Stacked pull requests | respected | One branch, one PR, merged before the next starts; `merge-guard` makes stacking awkward | — |

## 5. Gaps ranked by cost of leaving them open

1. **Mutation survivors in `secret-guard.ts`** (blip 2, Adopt, done at 74.47%). The score
   exists now; the 193 survivors are concentrated in one file (69.77%), mostly branch
   conditions the tests do not distinguish. Fix: read `agent/reports/stryker/mutation.html`,
   kill the survivors that map to a real branch. Cost: 2 hours.
2. **The supply-chain path has no sensor** (blip 29, partial). The eval suite is no longer
   thin or manual: 17 cases, six of them adversarial, on a weekly `pi-evals.timer`, with a
   `eval-freshness` warning when the run record goes stale. What remains is the one attacker
   path nothing tests: a package install (`docs/threat-model.md` §2.2) — no lock file, no
   provenance check, no hidden-Unicode scan. Fix: start with the scan, since it needs no
   trust model. Cost: 1 hour for the scan, an afternoon for the lock file.

Closed since the previous audit: the threat model (blips 6 and 31,
`docs/threat-model.md` — assets, attacker paths by ATLAS tactic, the real binds and masks,
and the explicit "does not cover bare mode, including the bare big-boss-pi boss"), decision
models (blip 62, `/home/mark/big-boss-pi/bin/jev` plus `agent/skills/jev`), grilling (blip 13,
`agent/prompts/grill.md` plus the `session-nudge` grill rule), risk tiers (blips 17/42,
`agent/AGENTS.md:14` plus the `pr-tier` CI job), sandbox enforcement (blip 1, the `install.sh`
shell wrapper), the mutation score (blip 2, 74.47% from a reproducible `make mutate-full`),
prompt evals (blip 110, `agent/evals/` plus `make evals`) and workflow linting (blip 103,
`.github/workflows/zizmor.yml`, 0 findings).

The threat model re-scoped what remains, and the leftover gap inherits one of its paths.
The fetched-page and malicious-skill paths (`docs/threat-model.md` §2.1 and §2.4) now have
an adversarial case each (12a, 12b), which is what closed the second gap. The supply-chain
path (§2.2, package installs) still has no test at all: no lock file, no provenance check,
no hidden-Unicode scan — the audit trail blip 72's row records as missing.

Enforced by `scripts/harness-check.sh` on every commit and in CI: a cited blip must exist in
`docs/radar-blips.tsv` (no invented blip numbers), a stale `Review:` date fails the check
(blips 36, 39), and a flagship `defaultModel` fails (blip 40). `make audit` runs the whole
set for the quarterly pass.

Then, in order: Hunk or a `gh pr diff` review habit for agent-authored PRs (blip 96),
semantic review of `AGENTS.md` and plan edits (blip 34). Skipped deliberately: subagents
(blip 21) conflict with Pi's design — parallel sessions cover most of the need; and
unattended overnight builds (blip 23) stay blocked until the gaps listed above are closed.

## 6. Re-running this audit

1. Copy the blip list: `awk -F'\t' 'NR>1{print $1"\t"$4}' docs/radar-blips.tsv`.
2. For each harness-relevant blip, name the file that implements it. No file, no credit.
3. Any row that was `missing` and is now `done` should point at a commit, not at an intention.
4. Delete rows that no longer apply — a Radar audit that only grows is the instruction bloat
   blip 36 warns about.
