# Install pi on a bare machine

One command. `setup.sh` (Linux, macOS, Git Bash) and `setup.ps1` (Windows)
install their own prerequisites — Node 24, the major `.node-version` pins and
`mise.toml` writes, and npm — through apt-get, dnf, pacman, brew, winget or mise,
announcing each command before it runs, then hand over to the questions. `git` is
the one thing you install by hand: nothing clones without it. `gh` is optional:
the installer uses it to clone the delegation workspace when it is authenticated,
and otherwise clones over https. SSH is the last resort and needs a key; both
repos are public, so nothing here asks for one. `herdr-app` is downloaded by the
installer unless you set `PI_SKIP_NETWORK=1`.

## 1. git, before the clone

Everything else the installer fetches. `git` it cannot: the clone is the first
command, so `git --version` answering a version is the whole check.

### Windows, in PowerShell

`winget` is on Windows 10 1809+ and on 11. This is not the bash block.

```powershell
winget install --id Git.Git -e --source winget
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
git --version
```

`git` saying `is not recognized` is a stale `PATH`, not a missing install:
[troubleshooting](docs/install.md#troubleshooting) has the four steps. The
`Set-ExecutionPolicy` line is the fix for `running scripts is disabled on this
system`, the wall the first real Windows install hit — the default `Restricted`
policy refuses the `npm.ps1` that Node ships, while `RemoteSigned` runs local
scripts and still demands signatures on downloads. `setup.ps1` is launched with
`-ExecutionPolicy Bypass`, so a machine that stays `Restricted` installs too.

A native Windows install runs `pi` unsandboxed — there is no bubblewrap to
install here. WSL2 runs a real Linux kernel and the sandbox with it:
[Sandboxing on Windows](docs/install.md#sandboxing-on-windows) has the command
and the three alternatives.

### macOS, in Terminal

```bash
xcode-select --install   # git, or: brew install git
git --version
```

### Linux, in bash or zsh

```bash
sudo apt-get install -y git   # Debian, Ubuntu, WSL; dnf or pacman otherwise
git --version
```

## 2. Clone, then run the installer

macOS and Linux — bash or zsh, **not** PowerShell:

```bash
git clone https://github.com/mjmeijerman/pi.git ~/.pi && cd ~/.pi && ./setup.sh
```

Windows — PowerShell, one command per line. This one installs Node 24 with
winget and re-reads the `PATH` block winget just wrote, which is why the window
you are in can see it:

```powershell
git clone https://github.com/mjmeijerman/pi.git $env:USERPROFILE\.pi
cd $env:USERPROFILE\.pi
powershell -ExecutionPolicy Bypass -File setup.ps1
```

`&&` between commands is PowerShell 7 and later; the 5.1 a fresh Windows starts
answers `the token && is not a valid statement separator in this version`. Use
separate lines, or `;`. Have `gh` logged in? `gh repo clone mjmeijerman/pi ~/.pi`
does the same clone, then run the same `cd` and setup command.

The long form — the full per-OS matrix, Intel Mac paths, what every question
means, flags, troubleshooting, secrets: [docs/install.md](docs/install.md).

## What happens next

Every question has a default, and `-y` takes all of them:

1. **prerequisites** — git, node, npm: whatever is missing is installed with the
   OS package manager, each command printed before it runs. No question, and no
   file written; `--skip-prereqs` (or `PI_SKIP_PREREQS=1`) turns it into skip lines
2. **pi** — `install pi with npm?`, asked only when no `pi` is on PATH, with
   the exact npm line as the sub-line — default **yes**
3. **system packages** with `sudo apt-get` — Linux only, default **no**
4. **skills**, one per skill in `agent/skills/` — default **keep**
5. **extensions**, one per `agent/extensions/*.ts` — default **keep**
6. **agent rules**, shown as `rule 4 of 17` and grouped in the 7 sections of
   `agent/AGENTS.md` — default **keep**; the installed `AGENTS.md` is written from
   your answers
7. **keys**, typed with the terminal echo off: the DeepSeek key, then
   `TYPESAFE_API_KEY` for jev — empty skips, `--no-keys` never asks
8. **optional extras**: the local model (~17 GB) and the dictation venv
   (~2.5 GB) — default **no**

It then installs (pi included, when it was missing), reconciles the pi packages
declared in `settings.json`, and prints a verification block (skills, extensions,
rules, hooks, sandbox, key). On Windows that block is worth reading once:
`node --version` should print `v24.x` and `npm.cmd --version` a version, in the
same window the install ran in.

```powershell
node --version
npm.cmd --version
```

`--no-install-pi` skips pi and carries on without it; `node setup.mjs --help`
prints every flag.
