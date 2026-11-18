# Radar adoption brief — four `missing` blips, and what each would change here

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-15
Radar: Thoughtworks Technology Radar, Vol. 35 (`werken-met-ai.pdf`, the same file the audit
reads). Baseline measured 2026-11-18 in `/home/mark/.pi` at `trunk` `7012b0f`; every number
below was produced by the command next to it, in the `## Evidence` block.
Decision this brief supports: **pick one of four** — not implement one.

Mission: a person who cannot see a green `harness-check` line today is better off, and the
observation is that line going from `1 failed` to `0 failed` on a host that never had the
toolchain `setup.sh` demands — which is what only one of these four delivers.

## 0. Spec history

The previous decision in this area is `specs/archive/radar-refresh-2.md` (written 2026-11-15,
the last Radar spec in `specs/archive/`). It re-measured `docs/radar-conformance.md` and
flipped rows that had shipped; it left 68, 73, 74 and 82 as `missing` with `—` in the
evidence column (`docs/radar-conformance.md:39`, `:64`, `:65`, `:76`). So this brief is the
first pass that has actually looked at the four rather than inheriting them.

Two of those four rows state a fact that is wrong, which the refresh could not have caught
because it never read the code behind them:

- `:76` (blip 82) says "no delta/archive step". There is one: `bin/delegate:1499-1505`
  moves a finished spec into `specs/archive/`, and `bin/delegate:1220` injects "read the
  newest `specs/archive/` spec for this area first" into every worker spec it writes.
- `:65` (blip 74) says task state "lives in `/tmp` spec files". It lives in a real directory:
  `/home/mark/big-boss-pi/specs/` (135 files), `specs/archive/` (71), `reports/` (198), with
  `state/decisions.jsonl` and `state/usage.jsonl` written by `bin/delegate:186-188`. Not
  `/tmp`, and not queryable either — the directory is **not a git repo**
  (`git rev-parse` → "not a git repository").

## 1. Ring correction — one of the four numbers in the task does not match the Radar

| blip | name | the task said | Radar Vol. 35 says | where I looked |
| --- | --- | --- | --- | --- |
| 68 | mise | Adopt | **Adopt**, kept: "We're keeping it in Adopt because it consolidates three fragmented concerns" | p.38 |
| 73 | ast-grep | **Assess** | **Trial** | p.40, "73. ast-grep / Trial" |
| 74 | Beads | (unstated) | **Trial**, moved: "We're moving Beads to Trial because many of our developers now use it by default with coding agents" | p.40 |
| 82 | OpenSpec | (unstated) | **Trial**, moved from Assess: "Since we featured it in Assess in April … enough to move it to Trial" | p.43 |

Also checked against the repo's own copy: `docs/radar-blips.tsv:69,74,75,83` says
`Adopt/Trial/Trial/Trial` — which agrees with the PDF and disagrees with the brief's
"Assess" for ast-grep. `docs/radar-conformance.md` files ast-grep under §2 Trial (`:64`),
consistent with both. Treat 73 as Trial, not Assess. No other correction needed; all four
blip numbers exist and the names match.

## 2. Baseline measured today, before any of this

| signal | today | command |
| --- | --- | --- |
| `harness-check` | **63 passed, 4 warn, 1 failed** (`FAIL npm-min-release-age`: "npm 10.9.9 ignores min-release-age (needs npm ≥ 11)", "`~/.local/bin/npm` is a dangling symlink"), 9 s | `bash scripts/harness-check.sh` |
| `npm test` | **958 tests, 98 suites, 0 fail**, 9 s | `cd agent && npm test` |
| offline shell suites | 2 suites, 33 assertions, 0 failed, 2 s | `bash scripts/ci-offline.sh` |
| CI shape | 6 workflows; a docs-only PR starts **11 job runs** (`extension-tests` matrix 24+26 counts twice); `mutation` is weekly-only | `grep` of `.github/workflows/*.yml` |
| CI wall clock, per PR | `mutation-changed` recorded 710 mutants in **25m18s** (job 134170533027, `.github/workflows/test.yml:122`); per-job times for the rest were **not verified** — `gh` is not logged in inside the sandbox | `gh run list` → "run gh auth login" |
| node the host actually has | **v22.23.4** (`/usr/bin/node`), npm 10.9.9 | `node -v`, `npm -v` |
| node the repo demands | **24 or newer**, `setup.sh:192` (`die`) and `:195` (warn) | `sed -n '192,197p' setup.sh` |
| places the node major is restated | **7 lines in 4 files** (`setup.sh:192,195`; `test.yml:27,73,145`; `harness-check.yml:37`; `prose-review.yml:59`) | `git grep -nE '"2[46]"\|Node 2[46] or newer\|older than 24\|node-version: "24"' -- '*.sh' '*.yml'` |
| places the npm major is restated | **8 lines in 4 files** (`setup.sh:315,316,319`; `harness-check.sh:417,419`; `harness-check.yml:41,42`; `.github/zizmor.yml:4`) | `git grep -nE 'npm@11\|npm >= 11\|npm ≥ 11' -- '*.sh' '*.yml' -- ':!docs/'` |
| `agent/AGENTS.md` headroom | **3065 bytes of 3072** → 7 bytes free | `wc -c agent/AGENTS.md`; `AGENTS_MD_LIMIT=3072` at `scripts/harness-check.sh:60` |
| task/prose backlog on disk | 135 live specs, 71 archived, 198 reports — none of it in git | `ls specs \| wc -l` etc. in `/home/mark/big-boss-pi` |

Two numbers in `docs/radar-conformance.md` are already stale: it claims 741 tests / 82 suites
(now 958 / 98) and 60 passed / 3 warn (now 63 / 4) — the doc's own §6 rule says re-measure
before trusting it. That is a separate, later mission; it is not fixed here.

---

## 3. Blip 68 — mise (Adopt, p.38)

**1. The problem, in this repo.** The toolchain the repo demands is not the toolchain the
host has, and nothing reconciles them. `setup.sh:192` dies without node and `:195` warns
below major 24; the host runs **22.23.4** and npm **10.9.9**, both from `/usr/bin`. That gap
is not hypothetical — it is the source of the one red line in today's run:
`FAIL npm-min-release-age — npm 10.9.9 ignores min-release-age (needs npm ≥ 11)`, whose
second half is a broken install path, `~/.local/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js`
with the target missing. The version is restated in **7 lines across 4 files** (table above),
one of which is prose in a `warn` string (`setup.sh:195`: "pi 1.5.x expects 24 or 26") that
no check can read. There is no `mise.toml`, no `.tool-versions`, no `.nvmrc`, and no
`engines` field in `agent/package.json` — so a second host resolves nothing.

**2. What adoption concretely changes.** One new file, `mise.toml`, holding `node = "24"` and
`npm = "11"`; `setup.sh`'s two literals become a read of that file; the five `node-version:`
lines in CI either stay (Actions needs its own node) or become one `mise install` step.
Afterwards a developer types `mise install` instead of discovering that `/usr/bin/node` is
too old — and `mise trust` / `mise ls` answer "which version is this repo on" for the first
time. The dangling `~/.local/bin/npm` symlink is deleted, not papered over.

**3. Cost.** `mise.toml` (new, ~4 lines), `setup.sh` (~10 lines changed), optionally 5 CI
lines. **It adds a host tool and therefore a sandbox change**: `sandbox/pi-sandbox.sh:159-164`
binds three directories read-only by name (`~/.local/bin`, `~/.local/share/pipx`,
`~/.local/share/uv`) and `:345` sets the sandbox `PATH`; mise's install root
(`~/.local/share/mise`) would be a fourth entry. That makes the sandbox half of this PR
**High tier** (`sandbox/` is High per `agent/AGENTS.md`), so a reviewer reads it line by line.
No runtime dependency is added to the repo's own tests: `agent/package.json` keeps its single
devDependency, and everything offline still runs — mise is needed to *install* a runtime
(network), never to *run* the suite (which is `node --test`).

**4. The measurable signal.** Today `harness-check` ends `1 failed`; after adoption,
`FAIL npm-min-release-age` is gone → **0 failed**, and `node -v` reports 24.x from mise
rather than 22.23.4 from `/usr/bin`. Secondary: lines restating the node major drop **7 → 2**
(one in `mise.toml`, one CI matrix pair), and `mise ls` is the first command that answers
"which version" without reading four files.

**5. Verdict: adopt.** The deciding reason: it is the only one of the four that fixes an
existing failure — the `1 failed` line in `harness-check` and `setup.sh:192`'s unmet
precondition are both version-management bugs, and the Radar puts it in Adopt because
attestation (`Cosign`, GitHub artifact attestations) comes with the pin, which is the half of
supply chain this repo has no sensor for (`docs/radar-conformance.md` §5, gap 2).

## 4. Blip 73 — ast-grep (Trial, p.40)

**1. The problem, in this repo.** No structural check exists anywhere. `agent/package.json:9-11`
carries exactly one package (`@stryker-mutator/core`); there is no `tsconfig.json` anywhere
under `agent/`, no eslint, no biome; `git ls-files 'agent/extensions/*.ts' | wc -l` = **41**
files. What the harness does check about TypeScript is nothing: `npm test` checks behaviour
(958 cases) and `scripts/harness-check.sh` checks markdown and shell (`:497` Owner/Review
header regex, `:591` blip-number regex, `:248` a token regex over `SKILL.md`). The Trap in the
brief was real and worth the check: **`sg` on this host is not ast-grep** —
`/usr/bin/sg` is util-linux 2.41.5's own `sg` (the newgrp sibling), so `sg --version`
printing "sg from util-linux 2.41.5" is a name collision, not an install. And the repo already has a byte-level scanner
for the one syntactic evil it cares about (`git-hooks/scan-unicode.sh`, bidi and homoglyphs),
so the AST niche is narrower than it looks.

**2. What adoption concretely changes.** A `sgconfig.yml` plus a `rules/` directory, and one
line in `scripts/harness-check.sh` (or a `make lint-structural`) that runs `sg scan` over
`agent/extensions/**/*.ts`. The only rule with a real failure behind it is erasable-only
syntax: node runs these `.ts` files by stripping types, so a single `enum` or parameter
property would fail at load, not at compile. Today there are **zero** such constructs
(`git grep -cE '^(export )?(enum|namespace) |constructor\(private'` → no matches), so the rule
would guard a class of breakage that has never happened. Realistically a developer types
`sg run -p '...' -l ts` instead of `rg` for the two or three conventions that are shapes.

**3. Cost.** New binary (Rust, so installable offline once fetched but fetched over network),
one config file, one rules directory, one check line. Not a runtime dependency of the repo —
but it is a second toolchain to keep current, next to the node one, which is exactly what
blip 68 exists to consolidate; adopting 68's manager is what would make 73's install
reproducible at all.

**4. The measurable signal.** Today: 41 `.ts` files, **0** structural rules, 0 findings.
After: 1 config + N rules, and the number that matters is findings-on-a-clean-trunk, which
must be 0 or the rules are noise. Cost side: `harness-check` is 9 s today and would gain a
tool invocation; `npm test` (958/98, 9 s) is unchanged either way, which is the honest
measure of how little 73 buys *here*.

**5. Verdict: skip (for now).** The deciding reason: the failure it prevents has zero
instances in 41 files and `npm test` already catches behaviour, so adoption adds a second
toolchain and a rule file nobody has asked for — the instruction-bloat path blip 36 warns
about, at 7 bytes of headroom in `AGENTS.md`.

## 5. Blip 74 — Beads (Trial, p.40)

**1. The problem, in this repo.** The work backlog is real and lives outside version control.
`/home/mark/big-boss-pi` is **not a git repo**; it holds 135 live specs, 71 archived specs and
198 reports, 1.6 MB each for specs and reports. `state/` holds `usage.jsonl` (353 bytes) and
no `delegations.json` at all — `bin/delegate:186-187` names `state/delegations.json` and
`state/decisions.jsonl`, so the queryable half is created only when a worker is spawned and
cannot be inspected today. Closing a worker is prose-adjacent: `bin/delegate` refuses a report
without an `## Evidence` block, and the check reads markdown. Nothing links a task to a line
of code; the link is the `Spec:` trailer written by `git-hooks/commit-msg` (blip 79, partial).

**2. What adoption concretely changes.** A `.beads/` store inside the repo (JSONL/SQLite,
git-backed per the blip) and `bd` as the way a task is created and closed; `delegate`'s slug
becomes a bead id; a report's "still open" section becomes a row instead of a paragraph. What
it deletes: nothing — the 198 reports stay, and Beads' own instructions would try to land in
`agent/AGENTS.md`.

**3. Cost.** A second git-backed store in the same repo, one new binary, and instructions.
The Radar's own caution is the one that bites here: "review the instructions Beads writes
into AGENTS.md" (p.40). `agent/AGENTS.md` is **3065 bytes against a 3072-byte limit**
(`scripts/harness-check.sh:60`) — there is **7 bytes** of room, so `harness-check` FAILs on
the first line Beads appends. That is not a preference, it is a hard wall. Offline: the store
is local, so the offline gate survives; the binary is another toolchain (see 73).

**4. The measurable signal.** Today: **0** machine-readable, git-versioned task rows; 135
unversioned spec files; 198 report files read by prose. After: `bd list` returning N rows that
survive a clone, and one query that answers "what did the last four workers on
`secret-guard.ts` leave open" — today that answer is 6 commits and 198 markdown files.

**5. Verdict: skip.** The deciding reason: this harness already has the thing Beads models —
`delegate spawn/close/sweep` plus one file per worker — and Beads' price of entry is editing
`agent/AGENTS.md`, which has 7 bytes free. Blip 80 (Linear) is already `n/a` for the same
reason: one person, no team backlog to split.

## 6. Blip 82 — OpenSpec (Trial, p.43)

**1. The problem, in this repo.** No spec is versioned with the code it describes. `docs/` is
5 tracked files, 4 with the `Owner:`/`Review:` header the check enforces
(`scripts/harness-check.sh:497-498`) — the closest thing to a spec convention here, and it
describes current state, not the delta that changed it. The place a decision actually lives is
a PR body and a spec file in a non-git directory: `agent/extensions/secret-guard.ts` has **6**
commits and `merge-guard.ts` has **4**, and a reader wanting "why is the flow ledger reset per
run" has to find the right report among 198. Meanwhile the *loop* is half-built already:
`bin/delegate:1499-1505` archives a spec and `:1220` tells the next worker to read it — so
the missing half is the persistent source-of-truth spec the deltas are against, and putting it
in git. `agent/prompts/grill.md` (34 lines) covers the up-front questions the blip also asks
for (`:32`, "if the answers leave the spec ambiguous … stop").

**2. What adoption concretely changes.** A `specs/` directory *in the repo* with one
`<area>.md` per area (`secret-guard`, `merge-guard`, `sandbox`, `pr-gates`) and a `changes/`
directory holding one delta per PR; `bin/delegate`'s archive step learns to fold a merged
delta into the area spec instead of moving a file out of `specs/`. A developer's habit changes
from "write a spec in big-boss-pi" to "read the area spec, write the delta, archive on merge".
Deletions: none — the 71 archived specs stay where they are.

**3. Cost.** Markdown only: one new directory, 4 area files to start, ~15 lines in
`bin/delegate`, and one `scripts/harness-check.sh` rule (every `changes/*.md` names an area
spec that exists). **No runtime dependency at all**, and nothing about the offline path
changes — `scripts/ci-offline.sh` (2 suites, 33 assertions, 2 s) does not touch `specs/`.
The real cost is the one blip 39 names: 4 more documents that can go stale; the existing
`review-freshness` check is what keeps them honest.

**4. The measurable signal.** Today: **0** spec files under version control in `/home/mark/.pi`
(`git ls-files docs/` = 5, none a spec); 6 commits to `secret-guard.ts`, 4 to `merge-guard.ts`,
each explainable only by its PR body. After: `git ls-files specs/` = 4 + one delta per open
change, and `harness-check` gains a PASS row that a delta's area spec exists. Corrected claim
for `docs/radar-conformance.md:76`: the delta/archive step is not missing
(`bin/delegate:1499-1505`), what is missing is its *location* — a store the code repository
carries.

**5. Verdict: assess further.** The deciding reason: it is the cheapest of the four (markdown,
zero dependency, Low tier) but it overlaps a mechanism that already exists outside the repo,
so the value is entirely in moving the loop into git — worth one small PR, not a framework.

---

## 7. Ranking, best first

| # | blip | verdict | why it ranks here |
| --- | --- | --- | --- |
| 1 | 68 mise | adopt | Fixes a live `1 failed` in `harness-check` and `setup.sh:192`'s unmet node requirement; Adopt ring; 7 restatements → 2. Cost: one High-tier sandbox line. |
| 2 | 82 OpenSpec | assess further | Zero dependency, Low tier, and half the loop already exists at `bin/delegate:1499-1505` — the cheapest durable gain. |
| 3 | 74 Beads | skip | Adds a store this harness already has, and `agent/AGENTS.md` has 7 bytes free of its 3072-byte budget. |
| 4 | 73 ast-grep | skip | 0 instances of the breakage it prevents across 41 `.ts` files, `npm test` (958) already covers behaviour, and `sg` on this host is util-linux's, not ast-grep. |

## 8. The smallest first step — one PR on the top one (blip 68)

One branch, two files, no sandbox change, no CI change, no new dependency to run anything:

1. `mise.toml`, new, four lines: `[tools]` with `node = "24"` and `npm = "11"`.
2. `setup.sh:192-197`, ~8 lines: read the pinned node major out of `mise.toml`
   (`sed`/`grep`, no TOML parser) and use it in both the `die` and the `warn`, so the two
   literals become one source. When `mise` is absent, behaviour is exactly what it is today.
3. Optional, separate commit: `rm ~/.local/bin/npm` on the host — the dangling symlink named
   in the FAIL line. That is a machine action, not a PR.

Tier: **Medium** (no `sandbox/`, `.github/`, `agent/extensions/` or `agent/AGENTS.md` path
touched; it is shell next to the toolchain). Reviewer reads it in two minutes. What it proves
or disproves: whether one file can own the version without the sandbox bind — because once
`mise` is *actually used*, `sandbox/pi-sandbox.sh:159-164` must learn `~/.local/share/mise`,
and that is the second, High-tier PR.

## Evidence

Command: `cd /home/mark/.pi && bash scripts/harness-check.sh 2>&1 | grep -E '^(FAIL|WARN)' ; bash scripts/harness-check.sh 2>&1 | tail -2 ; cd agent && npm test 2>&1 | grep -E '^# (tests|suites|pass|fail)' ; cd .. && node -v && npm -v && git grep -nE '"2[46]"|Node 2[46] or newer|older than 24|node-version: "24"' -- '*.sh' '*.yml' | wc -l && wc -c agent/AGENTS.md && (command -v mise || echo "mise: not on PATH") && sg --version && git ls-files 'agent/extensions/*.ts' | wc -l`

Output:

```
WARN skill-lines              agent/skills/valentina-grading/SKILL.md              352 lines / 150 (baselined, see scripts/harness-baseline.txt)
FAIL npm-min-release-age      -                                                    npm 10.9.9 ignores min-release-age (needs npm ≥ 11) — the sandbox cannot install a global npm; from a host shell run: bash /home/mark/.pi/setup.sh — /home/mark/.local/bin/npm is a dangling symlink; remove it: rm /home/mark/.local/bin/npm
WARN stale-baseline           learn/learn-11-19:learn-branch-published             no longer violates anything — delete this line, the ratchet only shrinks
WARN stale-baseline           learn/learn-11-51:learn-branch-published             no longer violates anything — delete this line, the ratchet only shrinks
WARN stale-baseline           learn/learn-12-07:learn-branch-published             no longer violates anything — delete this line, the ratchet only shrinks
63 passed, 4 warn, 1 failed
Fix the FAIL lines above. A violation that predates the check belongs in scripts/harness-baseline.txt, not in AGENTS.md.
# tests 958
# suites 98
# pass 958
# fail 0
v22.23.4
10.9.9
7
3065 agent/AGENTS.md
mise: not on PATH
sg from util-linux 2.41.5
41
```

Second command, for the claims about where the backlog and the versions live:
`ls specs | wc -l ; ls specs/archive | wc -l ; ls reports | wc -l ; git rev-parse --is-inside-work-tree ; git log --oneline -- agent/extensions/secret-guard.ts | wc -l`

```
135
71
198
fatal: not a git repository (or any of the parent directories): .git
6
```

## Thrown away

- A first draft ranked ast-grep second on the strength of the brief's "Assess ring" claim;
  the PDF (`73. ast-grep / Trial`) and `docs/radar-blips.tsv:74` both say Trial, so the
  ranking sentence was rewritten and the correction table added.
- A draft claim that mise would need a `sandbox/pi-sandbox.sh` change to *run* node was
  trimmed: `:82-88` resolves node with `readlink -f` and `:148` binds whatever prefix it
  lands in, so the bind is generic. Only the read-only whitelist at `:159-164` is by name.
- Row 82's inherited claim ("no delta/archive step") and row 74's ("`/tmp` spec files") were
  dropped as false and replaced with the paths that exist.

## What I would not repeat

Verify the ring before writing a single recommendation — one wrong ring reorders the whole
brief, and the repo already carries the answer in `docs/radar-blips.tsv`. And read
`bin/delegate` before claiming anything is missing from the workflow: half of blip 82 was
already implemented there.
