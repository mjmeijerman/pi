# Harness conformance against the Thoughtworks Radar, Volume 35

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-11-18 — yearly, see §6 below.
Re-measured 2026-11-18: `cd agent && npm test` → 1010 tests in 98 suites (835 of them
from `extensions/__tests__/*.test.ts` across 21 files / 92 suites, 175 from
`scripts/tests/*.test.mjs` across 13 files / 6 suites, plus the provenance hook script's
10 cases and 30 assertions), 17 extensions, 10 skills,
`agent/AGENTS.md` 3065 bytes against the 3072-byte budget, 976 lines in
`~/.pi/agent/suggestions.jsonl` (gitignored, so a floor), a fresh `make mutate-full` at
93.30% (1337 killed, 98 survived, 28 timeout, 0 no-coverage), and
`bash scripts/harness-check.sh` → 81 passed, 1 warn, 0 failed on the host (node
v26.13.0, npm 11.21.2) — before the `mise-installed` row, which adds one WARN on a
machine that has not installed mise; the same tree inside the sandbox reads 80 passed, 1 warn, 1 failed,
the one FAIL being `npm-min-release-age` (npm 10.9.9), and a checkout without the
gitignored local state adds `eval-freshness` and `retro-freshness` as WARNs.
Every number above was re-run today; anything that was not is marked **not re-verified**
with the date it last was. How to re-measure: the commands are step 0 of §6.

Audit date: 2026-11-18; threat-model pass 2026-11-13. Source: `werken-met-ai.pdf` (Radar Vol. 35, November 2026).
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
- **skipped** — weighed and decided against, with the reason in `docs/radar-adoption-brief.md`;
  the row carries the reason, not `missing`.

## 1. Adopt ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 1. Agent sandboxing | done | `install.sh` §4b installs a managed `pi()` shell function into `~/.bashrc` and `~/.zshrc` → `scripts/pisandbox` → `sandbox/pi-sandbox.sh` (bubblewrap); `PI_BARE=1 pi` bypasses, `pisandbox --no-net -- pi` adds isolation. `scripts/pi-bare` (symlinked into `~/.local/bin`, listed as "Pi (bare)" in Herdr's new-agent menu via `sandbox/herdr-programs.json`) is the sanctioned exit, so the choice is made before the session starts. `sandbox/pi-sandbox.sh` mounts `~/.local/bin`, `~/.local/share/pipx` and `~/.local/share/uv` read-only so `gh`, `uvx`, `gitleaks`, `semgrep`, `trivy` and `hc` exist inside, while `~/.config/gh` and the other credential directories stay masked — `gh` there reports "not logged in", which is the point. The launcher's `PI_SANDBOX_MODE`/`PI_SANDBOX_NET` markers show as the words `sandbox`/`bare` in front of the title (`agent/extensions/sandbox-badge.ts`) and in the footer status, so a contained session and a bare one are told apart at a glance (blip 42) | The wrapper is a shell function, so a launcher that skips the rc file (`env -i`, an IDE, cron) still gets the bare binary. Fallback prints one stderr line when `bwrap` is absent. |
| 2. Mutation testing | done | `agent/stryker.conf.json`, `make mutate-full` → **93.30%** (1337 killed, 98 survived, 28 timeout, 0 no-coverage) on 2026-11-18 over three files: `extensions/lib/usage-format.ts` 97.50%, `extensions/merge-guard.ts` 95.01%, `extensions/secret-guard.ts` 92.42%. A full score means throwing the cache away, not passing a flag: `make mutate-full` deletes `agent/reports/stryker/stryker-incremental.json` and runs `npx stryker run` unchanged. Stryker 10.1.1 spells "ignore the cached file" `--force`; `--incremental false` is eaten as a config path and dies with `ConfigReaderError: Invalid config file "false"`. `.github/workflows/test.yml` runs `npx stryker run` weekly, and `mutation-changed` per pull request on a `stryker.pr.conf.json` derived from the same config with `break: 100` | The weekly run reports, it does not gate (`break: null` in `stryker.conf.json`). 79 of the 98 survivors are in `secret-guard.ts`, 17 in `merge-guard.ts` and 2 in `usage-format.ts`, mostly branch conditions the tests do not distinguish. The score covers the extension tests only: the `command` runner copies `agent/` into `.stryker-tmp/`, so the runner command is the extension glob and not `npm test` (`scripts/tests/commit-msg-provenance.test.sh` is not in the copy), and `sandbox-binds.test.ts` finds the harness root by walking up instead of by fixed depth so it still runs there. |
| 3. Path-to-production mapping | partial | `.github/workflows/{test,secret-scan}.yml`, PR-per-change | The path exists in CI config, not as a reviewed map. Review capacity per day is unmeasured. |
| 4. Post-quantum cryptography | n/a | — | Nothing here holds a long-lived key: model traffic terminates at the provider's TLS, and the only secrets in scope are API tokens rotated by the providers. Revisit if the harness ever stores keys it must keep for years. |
| 5. Progressive context disclosure | done | 10 skills load on demand; `agent/AGENTS.md` is 3065 bytes under the 3072-byte budget in `scripts/harness-check.sh` | — |
| 6. Threat modeling | done | `docs/threat-model.md` — assets (with `~/.ssh`, `~/.config/gh`, `~/.pi/agent/auth.json`, `~/.pi`, git remotes), attacker paths (fetched pages and PDFs, package installs, model-issued shell commands, malicious skills), the real binds and masks quoted from `sandbox/pi-sandbox.sh`, and an explicit "does not cover" list whose first item is bare mode and the bare big-boss-pi boss | The doc is a snapshot: nothing fails when `pi-sandbox.sh` and the mask list drift apart. Review date 2027-05-15 is the only trigger. |
| 68. mise | partial | `mise.toml` (new in pi#136, `02378be`) pins `node = "24"` and `npm = "11"`; `setup.sh` reads that major out of the file instead of hardcoding it and installs the `mise` binary itself (official `mise.run` installer, binary only — never `mise install`, so the pinned major cannot be switched underneath a working PATH, and with no network the step says so and exits 0); `.node-version` (pi#140, `d825563`) is a projection of it that the four `setup-node` steps read via `node-version-file`; `bash scripts/harness-check.sh` carries five `mise-pin-*` rows (`node-version`, `matrix`, `workflows`, `node-version-file`, `npm`) that FAIL on drift, plus `mise-installed`, which WARNs when mise is absent, FAILs when the binary is on PATH and cannot answer `--version`, and FAILs when the binary is there without the pinned tool (it was a WARN until the pin was installed here — the row can only call a half-install a warning while no host has the pin); `sandbox/pi-sandbox.sh` mounts `~/.local/share/mise` read-only, so `mise which node` answers inside a sandboxed worker instead of claiming the host's node was never installed (`~/.local/state/mise` is deliberately not mounted — measured: trust gates envs and tasks, not those reads); `scripts/tests/mise-ci.test.mjs` pins all of it | The pin is installed on this host and nothing on the PATH changed to get it: `~/.local/bin/mise` from `curl -fsSL https://mise.run | sh`, then one `mise install` in the repo → `mise which node` = `~/.local/share/mise/installs/node/24/bin/node` and `mise exec -- node -v` → **v24.22.3**, while a plain `node -v` is still the system **v22.23.4** (`mise activate` was never run and `~/.local/share/mise/shims` is not on PATH). `bash scripts/harness-check.sh` → `PASS mise-installed … resolves the pinned node 24`; forced with `PATH` stripped of `~/.local/bin` it reads WARN, with a `mise` stub that answers no `--version` FAIL, and with an empty `MISE_DATA_DIR` FAIL `resolves no node 24`. Remaining gap: nothing checks a toolchain bump against signatures or attestations, the half of the blip that matters for supply chain. |
| 69. OpenAI Codex | n/a | — | pi is the harness (blip 84). A second CLI agent repeats what this repo already implements for pi — `sandbox/pi-sandbox.sh`, `merge-guard.ts`, the tier table in `agent/AGENTS.md:14` — and would sit outside all three. |
| 70. OpenCode | n/a | — | Same as 69: its headless/server mode is the enterprise-harness path, and the harness here is one person's pi with extensions. |

## 2. Trial ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 7. Agent plugin marketplace | partial | `agent/settings.json` → `packages` (git, npm and GitHub sources); a skill that arrives as files is pinned instead: `agent/skills.lock` (sha256 per file plus the commit that last touched it, verified by `scripts/harness-check.sh`) and `git-hooks/scan-unicode.sh` (hidden codepoints refused at commit) | Distribution works, provenance does not: an npm or git package is fetched by version range, never by hash, and nothing records what an upstream package may touch. |
| 8. Agent-maintained knowledge bases | partial | `agent/extensions/om-autostart.ts` + `pi-observational-memory` | Memory is per-session transcript compaction; nothing survives as a curated, cross-project base the agent maintains. |
| 9. Anchoring coding agents to a reference application | n/a | — | No reference application exists — the harness is the only codebase, and its conventions live in `AGENTS.md` and the skills. |
| 10. Coding harness for general-purpose agents | partial | `agent/skills/achterhoek-agenda/` runs research, not code | No non-coding workflow: research and writing inherit branch/PR/test rules that do not apply to them. |
| 11. Feedback flywheel | done | `agent/extensions/feedback-flywheel.ts` (`/suggest`, `/retro`, headless by `make retro`) and `agent/extensions/self-learn.ts`: every compaction is judged by a separate pi session, which writes a proposal to `~/.pi/agent/proposals/`. Re-measured 2026-11-15: the gate also reads the repetition the session cannot see — failing CI checks (`gh run list`, grouped by check name and branch), the same failure or override in two worker reports, learners that died without a proposal, and up to five of the user's own "again" lines — and on that day it fired on real evidence (`2 learners died without a proposal (learn-20-15, learn-21-02)` plus 9 failure lines repeated across worker reports), where the session-only gate had said "nothing" | The remove half still needs a human: the learner can propose a deletion, but the review is what lands it. Grouping worker prose is exact-string, so two tellings of one failure are two signals; the learner, not the gate, has to notice that. `make retro` itself is run by a person, or by `systemd/pi-retro.timer` where that unit is installed — this host has no user systemd bus (re-checked 2026-11-18: `systemctl --user list-timers` → "Failed to connect to user scope bus", and `loginctl` → "System has not been booted with systemd as init system"), so nothing runs it on a schedule here and `agent/extensions/session-nudge.ts` says at session start when the record is past its window |
| 12. Graph-grounded codebase reasoning | missing | — | Navigation is `rg` and whole-file reads; no code graph or AST index. |
| 13. Grilling | done | `/grill` → `agent/prompts/grill.md`; `agent/extensions/session-nudge.ts` nudges once per session after 4 distinct edited files with no `/grill` | The nudge is advice, not a gate: a session that ignores it still edits. |
| 14. Interactive visual plans with agents | n/a | — | Single-user, small changes; text plans suffice. |
| 15. Managed agents runtime | n/a | — | Local workstation is the runtime; nothing long-running. |
| 16. Open-weight models | partial | DeepSeek V4 Flash API, `qwen3.8:27b` local | No GLM-class open-weight model in the default route. |
| 17. Risk-tiered human oversight | done | `agent/AGENTS.md:14` (High/Medium/Low table), `agent/extensions/merge-guard.ts`, `scripts/pr-gate.sh` with its three gates (`tier`, `test-change`, `mission`), run by `.github/workflows/pr-tier.yml` on every PR body edit and by `make pr-check BODY=<file>` before a push | The check proves a tier is *stated*, that harness paths claim High, and that a `Mission:` line of 20+ characters is present. It cannot prove the human read the diff — that stays gap-ranked in §5. |
| 18. Self-improving harness | done | On `session_compact`, `self-learn.ts` gates on evidence before any model call, with a threshold of two on every signal: two identical failed-tool signatures, the same CI check red on two branches or in two workers' reports, the same gate/override recorded by two workers, two learners that died without a proposal (`runs.jsonl`), two of the user's "again" lines — or one `/suggest` note. Sources that cannot be read (a sandboxed `gh`, a missing workspace, a missing transcript) are WARNINGS in the evidence, never a silent zero, and the reason string names which signal fired and how often. A confirmed launch is then watched: a learner that exits without its proposal writes a `died` row (slug, launcher, queue, elapsed) instead of leaving nothing. The learner runs in its own pi process (Herdr pane, else headless `pisandbox -- pi -p`) with `PI_SELF_LEARN=1`, so a reflection never stalls or pollutes the session that triggered it. `agent/prompts/learn.md` is the spec: check before prose, deletion before addition, "nothing" is a valid verdict — including when the repetition is explained by something outside the harness | Applying a proposal is a High-tier review, by design (blip 17, blip 42): an agent rewriting its own prompt unread is the failure mode. No A/B scoring of competing rules. The `died` watch sees a learner's exit or a silent session, not a learner that keeps talking and never writes. Because the learner is sandboxed it cannot see `herdr-app`, so the publish hand-off (`learn-publish.sh`) stops at the space it would make and reports exit 2 instead of starting an agent: the branch is verified, the hand-off is left to a person. |
| 19. Small language models | done | `local_llm` tool → Ollama `qwen3.8:27b` | Nothing measures whether the local route is cheaper per finished task. |
| 20. Stateful guardrails | partial | `agent/extensions/secret-guard.ts` holds session state (`allow`/`block`) and a per-turn flow ledger: which secret-shaped paths a step touched, keyed by step number, tool and command | The ledger is reset per agent run, not carried across prompts; conversation-level policy is still absent. |
| 21. Subagents for better context management | missing | Parallel *sessions* instead (`scripts/agent-pane.sh` + Herdr) | Pi deliberately ships no subagents; exploration still lands in the main context. |
| 22. Toxic flow analysis for AI | partial | `agent/extensions/secret-guard.ts` refuses a send that carries file content when an earlier step in the same turn touched a secret-shaped path, and names that step (`__tests__/secret-guard-flow.test.ts`) | A flow split across two user prompts, and a read through `codemode`'s `tools.read`, are still invisible. |
| 71. Act | done | `scripts/pr-gate.sh` is the single copy of the body gates: `make pr-check BODY=<file>` runs the tier, mission and test-change checks locally against a chosen base and head, and `.github/workflows/pr-tier.yml` runs the same script in CI. `make scripts-test`, `npm test` and `make mutate` run the rest of the suite locally | The local call is a habit, not a hook: nothing forces `make pr-check` before a push, so a bad body is still found by CI when the habit lapses. |
| 73. ast-grep | skipped | Decision record: `docs/radar-adoption-brief.md` §4 (pi#129, `057fe25`) | Not `missing` but declined: zero instances of the breakage it prevents across 41 `.ts` files, `npm test` (1010) already covers the behaviour, and `sg` on this host is util-linux's, not ast-grep's. Revisit if a syntactic convention starts costing hand review. |
| 74. Beads | skipped | Decision record: `docs/radar-adoption-brief.md` §5 | Not `missing` but declined: the backlog already exists — `delegate spawn/close/sweep` plus one spec file per worker under `/home/mark/big-boss-pi/specs/` (`ls specs/*.md | wc -l` → 145), `specs/archive/` (90) and `reports/` (231, all counted 2026-11-18), with `state/decisions.jsonl` — and Beads' price of entry is editing `agent/AGENTS.md`, which has 7 bytes free of its 3072-byte budget. Genuine gap kept: that directory is not a git repo, so the backlog is unversioned and unqueryable. |
| 84. Pi | done | This repository: pi 1.5.2, 17 extensions, 648 tests in 76 suites (`cd agent && npm test`), `/home/mark/.pi` | Pinned to 1.5.2; the extension API is exercised but an upgrade is untested until it happens. |
| 23. Unattended overnight agentic builds | missing | — | Blocked by the same three prerequisites the blip names: default sandboxing, spec-up-front, sensors that validate without line-by-line review. |
| 110. Promptfoo | partial | `agent/evals/` — 17 behaviour cases (11 harness, 6 adversarial) over `agent/AGENTS.md`, the skills and `agent/prompts/grill.md`; `make evals` (promptfoo 0.125.1, local `qwen3.8:27b`, zero cost) runs weekly from `systemd/pi-evals.timer`, writes `agent/evals/last-run.txt` (last record 2026-11-18: 17 passed, 0 failed), and `scripts/harness-check.sh` warns (`eval-freshness`) when that record is older than 14 days | Trial ring, and the grader is a 27B local model whose verdicts vary run to run — a red case is read, not obeyed. The adversarial set covers the fetched-page and hostile-skill paths (`docs/threat-model.md` §2.1, §2.4) but not the supply-chain path (§2.2), and there are no hook or red-team cases yet. |
| 75. Chaos Mesh | n/a | — | Fault injection as Kubernetes custom resources; there is no cluster. The failure surface is one workstation, and `scripts/harness-check.sh` covers it deterministically rather than by scheduled chaos. |
| 76. Cube Core | n/a | — | A semantic layer over an analytics warehouse; this repo has no warehouse, no metric definitions and no BI consumers. |
| 77. Figma Code Connect | n/a | — | No design system and no Figma file: the artefacts here are markdown skills and TypeScript extensions, not UI components built from frames. |
| 78. FluxMarkdown | n/a | — | A macOS QuickLook plugin; the host is Linux x86_64 and docs are read in the terminal or on GitHub, so rendered-markdown preview needs no tool. |
| 79. Git AI | partial | `git-hooks/commit-msg` (installed by `git-hooks/install-hooks.sh`) appends `Agent-Slug:` and `Spec:` trailers to every commit, so a commit names the worker that wrote it and the spec file it followed; the review tier rides in the PR body and is enforced by `scripts/pr-gate.sh` | Commit-level attribution only: inside a commit nothing separates agent-written lines from human-edited ones, and there is no `git notes` or blame-level record. |
| 80. Linear | n/a | — | No team backlog: work arrives as one-shot spec files and PR bodies, and there is no second person to assign an issue to. |
| 81. mattpocock/skills | n/a | — | All 10 skills in `agent/skills/` are hand-written here (blip 37); importing a library is the cognitive-surrender path this blip itself warns about, not a gap. |
| 82. OpenSpec | partial | In-repo specs landed in pi#137 (`56f4049`) and pi#141 (`ebacc35`): `specs/areas/` holds four area specs (`merge-guard`, `pr-gates`, `sandbox`, `secret-guard`, each with `Owner:`/`Review:`), a change is a delta file in `specs/changes/` named after its branch (`specs/changes/README.md` states the rule), and `scripts/harness-check.sh` fails a delta whose `Area:` line names no area spec (`spec-delta-area`) and fails a delta still in trunk's tree after it landed (`spec-delta-folded`), both pinned by `scripts/tests/spec-deltas.test.mjs` | Four areas, not a spec tree: the harness has more than four, and `docs/` has none. The tool the blip is named after is not installed (`command -v openspec` is empty) — this is the shape hand-built on markdown, which is what the brief §6 recommended, so the loop is real but the editor, validation and archive commands are not. Folding a landed delta is a person's three-step commit, not a command. |
| 83. OpenWiki | missing | — | `docs/` is hand-written and `scripts/harness-check.sh` only enforces an `Owner:`/`Review:` header. Nothing regenerates a doc when the code it describes changes, which is what the blip's checkpointing buys. |
| 85. Sourcebot | n/a | — | Self-hosted multi-repo code search; there is one repo, and `rg` answers without an index to maintain. |
| 86. Timefold Solver | n/a | — | A constraint solver for routing, rostering and task assignment. No such planning problem exists here, and nothing is written in Java or Kotlin. |


## 3. Assess ring

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 24. Agent pipeline responsibility | partial | `agent/extensions/merge-guard.ts` forces an explicit human yes per landing | Owner, reviewer and approver are the same person; nothing records who accepted an agent-built change beyond that yes. |
| 25. Agent suggestion box | done | `/suggest` → `agent/suggestions.jsonl` (976 lines from `wc -l` on the host copy, counted 2026-11-18; a gitignored file that only grows, so this is a floor), `/retro` dedupes by signature, and `make retro` aggregates headless: digest to `agent/retro/<date>.md`, record in `agent/retro/last-run.txt`, and `scripts/harness-check.sh` warns (`retro-freshness`) when that record is older than 14 days. `agent/extensions/session-nudge.ts` raises `retro-due` at session start when the record is missing or older than that window, reading the same `RETRO_MAX_AGE_DAYS` line the checker assigns | No schedule runs `make retro` on this host: the units shipped (pi#76) but there is no user systemd bus here, so the run is a person's, and the session-start nudge — not a timer — is what makes a missed window visible. The digest is still read by a person: nothing acts on the top signatures automatically. |
| 26. Context profiling | done | `scripts/session-report.mjs` (cost, cache hit, context fill per project) | Profiling is after-the-fact; no per-turn attribution. |
| 27. Enterprise harness | n/a | — | One user; the "harness" is this repo. |
| 28. Foundation models for structured data | n/a | — | No tabular or warehouse workload; `local_llm` `extract` pulls fields out of prose, which is not the modelling this blip describes. |
| 29. Harness quality evaluation | partial | 1010 tests in 98 suites (`cd agent && npm test` on 2026-11-18: 835 extension tests across 21 files / 92 suites, 175 script tests across 13 files / 6 suites, plus the provenance hook script's 10 cases and 30 assertions), shell checks in `scripts/harness-check.sh` (81 passed, 1 warn, 0 failed on the host at node v26.13.0, npm 11.21.2 — the sandbox reads 80 passed, 1 warn, 1 failed because its npm 10.9.9 fails `npm-min-release-age`, and a fresh worktree of this repo reads 79 passed, 3 warn, 0 failed, the two extra WARNs being `eval-freshness` and `retro-freshness`, which need the gitignored `agent/evals/last-run.txt` and `agent/retro/last-run.txt`), offline hook tests in `scripts/ci-offline.sh` (2 suites, 33 assertions), 17 prompt evals in `agent/evals/` (`make evals`, weekly from `systemd/pi-evals.timer` where that unit is installed; record in `agent/evals/last-run.txt`: 17 of 17 passed on 2026-11-18) | The instruction half is sampled, not proven: the prompts are fixed and the grader is a 27B local model, so a verdict varies run to run; hooks still have no nondeterministic evaluation. The eval record is gitignored (`.gitignore:31`), so a fresh clone or a worktree always reads "no eval run recorded" and WARNs: the file proves a run on the machine that wrote it, never in the repo. |
| 30. Local coding models | done | `agent/extensions/local-llm.ts`, `/local` health check | Route is manual, chosen by the model's own judgement. |
| 31. MITRE ATLAS | done | `docs/threat-model.md` §2 groups attacker paths by ATLAS tactic (prompt injection, Execution, Persistence, Defense Evasion, Exfiltration) and names `AML.T0051` for the fetched-page path | Tactic names only, no per-technique ID mapping and no ATLAS-driven detection: the taxonomy shapes the document, not a test. |
| 32. Production-aware coding agents | n/a | — | Nothing in production; project work is local. |
| 33. Programmatic tool calling | done | `codemode` available in every session (default `+codemode`) | — |
| 34. Semantic review of AI-edited prose | done | `.github/workflows/prose-review.yml` plus `.github/scripts/prose-review.mjs` (pi#78) review the prose a behaviour change arrives in: a pull request that touches `agent/AGENTS.md`, `agent/prompts/**/*.md` or `agent/skills/**/SKILL.md` gets one comment answering five fixed questions, one line per question, each citing `file:line` or the words "no finding"; a re-run edits that comment instead of stacking another, and a diff over 400 changed lines is refused before any request is made (exit 3 → a warning annotation). Prompt, token cap and parsing live in the script, so `--dry-run` prints the exact request offline and `scripts/tests/prose-review.test.mjs` checks it with no network and no secret; the cap itself is the `PROSE_REVIEW_MAX_TOKENS` repository variable (default 700, never below it), because a reasoning model spends output tokens thinking before it writes, and those tokens are billed — the cap is money | It reviews nothing today: no `PROSE_REVIEW_API_KEY` repository secret is configured (`printenv PROSE_REVIEW_API_KEY` is empty on this machine), and the job's exit-4 path annotates that — a green check there means "nothing to review with", not "the prose passed". It is also narrow: `README.md` and `docs/` prose is still read by a human or nobody. |
| 35. Tests as data over tests as code | missing | — | Tests are TypeScript only. |
| 62. Decision models | done | `/home/mark/big-boss-pi/bin/jev` (TypeSafe's Jev over HTTPS, `POST https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`, 0 = yes, 1 = no, 3 = unsure, 193–268 ms per `plan` measured on this machine; `local-run` and the `local_llm` tool still run ollama `qwen3.8:27b` locally) and `agent/skills/jev/SKILL.md`, which says when to ask it: route, worker count, thinking effort, sandbox mode, permission requests | A decision model answering as prose is still a guess with a quote around it: no record of what it decided, and no scoring of its answers against the human's. |
| 57. Agent Client Protocol | n/a | — | No IDE integration wanted. |
| 58. Agent Plugins | n/a | — | Repo *is* the plugin set; distribution not a problem yet. |
| 72. Agent Package Manager | done (equivalent) | `agent/skills.lock` pins every file a skill loads by sha256 and the commit that last touched it; `scripts/harness-check.sh` verifies it on every run (a changed hash names the regenerate command, a skill file with no entry fails) and `--write-skills-lock` is the only mode that writes; `git-hooks/scan-unicode.sh` refuses bidi overrides, zero-width characters and homoglyphs in a staged `agent/skills/**`, `agent/prompts/**` or `agent/AGENTS.md`, and both behaviours have offline tests in `scripts/ci-offline.sh` | Local skills only: a package listed under `settings.json` `packages` is not pinned by hash, and there is no upstream registry to install a skill from. |
| 87. AgentsView | done (equivalent) | `scripts/session-report.mjs` reads pi session JSONL | Local-first, but no search or browse of past sessions. |
| 90. DeepSeek Harness | n/a | — | — |
| 93. GLM | missing | — | Reasoning-effort tuning per complexity is unaddressed; `thinking` level is manual. |
| 95. Herdr | done | `~/.config/herdr/`, `~/.pi/herdr-mods`, `agent/extensions/herdr-agent-state.ts`, `scripts/agent-pane.sh`, `agent/extensions/herdr-resume-map.ts` + `scripts/herdr-resume.mjs` (sessions resume after a reboot) | Attention inbox not used as the review queue it could be. |
| 96. Hunk | missing | — | Agent diffs are read via `gh pr diff`. |
| 97. nono.sh | done (equivalent) | `sandbox/pi-sandbox.sh` via bubblewrap | Same class of tool: OS-level isolation, no VM or daemon. |
| 94. Habit Hooks | done (equivalent) | `git-hooks/pre-commit` runs the budget, skill-length, skills-lock, secret and hidden-codepoint checks (`--quick`); `scripts/harness-check.sh` is the same ruleset on demand | Hooks fire on commit only, so an edit-and-never-commit session is unchecked. |
| 99. Safe Chain | done | `bash scripts/harness-check.sh --verify-release-age` → `PASS … npm 11.21.2, effective min-release-age=2 days ≥ 2 days`, measured bare on the host — **not re-verified 2026-11-18**: the same command inside a sandbox FAILs (`npm-min-release-age — npm 10.9.9 ignores min-release-age (needs npm ≥ 11)`), so the PASS still rests on the bare-host run | The check reads the npm version *and* the effective value, and FAILs when either cannot be read: npm < 11 echoes the key from `.npmrc` without honouring it, and the sandbox masks the config, so neither passes silently. Unit: npm 11 reads a bare number as **days** (`<days>` in @npmcli/config, `Date.now() - 86400000 * value`), measured on npm 11.21.2 — `--min-release-age=2` refused a package published today and accepted one published two days ago, while `=2880` cut off at 2018 — so the value is 2 days (the playbook's 48 hours), not 1440 minutes. |
| 102. Varlock | done (equivalent) | `agent/config/schema.mjs` + `bash scripts/harness-check.sh --verify-config` → `PASS config-schema agent/settings.json shape ok`, and `agent/extensions/config-guard.ts` prints the same sentence at session start | Config files only: `settings.json`, `models.json` and `keys.json` are shape-checked, unknown keys FAIL with a one-edit suggestion, and a key value is never printed. The shell rc blocks stay unvalidated, and `keys.json` is validated by shape, never by value. |
| 103. zizmor | done | `.github/workflows/zizmor.yml` runs `uvx --from zizmor==1.32.0 zizmor --pedantic .` on PRs, trunk pushes and weekly → 0 findings (1 justified ignore, 2026-11-13: 4 low cleared); every action pinned by full SHA with `persist-credentials: false`. Not re-run 2026-11-18 either: `uvx --from zizmor==1.32.0 zizmor --version` in the sandbox dies on a read-only store (`failed to create file ~/.local/share/uv/tools/.lock: Read-only file system`), so this row still rests on the 2026-11-13 run | The gate fails the job on any finding, so a pin cannot drift back to a tag unnoticed. |
| 88. Apple container | n/a | — | macOS-only lightweight VMs on Apple silicon; the host is Linux x86_64 and process isolation is bubblewrap (blip 97). |
| 89. Deepsec | partial | `.github/workflows/test.yml`: job `security scan (semgrep, trivy)` (pi#77) runs semgrep 1.185.0 with the shell ruleset pinned by commit (`SEMGREP_RULES_SHA`) and trivy 0.76.2 unpacked only after its release checksum verifies; any finding fails the run, and `tools/gitleaks`-class secret scanning stays in `.github/workflows/secret-scan.yml`. The sandboxed `semgrep`/`trivy` (blip 1) are no longer the only copy | Pattern, rule and CVE scanners, not the architecture-first, agent-driven review the blip describes: nobody asks whether the design is attackable, and a scan cannot see a logic flaw no rule names. |
| 91. Entire CLI | missing | — | Sessions stay in `~/.pi` JSONL and are read locally by `scripts/session-report.mjs`; nothing writes a session into the repo next to its commit, so a session cannot be replayed from the branch it produced. |
| 92. FreeToken | n/a | — | An inference engine for MoE models larger than consumer GPU memory; the local model is `qwen3.8:27b` served by Ollama on the host, which fits. |
| 98. OpenResearch CLI (orx) | n/a | — | Runs parallel research experiments in isolated git worktrees with one pinned run command. There is no experiment workload here; the worktree discipline it automates is done by hand per worker. |
| 100. Swamp | missing | — | Operational jobs are ad-hoc shell invocations (`scripts/harness-check.sh`, `make audit`, `make mutate-full`) with no typed model of the systems they touch and no versioned run history to query later. |
| 101. Vale | missing | — | Docs are checked for headers by `scripts/harness-check.sh`, not for prose: no style rules, so generated-text tells and drift in `AGENTS.md` and `docs/*.md` go unchecked. |

## 4. Caution ring — are the warnings being respected?

| Blip | Status | Evidence | Gap |
| --- | --- | --- | --- |
| 36. Agent instruction bloat | respected | `AGENTS.md` 3065 bytes under the 3072-byte budget in `scripts/harness-check.sh`; 10 skills, each under the 150-line limit except `valentina-grading` at 352 lines, baselined in `scripts/harness-baseline.txt`; `/retro` deletes rules | Watch: `cost-optimizer` and `secret-guard` inject always-on prompt text from extensions, the accumulation path this blip describes. |
| 37. Agent skill cognitive surrender | respected | All 10 skills in `agent/skills/` are hand-written here | `i-have-adhd` and `pi-web-access` come from packages — the only two not authored locally. |
| 38. AI-accelerated shadow IT | respected | Every change lands through CI and a PR (`.github/workflows/`, `merge-guard.ts`) | — |
| 39. AI-driven documentation sprawl | partial | `scripts/harness-check.sh` fails any `docs/*.md` without `Owner:` and `Review:`, and its `review-freshness` check fails a doc whose `Review:` date has passed (5 docs, all dated 2027, PASS on 2026-11-18) | The check makes an overdue doc loud, not gone: the deletion is still a human step. |
| 40. Blanket frontier model usage | respected | `agent/settings.json` default `deepseek-flash`; local model for chores | — |
| 41. Coding throughput as a metric | respected | `usage-footer` reports tokens and cost only | — |
| 42. Human-in-the-loop theater | partial | `merge-guard` guarantees the human is *asked*; risk tiers in `agent/AGENTS.md:14`; `scripts/pr-gate.sh --gate mission` fails a body with no `Mission:` line, so a landing has to say who is better off | It cannot guarantee the human *can evaluate* the diff. |
| 43. Meat proxy | respected | Agent output is never forwarded without local verification; the habit to keep | — |
| 44. Naive context compression | partial | `agent/extensions/om-autostart.ts`, `observational-memory.compactAtContextTokens` 120000 | Compaction is `deepseek-flash` summarisation, exactly the pattern named; it runs at a threshold, not mid-task, which protects the cache prefix — keep it that way. |
| 45. Stacked pull requests | respected | One branch, one PR, merged before the next starts; `merge-guard` makes stacking awkward | — |

## 5. Gaps ranked by cost of leaving them open

1. **Mutation survivors in `secret-guard.ts` and `merge-guard.ts`** (blip 2, Adopt, done
   at 93.30%). 79 of the 98 survivors sit in `secret-guard.ts` (92.42%), 17 in
   `merge-guard.ts` (95.01%) and 2 in `usage-format.ts` (97.50%), the two weakest first. They are mostly branch conditions the tests do not distinguish. The per-PR job
   (`break: 100`) already fails a changed file that keeps a survivor, so the weekly number
   is a backlog rather than a regression risk. Fix: read
   `agent/reports/stryker/mutation.html`, kill the survivors that map to a real branch.
   Cost: 2 hours.
2. **Package installs are still fetched by version range** (blips 7 and 72, partial). The
   lock file and the hidden-codepoint scan the last audit asked for now exist for skills —
   `agent/skills.lock` plus `git-hooks/scan-unicode.sh`, both offline-tested in
   `scripts/ci-offline.sh` — and the supply-chain path `docs/threat-model.md` §2.2 names is
   the one still open: a package listed under `settings.json` `packages` is resolved by
   range, with no hash and no record of what it may touch. Fix: record the resolved tarball
   hash per package and fail `scripts/harness-check.sh` when one drifts. Cost: an afternoon.

Closed since the previous audit: the threat model (blips 6 and 31,
`docs/threat-model.md` — assets, attacker paths by ATLAS tactic, the real binds and masks,
and the explicit "does not cover bare mode, including the bare big-boss-pi boss"), decision
models (blip 62, `/home/mark/big-boss-pi/bin/jev` plus `agent/skills/jev`), grilling (blip 13,
`agent/prompts/grill.md` plus the `session-nudge` grill rule), risk tiers (blips 17/42,
`agent/AGENTS.md:14` plus the `pr-tier` CI job), sandbox enforcement (blip 1, the `install.sh`
shell wrapper), the mutation score (blip 2, 79.15% from a reproducible `make mutate-full`),
prompt evals (blip 110, `agent/evals/` plus `make evals`) and workflow linting (blip 103,
`.github/workflows/zizmor.yml`, 0 findings). Since then: the per-PR mutation job with
`break: 100` (blip 2), the local body gates in `scripts/pr-gate.sh` behind `make pr-check`
(blips 71, 17, 42), commit-level provenance trailers from `git-hooks/commit-msg`
(blip 79, partial at line level), optional config shapes validated instead of hoped for
(blip 102, `agent/config/schema.mjs` plus `scripts/harness-check.sh --verify-config`), and
skills pinned by content with hidden codepoints refused at commit (blips 72 and 7,
`agent/skills.lock` and `git-hooks/scan-unicode.sh`, both with offline tests). Since this
pass: a second reader for the instruction files themselves (blip 34,
`.github/workflows/prose-review.yml`, pi#78 — it reports "not configured" until the
`PROSE_REVIEW_API_KEY` secret exists) and semgrep plus trivy as one CI scan job that any
finding fails (blip 89, `.github/workflows/test.yml`, pi#77).

The threat model re-scoped what remains, and the leftover gap inherits one of its paths.
The fetched-page and malicious-skill paths (`docs/threat-model.md` §2.1 and §2.4) now have
an adversarial case each (12a, 12b). The supply-chain path (§2.2, package installs) has a
sensor for the half that lives in this repo — a skill's bytes are pinned and scanned — and
none for the half that does not: an installed package's tarball is still unhashed.

Enforced by `scripts/harness-check.sh` on every commit and in CI: a cited blip must exist in
`docs/radar-blips.tsv` (no invented blip numbers), a stale `Review:` date fails the check
(blips 36, 39), and a flagship `defaultModel` fails (blip 40). `make audit` runs the whole
set for the quarterly pass.

Then, in order: Hunk or a `gh pr diff` review habit for agent-authored PRs (blip 96). Skipped deliberately: subagents
(blip 21) conflict with Pi's design — parallel sessions cover most of the need; and
unattended overnight builds (blip 23) stay blocked until the gaps listed above are closed.

## 6. Re-running this audit

0. Re-measure before editing a row: `cd agent && npm test` (the `# tests` / `# suites`
   lines), `bash scripts/harness-check.sh` (the `N passed, M warn, K failed` line), `make
   mutate-full` (the per-file table — it throws the incremental cache away; `--force` is
   Stryker 10's own switch for the same thing), `ls agent/skills`, `wc -c agent/AGENTS.md`,
   `wc -l ~/.pi/agent/suggestions.jsonl`, `bash scripts/ci-offline.sh`. A number you did not
   run this way goes in as **not re-verified**, with the date it last was.
1. Copy the blip list: `awk -F'\t' 'NR>1{print $1"\t"$4}' docs/radar-blips.tsv`.
2. For each harness-relevant blip, name the file that implements it. No file, no credit.
3. Any row that was `missing` and is now `done` should point at a commit, not at an intention.
4. Delete rows that no longer apply — a Radar audit that only grows is the instruction bloat
   blip 36 warns about.
