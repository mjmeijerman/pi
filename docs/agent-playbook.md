# Working with coding agents — playbook

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-02-13 — quarterly, alongside the Radar audit (`docs/radar-conformance.md` §6).
Delete a rule that no longer earns its place (blips 36, 39).

For one developer running several Pi sessions on one machine. Every rule here maps to a
Radar Vol. 35 blip (see `radar-conformance.md`), and to a command that exists in this repo.
When a rule and reality part ways, delete the rule — instruction bloat is blip 36.

## 0. The loop, in nine steps

1. Decide the change in one sentence.
2. Open a session in the right directory, with the right model.
3. Grill the request until the ambiguity is gone (5 questions max).
4. Write the plan where you can see it; get it wrong cheaply.
5. Implement in one branch, in a sandbox if the repo is unfamiliar.
6. Let CI and the harness check the mechanical things.
7. Review the diff at the tier the change deserves.
8. Land through a PR, never by pushing to trunk.
9. Run `/suggest` and `/retro` before closing the loop.

Steps 1–4 cost minutes and save hours. Steps 5–8 are the part agents are good at. Step 9 is
the only step that makes the next session better than this one.

## 1. Start the session right

| Decision | How | Why |
| --- | --- | --- |
| Directory | Start in the repo you are changing, not `~` | Project config comes from `<cwd>/.pi`; starting in `~` loads nothing project-specific and used to trigger the stale `tools/` warning |
| Model | Default `deepseek-flash`; `qwen3.8:27b` for chores via `local_llm` | Blip 40: frontier by default is the mistake being avoided |
| Thinking level | `medium` for edits, `high` only for design and debugging | Thinking tokens bill as output |
| Trust | `pi` is sandboxed by default (`install.sh` installs the wrapper); `pi-bare` (the "Pi (bare)" row in Herdr's `+` menu) or `PI_BARE=1 pi` bypasses it, `pisandbox --no-net -- pi` adds network isolation (`sandbox/README.md`) | Blip 1: sandboxing is Adopt, and it is now the installed default instead of an opt-in prefix |
| Task size | One PR per session | A session that produced two PRs produced one PR nobody reviewed properly |

Sandbox choices:

```bash
pisandbox -- pi                         # no SSH keys, no cloud creds, network on
pisandbox --no-net --exec -- make test  # also no network (no net = no model)
pisandbox --rw ~/scratch -- pi          # one extra writable dir
```

## 2. Grill before you build

Blip 13: the agent interviews you about the plan before acting. Guessing is the default
failure mode, and it is expensive — a wrong plan survives implementation, review and merge.

Ask for it explicitly: `/grill` (`agent/prompts/grill.md`). It asks one question at a
time until nothing is ambiguous, then writes the plan. Say "grill me on this" if you prefer
the words — it runs the same prompt.

Good questions you should be able to answer before code:

1. What is the observable behaviour change?
2. What must not change?
3. How will we know it works — which command, which assertion?
4. What is the smallest version that is still useful?
5. What would make us revert this?

If you cannot answer 3, you are not ready to code. If you cannot answer 4, the task is an
epic and needs splitting.

## 3. Write the plan as an artifact

Blip 14: a plan you can step through beats a plan you read. Minimum viable version: a
numbered list in the session with one bounded action per line, plus the verification command
for each. Keep it in the session, not in a new Markdown file — document sprawl is blip 39.

Plan hygiene:

- One step = one action, one verification, no "and then".
- Say where each step touches disk (`path:line`) before you approve it.
- Delete the plan when the work lands; the PR body is the durable record.

## 4. Split the work across sessions, not subagents

Pi has no subagents by design. The equivalent is parallel sessions with Herdr, each with
its own working copy:

```bash
~/.pi/scripts/agent-pane.sh spawn fix-parser fix-parser.md    # hidden pi worker, screen untouched
~/.pi/scripts/agent-pane.sh show fix-parser                   # borrow the current pane to watch it
~/.pi/scripts/agent-pane.sh hide fix-parser                   # put the pane back
~/.pi/scripts/agent-pane.sh list                              # worker state
~/.pi/scripts/agent-pane.sh close fix-parser                 # when the work is in
```

Workers start hidden: herdr shows every new pane and tab immediately, so a visible pane
would move you off the tab you are reading. `show` swaps the worker into the pane you are
in (focus does not move) and `hide` puts it back.

Rules that keep this from turning into a tangle:

1. **Two to four workers at a time.** Blip 21's guidance; beyond that your review capacity, not
   the machine, is the bottleneck.
2. **One repo per worker, ideally one worktree per worker.** Two agents editing the same working
   tree produce a merge conflict you have to untangle by hand.
3. **Never let two workers work on the same file set.** If they must, they are one task.
4. **Close the worker when the PR is open.** A worker waiting for review is a worker burning
   attention.
5. **Write the spec to a file** (`fix-parser.md`) and pass the path. A pane that receives a
   sentence has to reconstruct intent; a pane that receives a spec does not.

The failure mode here is not agent speed, it is your review queue: changes arriving faster
than you can judge them. Blips 42 and 17. Cap panes to what you can review before the next
one finishes.

## 5. Route the model to the task

| Task | Route | Command |
| --- | --- | --- |
| Summarise a page, log or diff | local, free | `local_llm(task=summarize, ...)` |
| Extract fields, classify, translate | local, free | `local_llm(task=extract)` |
| Ordinary edits, tests, refactors | `deepseek-flash`, thinking medium | default |
| Design, debugging a spiral, migration plan | `deepseek-flash`, thinking high | `/thinking high` |
| Image or PDF understanding | model with vision input | `deepseek-flash` accepts images |

Two rules that override any routing table:

- **Switch models at boundaries, not mid-task.** Prompt caches are per model; switching per
  request throws the cache away. Switch at a new session, a new subagent, or the handoff from
  plan to implementation (blip 40).
- **Measure the route.** A cheaper model that needs three attempts costs more than the
  expensive one that finishes. `/usage-footer` and `scripts/session-report.mjs` show whether
  a change actually saved money (blips 26, 44).

## 6. Review at the tier the change deserves

Flat review intensity is how human-in-the-loop theater starts (blip 42). Assign the tier
before you look at the diff, from the paths touched:

| Tier | What is in it | Required |
| --- | --- | --- |
| High | `agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`, `sandbox/`, anything touching auth, secrets, money or data deletion | Line-by-line read by you, plus reasoning about what it breaks |
| Medium | Application code, tests, migrations | Diff read, tests green, one adversarial check for a case the author did not test |
| Low | Docs, comments, formatting, dependency patch bumps | CI green, skim |

Line-by-line review does not scale to agent output, and pretending it does is theater.
For anything above Low, the durable check is mechanical: mutation testing (blip 2, Adopt),
property-based tests, and a harness you trust to validate changes you did not read
(blip 23).

Practical review habits:

- `gh pr diff <n>` — read for the thing that is *missing*, not the thing that is present.
- Ask the agent: "what did you not change that you considered changing?" The answer is
  where the risk hides.
- Force one failing case: "break this test on purpose, show me it fails, then revert."
- Never approve a diff you cannot explain in one sentence to yourself.

## 7. Land it

Non-negotiable, enforced by `merge-guard.ts`:

1. Never commit on trunk. Branch first: `git switch -c <type>/<kebab-name>`.
2. Conventional commit, subject ≤ 72 chars, body explains *why*.
3. Push the branch, open a PR against `trunk` with What / Why / How / Testing, and the
   three lines the body gates read: `Mission:`, `Review tier:`, and `Test change:` when a
   test moved beside its source (`specs/areas/pr-gates.md`).
4. Merging is the user's decision. Say yes out loud, then `/mergeguard allow` and run the
   single merge command. A green CI run is not permission.
5. One branch = one logical change. If the PR needs a "stacked" explanation, split the work
   earlier instead (blip 45).

```bash
git switch -c fix/date-parser-tz
git commit -m "fix(parser): handle timezone offsets"
git push -u origin fix/date-parser-tz
# The body is a file, not a `--fill` summary of the commits: the gates read
# `Mission:`, `Review tier:` and `Test change:`, and a filled body never has them.
make pr-check BODY=/tmp/pr-body.md      # the same script pr-tier runs, in seconds
gh pr create --base trunk --body-file /tmp/pr-body.md
gh pr checks <n>          # then, and only then, ask for the merge
```

## 8. Keep the harness sharp

The harness is code and needs the same ownership as code (blips 11, 18, 36).

| Cadence | Action |
| --- | --- |
| Every session | `/suggest <what got in the way>` — one line, while it is fresh |
| Weekly | `/retro` — read the aggregate, then either fix the tool or delete the note |
| Monthly | Delete one rule from `AGENTS.md` or one skill nobody used. Deletion is the point; rules that only accumulate become bloat |
| Every compaction | Nothing, unless `self-learn` tripped its gate — then read `~/.pi/agent/proposals/` and either land the diff or delete the file. A proposal marked "nothing" is a judgement already made; do not re-open it |
| Quarterly | Re-run the Radar conformance audit (`docs/radar-conformance.md`) |
| After a model upgrade | Re-test whether an instruction is still needed — progression, not regression |

Hard budgets, checked when you edit the harness:

- `agent/AGENTS.md` ≤ 3 KB. It loads on every turn, in every project.
- Any skill > 150 lines: split it or cut it.
- Every extension declares its Radar basis in the file header, or it gets deleted.

When an agent gets something wrong, the order of fixes is: deterministic check (hook, test,
lint rule) → then an instruction. Instructions are the weakest enforcement you have.

## 9. Keep cost visible, not conversational

- Cache hit above 90% is the steady state for a long session. Below 50% means the session is
  restarting constantly or the prefix keeps changing.
- Compaction at 120k tokens (`om-autostart.ts`) is the safety net, not a strategy. Long
  sessions with many topic switches should just be restarted.
- Profile before optimising: `node ~/.pi/scripts/session-report.mjs`, then `--since 7d --top 5`.
- Do not trust token counts as progress. Blip 41: throughput is not productivity.

## 10. Safety rules that are not optional

1. **Secrets never enter a session.** No keys in prompts, files, commits or URLs. Rotate
   anything that was pasted (blips 1, 20).
2. **Sandbox unfamiliar code.** A fresh clone with a `package.json` postinstall script is
   equivalent to running a stranger's code with your SSH keys.
3. **Set a package release age.** `npm config set min-release-age 2` blocks versions
   published in the last 48 hours (blip 99). Cheap, and it defuses the fastest supply-chain
   attacks. The key is `min-release-age`: npm 11.20 rejects `minimum-release-age` as an
   unknown option, and the number is in **days**, not minutes — 1440 would mean four years.
   Check it with `npm config get min-release-age` → `2`.
4. **Approve actions, not vibes.** If you cannot evaluate what you are approving, escalate
   the review tier or reject the action.
5. **Read what you forward.** Passing agent output to a colleague unread makes you a meat
   proxy (blip 43).

## 11. Anti-patterns to watch for in yourself

1. Starting a session without a one-sentence goal, then steering by correction.
2. Approving a diff because CI is green.
3. Adding an instruction for every failure instead of a check.
4. Running five panes because four felt fast.
5. Measuring success in commits or tokens instead of DORA-style outcomes.
6. Importing a community skill library wholesale.
7. Letting a session run to context exhaustion instead of restarting.
8. Reading the agent's summary instead of the diff.
9. Skipping `/suggest` because it was "a small problem".

## 12. Quick reference

```bash
# sessions
pi                                    # interactive, in this directory
pisandbox -- pi                        # same, sandboxed
~/.pi/scripts/agent-pane.sh spawn s spec.md && ~/.pi/scripts/agent-pane.sh list   # hidden workers
~/.pi/scripts/agent-pane.sh show s        # borrow this pane to watch it; hide s puts it back
/grill                                 # interview the plan before coding (blip 13)

# git / GitHub
git switch -c feat/short-name
gh pr create --base trunk --body-file /tmp/pr-body.md
gh pr checks <n>

# harness maintenance
/suggest <what got in the way>
/retro
/learn                                 # judge the harness now, in a separate pi session
ls ~/.pi/agent/proposals/              # learner output: a diff, or a recorded "nothing"
scripts/harness-check.sh               # skill/AGENTS.md budget check (automation PR)
make mutate                            # mutation tests, incremental (blip 2)
make mutate-full                       # same, cache thrown away; stryker 10 calls that --force
/secretguard status        # session secret-guard state
/mergeguard allow          # one merge, only after an explicit yes

# measurement
node ~/.pi/scripts/session-report.mjs --since 7d --top 5
cd ~/.pi/agent && npm test
```
