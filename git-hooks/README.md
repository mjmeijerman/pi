# Secret Guard — global git hooks

Mechanical protection so secrets never end up in git, in any repo you commit to.

## What it does

- `pre-commit`: scans **staged** files (names and content) for secrets and blocks the commit (max 10 findings reported, as `pattern name` + `file:line` — never the value).
- `commit-msg`: scans commit messages for secret values, then appends provenance. When the environment carries a worker slug (`AGENT_SLUG`, or `PI_AGENT_SLUG`; `delegate spawn` exports it), the message ends with `Agent-Slug: <slug>` and `Spec: specs/<slug>.md` — added at commit time, so the trailer is there before anything can refuse the commit for missing it. No slug, no change: a human commit is untouched, existing trailers are never duplicated, and `--no-verify` bypasses it like any hook. Logic: `add-provenance.sh`; tests: `scripts/tests/commit-msg-provenance.test.sh`.
- `pre-push`: scans every **pushed commit** (file contents, filenames, commit messages) — the last gate before secrets leave your machine. Catches `--no-verify`/`-f` commits, merges, cherry-picks.
- `pre-push` also **chains to the repo's own hook** (e.g. husky, a team hook), if one exists. The `git-vuln-scan` agent scan was removed from the pre-push path.
- Every other hook name is a thin wrapper that **chains to your repo's own `.git/hooks/<name>`**, so existing hooks (husky, pre-commit framework, …) keep working.
- `~/.pi/gitignore_global` (via `core.excludesFile`) keeps `.env`, `*.pem`, `*.key`, credentials, etc. from being staged with `git add .`.

## One-command installer (new PC, or if you forgot the hooks)

```bash
# clone your ~/.pi repo to the new machine, then:
<clone>/install.sh
```

Installs everything: agent skills/extensions/settings, global hooks, global gitignore, and the git templates. Idempotent — re-run any time.

## Install / undo

```bash
~/.pi/git-hooks/install-hooks.sh     # generate wrappers + set core.hooksPath
```

```bash
# undo:
git config --global --unset core.hooksPath
git config --global --unset core.excludesFile
git config --global --unset init.templateDir
rm -rf ~/.pi/git-hooks ~/.pi/gitignore_global ~/.git-templates ~/.local/bin/git-vuln-scan
```

## Overrides (use sparingly — you are the last line of defense)

- `SKIP_SECRET_SCAN=1 git commit ...` — skip the scan for one commit
- `AGENT_SLUG=` (empty) `git commit ...` — write a commit without the provenance trailers
- `git commit --no-verify` — skip all hooks
- `git add -f .env` — force-stage a file that is gitignored (the pre-commit hook still blocks it)

## Notes

- Repos that set their own `core.hooksPath` (e.g. husky) bypass the global wrappers.
- Secret scans still run on every push. The agent-based `git-vuln-scan` is no longer wired into any hook; run `git-vuln-scan` by hand when you want it.
- If a secret was ever committed and pushed, **rotation is required** — history is permanent.
- The pre-commit hook scans only staged content. Secrets in untracked files are covered by the global gitignore.
