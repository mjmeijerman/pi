---
name: github-workflow
description: Git/GitHub workflow rules — every change goes on a feature branch and lands via a pull request, with conventional commits, gh CLI usage, and PR hygiene. The git user is always mjmeijerman. Use for any git or GitHub task (branching, commits, pushes, pull requests, reviews, merges).
---

# GitHub Workflow

## Identity & prerequisites

- The git/GitHub user is always **mjmeijerman**.
- Before any push/PR, verify: `git config user.name` is `mjmeijerman` and `gh auth status` shows mjmeijerman authenticated. If not, fix or ask — never push under a different identity.
- If `gh` is not installed or not authenticated, say so and ask before proceeding.

## Golden rule

**Never commit or push directly to `main` (or `master`).** Every change goes on a new branch, is pushed, and lands via a pull request. The only exception: the user explicitly and unambiguously asks for a direct commit.

## Standard workflow

1. **Sync first**: `git fetch origin && git switch main && git pull --ff-only` (or `git switch -c <branch> origin/main`).
2. **Create a branch** from the latest `main`: `git switch -c <type>/<short-kebab-description>`.
3. **Commit** with a conventional message (see below), in small logical commits.
4. **Run tests/lint** relevant to the change before pushing.
5. **Review your own diff**: `git diff origin/main...HEAD` — no debug code, no secrets, no leftover changes.
6. **Push**: `git push -u origin <branch>`.
7. **Open a PR** against `main` with `gh pr create` (see PR template below).
8. **Handle review feedback**: push fixes to the same branch, reply to comments, re-request review when ready.
9. **Merge** only when CI is green (and required approvals are in), prefer squash merge, then clean up.

## Branch naming

- `feat/` new features · `fix/` bug fixes · `docs/` documentation · `chore/` maintenance · `refactor/` · `test/`
- Short kebab-case: `feat/add-login`, `fix/date-parser-tz`, `docs/api-usage`.
- Never branch off a branch; always off the latest `main`.

## Commit messages

Conventional Commits format: `<type>(<scope>): <subject>` — e.g. `feat(auth): add login endpoint`, `fix(parser): handle timezone offsets`, `docs: update setup guide`.

- Subject: imperative, ≤ ~72 chars, no trailing period.
- Body: explain **why**, not what (the diff shows what). Reference issues with `Closes #12`.

## PR creation

```bash
gh pr create --base main --title "feat(auth): add login endpoint" --body "..."
# or: gh pr create --fill
```

Body template:

```
## What
<one paragraph>

## Why
<motivation / linked issue: Closes #123>

## How
<implementation notes, trade-offs>

## Testing
<commands run, test results, manual verification>
```

### Body gates (the ones CI actually reads)

`.github/workflows/pr-tier.yml` runs `scripts/pr-gate.sh`, and so does
`make pr-check BODY=<file>`. Same script, so the local verdict is the CI
verdict — run it before handing the PR over, not after a red check.

- `Mission: <line>` — a literal line, **not** a `## Mission` heading; 20+
  characters after the colon. A heading is markup and no gate reads it.
- `Review tier: High|Medium|Low` — a harness path in the diff
  (`agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`,
  `sandbox/`) is **High whatever the body claims**.
- `Test change: <reason>` — required when a test file changes beside its
  source; delete the line when it does not apply.

Start from `.github/pull_request_template.md`; every line a gate reads is in it.

- Small, focused PRs: one logical change per PR. Split large changes.
- WIP → open as **draft** (`gh pr create --draft`), promote when ready.
- Update the PR from `main` before it grows stale: `git switch main && git pull && git switch <branch> && git rebase main` (or merge `main` into the branch). Fix conflicts on the branch.

## Review cycle

- Address every comment; if you disagree, explain in a reply — don't silently ignore.
- Push fixes to the same branch; the PR updates automatically.
- Avoid force-push after reviewers have started; if rebase is necessary, prefer `git rebase main` for sync and `git push --force-with-lease` only on your own feature branch.

## Merging & cleanup

- Merge only when CI is green. Check with `gh pr checks <number>`.
- Prefer **squash merge** for a single-purpose branch, preserving a clean history.
- After merge: `gh pr merge <number> --squash --delete-branch`, then `git switch main && git pull --ff-only` to stay in sync.
- Never merge your own PR without review when a review is required — unless the user says otherwise.

## Safety rules

- No force-push to shared branches (`main`, long-lived branches).
- No secrets in commits, diffs, PR bodies, or commit messages (see the secret-guard rules; the git hooks enforce this).
- Never bypass failing CI or use admin privileges to merge — investigate the failure instead.
- If a push is rejected (non-fast-forward), pull/rebase first — never `--force`.
- When in doubt about history rewriting, merging, or permissions: ask the user.

## Cheatsheet

```bash
git fetch origin && git switch -c feat/my-change origin/main   # start
git push -u origin feat/my-change                              # push
gh pr create --base main --title "feat: my change" --body "..." # PR
gh pr view -w                                                  # open in browser
gh pr checks <number>                                          # CI status
gh pr merge <number> --squash --delete-branch                  # merge + cleanup
git switch main && git pull --ff-only                          # sync
```
