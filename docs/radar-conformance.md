# Harness conformance against the Thoughtworks Radar, Volume 35

Audit date: 2026-11-13. Source: `werken-met-ai.pdf` (Radar Vol. 35, November 2026).
Scope: the 47 blips that concern coding-agent harnesses (Techniques 1–45, Tools 57–103,
Languages and Frameworks 110). Infrastructure blips (Kubernetes, storage, networking,
data contracts, Bayesian optimization) are out of scope for a single-developer harness.

Status values:

- **done** — implemented and verifiable in this repo, with the file named as evidence.
- **partial** — exists but has a named gap.
- **missing** — not implemented; ranked below with a fix.
- **n/a** — meaningless at one-person scale; listed so the omission is deliberate.

## 1. Adopt ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 1. Agent sandboxing | partial | `sandbox/pi-sandbox.sh` (bubblewrap, optional `--no-net`) | Not the default. Interactive sessions run with full `$HOME`, SSH keys and cloud creds visible. |
| 2. Mutation testing | missing | — | No mutation runner. Tests assert behaviour (215 passing) but nothing proves the assertions bite. |
| 3. Path-to-production mapping | partial | `.github/workflows/{test,secret-scan}.yml`, PR-per-change | The path exists in CI config, not as a reviewed map. Review capacity per day is unmeasured. |
| 5. Progressive context disclosure | done | 8 skills load on demand; `agent/AGENTS.md` is 2.9 KB | Enforced only by size discipline, not by a budget check. |

## 2. Trial ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 11. Feedback flywheel | done | `agent/extensions/feedback-flywheel.ts`, `/suggest`, `/retro` | The remove half is manual: nothing flags rules that stopped earning their place. |
| 13. Grilling | missing | `questionnaire` skill is a quiz, not a plan interview | Ambiguous requests are resolved by guessing. |
| 14. Interactive visual plans with agents | n/a | — | Single-user, small changes; text plans suffice. |
| 15. Managed agents runtime | n/a | — | Local workstation is the runtime; nothing long-running. |
| 16. Open-weight models | partial | DeepSeek V4 Flash API, `qwen3.8:27b` local | No GLM-class open-weight model in the default route. |
| 17. Risk-tiered human oversight | partial | `merge-guard.ts` forces an explicit human yes before landing | Tiers are flat: a README typo and an extension rewrite need the same approval. |
| 18. Self-improving harness | partial | `/retro` aggregates evidence; the agent proposes edits | The agent never runs the loop unattended; bounded experiments absent. |
| 19. Small language models | done | `local_llm` tool → Ollama `qwen3.8:27b` | Nothing measures whether the local route is actually cheaper per finished task. |
| 20. Stateful guardrails | partial | `secret-guard.ts` holds session state (`allow`/`block`) | Guards single actions, not conversation-level policy over turns. |
| 21. Subagents for better context management | missing | Parallel *sessions* instead (`scripts/agent-pane.sh` + Herdr) | Pi deliberately ships no subagents; exploration still lands in the main context. |
| 23. Unattended overnight agentic builds | missing | — | Blocked by the same three prerequisites the blip names: default sandboxing, spec-up-front, sensors that validate without line-by-line review. |

## 3. Assess ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 25. Agent suggestion box | done | `/suggest` → `agent/suggestions.jsonl` (14 entries), `/retro` dedupes | Nothing reviews the box on a schedule. |
| 26. Context profiling | done | `scripts/session-report.mjs` (cost, cache hit, context fill per project) | Profiling is after-the-fact; no per-turn attribution. |
| 27. Enterprise harness | n/a | — | One user; the "harness" is this repo. |
| 29. Harness quality evaluation | partial | 215 tests for extensions (`npm test`), CI shell checks | Zero evaluation of skills, `AGENTS.md` and hooks — the nondeterministic half. |
| 30. Local coding models | done | `local-llm.ts`, `/local` health check | Route is manual, chosen by the model's own judgement. |
| 31. MITRE ATLAS | missing | — | No AI-threat taxonomy in use; threat modelling of the harness never done. |
| 32. Production-aware coding agents | n/a | — | Nothing in production; project work is local. |
| 33. Programmatic tool calling | done | `codemode` available in every session (default `+codemode`) | — |
| 34. Semantic review of AI-edited prose | missing | — | Plans, ADRs and `AGENTS.md` diffs are reviewed as text diffs. |
| 35. Tests as data over tests as code | missing | — | Tests are TypeScript only. |
| 57. Agent Client Protocol | n/a | — | No IDE integration wanted. |
| 58. Agent Plugins | n/a | — | Repo *is* the plugin set; distribution not a problem yet. |
| 72. Agent Package Manager | missing | Skills are copy-pasted by nature of being local | Acceptable at one user; note it fails the supply-chain audit trail (lock file, provenance, hidden-Unicode scan). |
| 87. AgentsView | done (equivalent) | `scripts/session-report.mjs` | Local-first, reads pi session JSONL. Missing: search/browse of past sessions. |
| 90. DeepSeek Harness | n/a | — | — |
| 93. GLM | missing | — | Reasoning-effort tuning per complexity is unaddressed; `thinking` level is manual. |
| 95. Herdr | done | `~/.herdr`, `HERDR_PANE_ID` in `desktop-notify.ts`, `herdr-agent-state.ts`, `scripts/agent-pane.sh` | Attention inbox not used as the review queue it could be. |
| 96. Hunk | missing | — | Agent diffs are read via `gh pr diff`. |
| 97. nono.sh | done (equivalent) | `sandbox/pi-sandbox.sh` via bubblewrap | Same class of tool: OS-level isolation, no VM or daemon. |
| 99. Safe Chain | missing | `npm config get minimum-release-age` → unset | A freshly published malicious package version is installable. |
| 110. Promptfoo | missing | — | No red-team or eval gate on prompts, skills or hooks. |

## 4. Caution ring — are the warnings being respected?

| Blip | Status | Evidence |
| --- | --- | --- |
| 36. Agent instruction bloat | respected | `AGENTS.md` 2.9 KB, 670 lines across 8 skills, every extension declares its Radar basis, `/retro` exists to delete rules. Watch: `cost-optimizer` and `secret-guard` inject always-on prompt text from extensions, which is the accumulation path this blip describes. |
| 37. Agent skill cognitive surrender | respected | All 8 skills are hand-written here, not imported. `i-have-adhd` and `pi-web-access` come from packages — the only two not authored locally. |
| 38. AI-accelerated shadow IT | respected | Every change lands through CI and a PR; nothing runs unattended. |
| 39. AI-driven documentation sprawl | partial | This audit adds two documents; the repo has no prune step for them. Give each doc an owner and a review date, or delete it. |
| 40. Blanket frontier model usage | respected | Default is `deepseek-flash`, not a frontier model; local model for chores; no automatic frontier escalation. |
| 41. Coding throughput as a metric | respected | `usage-footer` reports tokens and cost only. No LOC or "AI-generated %" counters. |
| 42. Human-in-the-loop theater | partial | `merge-guard` guarantees the human is *asked*. It cannot guarantee the human *can evaluate* the diff — that is what risk tiers and mutation tests are for. |
| 43. Meat proxy | respected | Agent output is never forwarded without local verification; the habit to keep. |
| 44. Naive context compression | partial | `om-autostart.ts` turns observational memory on for every session and compacts at 120k tokens. Compaction is summarisation by `deepseek-flash`, so it is exactly the "LLM summarises during compression" pattern. It runs at a threshold, not mid-task, which protects the cache prefix — keep it that way. |
| 45. Stacked pull requests | respected | One branch, one PR, merged before the next starts. `merge-guard` makes stacking awkward on purpose. |

## 5. Gaps ranked by cost of leaving them open

1. **Sandboxing is opt-in** (blip 1, Adopt). One accidental `rm -rf` or one prompt-injected
   instruction and the blast radius is the whole home directory. Fix: run `pi` through
   `sandbox/pi-sandbox.sh` by default for anything touching unfamiliar repos, and add the
   one-line alias. Cost: 5 minutes. Highest value per minute in this list.
2. **No mutation tests** (blip 2, Adopt). 215 green tests do not prove the assertions bite,
   and agent-written tests are the exact failure mode the blip names. Fix: one Stryker run
   over `extensions/lib`, incremental after that. Cost: half a day for the first pass.
3. **Skills and `AGENTS.md` are unevaluated** (blip 29). The deterministic half is tested;
   the half that shapes every turn is not. Fix: 10 fixed prompts, one monthly run, judge
   against yesterday's answers. Cost: 2 hours to set up.
4. **No grilling before work starts** (blip 13). Guessing is the default whenever a request
   is vague. Fix: a `grill` skill: 5 questions, no code until answered. Cost: 30 minutes.
5. **Risk tiers are flat** (blip 17/42). Everything needs the same yes. Fix: a `HIGH-RISK`
   path list in `AGENTS.md` (extensions, git hooks, CI, `sandbox/`) and auto-merge allowed
   for the rest once CI is green. Cost: 15 minutes.

Then, in order: `minimum-release-age` (blip 99, 2 minutes), a Hunk or `gh pr diff`
review habit for agent-authored PRs (blip 96), semantic review of `AGENTS.md`/plan edits
(blip 34), Promptfoo for the feedback loop (blip 110). Skipped deliberately: subagents
(blip 21) conflict with Pi's design — parallel sessions cover most of the need; and
unattended overnight builds (blip 23) stay blocked until gaps 1, 2 and 3 are closed.

## 6. Re-running this audit

1. Copy the blip list: `pdftotext -layout werken-met-ai.pdf - | grep -E '^[0-9]{1,3}\.'`
2. For each harness-relevant blip, name the file that implements it. No file, no credit.
3. Any row that was `missing` and is now `done` should point at a commit, not at an intention.
4. Delete rows that no longer apply — a Radar audit that only grows is the instruction bloat
   blip 36 warns about.
