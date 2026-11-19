# Install reference

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-20 — whenever the flag table in `scripts/install-lib.mjs`
(`ENGINE_FLAGS`) changes: `node setup.mjs --help` is the copy this page has to
match, and `scripts/tests/install-help.test.mjs` holds the help text to the parser.

`setup.mjs` asks, then installs. `install.mjs` is the non-interactive engine that
does the installing. `setup.sh` and `setup.ps1` are the bootstraps: they install
what the engine needs (Node, and git where they can) before `node setup.mjs` can
run at all, because a shim that starts with `exec node` cannot install node.
`install.sh` stays a five-line shim over `install.mjs`. Windows has no bash, so
`setup.ps1` is the entry point there and `node install.mjs` the non-interactive
one.

Quick start: [../INSTALL.md](../INSTALL.md).

Contents:

1. [Prerequisites, per OS](#prerequisites-per-os)
2. [The questions, in order](#the-questions-in-order)
3. [Flags](#flags)
4. [Environment overrides](#environment-overrides)
5. [What lands where](#what-lands-where)
6. [Per-OS differences](#per-os-differences)
7. [Sandboxing on Windows](#sandboxing-on-windows)
8. [Second run, and switching things off](#second-run-and-switching-things-off)
9. [Troubleshooting](#troubleshooting)
10. [Secrets](#secrets)

## Prerequisites, per OS

One of these, and the installer does the rest:

```bash
./setup.sh              # Linux, macOS, Git Bash
```

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1   # Windows
```

Each bootstrap installs Node at the major `.node-version` pins — 24, the same
number `mise.toml` writes — and npm, plus git where the platform lets it, through
the first package manager it finds: `apt-get`, `dnf`, `pacman`, `brew`, `winget`
or `mise`. It announces every command before running it, says so before `sudo`,
re-reads `node` from `PATH` afterwards (a fresh install is usually not in the
`PATH` this shell inherited), and then execs the engine. A failed install prints
the line that does it by hand and the next prerequisite still runs. Nothing needs
`gh`; the installer falls back to an https clone.

`PI_SKIP_PREREQS=1` or `--skip-prereqs` turns the whole step into skip lines —
CI, and anyone who manages node with mise/nvm/asdf on purpose.

The blocks below are what the bootstraps run, and the manual answer when a machine
has no package manager at all or a policy blocks the install. Each one checks
itself: `git --version`, `node --version` and npm answering is the whole of "is my
machine ready". Reopen the shell after installing by hand, because `PATH` is read
once at start; the bootstraps do that re-read for you.

Windows comes first because its install is the one that goes wrong: a fresh
Windows machine has no `git`, no Node, and a policy that refuses npm's script.
macOS and Linux are one package manager line each.

### Windows, in PowerShell

Not bash. `winget` ships with Windows 10 1809+ and 11, and is what `setup.ps1`
uses for both packages. By hand — git first, because the clone needs it:

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
git --version
node --version
npm.cmd --version
where.exe git node
```

`node --version` must print `v24.x`; that number is `.node-version`'s. Put the
`PATH` block a fresh winget wrote in front of this window before the check lines,
or use `setup.ps1`, which does it: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.
The third line exists because Node installs its npm entry points as scripts
(`npm.ps1`), and the default `Restricted` execution policy refuses to run any
script:

```
npm.ps1 cannot be loaded because running scripts is disabled on this system.
```

`RemoteSigned` runs local scripts and still requires a signature on downloaded
ones. Refusing it is fine: keep `Restricted`, call the `.cmd` form instead, and
nothing else changes — a batch shim is not a script, so the policy does not touch
it. `setup.ps1` sidesteps the policy entirely with `-ExecutionPolicy Bypass` on
the invocation. That is also why every line here is a separate command: Windows
PowerShell 5.1, which is what a fresh install opens, has no `&&` and answers
`the token && is not a valid statement separator in this version`. `&&` arrived
in PowerShell 7. Use separate lines, or `;`, and do not paste the block below it.

### macOS, in Terminal

`setup.sh` installs node@24 with brew when brew is there. By hand:

```bash
xcode-select --install                    # git; or: brew install git
brew install node@24
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc
```

Reopen the terminal, or `source ~/.zshrc`, then check the four answers:

```bash
git --version
node --version
npm --version
which git node
```

On an Intel Mac the prefix is `/usr/local/opt/node@24/bin`. `brew install node`
installs whatever is current; `node@24` is the one that matches `.node-version`.
Without brew, `mise use -g node@24` is the other answer the bootstrap knows.

### Linux, in bash or zsh

`setup.sh` picks the first of `apt-get`, `dnf`, `pacman`; by hand:

```bash
# Debian, Ubuntu, WSL
sudo apt-get install -y git nodejs npm
# Fedora, RHEL
sudo dnf install -y git nodejs npm
# Arch
sudo pacman -S --needed git nodejs npm
git --version
node --version
npm --version
command -v git node
```

Only the first block applies to your machine; the other two are there so nobody
has to translate `apt-get` by hand. A distro `nodejs` below 24 fails the
`node --version` line: `mise use -g node@24` (or nvm) is the fix, not a second
package manager. WSL is this block, not the Windows one — the bootstraps follow
the platform they run on.

## The questions, in order

`node setup.mjs`, or `./setup.sh` (Windows: `powershell -ExecutionPolicy Bypass
-File setup.ps1`). Run it from the clone. Every question has a default and `-y`
takes all of them; with no terminal (`stdin` not a TTY) the defaults are used and
each line says so.

| # | Step | What it asks | Default |
|---|---|---|---|
| 1 | prerequisites | git, node and npm: whatever is missing is installed with the first package manager found, each command printed before it runs. No question — it happens before the questions, and `--skip-prereqs` turns it into skip lines | **install** |
| 2 | pi | `install pi with npm?`, asked only when no `pi` is on PATH (a pi found on disk under pnpm or `/usr/local/bin` is put on `PATH` instead of asked about); the sub-line is the exact command that will run | **yes** |
| 3 | system packages | `sudo apt-get install -y` for the binaries missing from `bwrap`, `jq`, `arecord`, `curl`, `gh` — Linux only, other OSes print one line | **no** |
| 4 | skills | one question per skill directory in `agent/skills/`, plus anything already in `~/.pi/skills` that the repo does not carry. Description read from the skill's `SKILL.md` | **keep** |
| 5 | extensions | one question per `agent/extensions/*.ts`, description read from the file's first comment | **keep** |
| 6 | agent rules | one question per bullet rule in `agent/AGENTS.md`, shown as `rule 4 of 17 — <first line>`, walked through the 7 sections in file order | **keep** |
| 7 | keys | the DeepSeek key, then `TYPESAFE_API_KEY` for jev | empty **skips** |
| 8 | optional extras | pull the local model `qwen3.8:27b` (~17 GB) with ollama; build the faster-whisper venv (~2.5 GB) | **no**, both |

A 17-rule answer set has 17 answers, and the installed `AGENTS.md` is written from
them: drop a rule and its paragraph goes with it, and a section whose rules are
all dropped loses its heading too. Keeping every rule reproduces
`agent/AGENTS.md` byte for byte.

Answers are recorded in `~/.pi/state/setup.json`, keyed by a slug built from each
rule's first six words. A second run asks only about what that file does not
cover, so a dropped rule stays dropped. `--reask` ignores the record and asks
about everything again.

Between the questions and the install, the keys (step 6) are the only interactive
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
| `--skip-prereqs` | both | Never check or install git, node and npm — the same as `PI_SKIP_PREREQS=1` |
| `--no-verify` | setup | Skip the verification block |
| `--force-key` | setup | Replace an existing `deepseek.key` instead of leaving it alone |
| `--with-ollama` | setup | Pull the local model without asking |
| `--with-dictation` | setup | Build the dictation venv without asking |
| `--install-pi` | both | Accepted and does what it always did — installing pi is the default now, so passing it changes nothing and an old script keeps working |
| `--no-install-pi` | both | Never install pi and never ask: the install carries on without it, and `pi` stays missing. Setup stops asking about it too |
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
| `PI_SKIP_PREREQS=1` | both | No package manager is called: the prerequisites step prints skip lines. What CI uses, since a runner has no package manager to install for |
| `PI_SKIP_SYSTEMD=1` | install | Copy the systemd units, do not enable them |
| `PI_ENABLE_SERVICES=1` | install | Opt in to the macOS launchd plist / Windows scheduled task; without it the installer says the service is opt-in and skips it |
| `PI_ALLOW_MISSING_PI=1` | both | Skip pi entirely — no question, no install — and carry on with one `== pi binary: PI_ALLOW_MISSING_PI=1 — config only` line. **CI only**: it exists so a runner with no `pi` can prove the config wires up. On a machine you are setting up, let the installer install pi instead |
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
| sandbox | bubblewrap: `pi` runs under `~/.pi/sandbox/pi-sandbox.sh` | not available — one line, no failure | not available natively — WSL2 and Docker provide it: [Sandboxing on Windows](#sandboxing-on-windows) |
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

## Sandboxing on Windows

A native Windows install runs `pi` unsandboxed: the installer prints one line and
carries on. That is a fact about Windows, not a missing step in this installer —
AppContainer and job objects sandbox a *token*, not a filesystem tree, so there is
no bubblewrap equivalent to install, and no flag to turn on. Four ways to get a
real boundary, in the order they buy the most for the least.

### WSL2 + bubblewrap (recommended)

WSL2 runs a real Linux kernel, so everything on this page is the Linux path,
unchanged: the same `~/.pi/sandbox/pi-sandbox.sh`, the same bubblewrap, the same
systemd user units, the same mode bits. The installer detects WSL, prints
`system : linux (WSL, sandbox available)`, and runs the Linux plan because that
is what the host is.

```powershell
wsl --install -d Ubuntu
```

Then inside Ubuntu — git, Node 24, bubblewrap, then the installer:

```bash
sudo apt-get update
sudo apt-get install -y git curl bubblewrap
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
git clone https://github.com/mjmeijerman/pi.git ~/.pi
cd ~/.pi
./setup.sh
```

Keep the repo, `~/.pi` and `PI_BOSS_DIR` under the **Linux** home (`~/`), never
under `/mnt/c/`. That mount is 9p: Unix mode bits do not survive it (every file
reads as 0777, so a hook script is "executable" whatever it says), symlinks need
Developer Mode on the Windows side, and every write pays for a 9p round trip. The installer warns and names the offending path when it sees one; the fix
is `mv` it under `~/` and re-run.

Two costs that the Linux page shares, stated plainly:

- **The network is not isolated.** The sandbox binds the filesystem; a process
  inside it can still open a socket. `--no-net` exists for repo scripts, not for
  agents — no network means no model.
- **`herdr-app` sits on the other side of a filesystem wall.** An app installed
  on Windows cannot see `/home/you` inside the distro. Either install it inside
  WSL (WSLg puts its window on the Windows desktop), or keep the repos on `/mnt/c`
  and lose the mode bits. One or the other; nothing can pick for you.

### Docker Desktop (WSL2 backend)

A stronger, disposable boundary: the host filesystem arrives only where you mount
it, and `--rm` leaves nothing behind.

```powershell
docker run --rm -it -v "${PWD}:/work" -w /work node:24 bash
```

Inside the container, the sandbox is still bubblewrap:

```bash
apt-get update && apt-get install -y bubblewrap git
```

The cost is a second thing to keep in sync — the image is yours to rebuild when
the Node major moves — plus a socket that has to be mounted deliberately, or not
at all: the Docker socket is root on the host. Nothing persists past `--rm`, which
is the point and also the annoyance.

### Windows Sandbox

A throwaway VM that ships with Windows: needs Pro or Enterprise and
virtualization in the firmware, installs nothing on the host.

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' -All
```

Nothing persists — no repo, no keys, no `~/.pi` — so it is the right home for one
untrusted thing and the wrong home for a workspace you come back to on Monday.

### Cloud sandbox

The most isolation and the least integration: a machine you reach over the
network. It gives up the desktop entirely — no herdr window, no local repo under
`~/`, nothing to open in an editor here. Right for a red-team run, wrong for a day
of work.

## Second run, and switching things off

A second run changes nothing: every copy compares content first, `git config` is
read before it is written, and the wrapper block is spliced in place. The engine
prints `== done — N change(s) written`, and a run over an untouched install prints
`0`.

```bash
# assert that, rather than trust it, into a throwaway HOME:
export H=$(mktemp -d)
HOME=$H PI_SKIP_NETWORK=1 PI_ALLOW_MISSING_PI=1 PI_SKIP_PREREQS=1 node setup.mjs -y --no-keys --no-apt --no-verify
HOME=$H node scripts/verify-install.mjs --home "$H" --snapshot /tmp/before.json
HOME=$H PI_SKIP_NETWORK=1 PI_ALLOW_MISSING_PI=1 PI_SKIP_PREREQS=1 node setup.mjs -y --no-keys --no-apt --no-verify
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

**`git` is not recognized, right after installing it (Windows).** `setup.ps1`
does not have this problem: it re-reads the machine and user `PATH` blocks after
winget runs and before it calls node, so the window that installed can use what
it installed. This entry is the by-hand install — the `winget` line finished, you opened a new PowerShell, and `git --version` prints
`git : The term 'git' is not recognized as the name of a cmdlet, function,
script file, or operable program.` The install landed; the shell did not see it.
`winget` writes the machine `PATH`, and every process inherits the environment
block of the Explorer that started it — a block copied at sign-in, before the
install. A new window from the Start menu is the same Explorer, so it hands out
the same old block. Four steps:

1. Prove the files are there. `True` means the install landed:

```powershell
Test-Path 'C:\Program Files\Git\cmd\git.exe'
Test-Path 'C:\Program Files\nodejs\node.exe'
```

2. Repair this session only. The append lasts until the window closes, which is
long enough to finish the install:

```powershell
$env:Path += ';C:\Program Files\Git\cmd'
git --version
```

3. Make it permanent by appending to the **user** `PATH`, not the machine one —
the machine variable needs admin and already holds what `winget` wrote:

```powershell
$u = [Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path', "$u;C:\Program Files\Git\cmd", 'User')
```

Then sign out and back in. A new window from the Start menu is not enough:
Explorer still hands out the block it copied before the install. Same for node —
`C:\Program Files\nodejs` in place of `C:\Program Files\Git\cmd`.

4. If step 1 printed `False`, the install did not finish. Ask what winget thinks
it installed, then watch it run:

```powershell
winget list --id Git.Git
winget install --id Git.Git -e --source winget
winget list --id OpenJS.NodeJS.LTS
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

**`node` missing, or the wrong major.** `node -v` prints nothing or a number below
24. Both engines install a missing node first now, so this is the case the
install could not fix: no package manager answered, or the shell still holds a
`PATH` from before. `setup.mjs` stops with
`git is not on PATH — install it, reopen the shell, and re-run` when git is still
missing after the step, and warns `node v22.x is older than 24; pi 1.5.x expects
24 or 26` and continues when the major is only old. Fix: install Node 24
(`mise use -g node@24`, or your package manager), reopen the shell, re-run. The
number comes from `mise.toml`, not from this page.

**The prerequisites step is about to run `sudo`.** That is `apt-get`, `dnf` or
`pacman` on Linux, and the line above it says so before it happens — it is the
only prompt in the step that is not the OS asking for a password. `--skip-prereqs`
(or `PI_SKIP_PREREQS=1`) turns the whole step into skip lines and installs
nothing. On macOS and Windows nothing in the step uses root; `brew` and `winget`
install per user where they can.

**`pi` not found.** The installer installs it for you: when no `pi` is on PATH it
runs `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` in the
preflight, before the first file is written, and continues. A pi installed under
pnpm (`~/.local/share/pnpm/bin/pi`) is found on disk and put on `PATH` for the
rest of the run — nothing to fix.

The one case it cannot handle is a machine with neither `pi` nor `npm`, because
Node is the thing that would have installed it. The run stops before anything is
written and names the command for that OS:

```
!! no pi on PATH and no npm to install it with — Node (npm ships with it) is a prerequisite — nothing written yet
   sudo apt-get install -y nodejs npm   (dnf/pacman one-liners in docs/install.md), then reopen the shell
   then re-run this installer: npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Fix: install Node 24 from
[Prerequisites, per OS](#prerequisites-per-os), reopen the shell, re-run. To
deliberately install without pi — a config-only box, a CI runner — pass
`--no-install-pi` (or set `PI_ALLOW_MISSING_PI=1` where nobody can answer a
prompt): the rest of the install runs and `pi` stays missing.

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
