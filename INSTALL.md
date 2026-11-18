# Install pi on a bare machine

You need `git`, and Node at the version in `.node-version` (24, pinned from
`mise.toml`). `gh` is optional: the installer uses it to clone the delegation
workspace when it is authenticated, and otherwise clones over https. SSH is the
last resort and needs a key; both repos are public, so nothing here asks for one.
`herdr-app` is downloaded by the installer unless you set `PI_SKIP_NETWORK=1`.

Linux and macOS:

```bash
git clone https://github.com/mjmeijerman/pi.git ~/.pi && cd ~/.pi && ./setup.sh
```

Windows, in PowerShell:

```powershell
git clone https://github.com/mjmeijerman/pi.git $env:USERPROFILE\.pi; cd $env:USERPROFILE\.pi; node setup.mjs
```

Have `gh` logged in? `gh repo clone mjmeijerman/pi ~/.pi` does the same clone.
Either way, then run the `cd` and the setup command above.

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

`node setup.mjs --help` prints every flag. Reference — the full flag and
environment tables, what lands where, the per-OS differences, how to run it a
second time, how to switch things off, troubleshooting and secrets:
[docs/install.md](docs/install.md).
