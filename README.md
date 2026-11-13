# pi agent config & security setup

This repository is the pi coding-agent configuration for this machine: skills, always-on extensions, and a multi-layer secret-protection setup for git.

## Contents

| Path | What |
|---|---|
| `agent/skills/` | pi skills: `cost-optimizer`, `secret-guard`, `ethical-hacker`, `gh-repo-scan`, `questionnaire`, `ui-ux` |
| `agent/extensions/` | always-on extensions: `cost-optimizer`, `secret-guard`, `merge-guard`, `om-autostart`, `dictation`, `usage-footer` |
| `git-hooks/` | global secret-scan hooks (`pre-commit`, `commit-msg`, `pre-push`) + installer |
| `git-vuln-scan` | pre-push agent vulnerability scan (GitHub pushes) |
| `git-templates/` | `git init` template that installs the vuln-scan hook into new repos |
| `gitignore_global` | global gitignore for secret files |
| `sandbox/` | bubblewrap launcher + policy selftest (`pi-sandbox.sh`) |
| `herdr-mods/` | Herdr window mods: `prs` shows open pull requests with merge |
| `scripts/` | session report / prune helpers + Herdr pane launcher |
| `docs/` | Radar conformance audit and the agent working playbook |
| `install.sh` | config + hooks only, non-interactive |
| `setup.sh` | full provisioning on a new machine: packages, API key, pi packages, optional model/venv, verification |
| `Makefile` | `setup` / `bootstrap` / `verify` / `hooks` / `update` / `uninstall` |

## Rebuild this exact machine on another PC

```bash
# clone to ~/.pi so the absolute paths in AGENTS.md resolve
# (a clone elsewhere works too; setup.sh copies sandbox/ and scripts/ into ~/.pi)
git clone git@github.com:mjmeijerman/pi.git ~/.pi
cd ~/.pi
./setup.sh
pi
```

`setup.sh` is the whole story: it asks for the API key, installs the system
packages it can, puts config and hooks on disk, reconciles the pi packages named
in `settings.json`, and then verifies the result (sandbox selftest, 215 extension
tests, hook paths, key present). Read it before running it — 300 lines, no
network calls except apt, `pi update` and the optional model pull.

Every skill, extension and pi package is offered one at a time — name,
one-line description taken from the file's own header, then `install? [Y/n]`.
Enter keeps it, `n` skips it. Declining a package runs `pi remove`, so it leaves
`settings.json` instead of coming back on the next update. Nothing already on
disk is deleted; a skipped component that was installed earlier just stays, and
the script says so.

| Flag | Effect |
| --- | --- |
| `-y`, `--yes` | Accept every prompt: installs the full set (the API key is still typed by you) |
| `--dry-run` | Print the plan, change nothing |
| `--no-apt` | Never call `sudo apt-get`, only report missing packages |
| `--with-ollama` | Pull `qwen3.8:27b` (~17 GB) for the `local_llm` tool |
| `--with-dictation` | Build the faster-whisper venv (~2.5 GB of wheels) |
| `--force-key` | Replace an existing `deepseek.key` |
| `--no-verify` | Skip the verification block |

What it does **not** do, because it is a per-machine identity rather than
config: `git config --global user.name/email`, `gh auth login`, and `pi auth`
for any provider other than DeepSeek. It prints a reminder when any of them is
missing.

`make setup` runs `./setup.sh`. `make bootstrap` runs the subset that touches no
secrets and no system packages (`--no-apt --no-verify`).

### Herdr window

`herdr-mods/prs` is a mod for the Herdr app: open pull requests on the left,
the diff on the right, and what you do about it underneath.

Left: **every open pull request you can see** — your own repositories, your
organisations and anything you are involved in — grouped by repository with the
number of open PRs next to the name; click the repository to fold it away,
review requests come first, with author, age, a green check, `!` for failing
checks and `≠` for conflicts. Click one and the right side shows its diff: file
headers with `+n −n` counts, hunk headers, line numbers, a filled green/red sign
gutter, tinted added and removed lines, horizontal scroll.

Right, below the diff: a note field with `approve`, `request changes` and
`comment`, then four buttons that open **a new space** with a pi agent already
told what to do:

| button | the agent is asked to |
| --- | --- |
| `1 review the PR` | read the diff and its surroundings, post one review, touch no code |
| `2 fix pipeline` | read the failing job, reproduce it, fix the cause, push to the branch |
| `3 fix merge conflicts` | merge the base branch in, keep both intents, run the tests, push |
| `4 fix review comments` | address each comment, reply where it disagrees, push |

The space starts in the repository's local clone when one can be found (a few
usual roots are probed for a matching `origin`), otherwise in `$HOME` with an
instruction to clone it first. Every task says: never merge, never push to
trunk.

| key | does |
| --- | --- |
| `↑` `↓` / `j` `k` | move |
| click a changed line | pick it: its number turns into `#` and the note field gets a `note on <file>:<line>` chip |
| `[` `]` | move the line cursor without the mouse |
| `enter` | with a line picked: post the note as a review comment on that line and start an agent that fixes it. Otherwise it sends the pending review |
| `a` `x` `c` | approve · request changes · comment (note required for the last two; `x` and `c` also start an agent on the comments) |
| `m` | merge, squash — press twice. Afterwards the local clone's trunk is fast-forwarded and the merged branch is deleted there |
| `1` `2` `3` `4` | the four agent actions |
| `o` | open the PR in the browser |
| `r` | refresh (it also repolls every two minutes) |
| `esc` | drop the picked line, then the pending review |

A line note goes out as a one-comment review (`POST /pulls/<n>/reviews` with
`event: COMMENT`), so added and context lines use `side: RIGHT` with the new
line number and removed lines `LEFT` with the old one. Then a new space gets an
agent told which file and line the note is on, what it says, and to reply to the
comment once it is fixed.

It lives in the `Apps` space, `Pull requests` tab. Rebuild on a new machine:
`install.sh` copies the folder into `$HOME/.config/herdr-app/mods/` when the app
is installed, and never overwrites a folder that already exists (you may have
edited the mod in place). Then:
```bash
herdr-app do space.new --name Apps --folder "$HOME"
herdr-app do tab.new --space <space-id> --name "Pull requests" --mod prs
```

What the merge does locally, in the repository's clone (found by name in `$HOME`,
`$HOME/code`, … and matched on its `origin` URL): `git fetch --prune`, checkout
the default branch if the merged branch was checked out, `merge --ff-only
origin/<default>`, then delete the merged branch — forced only when it pointed
at exactly what was pushed. A dirty tree, local commits on the branch, or a
trunk that is not a fast-forward is reported in the sentence at the top instead
of being forced.

### What is not in git, and why

| Not tracked | Why | How it comes back |
| --- | --- | --- |
| `agent/deepseek.key` | Secret | Prompted by `setup.sh`, written mode 600 |
| `agent/auth.json`, `models-store.json` | Provider tokens | `pi auth` |
| `agent/sessions/` | Conversation history | Not restored; starts empty |
| `agent/bin/` | `fd`/`rg` extracted by pi | Re-extracted on first run |
| `agent/dictation/venv/` | 2.5 GB of wheels | `--with-dictation` |
| `agent/npm/`, `agent/git/` | Installed packages | `pi update --extensions` |
| `agent/suggestions.jsonl`, `agent/retro/` | Local feedback log | Starts empty |
| Ollama model weights | 17 GB | `--with-ollama` |
| `werken-met-ai.pdf` | 15 MB third party | Radar site |

`install.sh` alone (config + hooks, no interactivity) still works: `./install.sh --install-pi`.
It is idempotent — re-run it any time, including when you suspect the hooks are gone.

## Following the Technology Radar

The harness is deliberately shaped by the [Thoughtworks Technology Radar](https://www.thoughtworks.com/radar) — currently **Volume 35, November 2026**. The rules in `agent/AGENTS.md` cite blip numbers, and each change here should trace back to one.

Where this repo came from, in Radar terms:

| Blip | Ring | What it produced here |
|---|---|---|
| #1 agent sandboxing | Adopt | `sandbox/` bubblewrap launcher |
| #29 harness quality evaluation | Assess | `agent/extensions/__tests__/` |
| #30 local coding models | Assess | `local_llm` tool on the local qwen model |
| #11 feedback flywheel, #25 agent suggestion box | Trial / Assess | `/suggest`, `/retro` |
| #26 context profiling | Assess | `scripts/session-report.mjs` |
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
