# merge-guard

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `agent/extensions/merge-guard.ts` changes.

**What this file is.** The landing rules the guard enforces today, checked against
`agent/extensions/merge-guard.ts` at trunk `d825563`; that file is byte-identical to `4e40c9a`,
where these line numbers were first taken. A rule change is a delta in `specs/changes/`, not an
edit to the rule text below.

## The rule under the rules

Landing a change is the user's decision, not the agent's (Radar blips 17 and 42, quoted at
`merge-guard.ts:31-32`). So the guard blocks the landing and leaves everything up to it open:
branching, committing on a feature branch, pushing that branch, opening a pull request (`:4-8`).

## Blocked, with the reason it names

| Blocked | Inside the segment | Reason text |
| --- | --- | --- |
| `gh pr merge` | `:171` | `gh pr merge` |
| `gh api … /merge` or `/merges` | `:172` | the pull-request merge API |
| a push naming trunk/main/master | `:173` | a push to the trunk branch |
| a bare `git push` while on trunk | `:238-239` | a push from `<branch>` |
| `git commit` / `git merge` while on trunk | `:236-237` | a commit on `<branch>` / a merge on `<branch>` |
| `git stash` and `git stash drop`/`clear` | `:188-200` | a `git stash` / a `git stash <verb>` |
| a commit, merge or push naming no repo but run from a trunk session | fallback at `:229-235` | the same reasons |

`--dry-run` on a push, and `--help` anywhere, are never blocked (`:169`, `:173`, `:191`, `:228`,
`:239`). The stash rule is the exception to "while on trunk": it is judged by subcommand only, so
it blocks in a feature tree too.

## What is deliberately open

`git stash list`, `show`, `pop`, `apply` and `branch` (`STASH_SAFE`, `:180`) stay available,
because restoring work must never be blocked. A stash is blocked only in its saving and deleting
forms — the exact command `delegate` prints when it refuses a spawn on a dirty trunk is blocked
here, and the guard points at `git worktree add … origin/trunk` instead (`:256-271`, commit
`b79cd1e`).

## How a command is read

- Heredoc bodies are dropped first, then quoted text, then the rest is split on `&&`, `||`, `;`,
  `|` and newlines (`:43-65`). Heredocs go first because their delimiters are often quoted and
  unquoting would eat them. A commit message or PR body that happens to say `gh pr merge` is text,
  not a landing (commit `3be916e`).
- The branch considered is the branch of **the repository the command targets**: `git -C /path
  …` and `cd /path && git …` are decided by `/path`, a command naming no directory falls back to
  the session cwd, and a path that is not a repository or sits on a detached HEAD is never
  reported as a trunk commit (`:114-160`, `:222-241`). `-C`, `-c`, `--git-dir`, `--work-tree`,
  `--namespace` and `--exec-path` are the flags that consume the next token (`:68`).
- Pushing an explicit other branch (`git push origin feature`) is not a trunk push (`:92-101`):
  the from-trunk rule consults the refspecs (`:239`). The trunk-push rule does not — a segment
  that mentions trunk, main or master is blocked whatever the refspec names (`:173`).

## The two ways through

1. `/mergeguard allow` (`:288-303`) arms **one** landing: the next blocked merge, trunk push, trunk
   commit or stash runs and the allowance is spent (`:276-280`, stash at `:257-261`). Unrelated
   commands do not spend it, and `session_start` revokes it (`:248-250`).
2. The user says yes and then the agent runs `/mergeguard allow` — that ordering is the point:
   an approval a machine grants itself is not an approval.

## Not established

- Whether the guard is loaded in a bare (`PI_BARE=1`) session: the loader is pi's extension
  registry, not this file, and it was not run here.
- The `agent/extensions/__tests__/merge-guard.test.ts` cases were read, not executed, for this
  spec; `make scripts-test` runs `scripts/tests/*.test.mjs` and does not run the extension suite.
