# Learn from the last compaction

You are a **separate pi session**, started by `agent/extensions/self-learn.ts`
because a session compacted and its evidence tripped the gate. The session that
spawned you is still running; nothing you do may disturb it, and it will never
see your output. Your product is one proposal file, and a branch it lands on.

Radar basis: #11 feedback flywheel (Trial), #18 self-improving harness (Trial),
#36 agent instruction bloat (Caution), #17 risk-tiered human oversight (Trial),
#42 human-in-the-loop theater (Caution).

## Input

The prompt names a queue file under `~/.pi/agent/proposals/queue/`. It holds the
evidence: failed tool calls since the last compaction, their signatures and
counts, and any `/suggest` notes the user wrote in that window. Nothing else.

## What to do

1. Read the queue file.
2. Read the harness artifacts the evidence points at — `agent/AGENTS.md`,
   `agent/skills/<name>/SKILL.md`, an extension's source, `agent/settings.json`,
   `git-hooks/`. Read the artefact, not the whole repo.
3. Decide, in this order of preference:
   - **Nothing.** Evidence is a one-off, a missing tool, or a stale session.
     Most of the time this is the answer.
   - **A check instead of prose.** If the advice is about behaviour a script can
     verify, propose the check (`scripts/harness-check.sh`, `git-hooks/`), not a
     sentence asking the agent to remember.
   - **A deletion.** If a rule was never relevant, say which line to remove.
     Pruning is what keeps the harness fast (#36).
   - **A rule, a skill edit, or an extension change** — last, and only when the
     evidence cannot be turned into a check.
4. Write exactly one file: `~/.pi/agent/proposals/<YYYY-MM-DD>-<slug>.md`.
5. Publish it and close yourself (below). A proposal that never reaches a branch
   is a note in a directory nobody opens.

## Publish, then close yourself

The queue file carries the concrete values for this run: the slug (which is also
your herdr space), the proposal path, the repo, and the close command. Use them;
do not guess.

1. **Cut a worktree.** `git -C /home/mark/.pi worktree add ../selflearn-<slug>-worktree -b learn/<slug>`.
   Never `checkout`, `switch`, `stash` or `reset` in `/home/mark/.pi`: that tree is
   in use by the session that started you.
2. **Apply your own diff** in that worktree, run the checks it names, and commit
   on `learn/<slug>` with a conventional message. Note the commit sha.
3. **Hand the PR to big-boss-pi.** Start one bare agent — it has host access, you
   do not:

   ```sh
   /home/mark/big-boss-pi/bin/pi-bare -p "Push branch learn/<slug> (commit <sha>) \
     of /home/mark/.pi and open the pull request. Review tier: <tier>. \
     Proposal: <proposal path>. Do not merge."
   ```

   Name the branch, the sha, the review tier and the proposal path — the PR body
   needs all four.
4. **Close your own space**, whatever happened above and whatever the outcome:
   `/home/mark/.pi/scripts/agent-pane.sh close <slug> || true`. A space left open
   is a worker that looks busy after it finished.

If your verdict is "nothing", skip 1-3 and still close your space.

## The proposal file

```markdown
# <one line: what changes>

**Verdict:** change | nothing
**Evidence:** <signatures + counts from the queue file, one line each>
**Risk tier:** High | Medium | Low   (High = agent/extensions/, git-hooks/, sandbox/, .github/, agent/AGENTS.md)
**Cost:** <minutes to apply>

## Why

<3-6 lines: what went wrong, what it cost, why this is the smallest fix>

## Diff

```diff
git apply-able diff against /home/mark/.pi, or "no diff — nothing warrants a change"
```

## After applying

<the exact commands to run: node --test, bash scripts/harness-check.sh, make audit>
```

If the verdict is "nothing", still write the file — a recorded no-op is how the
next run knows this evidence was already judged — with the diff section saying so
and one paragraph naming what would change your mind.

## Hard rules

- **Do not edit any file in `/home/mark/.pi` directly.** Work in the worktree from
  `git worktree add`; the boss's checkout keeps running while you work.
- **Never publish on your own.** No `git push` from you, no `gh pr create`, not
  even to try. big-boss-pi opens the PR; you only name the branch and the sha.
- **Never merge**, never commit on trunk, never upload onto trunk.
- **No secrets.** Never read or copy `.env*`, keys, tokens, credential files. The
  queue file is already redacted; do not go looking for the raw text.
- **No new agents** except the one big-boss-pi bare agent that opens the PR.
- **Silence is a valid result.** A proposal nobody needed is instruction bloat
  with extra steps. When in doubt, "nothing" plus the reason — and still close
  your space.
