# Install pi on a bare machine

You need `git` and Node 24 — the major `.node-version` pins, read from
`mise.toml`. `gh` is optional: the installer uses it to clone the delegation
workspace when it is authenticated, and otherwise clones over https. SSH is the
last resort and needs a key; both repos are public, so nothing here asks for one.
`herdr-app` is downloaded by the installer unless you set `PI_SKIP_NETWORK=1`.

## 1. git and Node 24, before the clone

Do I already have it? `git --version` and `node --version` — a `v24.x` and no
error means yes. Otherwise: install, reopen the shell (or `PATH` still points at
the old one), then run the check lines at the end of the block.

### Windows, in PowerShell

`winget` is on Windows 10 1809+ and on 11. This is not the bash block.

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
git --version
node --version
npm.cmd --version
where.exe git node
```

`node --version` has to print `v24.x`. `git` saying `is not recognized` is a
stale `PATH`, not a missing install: [troubleshooting](docs/install.md#troubleshooting)
has the four steps. The third line unblocks `npm`, which Node ships as a script
`npm.ps1` that the default `Restricted` policy refuses; `RemoteSigned` runs local
scripts and still demands signatures on downloads, and `npm.cmd` is a batch shim
no policy blocks.

### macOS, in Terminal

Do I already have it? `git --version`, `node --version`.

```bash
xcode-select --install   # git, or: brew install git
brew install node@24
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc && exec zsh
git --version
node --version
npm --version
which git node
```

### Linux, in bash or zsh

Do I already have it? `git --version`, `node --version`.

```bash
sudo apt-get install -y git nodejs npm   # Debian, Ubuntu, WSL; dnf or pacman otherwise
git --version
node --version
npm --version
command -v git node
```

A distro `nodejs` below 24 fails that check; `mise use -g node@24` is the fix.

## 2. Clone, then run the installer

macOS and Linux — bash or zsh, **not** PowerShell:

```bash
git clone https://github.com/mjmeijerman/pi.git ~/.pi && cd ~/.pi && ./setup.sh
```

Windows — PowerShell, one command per line:

```powershell
git clone https://github.com/mjmeijerman/pi.git $env:USERPROFILE\.pi
cd $env:USERPROFILE\.pi
node setup.mjs
```

`&&` between commands is PowerShell 7 and later; the 5.1 a fresh Windows starts
answers `the token && is not a valid statement separator in this version`. Use
separate lines, or `;`. Have `gh` logged in? `gh repo clone mjmeijerman/pi ~/.pi`
does the same clone, then run the same `cd` and setup command.

The long form — the full per-OS matrix, Intel Mac paths, what every question
means, flags, troubleshooting, secrets: [docs/install.md](docs/install.md).

## What happens next

Every question has a default, and `-y` takes all of them:

1. **system packages** with `sudo apt-get` — Linux only, default **no**
2. **skills**, one per skill in `agent/skills/` — default **keep**
3. **extensions**, one per `agent/extensions/*.ts` — default **keep**
4. **agent rules**, shown as `rule 4 of 17` and grouped in the 7 sections of
   `agent/AGENTS.md` — default **keep**; the installed `AGENTS.md` is written from
   your answers
5. **keys**, typed with the terminal echo off: the DeepSeek key, then
   `TYPESAFE_API_KEY` for jev — empty skips, `--no-keys` never asks
6. **optional extras**: the local model (~17 GB) and the dictation venv
   (~2.5 GB) — default **no**

It then installs, reconciles the pi packages declared in `settings.json`, and
prints a verification block (skills, extensions, rules, hooks, sandbox, key).

`node setup.mjs --help` prints every flag.
