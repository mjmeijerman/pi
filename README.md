# pi agent config & security setup

This repository is the pi coding-agent configuration for this machine: skills, always-on extensions, and a multi-layer secret-protection setup for git.

## Contents

| Path | What |
|---|---|
| `agent/skills/` | 8 pi skills: `achterhoek-agenda`, `cost-optimizer`, `ethical-hacker`, `gh-repo-scan`, `github-workflow`, `questionnaire`, `secret-guard`, `ui-ux` |
| `agent/extensions/` | 14 always-on extensions: `cost-optimizer`, `desktop-notify`, `dictation`, `feedback-flywheel`, `herdr-agent-state` (installed by herdr), `herdr-resume-map`, `local-llm`, `merge-guard`, `om-autostart`, `sandbox-badge`, `secret-guard`, `self-learn`, `session-nudge`, `usage-footer` |
| `agent/prompts/` | prompt templates: `/grill` (interview the plan before coding, blip 13) |
| `git-hooks/` | global secret-scan hooks (`pre-commit`, `commit-msg`, `pre-push`) + installer |
| `git-vuln-scan` | pre-push agent vulnerability scan (GitHub pushes) |
| `git-templates/` | `git init` template that installs the vuln-scan hook into new repos |
| `gitignore_global` | global gitignore for secret files |
| `sandbox/` | bubblewrap launcher + policy selftest (`pi-sandbox.sh`) |
| `herdr-mods/` | Herdr window mods: `prs` shows open pull requests with merge |
| `scripts/` | session report / prune helpers + Herdr pane launcher |
| `docs/` | Radar conformance audit and the agent working playbook |
| `install.mjs` | the installer engine, one file for Linux, macOS and Windows (config, hooks, bin entries, services) |
| `setup.mjs` | the interactive pass: per skill, per extension, per AGENT rule and per key, then `install.mjs` |
| `install.sh`, `setup.sh` | thin shims so the old commands still work: they exec the Node entry points |
| `INSTALL.md` | quick start on a bare machine: prerequisites, one command per OS, the questions in order |
| `docs/install.md` | the install reference: every flag, the environment overrides, what lands where, per-OS facts, uninstall, troubleshooting, secrets |
| `Makefile` | `setup` / `bootstrap` / `verify` / `hooks` / `update` / `uninstall`, plus `mutate` / `mutate-full` for mutation testing (blip 2) |

## Rebuild this exact machine on another PC

```bash
git clone https://github.com/mjmeijerman/pi.git ~/.pi   # or anywhere; setup copies what it needs
cd ~/.pi
./setup.sh            # asks what to keep, then installs
pi
```

`setup.sh` and `install.sh` are one-line shims now: the work happens in
`setup.mjs` (the questions) and `install.mjs` (the install), both plain Node 24
with no dependencies. They run on **Linux, macOS and Windows**.

Quick start for a bare machine: [INSTALL.md](INSTALL.md). The reference — what it
asks in which order, every flag, the per-OS differences, uninstall and
troubleshooting — is [docs/install.md](docs/install.md). `node setup.mjs --help`
prints the flag list from the same table the parser reads; do not restate the
flags here, they have one home.

Preflight, once per machine: Node 24 (`.node-version`, pinned from `mise.toml`)
and `git`. On Windows, run them from Git Bash or PowerShell.

`install.mjs` is non-interactive and idempotent: skills, extensions,
`settings.json`/`models.json`/`keybindings.json`/`i-have-adhd.json`/`package.json`,
`~/.pi/sandbox` + `~/.pi/scripts` (AGENTS.md names them by absolute path), the
global git hooks plus their `init.templateDir` layer, the global gitignore,
`git-vuln-scan`, `pisandbox`, `pi-bare`, the Herdr "Pi (bare)" menu row, the
managed `pi()` sandbox wrapper in `~/.bashrc`/`~/.zshrc`, `herdr-app` (vendor
installer), the `big-boss-pi` clone with its `jev`/`delegate`/`local-run` bin
entries, and the guard service. Its sections keep the old `install.sh` numbering
0..5, so a reader can map one file onto the other.

A second run writes nothing. It never replaces a file you may have edited in
place: Herdr mods, `herdr-app/programs.json`, anything outside the
`# >>> pi sandbox >>>` markers, and an existing `AGENTS.md` rule set (that one
`setup.mjs` asks about).

| What | Linux | macOS | Windows |
|---|---|---|---|
| sandbox (`bubblewrap`) | installed and wraps `pi` | not available — one line, no failure | not available — one line, no failure |
| bin entries in `~/.local/bin` | symlinks | symlinks | copies (a symlink needs elevation or Developer Mode) |
| guard service | systemd user unit, enabled | launchd plist, opt-in with `PI_ENABLE_SERVICES=1` | Task Scheduler entry at logon, same opt-in |
| weekly timers (`pi-evals`, `pi-retro`) | systemd timers | skipped, one line | skipped, one line |
| `herdr-app` | `curl … install.sh \| sh` | same | `irm … install.ps1 \| iex` |

Everything above is one table in `scripts/install-lib.mjs` (`OS_PLAN`) plus one
copy-vs-symlink helper — three places at most, on purpose.

`setup.mjs` asks, with a default on every question and `-y` for the defaults:
skills (one per `agent/skills/` entry), extensions (one per
`agent/extensions/*.ts`), the agent rules (one per bullet in `agent/AGENTS.md`,
shown as `rule 4 of 17` across its 7 sections), and the two keys. Answers are
recorded in `~/.pi/state/setup.json`, so a dropped rule stays dropped;
`--reask` ignores the record. A key is asked with the terminal echo off, never
printed and never logged, and written only to the file that owns it
(`agent/deepseek.key`, `agent/env.secret`, both mode 600). The optional extras it
offers, both defaulting to no, are the local ollama model (`qwen3.8:27b`, ~17 GB)
and the faster-whisper venv for dictation (~2.5 GB).

`./setup.sh -y --no-keys --no-apt --no-verify` is the CI-shaped run: it is what
`.github/workflows/install-matrix.yml` executes on `ubuntu-latest`,
`macos-latest` and `windows-latest`, twice, with a throwaway `HOME` and
`PI_SKIP_NETWORK=1`, then asserts the manifest and that the second run changed
nothing (`scripts/verify-install.mjs`).

`make setup` runs `./setup.sh`. `make bootstrap` runs the subset that touches no
secrets and no system packages (`--no-apt --no-verify`).

### When to stop and go back (revert triggers)

The port is worth keeping only while these hold. Hitting one means report it and
stop, not grind:

1. a Windows install that needs manual fixes to work;
2. per-OS special cases spreading past three places (the `OS_PLAN` table, the
   copy-vs-symlink helper, and the service step);
3. the CI matrix unavailable — no Windows or macOS runner, or a job that has to
   be skipped to stay green;
4. more than one worker-day across two attempts without a green matrix run;
5. start-at-login on macOS or Windows proving flaky.

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
`comment`, then four buttons that each start **a new agent** — a new tab in the
`big-boss-pi` space, with the job as its first message (the space is made when
it is missing, and never a second time):

| button | the agent is asked to |
| --- | --- |
| `1 review the PR` | read the diff and its surroundings, post one review, touch no code |
| `2 fix pipeline` | read the failing job, reproduce it, fix the cause, push to the branch |
| `3 fix merge conflicts` | merge the base branch in, keep both intents, run the tests, push |
| `4 fix review comments` | address each comment, reply where it disagrees, push |

The new agent starts in `/home/mark/big-boss-pi`, where that workspace's
`AGENTS.md` makes it hand the job to a worker in the repository's local clone
when one can be found (a few usual roots are probed for a matching `origin`),
and to clone it first when there is none. Every task says: never merge, never
push to trunk. No button ever types into an agent that is already running.

| key | does |
| --- | --- |
| `↑` `↓` / `j` `k` | move |
| click a changed line | pick it: its number turns into `#` and a comment box opens underneath it |
| `[` `]` | move the line cursor without the mouse |
| `post comment` in that box | posts the text as a review comment on that line and starts an agent that fixes it; the line stays picked |
| `a` `x` `c` | approve · request changes · comment (note required for the last two; `x` and `c` also start an agent on the comments) |
| `m` | merge, squash — press twice. The row leaves the list the moment GitHub confirms it, then the local clone's trunk is fast-forwarded and the merged branch is deleted there |
| `1` `2` `3` `4` | the four agent actions |
| `o` | open the PR in the browser |
| `r` | refresh (it also repolls every two minutes) |
| `esc` | drop the picked line, then the pending review |

Both note boxes are multi-line: Enter starts a new line and never posts, the box
grows to four rows and then scrolls, and posting is only ever the button next to
it. The box under the diff is the comment on the picked line; the box at the
bottom is the note that goes with the whole-PR review.

A line note goes out as a one-comment review (`POST /pulls/<n>/reviews` with
`event: COMMENT`), so added and context lines use `side: RIGHT` with the new
line number and removed lines `LEFT` with the old one. Then a new agent in the
`big-boss-pi` space is told which file and line the note is on, what it says,
and to reply to the comment once it is fixed.

It lives in the `Apps` space, `Pull requests` tab. Rebuild on a new machine:
`install.sh` copies the folder into `$HOME/.config/herdr-app/mods/` when the app
is installed, and never overwrites a folder that already exists (you may have
edited the mod in place). An existing copy is updated by copying the file over
it:
```bash
cp ~/.pi/herdr-mods/prs/main.js ~/.config/herdr-app/mods/prs/main.js
```
The app picks the new file up on its own. Then, first time only:
```bash
herdr-app do space.new --name Apps --folder "$HOME"
herdr-app do tab.new --space <space-id> --name "Pull requests" --mod prs
```

What the merge does locally, in the repository's clone (found by name in `$HOME`,
`$HOME/code`, … and matched on its `origin` URL): `git fetch --prune`, then the
default branch is brought up to date — `merge --ff-only` when it is checked out,
`branch -f` when it is not, so trunk follows the merge either way. Before that it
switches off the merged branch when that branch is checked out and its tracked
files are clean (untracked files do not count, they never block a checkout).
Then the merged branch is deleted — `<code>-D` because a squash merge never makes
it an ancestor — and only after checking it pointed at exactly what was pushed
upstream. Uncommitted changes, local commits, or a default branch that is not a
fast-forward are reported in the sentence at the top instead of being forced.

### Pi sessions come back after a reboot

A reboot used to end every open pi session. Herdr keeps the terminals, but on
purpose it replaces a lost program with a plain shell in the same tab and folder
and never re-runs it (`hc --skill`, `hc keep`) — so the conversation was on disk
and the tab was empty. Two pieces close that gap, and nothing else:

1. `agent/extensions/herdr-resume-map.ts` writes one small JSON file per hc
   terminal, in `agent/herdr-resume/`: the session file, the command line that
   reproduces the launch (wrapper, flags, model), the folder, and the space/tab
   labels. It rewrites it on a session switch, and does nothing at all outside a
   Herdr terminal (`$HC_TERMINAL_ID` unset).
2. `systemd/herdr-resume.service` runs `scripts/herdr-resume.mjs` once per login.
   It waits for the core, then for each terminal that came back as a *shell* it
   types `exec <the recorded command> --session <the recorded file>` into that
   terminal. Same tab, same folder, same conversation; pi starts idle, waiting
   for you.

What it refuses to do: resume a terminal something is already running in (never
two pi in one tab), resume when the session file is gone, resume a launch it
cannot rebuild (`mode: unknown` rather than a guess — a sandboxed worker must not
come back unsandboxed), or touch a terminal that never held pi. Every decision is
one timestamped line in `agent/herdr-resume/restore.log`, and a second run in the
same boot types nothing.

No terminal output is ever written to disk: no screen capture, no scrollback, no
pane history. The map holds paths and arguments, not screen text.

Two things worth knowing:

- A first-run shell prompt can eat the first character of the pasted line (zsh's
  new-user menu does exactly that). The script checks that the command actually
  started and, if nothing did, types the line once more; if that also fails it
  says so in the log and leaves the entry unmarked instead of pretending.
- The launch mode is read from the markers the wrappers export (`PI_BARE`,
  `PI_SANDBOX_MODE`, `PI_SANDBOX_NET`, `PI_WORKER`). Those markers are inherited
  by children, so a pi started *inside* another pi's environment is recorded with
  the environment it inherited. Starting Herdr from a plain login shell is the
  normal case and the only one that is guaranteed.

### What is not in git, and why

| Not tracked | Why | How it comes back |
| --- | --- | --- |
| `agent/deepseek.key` | Secret | Prompted by `setup.sh`, written mode 600 |
| `agent/auth.json`, `models-store.json` | Provider tokens | `pi auth` |
| `agent/sessions/` | Conversation history | Not restored; starts empty |
| `agent/herdr-resume/` | One file per Herdr terminal: what to type to bring that pi session back | Rewritten by `herdr-resume-map` as sessions run |
| `agent/bin/` | `fd`/`rg` extracted by pi | Re-extracted on first run |
| `agent/dictation/venv/` | 2.5 GB of wheels | `--with-dictation` |
| `agent/npm/`, `agent/git/` | Installed packages | `pi update --extensions` |
| `agent/suggestions.jsonl`, `agent/retro/` | Local feedback log and its weekly digest | Starts empty; `make retro` recreates the digest and `last-run.txt` |
| Ollama model weights | 17 GB | `--with-ollama` |
| `werken-met-ai.pdf` | 15 MB third party | Radar site |

`install.sh` alone (config + hooks, no interactivity) still works: `./install.sh --install-pi`.
It is idempotent — re-run it any time, including when you suspect the hooks are gone.

## Following the Technology Radar

The harness is deliberately shaped by the [Thoughtworks Technology Radar](https://www.thoughtworks.com/radar) — currently **Volume 35, November 2026**. `agent/AGENTS.md` names the Radar as the source of every harness rule, and each change here should trace back to the blips in the table below; the per-blip audit is `docs/radar-conformance.md`.

Where this repo came from, in Radar terms:

| Blip | Ring | What it produced here |
|---|---|---|
| #1 agent sandboxing | Adopt | `sandbox/` bubblewrap launcher |
| #29 harness quality evaluation | Assess | `agent/extensions/__tests__/` |
| #30 local coding models | Assess | `local_llm` tool on the local qwen model |
| #11 feedback flywheel, #25 agent suggestion box | Trial / Assess | `/suggest`, `/retro`, and `make retro` weekly from `systemd/pi-retro.timer`; `agent/extensions/self-learn.ts` judges each compaction behind a gate that needs repetition before it spends a model call — two identical failed tool calls, the same CI check red on two branches or in two workers' reports, the same gate or override recorded by two workers, two learners that died without a proposal, two of the user's own "again" lines, or one `/suggest` note — and then starts a separate pi session that writes one proposal |
| #26 context profiling | Assess | `scripts/session-report.mjs` |
| #36 agent instruction bloat | Caution | lean `AGENTS.md`, rules replaced by hooks where possible |

The edition PDF is not committed (15 MB, third-party, read once) — read it from the Radar site instead.

## Observational memory

Long sessions are compacted by [`pi-observational-memory`](https://github.com/michielpapenhove/pi-observational-memory) (community fork of Amos Blomqvist's extension) instead of Pi's default threshold compaction. It observes ~10k-token chunks, keeps an index plus topic files in `.memory/<session-id>/`, and compacts at `observational-memory.compactAtContextTokens` (set to 120k here, under the 150k working limit).

`agent/extensions/om-autostart.ts` enables it at session start — the extension's own gate defaults to off, so without it every session needs a manual `/om on`. Pi's built-in `compaction.enabled` threshold stays as the far-away last resort.

Notes: the worker models are configured separately from the chat model (`deepseek-flash`, medium/high thinking), `.memory/` is in the global gitignore, and `/om:status` shows memory path, coverage and worker cost.

## Protection layers

1. **Secret-guard extension** — secrets never reach the model: user-input redaction, tool-call blocking (`.env`, keys, credentials), tool-output redaction, always-on system-prompt rules, a per-turn flow ledger that refuses an off-machine send once a secret-shaped file was touched in the same turn, audit log at `~/.pi/agent/secret-guard.log` (pattern names only, never values).
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
- Installer env flags: `PI_SKIP_NETWORK=1` (no vendor download, no
  `big-boss-pi` clone), `PI_SKIP_SYSTEMD=1` (copy units, enable nothing),
  `PI_ENABLE_SERVICES=1` (opt into the macOS/Windows login entry),
  `PI_ALLOW_MISSING_PI=1` (a config-only install on a box without `pi`),
  `PI_DRY_RUN=1`, `PI_PLATFORM=win32|darwin|linux` (exercise another OS's
  branches from one host — the CI matrix and the tests use it)

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
