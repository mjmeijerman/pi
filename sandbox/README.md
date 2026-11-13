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

## What it protects

Read-only: `/usr /bin /sbin /lib /lib64 /etc`, plus the toolchain
(`$HOME/.local/share/pnpm`, the active `$HOME/.local/share/fnm` node install).

Read-write: `$HOME/.pi`, `$HOME/.gitconfig`, `$HOME/projects`,
`$HOME/achterhoek-uitagenda`, `$HOME/pi-projects` (whichever exist), `--rw DIR`,
and the current directory when it is not already covered.

Hidden (the path exists but is empty, or is absent): `~/.ssh ~/.gnupg ~/.aws
~/.kube ~/.config/gh ~/.docker ~/.config/1Password ~/.netrc ~/.npmrc`,
and every `.env` /
`.env.*` / `*.env` file under the read-write trees. The rest of `$HOME`
(`.bash_history`, browsers, `.config`, the Docker socket) is never mounted.

Also: `--unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session`,
fresh `/tmp`, and `/proc` and `/dev` of its own.

Network stays shared unless you pass `--no-net`, which unshares it completely
(loopback-only namespace). The environment is inherited, so provider API keys and
`PI_*` variables still reach pi; `HOME`, `PATH`, `USER` and `TMPDIR` are set to
the sandbox layout.

The launcher refuses to start when the current directory is `$HOME` (or any of
its broad parents), when a `--rw` directory does not exist, or when `pi`/`node`
is not on `PATH`.

## Widen

- `--rw ~/scratch` — extra writable directory, repeatable.
- Editing the launcher: add a path to the read-write loop, or drop an entry from
  the mask list. Keep masks after binds; bwrap applies arguments in order.

## Known gaps

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
