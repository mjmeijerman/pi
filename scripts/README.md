# pi session hygiene tools

Scripts for answering "where did my tokens and disk go?", "what can I
throw away?" and "is the harness still inside its own budgets?". They use only
core modules / coreutils, and none of them deletes anything.

| File | What it does |
| --- | --- |
| `session-report.mjs` | Read-only report: tokens, cost, cache hit rate, context fill, disk per project + most expensive sessions + stale sessions. |
| `prune-sessions.sh` | Moves old session logs into `./archive/`. Dry-run unless `--apply`. |
| `harness-check.sh` | Read-only `PASS`/`WARN`/`FAIL` checks for the playbook's rules: budgets, install state, ownership, and the skill pin. `--write-skills-lock` is its one writing mode: it regenerates `agent/skills.lock`. `--verify-doc-facts` runs the transport table alone. |
| `doc-facts.txt` | The transport table: one line per subject saying which transport serves it, which one it must never be described with, and the files that talk about it. Hand-edited; `harness-check.sh` turns it into `PASS doc-facts`/`FAIL doc-facts` lines. |
| `ci-offline.sh` | Runs every `test-*.sh` next to it: the gate tests that build their own temp repos and need no network. `make offline-test` runs the same thing CI does. |
| `test-*.sh` | One suite per gate behaviour, plain bash. `test-skills-lock.sh` covers `agent/skills.lock`, `test-unicode-guard.sh` covers the hidden-codepoint scan in the pre-commit hook. |
| `pr-gate.sh` | The PR body gates (mission, review tier, test change) CI runs, runnable locally before the push. |
| `harness-baseline.txt` | The ratchet `harness-check.sh` reads: known violations report `WARN`, not `FAIL`. |
| `pisandbox` | `~/.pi/sandbox/pi-sandbox.sh` without typing the path. |
| `archive/` | Created on first `--apply`. Holds moved sessions, same project layout. |

Data source: `~/.pi/agent/sessions/<slugified-cwd>/<timestamp>_<uuid>.jsonl`.
One JSONL file per session; each `assistant` message and each `compaction`
entry carries a `usage` object.

## session-report.mjs

```bash
node session-report.mjs                      # default: 30d staleness window, top 10
node session-report.mjs --since 90d --top 5
node session-report.mjs --json | jq '.projects'
node session-report.mjs --sessions /tmp/store --models ~/.pi/agent/models.json
```

Options: `--since <30d|12h|2w|6mo|1y|2026-01-01>`, `--top <n>`, `--json`,
`--sessions <dir>`, `--models <file>`, `--help`.

Runtime: ~0.6 s for 110 sessions / 260 MB.

### Columns

| Column | Meaning |
| --- | --- |
| `project` | Session store directory, i.e. the working directory with `/` → `-` (`home-mark-escaperoom` = `/home/mark/escaperoom`). The real `cwd` is read from each session's header line. |
| `sess` | Number of session files in that project. |
| `input` | Sum of uncached prompt tokens (`usage.input`). |
| `output` | Sum of completion tokens (`usage.output`). Reasoning tokens are already inside this number. |
| `cache-r` | Cache-read tokens: prompt tokens served from the provider's prompt cache. |
| `cache-w` | Cache-write tokens (cache creation). DeepSeek and local models report 0. |
| `cost` | USD, see [Cost model](#cost-model). |
| `hit` | Cache hit rate = `cacheRead / (input + cacheRead + cacheWrite)`. 99% means almost every prompt token was a cache hit — the normal steady state for a long session. 0% means the session never got cache reuse (usually many short sessions or a model without caching). |
| `ctx` | Mean context fill at the end of each session, as a percentage of the model's `contextWindow`: `(last prompt tokens) / contextWindow`. Sessions where the model is unknown or reports no usage are excluded. High values mean sessions ran near the compaction limit. |
| `disk` | Bytes on disk (file sizes, matches `du -sb`). |
| `last` | Date of the last timestamped entry in any of that project's sessions. |

`TOP N MOST EXPENSIVE SESSIONS` is ranked by cost, not by disk size — the two
diverge because tool output is huge on disk but cheap in tokens. The
`cost split:` line under the table shows where the money went: input, output,
cache read, cache write (same breakdown as the live usage footer).

`STALE SESSIONS` = last activity older than `--since` (default 30 days),
sorted by size. This is the reclaimable set; the printed line is the exact
`prune-sessions.sh` command to act on it.

### Cost model

Mirrors `extensions/usage-footer.ts` so the numbers match the live footer:

- `deepseek*` — always recomputed from the message timestamp using peak
  (01–04, 06–10 UTC) and off-peak rates. The `usage.cost` recorded inside old
  sessions was written by older rate tables and is ignored on purpose.
- other models — the provider-recorded `usage.cost` is trusted; if it is zero,
  rates from `models.json` are applied as fallback.
- models with no rates (e.g. local `qwen3.8:27b`) cost `$0` and are listed in
  the footer line of the report as "unpriced".
- model ids are matched exactly, then by prefix, then by shared leading token —
  so a session logged as `deepseek-flash` still inherits `deepseek-v4-flash`
  pricing and context window.

### JSON output

`--json` prints one JSON document, pretty-printed: `generatedAt`,
`sessionsDir`, `window`, `totals`, `window_totals`, `projects[]`,
`topSessions[]`, `stale{count,bytes,sessions[]}`. Totals are the sum of the
rounded per-project rows, so checks like
`jq '.projects | map(.cost) | add' == .totals.cost` hold exactly.

`--json | head -20` shows the first 20 lines only, so the preview is
truncated — pipe through `jq` for the real thing:

```bash
node session-report.mjs --json | jq -r '.projects[] | "\(.project)\t\(.cost)"' | sort -k2 -rn
```

### Malformed input

Truncated or corrupt JSONL lines are skipped and counted, never fatal. The
report prints `Skipped N malformed line(s) out of M` when any are found;
`--json` exposes `totals.malformedLines` and per-project `malformedLines`.

## prune-sessions.sh

```bash
./prune-sessions.sh                          # dry run, 30d
./prune-sessions.sh --older-than 90d          # dry run, 90d
./prune-sessions.sh --older-than 30d --apply  # actually move
```

Options: `--older-than <30d|12h|8w|6mo|1y>`, `--apply`, `--sessions <dir>`,
`--archive <dir>`, `--help`.

- Age is the file modification time (last write to the log).
- Without `--apply` it prints the list and the total reclaimable size, and
  moves nothing (`--apply` is the only way to change the disk).
- With `--apply`, each file goes to `archive/<project-slug>/<session>.jsonl`.
  Nothing is deleted; a file already present in the archive is skipped.
- A warning is printed when `--older-than` is under 7 days.

Restore one session:

```bash
mv ~/.pi/scripts/archive/--home-mark-projects-ACE--/<name>.jsonl \
   ~/.pi/agent/sessions/--home-mark-projects-ACE--/
```

pi will list it again on the next `--resume` in that directory.

## harness-check.sh

Anything a script can check must not be a paragraph in `AGENTS.md` (blip 36).
`harness-check.sh` is that script for the harness itself: the playbook's hard
budgets, plus the install state they depend on. Read-only — it never writes and
never touches the network.

```bash
bash scripts/harness-check.sh            # everything, one line per check
bash scripts/harness-check.sh --quick    # budgets only, <1 s (the git hook runs this)
bash scripts/harness-check.sh --json     # one JSON document, same exit code
bash scripts/harness-check.sh --root DIR # check another checkout
bash scripts/harness-check.sh --verify-config  # only the config-file shapes
bash scripts/harness-check.sh --verify-release-age  # only the npm quarantine
```

Exit 0 when nothing `FAIL`s, 1 on any `FAIL`. What it checks:

| Check | Rule |
| --- | --- |
| `agents-md-size` | `agent/AGENTS.md` ≤ 3072 B — it loads on every turn. |
| `skill-lines` | every `agent/skills/*/SKILL.md` ≤ 150 lines. |
| `doc-metadata` | every `docs/*.md` has `Owner:` and `Review:` (blip 39). |
| `review-freshness` | no doc or skill past its own `Review:` date. |
| `extension-radar-basis` | every `agent/extensions/*.ts` header cites its Radar blips. |
| `npm-min-release-age` | npm refuses versions younger than 2 days — the value is in days, not minutes (blip 99). |
| `config-schema` | `agent/settings.json` and `agent/models.json` match the shapes in `agent/config/schema.mjs`; an unknown key `FAIL`s with a one-edit suggestion, and `agent/keys.json` is checked by shape only, never by value (blip 102). |
| `git-hooks-path` | global `core.hooksPath` is `~/.pi/git-hooks`. |
| `git-hooks-templates` | `~/.git-templates/hooks` is populated (the `git init` layer). |

Two hooks call this: the global pre-commit wrapper runs `harness-pre-commit`
(`--quick`) before the secret scan, only when a budgeted file is staged; CI runs
the full check on every PR and weekly on a schedule. The schedule is the
automated version of "delete a rule monthly / re-audit quarterly" — a check that
nobody runs is a paragraph with extra steps.

## pr-gate.sh

The three body gates `.github/workflows/pr-tier.yml` enforces — mission line,
review tier (with the harness-path rule), test change justified — in one place.
The workflow calls this script and so does `make pr-check`, so a local verdict
and the CI verdict cannot disagree. Read-only: it prints a verdict, it never
edits a PR.

```bash
make pr-check BODY=pr.md                        # merge base of origin/trunk and HEAD
make pr-check BODY=pr.md BASE=origin/trunk HEAD=HEAD
make pr-check BODY=pr.md BRANCH=my-branch       # that branch, without switching
make pr-check BODY=pr.md PATHS=changed.txt      # explicit changed paths
bash scripts/pr-gate.sh --body pr.md --gate mission   # one gate, like CI
```

A body file is the only required input: with no `PATHS` the script derives the
changed files from `git diff` (the merge base of `origin/trunk` and `HEAD`, or
`BASE_SHA`/`HEAD_SHA` from the environment as CI passes them). Green means
checked — a run given no file list, or one whose diff cannot be resolved (no
`origin/trunk`, a shallow clone), fails and names what it could not check
instead of passing. Passing an empty `PATHS` file is a gate handed nothing and
fails the same way, and so is an empty diff: a checkout sitting on trunk diffs
trunk against trunk, so the run says `unverifiable: no changed files` and
prints the command that shows the branch's real diff. `BRANCH=<branch>` checks
another branch from this checkout (merge base of `origin/trunk` and that
branch), which is how a tree on trunk checks a worker's branch without moving.

Exit 0 green, 1 a body CI would reject or a gate that had nothing to check,
2 bad usage, a diff that cannot be resolved, or an empty diff. The output is the
CI verdict verbatim, including which harness path forced High and which diff was
read:

```text
tier: medium
Harness paths in the diff (tier must be High):

- `agent/extensions/__tests__/secret-guard-branches.test.ts`
::error::harness paths changed; tier must be High (blips 17, 42) — offending paths: agent/extensions/__tests__/secret-guard-branches.test.ts
```

In CI the markdown block goes to `$GITHUB_STEP_SUMMARY`; locally it goes to
stdout. `.github/pull_request_template.md` carries every line a gate reads.

## harness-baseline.txt

One `path:check` per line, `#` starts a comment. A violation listed there is
reported `WARN` instead of `FAIL`, so pre-existing debt does not block new work
while new violations still fail. It is a ratchet: **lines only ever come out.**
Fixing the violation means deleting its line, not adding a rule to `AGENTS.md`.

```text
# 223 lines, over the 150-line skill budget. Delete when the split lands.
agent/skills/achterhoek-agenda/SKILL.md:skill-lines
```

Do not add a line to make a new violation pass. Fix it, delete the rule, or
delete the file.

## pisandbox

Thin `exec` wrapper around `~/.pi/sandbox/pi-sandbox.sh`, symlinked to
`~/.local/bin/pisandbox` by `install.sh`. An opt-in safety measure behind a
40-character path is one that never gets used (blip 1, Adopt).

```bash
pisandbox -- pi                     # no SSH keys, no cloud creds, network on
pisandbox --no-net --exec -- cmd    # also no network at all (no net = no model)
pisandbox --rw ~/scratch -- pi      # one extra writable directory
```

Every argument is passed through untouched; `PI_SANDBOX` overrides the path to
the underlying script. `pisandbox --help` prints the three forms above.

## When to prune — recommendation

1. **Do not prune anything you might still resume.** A session file is the only
   copy of that conversation. Cost is already spent; the file is only worth
   its recovery value.
2. **Prune by size when disk is the problem, by age when in doubt.** Every run
   of `session-report.mjs` gives both.
3. **Practical policy for this machine (260 MB, 110 sessions):**
   - keep everything from the last 30 days (that is 63 sessions / 249 MB here),
   - archive sessions older than 90 days first (`--older-than 90d`) — zero
     cost impact, pure disk win,
   - only after that consider 30 days. Today that reclaims 11 MB, so the win
     is small: the real disk hogs are 4 recent escaperoom sessions worth
     160 MB. Those are recent and expensive — keep them, or move them
     deliberately with `--apply --older-than 7d` after deciding.
4. **Re-run the report before every prune.** A single new long session can add
   50 MB; a stale-session list from last week is meaningless.
5. **Archive, never `rm`.** `archive/` is inside this tools directory; deleting
   it is a separate, explicit decision.

## Notes

- Nothing here writes to `~/.pi/agent/` — `session-report.mjs` only reads, and
  `prune-sessions.sh` only moves files *out* of it when `--apply` is passed.
- Both scripts accept `--sessions` so you can point them at a copy before
  trusting them with the real store.
