# Harness conformance against the Thoughtworks Radar, Volume 35

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-02-15 — quarterly, see §6 below.
Re-measured 2026-11-13: 278 extension tests (40 suites), 8 skills, `agent/AGENTS.md`
3007 bytes, 62 entries in `~/.pi/agent/suggestions.jsonl`.

Audit date: 2026-11-13. Source: `werken-met-ai.pdf` (Radar Vol. 35, November 2026).
Scope: the 63 rows below, out of the 117 in `docs/radar-blips.tsv` — every Technique
(1–45), the two Platforms that touch a coding harness (57, 58), the Tools a one-person
harness could use (68–103), and Promptfoo (110). The other 54 rows are Kubernetes, model
serving, storage, networking, data contracts, Bayesian optimization and other
infrastructure, out of scope for a single-developer harness.

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
| 5. Progressive context disclosure | done | 8 skills load on demand; `agent/AGENTS.md` is 3040 bytes under the 3072-byte budget in `scripts/harness-check.sh` | — |
| 6. Threat modeling | missing | — | Blip 1 says the sandbox scope is informed by threat modeling, and `agent/AGENTS.md` says prefer Adopt, yet no threat model exists anywhere in the repo. Ranked first in §5. |

## 2. Trial ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 7. Agent plugin marketplace | partial | `agent/settings.json` → `packages` (git, npm and GitHub sources) | Distribution works, provenance does not: no curation and no record of what an upstream package may touch. |
| 8. Agent-maintained knowledge bases | partial | `agent/extensions/om-autostart.ts` + `pi-observational-memory` | Memory is per-session transcript compaction; nothing survives as a curated, cross-project base the agent maintains. |
| 9. Anchoring coding agents to a reference application | n/a | — | No reference application exists — the harness is the only codebase, and its conventions live in `AGENTS.md` and the skills. |
| 10. Coding harness for general-purpose agents | partial | `agent/skills/achterhoek-agenda/` runs research, not code | No non-coding workflow: research and writing inherit branch/PR/test rules that do not apply to them. |
| 11. Feedback flywheel | done | `agent/extensions/feedback-flywheel.ts` (`/suggest`, `/retro`) and `agent/extensions/self-learn.ts`: every compaction is judged by a separate pi session, which writes a proposal to `~/.pi/agent/proposals/` | The remove half still needs a human: the learner can propose a deletion, but the review is what lands it. |
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
| 84. Pi | done | This repository: pi 1.5.2, 13 extensions, 278 tests over 40 suites, `/home/mark/.pi` | Pinned to 1.5.2; the extension API is exercised but an upgrade is untested until it happens. |
| 23. Unattended overnight agentic builds | missing | — | Blocked by the same three prerequisites the blip names: default sandboxing, spec-up-front, sensors that validate without line-by-line review. |
| 110. Promptfoo | missing | — | No eval or red-team gate on prompts, skills or hooks: the deterministic half is tested, the half that shapes every turn is not. Ranked in §5. |


## 3. Assess ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 24. Agent pipeline responsibility | partial | `agent/extensions/merge-guard.ts` forces an explicit human yes per landing | Owner, reviewer and approver are the same person; nothing records who accepted an agent-built change beyond that yes. |
| 25. Agent suggestion box | done | `/suggest` → `agent/suggestions.jsonl` (51 entries), `/retro` dedupes | Nothing reviews the box on a schedule. |
| 26. Context profiling | done | `scripts/session-report.mjs` (cost, cache hit, context fill per project) | Profiling is after-the-fact; no per-turn attribution. |
| 27. Enterprise harness | n/a | — | One user; the "harness" is this repo. |
| 28. Foundation models for structured data | n/a | — | No tabular or warehouse workload; `local_llm` `extract` pulls fields out of prose, which is not the modelling this blip describes. |
| 29. Harness quality evaluation | partial | 278 tests in 40 suites (`cd agent && node --test "extensions/__tests__/*.test.ts"`), shell checks in `scripts/harness-check.sh` | Zero evaluation of skills, `AGENTS.md` and hooks — the nondeterministic half. |
| 30. Local coding models | done | `agent/extensions/local-llm.ts`, `/local` health check | Route is manual, chosen by the model's own judgement. |
| 31. MITRE ATLAS | missing | — | No AI-threat taxonomy in use; threat modelling of the harness never done. |
| 32. Production-aware coding agents | n/a | — | Nothing in production; project work is local. |
| 33. Programmatic tool calling | done | `codemode` available in every session (default `+codemode`) | — |
| 34. Semantic review of AI-edited prose | missing | — | Plans, ADRs and `AGENTS.md` diffs are reviewed as text diffs. |
| 35. Tests as data over tests as code | missing | — | Tests are TypeScript only. |
| 57. Agent Client Protocol | n/a | — | No IDE integration wanted. |
| 58. Agent Plugins | n/a | — | Repo *is* the plugin set; distribution not a problem yet. |
| 72. Agent Package Manager | missing | Skills are copy-pasted by nature of being local | Acceptable at one user; note it fails the supply-chain audit trail (lock file, provenance, hidden-Unicode scan). |
| 87. AgentsView | done (equivalent) | `scripts/session-report.mjs` reads pi session JSONL | Local-first, but no search or browse of past sessions. |
| 90. DeepSeek Harness | n/a | — | — |
| 93. GLM | missing | — | Reasoning-effort tuning per complexity is unaddressed; `thinking` level is manual. |
| 95. Herdr | done | `~/.config/herdr/`, `~/.pi/herdr-mods`, `agent/extensions/herdr-agent-state.ts`, `scripts/agent-pane.sh` | Attention inbox not used as the review queue it could be. |
| 96. Hunk | missing | — | Agent diffs are read via `gh pr diff`. |
| 97. nono.sh | done (equivalent) | `sandbox/pi-sandbox.sh` via bubblewrap | Same class of tool: OS-level isolation, no VM or daemon. |
| 94. Habit Hooks | done (equivalent) | `git-hooks/pre-commit` runs the budget, skill-length and secret checks; `scripts/harness-check.sh` is the same ruleset on demand | Hooks fire on commit only, so an edit-and-never-commit session is unchecked. |
| 99. Safe Chain | done | `npm config get min-release-age` → `2880` (48 h quarantine, measured on the host) | The key is `min-release-age`; `minimum-release-age` is rejected by npm 11.20. Inside the sandbox the config is masked, so `harness-check` reports it as unverifiable there instead of failing. |
| 102. Varlock | missing | — | `agent/settings.json`, `keys.json` and the rc blocks are unvalidated: a typo is found when a feature silently stops working. |
| 103. zizmor | partial | `uvx zizmor .github/workflows` → 0 high, 0 medium, 1 low (2026-11-13); every action pinned by SHA with `persist-credentials: false` | zizmor is a manual run, not a CI gate: the pins can drift back to tags unnoticed. |

## 4. Caution ring — are the warnings being respected?

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 36. Agent instruction bloat | respected | `AGENTS.md` 3040 bytes under the 3072-byte budget in `scripts/harness-check.sh`; 670 lines across 8 skills; `/retro` deletes rules | Watch: `cost-optimizer` and `secret-guard` inject always-on prompt text from extensions, the accumulation path this blip describes. |
| 37. Agent skill cognitive surrender | respected | All 8 skills in `agent/skills/` are hand-written here | `i-have-adhd` and `pi-web-access` come from packages — the only two not authored locally. |
| 38. AI-accelerated shadow IT | respected | Every change lands through CI and a PR (`.github/workflows/`, `merge-guard.ts`) | — |
| 39. AI-driven documentation sprawl | partial | `scripts/harness-check.sh` fails any `docs/*.md` without `Owner:` and `Review:` | No prune step: nothing deletes a doc whose review date passed. |
| 40. Blanket frontier model usage | respected | `agent/settings.json` default `deepseek-flash`; local model for chores | — |
| 41. Coding throughput as a metric | respected | `usage-footer` reports tokens and cost only | — |
| 42. Human-in-the-loop theater | partial | `merge-guard` guarantees the human is *asked*; risk tiers in `agent/AGENTS.md:14` | It cannot guarantee the human *can evaluate* the diff. |
| 43. Meat proxy | respected | Agent output is never forwarded without local verification; the habit to keep | — |
| 44. Naive context compression | partial | `agent/extensions/om-autostart.ts`, `observational-memory.compactAtContextTokens` 120000 | Compaction is `deepseek-flash` summarisation, exactly the pattern named; it runs at a threshold, not mid-task, which protects the cache prefix — keep it that way. |
| 45. Stacked pull requests | respected | One branch, one PR, merged before the next starts; `merge-guard` makes stacking awkward | — |

## 5. Gaps ranked by cost of leaving them open

1. **No threat model** (blip 6, Adopt, missing). The sandbox claims a scope informed by
   threat modeling, but nothing names what the harness must protect or what the sandbox
   does not cover. Fix: one page — assets (`~/.ssh`, cloud creds, `~/.pi` itself), attacker
   paths (fetched pages, package installs, the model's own commands), covered vs uncovered.
   Cost: 45 minutes. It re-scopes gap 2, so it goes first.
2. **Mutation survivors in `secret-guard.ts`** (blip 2, Adopt, done at 74.47%). The score
   exists now; the 193 survivors are concentrated in one file (69.77%), mostly branch
   conditions the tests do not distinguish. Fix: read `agent/reports/stryker/mutation.html`,
   kill the survivors that map to a real branch. Cost: 2 hours.
3. **Skills and `AGENTS.md` are unevaluated** (blip 29, partial). The deterministic half is
   tested (278); the half that shapes every turn is not. Fix: 10 fixed prompts, one monthly
   run, judge against last month's answers. Cost: 2 hours to set up.
4. **Actions pinned but not linted** (blip 103, partial). SHAs replace tags and
   `persist-credentials: false` is set, but zizmor runs only when someone remembers it.
   Fix: `uvx zizmor --pedantic .github/workflows` as a CI job. Cost: 30 minutes.
5. **Promptfoo absent at Trial** (blip 110, missing). No eval or red-team gate on prompts,
   skills or hooks, and it is the natural home for gap 4's 10 prompts. Cost: 3 hours for one
   suite.

Closed since the previous audit: grilling (blip 13, `agent/prompts/grill.md` plus the
`session-nudge` grill rule), risk tiers (blips 17/42, `agent/AGENTS.md:14` plus the `pr-tier`
CI job), sandbox enforcement (blip 1, the `install.sh` shell wrapper) and the mutation score
(blip 2, 74.47% from a reproducible `make mutate-full`).

Enforced by `scripts/harness-check.sh` on every commit and in CI: a cited blip must exist in
`docs/radar-blips.tsv` (no invented blip numbers), a stale `Review:` date fails the check
(blips 36, 39), and a flagship `defaultModel` fails (blip 40). `make audit` runs the whole
set for the quarterly pass.

Then, in order: Hunk or a `gh pr diff` review habit for agent-authored PRs (blip 96),
semantic review of `AGENTS.md` and plan edits (blip 34). Skipped deliberately: subagents
(blip 21) conflict with Pi's design — parallel sessions cover most of the need; and
unattended overnight builds (blip 23) stay blocked until gaps 1–3 are closed.

## 6. Re-running this audit

1. Copy the blip list: `awk -F'\t' 'NR>1{print $1"\t"$4}' docs/radar-blips.tsv`.
2. For each harness-relevant blip, name the file that implements it. No file, no credit.
3. Any row that was `missing` and is now `done` should point at a commit, not at an intention.
4. Delete rows that no longer apply — a Radar audit that only grows is the instruction bloat
   blip 36 warns about.
