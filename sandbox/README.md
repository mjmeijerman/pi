# pi-sandbox

Runs the pi coding agent inside a bubblewrap sandbox, so prompt-injected commands
cannot reach SSH keys, cloud credentials or dotenv files, and can only write to
the directories you name.

## Launch

```
/home/mark/.pi/sandbox/pi-sandbox.sh [--no-net] [--rw DIR]... -- [pi arguments...]
/home/mark/.pi/sandbox/pi-sandbox.sh -- -p "review this repo"
/home/mark/.pi/sandbox/pi-sandbox.sh --no-net -- --continue
```

Every argument after `--` goes to pi. Always use `--`, otherwise the launcher
refuses the argument as unknown. Add the alias:

```
alias pisandbox='/home/mark/.pi/sandbox/pi-sandbox.sh'
```

New shell, then `pisandbox -- --version`. Run `selftest.sh` to re-check the policy.
It is cwd-independent: it creates a temp work directory under `$HOME/.pi`, prints
it, and runs every assertion from there, so the result does not depend on where
you were standing (`~`, `/tmp` and `~/.pi` all give the same answer).

## What it protects

Read-only: `/usr /bin /sbin /lib /lib64 /etc`, plus the toolchain
(`$HOME/.local/share/pnpm`, the active `$HOME/.local/share/fnm` node install).

Read-only when you start in `$HOME` itself: the whole home tree (see
[Starting in `$HOME`](#starting-in-home)).

Read-write: `$HOME/.pi`, `$HOME/.gitconfig`, `$HOME/projects`,
`$HOME/achterhoek-uitagenda`, `$HOME/pi-projects` (whichever exist), `--rw DIR`,
and the current directory when it is not already covered.

Hidden (the path exists but is empty, or is absent): `~/.ssh ~/.gnupg ~/.aws
~/.kube ~/.config/gh ~/.docker ~/.config/1Password ~/.netrc ~/.npmrc`,
and every `.env` /
`.env.*` / `*.env` file under the read-write trees. Started in a project
directory, the rest of `$HOME` (`.bash_history`, browsers, `.config`, the Docker
socket) is never mounted at all.

A path that does not exist on the host gets no mask: it is absent inside anyway,
and bubblewrap cannot create a mountpoint under a read-only `$HOME`.

Also: `--unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session`,
fresh `/tmp`, and `/proc` and `/dev` of its own.

Network stays shared unless you pass `--no-net`, which unshares it completely
(loopback-only namespace). The environment is inherited, so provider API keys and
`PI_*` variables still reach pi; `HOME`, `PATH`, `USER` and `TMPDIR` are set to
the sandbox layout.

The launcher refuses to start when the current directory is a broad parent
(`/`, `/home`, `/tmp`, `/var`, `/run` and the like), when a `--rw` directory does
not exist, or when `pi`/`node` is not on `PATH`.

## Starting in `$HOME`

`pi-sandbox.sh` from `$HOME` itself does not hand the home directory out
read-write. It mounts `$HOME` read-only and prints one notice:

```
pi-sandbox.sh: $HOME is read-only inside the sandbox; pass --rw DIR to make a directory writable
```

`pi` starts normally from there. The read-write binds (`$HOME/.pi`, the
allow-listed trees, `--rw DIR`) are mounted after the read-only home, so they
win: `$HOME/.pi` stays writable, and `--rw ~/scratch` makes `~/scratch` writable
again. Everything else under `$HOME` is refused for writing and readable —
credentials and dotenv files stay masked (see Known gaps).

Broad parents are still refused outright: a read-only mount of `/` or `/home`
buys nothing, and the notice would be noise on every session.

## Widen

- `--rw ~/scratch` — extra writable directory, repeatable.
- Editing the launcher: add a path to the read-write loop, or drop an entry from
  the mask list. Keep masks after binds; bwrap applies arguments in order.

## Known gaps

- **Read-only is not hidden**: started in `$HOME`, the whole home tree is mounted
  read-only, so sandboxed code can *read* `.bash_history`, browser profiles and
  `.config` (the credential and dotenv masks still apply, and `--rw` does not
  change the read-only home). Start in a project directory when the repo is
  unfamiliar and you want the home tree absent, not merely unwritable.
- **X11**: `/tmp/.X11-unix` is not mounted, so GUI tools (and the Shotcut
  screenshot helper) do not work inside. Add `--ro-bind /tmp/.X11-unix
  /tmp/.X11-unix` after the `--tmpfs /tmp` line if you need it.
- **Local services**: `127.0.0.1` is reachable by default, so a local Ollama or
  any dev server is exposed to sandboxed code. Use `--no-net` for that.
- **Network exfiltration**: with networking on, anything readable can still be
  posted out. `--no-net` is the only hard stop.
- **Provider credentials**: `~/.pi/agent/auth.json` is rewritten in flight to
  hold only the allowed providers (default: the `defaultProvider` from
  `settings.json`). Override with `PI_SANDBOX_AUTH_PROVIDERS=deepseek,openai`.
  The keys that remain are readable by generated code, as are provider env vars.
- **GPG and SSH**: no agent sockets and no keys, so signing, `git push` over SSH
  and `gh` credential helpers (`~/.local/bin/gh`) do not work inside.
- **Tracked dotenv files** appear modified because they are masked as empty.
  Never `git commit -a` / `git add -A` inside the sandbox.
- **npm/extensions**: `~/.npm` and `~/.cache` are not mounted, so package
  installs and Pi extension installs fail inside.
- **Same uid**: the sandbox shares your uid, so anything it writes under the
  read-write binds is yours, permanently.
