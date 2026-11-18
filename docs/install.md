# Install reference

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-20 — whenever the flag table in `scripts/install-lib.mjs`
(`ENGINE_FLAGS`) changes: `node setup.mjs --help` is the copy this page has to
match, and `scripts/tests/install-help.test.mjs` holds the help text to the parser.

`setup.mjs` asks, then installs. `install.mjs` is the non-interactive engine that
does the installing. `install.sh` and `setup.sh` are 12/13-line shims that exec
them, so both spellings work on Linux and macOS; on Windows call node directly
(`node setup.mjs`, `node install.mjs`) — there is no shell shim there.

Quick start: [../INSTALL.md](../INSTALL.md).

Contents:

1. [The questions, in order](#the-questions-in-order)
2. [Flags](#flags)
3. [Environment overrides](#environment-overrides)
4. [What lands where](#what-lands-where)
5. [Per-OS differences](#per-os-differences)
6. [Second run, and switching things off](#second-run-and-switching-things-off)
7. [Troubleshooting](#troubleshooting)
8. [Secrets](#secrets)

## The questions, in order

`node setup.mjs`, or `./setup.sh`. Run it from the clone. Every question has a
default and `-y` takes all of them; with no terminal (`stdin` not a TTY) the
defaults are used and each line says so.

| # | Step | What it asks | Default |
|---|---|---|---|
| 1 | system packages | `sudo apt-get install -y` for the binaries missing from `bwrap`, `jq`, `arecord`, `curl`, `gh` — Linux only, other OSes print one line | **no** |
| 2 | skills | one question per skill directory in `agent/skills/`, plus anything already in `~/.pi/skills` that the repo does not carry. Description read from the skill's `SKILL.md` | **keep** |
| 3 | extensions | one question per `agent/extensions/*.ts`, description read from the file's first comment | **keep** |
| 4 | agent rules | one question per bullet rule in `agent/AGENTS.md`, shown as `rule 4 of 17 — <first line>`, walked through the 7 sections in file order | **keep** |
| 5 | keys | the DeepSeek key, then `TYPESAFE_API_KEY` for jev | empty **skips** |
| 6 | optional extras | pull the local model `qwen3.8:27b` (~17 GB) with ollama; build the faster-whisper venv (~2.5 GB) | **no**, both |

A 17-rule answer set has 17 answers, and the installed `AGENTS.md` is written from
them: drop a rule and its paragraph goes with it, and a section whose rules are
all dropped loses its heading too. Keeping every rule reproduces
`agent/AGENTS.md` byte for byte.

Answers are recorded in `~/.pi/state/setup.json`, keyed by a slug built from each
rule's first six words. A second run asks only about what that file does not
cover, so a dropped rule stays dropped. `--reask` ignores the record and asks
about everything again.

Between the questions and the install, the keys (step 5) are the only interactive
part: input echo is off (`setRawMode`), a value is never printed and never logged,
and it is written only to the file that owns it. With `--no-keys`, or with no
terminal, nothing is asked and the missing key is stated once.

After the answers: `install.mjs` runs, then the pi packages in `settings.json` are
reconciled (`pi update --extensions`, skipped with `PI_SKIP_NETWORK=1`), then git
identity and `gh auth` are reported (never changed for you), then the optional
extras, then the verification block unless `--no-verify`.

## Flags

`node setup.mjs --help` and `node install.mjs --help` print the same tables these
lines come from — one flag table per engine in `scripts/install-lib.mjs`, read by
the parser and by `--help`, and
`scripts/tests/install-help.test.mjs` fails if the two ever disagree.

| Flag | Engine | What it changes |
|---|---|---|
| `-y`, `--yes` | setup | Accept every default: the full set, no prompts |
| `--skills=a,b` | both | Only these skills; no question per skill |
| `--extensions=a,b` | both | Only these extensions; `.ts` optional in the name |
| `--rules=all` | setup | Keep every rule (the same as the default) |
| `--rules=none` | setup | Drop every rule |
| `--rules=keep:1,2` | setup | Keep only the named rule numbers |
| `--rules=drop:3,4` | setup | Drop the named rule numbers, keep the rest (`--rules=drop:3,4` on the 17-rule file writes a 15-rule `AGENTS.md`) |
| `--no-keys` | setup | Never ask for a key |
| `--dry-run` | both | Print what would be written (and each command), change nothing — including the state file |
| `--reask` | setup | Ask again about everything the state file records, and overwrite the answers |
| `--no-apt` | setup | Never call `sudo apt-get`, even on Linux |
| `--no-verify` | setup | Skip the verification block |
| `--force-key` | setup | Replace an existing `deepseek.key` instead of leaving it alone |
| `--with-ollama` | setup | Pull the local model without asking |
| `--with-dictation` | setup | Build the dictation venv without asking |
| `--install-pi` | both | Install pi with npm when no `pi` is on PATH (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`) |
| `-h`, `--help` | both | Print the flag list and exit 0 |

An option neither engine knows is an error, not a silently ignored argument:
`!! unknown option: --bogus (try --help)`, exit 1.

`--rules=` takes the answers from the command line, so it also applies them: an
existing `AGENTS.md` that differs is rewritten without the confirm prompt the
interactive path asks.

## Environment overrides

These are read by the code that runs, not by the docs: every row below is a
variable one of the two engines or `scripts/install-lib.mjs` reads.

| Variable | Read by | What it changes |
|---|---|---|
| `PI_AGENT_DIR` | both | The agent config directory, default `~/.pi/agent`. Everything else (`~/.pi`, hooks, state file) is derived from it |
| `PI_BOSS_DIR` | install | Where the delegation workspace clone lives, default `~/big-boss-pi` |
| `BOSS_REPO` | install | Which repo that clone comes from, default `mjmeijerman/big-boss-pi` |
| `PI_SKIP_NETWORK=1` | both | No vendor download, no workspace clone, no package reconciliation |
| `PI_SKIP_SYSTEMD=1` | install | Copy the systemd units, do not enable them |
| `PI_ENABLE_SERVICES=1` | install | Opt in to the macOS launchd plist / Windows scheduled task; without it the installer says the service is opt-in and skips it |
| `PI_ALLOW_MISSING_PI=1` | install | Warn and carry on when no `pi` is on PATH, instead of stopping with the npm line. This is what CI uses |
| `PI_DRY_RUN=1` | install | The same as `--dry-run`. `setup.mjs` reads the flag and sets this for the engine it calls |
| `PI_PLATFORM` | both | Override the OS the per-OS plan comes from (`linux`, `darwin`, `win32`) — it exists so one host can exercise all three branches; a real install reads the platform it runs on |
| `PI_SKILLS=a b` | install | The skills to copy, space- or comma-separated. `setup.mjs` sets it from your answers |
| `PI_EXTENSIONS=a.ts b.ts` | install | Same, for extensions |
| `HERDR_MODS` | install | Where the Herdr mods go, default `~/.config/herdr-app/mods` |
| `PI_LOCAL_MODEL` | setup | The ollama model the `local_llm` tool uses, default `qwen3.8:27b` |
| `DEEPSEEK_API_KEY`, `TYPESAFE_API_KEY` | setup | A key in the environment is used instead of the prompt; neither is ever printed |
| `PI_BIN`, `PI_BARE` | the shell wrapper | Which `pi` binary the wrapper runs, and `PI_BARE=1` for one unsandboxed session |

## What lands where

| What | Path |
|---|---|
| agent config, skills, extensions | `~/.pi/agent/` — `settings.json`, `models.json`, `i-have-adhd.json`, `keybindings.json`, `package.json`, `skills/`, `extensions/` (with `lib/` and `__tests__/`), `dictation/` |
| the rule set | `~/.pi/agent/AGENTS.md`, written from your rule answers; an existing one is never overwritten unless you say yes |
| sandbox and scripts | `~/.pi/sandbox/`, `~/.pi/scripts/` — `AGENTS.md` and the skills name these by absolute path |
| answer record | `~/.pi/state/setup.json` |
| global git hooks | `~/.pi/git-hooks/`, plus `core.hooksPath` pointing at it and an `init.templateDir` layer at `~/.git-templates` |
| global gitignore | `~/.pi/gitignore_global`, plus `core.excludesFile` pointing at it |
| bin entries | `~/.local/bin/` — `git-vuln-scan` (copied), `pisandbox` and `pi-bare` (linked; copied on Windows), `herdr-app`, and `jev`, `delegate`, `local-run` from the workspace clone |
| `pi` itself, sandboxed | a `pi()` wrapper block, marked `# >>> pi sandbox >>>`, in `~/.bashrc` and `~/.zshrc` (Linux and macOS only) |
| Herdr mods and menu row | `~/.config/herdr-app/mods/`, `~/.config/herdr-app/programs.json` — an existing `programs.json` is left alone and the line says what to add by hand |
| `herdr-app` | `~/.local/share/herdr-app/herdr-app`, then a bin entry |
| the delegation workspace | `~/big-boss-pi` (`gh repo clone` when `gh` is authenticated, then `git clone https://github.com/mjmeijerman/big-boss-pi.git`; the SSH remote `git@github.com:mjmeijerman/big-boss-pi.git` is the last resort and needs a key) |
| services | Linux `~/.config/systemd/user/`, macOS `~/Library/LaunchAgents/`, Windows a Task Scheduler entry |

Nothing here touches `~/.pi/agent/auth.json`, sessions, `models-store.json`, or a
file you may have edited in place.

## Per-OS differences

| | Linux | macOS | Windows |
|---|---|---|---|
| sandbox | bubblewrap: `pi` runs under `~/.pi/sandbox/pi-sandbox.sh` | not available — one line, no failure | not available — one line, no failure |
| bin entries | symlinks | symlinks | copies; a symlink needs elevation or Developer Mode |
| `herdr-app` | `curl … install.sh \| sh` | same | `powershell … irm … install.ps1 \| iex` |
| guard service | systemd user unit, enabled when a user manager answers | launchd plist, only with `PI_ENABLE_SERVICES=1` | `schtasks /Create /SC ONLOGON`, only with `PI_ENABLE_SERVICES=1` |
| weekly timers (`pi-evals`, `pi-retro`) | systemd timers, enabled | skipped, one line | skipped, one line |
| shell rc files updated | `~/.bashrc`, `~/.zshrc` | `~/.zshrc`, `~/.bashrc` | none: the wrapper is POSIX shell, so nothing is written and the summary points at `pi-bare` |
| `core.hooksPath` spelling | `~/.pi/git-hooks` | same | the node-computed path (not the `/c/Users/…` form Git Bash writes), so a second run is not a change |

`~/.local/bin` is where the bin entries land on all three systems. Linux and macOS
normally have it on `PATH` already (many distros do not — check `echo $PATH`); on
Windows nothing adds it, so add `%USERPROFILE%\.local\bin` to your user `PATH`
once.

## Second run, and switching things off

A second run changes nothing: every copy compares content first, `git config` is
read before it is written, and the wrapper block is spliced in place. The engine
prints `== done — N change(s) written`, and a run over an untouched install prints
`0`.

```bash
# assert that, rather than trust it, into a throwaway HOME:
export H=$(mktemp -d)
HOME=$H PI_SKIP_NETWORK=1 PI_ALLOW_MISSING_PI=1 node setup.mjs -y --no-keys --no-apt --no-verify
HOME=$H node scripts/verify-install.mjs --home "$H" --snapshot /tmp/before.json
HOME=$H PI_SKIP_NETWORK=1 PI_ALLOW_MISSING_PI=1 node setup.mjs -y --no-keys --no-apt --no-verify
HOME=$H node scripts/verify-install.mjs --home "$H" --snapshot /tmp/before.json   # fails if one byte moved
```

Dropping and re-adding later:

| To | Do |
|---|---|
| drop a skill | `rm -rf ~/.pi/agent/skills/<name>` — the installer copies the ones you picked and never deletes; the answer stays in `state/setup.json` |
| drop an extension | `rm ~/.pi/agent/extensions/<name>.ts` |
| add a skill or extension back | `./setup.sh --extensions=<name> --no-keys --no-apt --no-verify`, or `./setup.sh --reask` and answer again |
| change the rule set | `./setup.sh --rules=drop:3,4` (applies immediately when no `AGENTS.md` conflict is pending) or `./setup.sh --reask` |
| refresh the hook wrappers without a full install | `bash ~/.pi/git-hooks/install-hooks.sh` — writes the 15 wrappers and sets both git paths |
| see every answer you gave | `cat ~/.pi/state/setup.json` |

Switching services off (the exact lines, as the installer prints them — one row
per unit it copied; the two timer services have no `[Install]` section, so they
are named as comments and stopped by their timers):

```bash
# Linux
systemctl --user disable herdr-resume.service
systemctl --user disable --now pi-evals.timer
systemctl --user disable --now pi-retro.timer
systemctl --user disable --now big-boss-pi-guard.service
# pi-evals.service: started by its timer — nothing to disable
# pi-retro.service: started by its timer — nothing to disable
```

```bash
# macOS
launchctl unload -w ~/Library/LaunchAgents/dev.herdr.big-boss-pi-guard.plist
launchctl unload -w ~/Library/LaunchAgents/*.plist   # every pi login item
```

```powershell
# Windows
schtasks /Delete /TN big-boss-pi-guard /F
```

The systemd step copies every unit in the clone's `systemd/` directory, because it
reads that directory instead of a list: the guard, `pi-evals.timer` with its
`pi-evals.service`, `pi-retro.timer` with its `pi-retro.service`, and
`herdr-resume.service`. The timers are enabled `--now`, `herdr-resume.service`
without `--now` (it runs at the next login), and the two timer services are
copied but not enabled — they carry no `[Install]` section, and their timer's
`Unit=` line is what starts them. Nothing is left for you to run by hand after an
install: `systemctl --user list-timers` shows both timers with a next run.

Removing an install without touching sessions or keys:

```bash
make uninstall      # unsets core.hooksPath, core.excludesFile, init.templateDir
rm -rf ~/.pi/git-hooks ~/.pi/gitignore_global ~/.git-templates ~/.local/bin/git-vuln-scan
```

`make uninstall` only unsets the git keys; the files it names in its closing line
are yours to remove. The clone at `~/.pi` holds `AGENTS.md`, your keys and the
state file, so delete it last and only if you mean it: `rm -rf ~/.pi`. Sessions
(`~/.pi/agent/sessions`), `auth.json` and the key files are never touched by any
installer step.

## Troubleshooting

**`node` missing, or the wrong major.** `node -v` prints nothing or a number below
24. `setup.mjs` stops with `node is not installed (pi needs Node 24 or newer)`, or
warns `node v22.x is older than 24; pi 1.5.x expects 24 or 26` and continues.
Fix: install Node 24 (`mise install node@24`, or your package manager), reopen the
shell, re-run. The number comes from `mise.toml`, not from this page.

**`pi` not found.** `install.mjs` exits 1 with
`'pi' not found on PATH. Install it first, e.g.: npm install -g --ignore-scripts
@earendil-works/pi-coding-agent`. Fix: run that line, or re-run setup with
`--install-pi` and let it do it. A pi installed under pnpm
(`~/.local/share/pnpm/bin/pi`) is found on disk and put on `PATH` for the rest of
the run.

**herdr-app download skipped.** With `PI_SKIP_NETWORK=1`, or on a machine with no
`curl`/no network, the installer prints
`== herdr-app: PI_SKIP_NETWORK=1 — vendor installer not downloaded` and continues
without a bin entry. Fix: re-run without `PI_SKIP_NETWORK`, or install it from
`https://releases.herdr.dev/app/install.sh` (`install.ps1` on Windows). Every other
step still runs.

**A read-only `~/.git-templates` line from `git-hooks/install-hooks.sh`.** Inside
the sandbox `$HOME` is read-only except the paths the launcher binds, so the hook
installer's template write fails and prints something like
`mkdir: cannot create directory '…/.git-templates/hooks': Permission denied`.
Nothing to fix: `install.mjs` sets `core.hooksPath` and `init.templateDir` itself
from node, after that script and whether it succeeded or not, and prints
`== git hooks active : ~/.pi/git-hooks`. What did not happen is the write of the
15 wrapper files into `~/.pi/git-hooks` and `~/.git-templates/hooks` — re-run
`./install.sh` from a host shell to refresh those. Until then `git init` gets no
hook template; the verification block shows the key as
`init.templateDir=~/.git-templates`, not `MISSING`.

**No systemd user manager.** In a container or on a bare TTY the unit files are
copied but nothing is enabled, and the installer prints
`== enable: no systemd user session — start it, then: systemctl --user enable --now pi-evals.timer pi-retro.timer && systemctl --user enable herdr-resume.service`.
Fix: after logging into a real user session, run exactly those lines. The five unit
files are already in `~/.config/systemd/user/`, so nothing else has to be copied.

## Secrets

Two files hold keys, both written by `setup.mjs` at mode 600, both under
`~/.pi/agent/`:

| File | Holds | Read by |
|---|---|---|
| `deepseek.key` | the DeepSeek API key, one line | `models.json` (`!cat ~/.pi/agent/deepseek.key`) |
| `env.secret` | `TYPESAFE_API_KEY=…` for jev | the shell / pi environment, exported at load |

A key is asked for with the terminal echo off, never printed, never logged, and
written only to its own file. `--no-keys` skips both questions; an existing file is
left alone unless you pass `--force-key`.

Neither file can be committed: the repo's `.gitignore` names them, and the global
gitignore the installer sets (`*.key`, `.env*`, `secrets.*`) catches them in every
other repo on the machine. The clone you install from never receives a key — the
installer copies files out of it into `~/.pi`, never the other way.

A leaked key is rotated, not deleted: revoke it at the provider, write the new one
(`./setup.sh --force-key`, or edit the file), and treat anything the old key
reached as exposed. Keys do not belong in a commit, a log, an issue, a screenshot
or a chat message, and `git log -S` on the old value tells you whether one ever
did.
