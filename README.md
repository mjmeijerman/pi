# pi agent config & security setup

This repository is the pi coding-agent configuration for this machine: skills, always-on extensions, and a multi-layer secret-protection setup for git.

## Contents

| Path | What |
|---|---|
| `agent/skills/` | pi skills: `cost-optimizer`, `secret-guard`, `ethical-hacker`, `gh-repo-scan`, `questionnaire`, `ui-ux` |
| `agent/extensions/` | always-on extensions: `cost-optimizer`, `secret-guard`, `om-autostart`, `dictation`, `usage-footer` |
| `git-hooks/` | global secret-scan hooks (`pre-commit`, `commit-msg`, `pre-push`) + installer |
| `git-vuln-scan` | pre-push agent vulnerability scan (GitHub pushes) |
| `git-templates/` | `git init` template that installs the vuln-scan hook into new repos |
| `gitignore_global` | global gitignore for secret files |
| `install.sh` | one-command installer (what `make setup` runs) |
| `Makefile` | `setup` / `verify` / `hooks` / `update` / `uninstall` |

## One-step install on a new PC

```bash
git clone git@github.com:mjmeijerman/pi.git ~/pi-setup
cd ~/pi-setup
make setup          # or: ./install.sh --install-pi
```

`make setup` installs pi itself if missing (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), copies skills/extensions/settings into `~/.pi/agent`, installs the global git hooks, global gitignore, `git-vuln-scan`, and the git templates. It is **idempotent** — safe to re-run any time (also the fix if you ever suspect the hooks are gone).

It does **not** copy machine-specific or secret files: `auth.json`, sessions, `bin/`, `models-store.json`, or your `~/.gitconfig` identity. Set `git config --global user.name/email` once on the new machine.

## Following the Technology Radar

The harness is deliberately shaped by the [Thoughtworks Technology Radar](https://www.thoughtworks.com/radar) — currently **Volume 35, November 2026**. The rules in `agent/AGENTS.md` cite blip numbers, and each change here should trace back to one.

Where this repo came from, in Radar terms:

| Blip | Ring | What it produced here |
|---|---|---|
| #1 agent sandboxing | Adopt | `sandbox/` bubblewrap launcher |
| #29 harness quality evaluation | Assess | `agent/extensions/__tests__/` |
| #30 local coding models | Assess | `local_llm` tool on the local qwen model |
| #11 feedback flywheel, #25 agent suggestion box | Trial / Assess | `/suggest`, `/retro` |
| #26 context profiling | Assess | `tools/session-report.mjs` |
| #36 agent instruction bloat | Caution | lean `AGENTS.md`, rules replaced by hooks where possible |

The edition PDF is not committed (15 MB, third-party, read once) — read it from the Radar site instead.

## Observational memory

Long sessions are compacted by [`pi-observational-memory`](https://github.com/michielpapenhove/pi-observational-memory) (community fork of Amos Blomqvist's extension) instead of Pi's default threshold compaction. It observes ~10k-token chunks, keeps an index plus topic files in `.memory/<session-id>/`, and compacts at `observational-memory.compactAtContextTokens` (set to 120k here, under the 150k working limit).

`agent/extensions/om-autostart.ts` enables it at session start — the extension's own gate defaults to off, so without it every session needs a manual `/om on`. Pi's built-in `compaction.enabled` threshold stays as the far-away last resort.

Notes: the worker models are configured separately from the chat model (`deepseek-flash`, medium/high thinking), `.memory/` is in the global gitignore, and `/om:status` shows memory path, coverage and worker cost.

## Protection layers

1. **Secret-guard extension** — secrets never reach the model: user-input redaction, tool-call blocking (`.env`, keys, credentials), tool-output redaction, always-on system-prompt rules, audit log at `~/.pi/agent/secret-guard.log` (pattern names only, never values).
2. **Cost-optimizer extension** — token-minimal responses, same professional quality (always active).
3. **Git `pre-commit`** — blocks staging secret files or values (name + content scan).
4. **Git `commit-msg`** — blocks secret commit messages.
5. **Git `pre-push`** — scans every pushed commit (contents, filenames, messages); catches `--no-verify`/`-f` commits. Last gate before secrets leave the machine.
6. **`git-vuln-scan`** — interactive agent vulnerability review on GitHub pushes (choose `c`ontinue / `f`ix / `a`bort).
7. **Global gitignore** — `.env`, `*.pem`, `*.key`, credentials, etc. are never staged by `git add .`.

Repo-local hooks are preserved: the global wrappers chain to your repo's own `.git/hooks/<name>`.

## Commands

| Command | Effect |
|---|---|
| `/secretguard status` | show whether protection is active |
| `/secretguard allow` | process secrets this session (not recommended) |
| `/secretguard block` | re-enable protection |
| `/skill:cost-optimizer` | load the cost-optimizer skill explicitly |

## Overrides (last line of defense is you)

- `SKIP_SECRET_SCAN=1 git commit/push …` — skip secret scan for one operation
- `git commit --no-verify` / `git push --no-verify` — skip all hooks
- `git add -f .env` — force-stage a gitignored file (pre-commit still blocks it)
- `SKIP_VULN_SCAN=1` — skip the agent vuln scan for one push
- Repos that set their own `core.hooksPath` (e.g. husky) bypass the global wrappers

## Updating

```bash
cd ~/.pi
make update        # git pull + reinstall
```

## Uninstalling (on any machine)

```bash
make uninstall     # unset the global git config keys
rm -rf ~/.pi/git-hooks ~/.pi/gitignore_global ~/.git-templates ~/.local/bin/git-vuln-scan
```

## Verifying

```bash
make verify
```

Expected output: `pi` found, `hooksPath` = `~/.pi/git-hooks`, `excludesFile` = `~/.pi/gitignore_global`, `templateDir` = `~/.git-templates`, `git-vuln-scan` found. In pi itself, `/secretguard status` should report protection active.

## If a secret ever leaked

If a secret was committed and pushed (or shared anywhere), it must be **rotated** — git history is permanent. Treat it as compromised. The hooks prevent this from happening in the first place; they cannot undo it.
