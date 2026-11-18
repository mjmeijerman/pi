# merge-guard

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `agent/extensions/merge-guard.ts` changes.

**What this file is.** The landing rules the guard enforces today, mined from
`agent/extensions/merge-guard.ts` at trunk `4e40c9a`. Line numbers are that file. A rule change is
a delta in `specs/changes/`, not an edit to the rule text below.

## The rule under the rules

Landing a change is the user's decision, not the agent's (Radar blips 17 and 42, quoted at
`merge-guard.ts:33-34`). So the guard blocks the landing and leaves everything up to it open:
branching, committing on a feature branch, pushing that branch, opening a pull request (`:4-8`).

## Blocked, with the reason it names

| Blocked | Inside the segment | Reason text |
| --- | --- | --- |
| `gh pr merge` | `:172` | `gh pr merge` |
| `gh api … /merge` or `/merges` | `:173` | the pull-request merge API |
| a push naming trunk/main/master | `:174` | a push to the trunk branch |
| a bare `git push` while on trunk | `:238-239` | a push from `<branch>` |
| `git commit` / `git merge` while on trunk | `:236-237` | a commit on `<branch>` / a merge on `<branch>` |
| `git stash` and `git stash drop`/`clear` | `:188-199` | parks uncommitted work a checkout is still using |
| a commit, merge, push or stash naming no repo but run from a trunk session | fallback at `:225-228` | the same reasons |

`--dry-run` on a push, and `--help` anywhere, are never blocked (`:169-170`, `:193-194`,
`:232-233`).

## What is deliberately open

`git stash list`, `show`, `pop`, `apply` and `branch` (`STASH_SAFE`, `:179`) stay available,
because restoring work must never be blocked. A stash is blocked only in its saving and deleting
forms — the exact command `delegate` prints when it refuses a spawn on a dirty trunk is blocked
here, and the guard points at `git worktree add … origin/trunk` instead (`:255-272`, commit
`b79cd1e`).

## How a command is read

- Quoted text is dropped, heredoc bodies are dropped, then the line is split on `&&`, `||`, `;`,
  `|` and newlines (`:43-66`). A commit message or PR body that happens to say `gh pr merge` is
  text, not a landing (commit `3be916e`).
- The branch considered is the branch of **the repository the command targets**: `git -C /path
  …` and `cd /path && git …` are decided by `/path`, a command naming no directory falls back to
  the session cwd, and a path that is not a repository or sits on a detached HEAD is never
  reported as a trunk commit (`:103-160`, `:222-241`). `-C`, `-c`, `--git-dir`, `--work-tree`,
  `--namespace` and `--exec-path` are the flags that consume the next token (`:67`).
- Pushing an explicit other branch (`git push origin feature`) is not a trunk push (`:92-101`).

## The two ways through

1. `/mergeguard allow` (`:286-300`) arms **one** landing: the next blocked merge, trunk push or
   trunk commit runs and the allowance is spent (`:276-281`). Unrelated commands do not spend it,
   and `session_start` revokes it (`:246-249`).
2. The user says yes and then the agent runs `/mergeguard allow` — that ordering is the point:
   an approval a machine grants itself is not an approval.

## Not established

- Whether the guard is loaded in a bare (`PI_BARE=1`) session: the loader is pi's extension
  registry, not this file, and it was not run here.
- The `agent/extensions/__tests__/merge-guard.test.ts` cases were read, not executed, for this
  spec; `make scripts-test` does not run the extension suite.
