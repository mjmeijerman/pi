# pi-sandbox

Runs the pi coding agent inside a bubblewrap sandbox, so prompt-injected commands
cannot reach SSH keys, cloud credentials or dotenv files, and can only write to
the directories you name.

## Default: `pi` is sandboxed

`~/.pi/install.sh` puts a `pi()` shell function in `~/.bashrc` and `~/.zshrc`, so
plain `pi` already runs inside the sandbox. Nothing to remember:

```
pi                      # same as `pisandbox -- pi`
PI_BARE=1 pi            # escape hatch: the raw binary, no sandbox
pisandbox --no-net --exec -- make test  # no network at all (an agent cannot reach the model here)
```

The block sits between `# >>> pi sandbox >>>` and `# <<< pi sandbox <<<`.
install.sh replaces it on every run (never duplicates it) and keeps the
pre-wrapper file as `~/.bashrc.bak-pi` / `~/.zshrc.bak-pi`. Delete the block to
go back to the bare binary; the raw `pi` stays on PATH either way.

### What is mounted

Read-only: `/usr`, `/etc`, the node and pnpm prefixes, `~/.local/bin` and the tool
stores behind its symlinks (`~/.local/share/pipx`, `~/.local/share/uv`).

That last group is why `gh`, `uvx`, `gitleaks`, `semgrep`, `trivy`, `herdr` and `hc`
exist inside a session at all — without it they are `command not found`, and every
`gh pr …` step the agent is told to run needs `PI_BARE=1`.

A `~/.local/bin` symlink that points outside those trees gets its resolved directory
mounted read-only as well, so the link is not a dangling `command not found`: `jev` and
`local-run` live in `~/big-boss-pi/bin`, and that one directory (never the repo, never
read-write) is what makes the mandatory `jev route` check work inside the sandbox.
Directories the `too_broad` rule refuses — anything under `~/.local`, `~/.config`,
`~/.ssh` — stay out, so `herdr-app` is still absent inside.

What does *not* come with them is their config. `~/.config/gh`, `~/.ssh`, `~/.aws`,
`~/.kube`, `~/.docker` and `~/.config/1Password` are masked, and `.netrc`/`.npmrc` are
bound to `/dev/null`. So `gh` inside reports `not logged into any GitHub hosts`, npm
reports every setting as unset, and both are telling the truth: a sandbox that hands out
a GitHub token has stopped being a sandbox. Run the credentialed step outside, or pass a
narrow `GH_TOKEN` for that one command.

### Starting a session without the sandbox

`scripts/pi-bare` is the named way out — the same binary, started without the
wrapper. `install.sh` symlinks it into `~/.local/bin`, so it is a program:

```
pi-bare            # unsandboxed; the session title starts with "bare"
```

Herdr's new-agent menu (`+`, top right) lists agents from
`~/.config/herdr-app/programs.json`. `sandbox/herdr-programs.json` is the entry
that puts "Pi (bare)" next to "Pi" in that menu; `install.sh` copies it when the
file is absent and leaves an existing one alone. It is a template and holds the
wrapper name (`pi-bare`), never a path: the installer splits that word into the
machine's own bin directory (`pi-bare.cmd` on Windows), because a path written
into the repo is one person's home and everybody else's dead menu row. Menu and terminal are the same
choice: `Pi` → sandboxed, `Pi (bare)` → not, and both sessions say which one
they are.

The hatch exists because a default with no sanctioned exit gets bypassed in a
worse way — a pasted absolute path, or `PI_BARE=1` exported once and inherited
by every later shell.

### Seeing which session is contained

A sandbox you cannot see becomes a sandbox you stop trusting: once the wrapper
exists, the contained session and the `PI_BARE=1` escape look identical. Every
session therefore carries its own state:

- the terminal title starts with the word `sandbox` when the launcher ran and
  `bare` when it did not, plus `no-net` for `--no-net` runs. Herdr shows that
  title as the agent's name in its Agents list — per tab, not per pane: rows
  take the title of the tab's lead agent, so two agents sharing a tab share one
  tag, and a *named* tab shows its name instead of the title;
- the `sandbox` status line says `sandboxed (bwrap)` or `bare: real home and
  credentials` in that session's own footer, which is per session;

Words and not glyphs, deliberately: Herdr's agents mod strips leading
non-alphanumerics from a title (`clean()` in `mods/agents/main.js`), so the
`⛨`/`⚠` prefixes this started with never reached the list, and a symbol the
terminal font lacks would have been invisible in a plain terminal too;
- `sandbox/pi-sandbox.sh` exports `PI_SANDBOX_MODE=bwrap` and
  `PI_SANDBOX_NET=on|off` inside the sandbox. An unset marker means "not
  sandboxed" — absence is the signal, not an unknown.

The badge lives in `agent/extensions/sandbox-badge.ts` and reads the marker
instead of probing: a probe reports what the session can see, the marker reports
what the launcher decided.

Two guards keep this from turning into a broken `pi`:

- `pisandbox` or `bwrap` missing → one line on stderr, then the plain binary.
- `PI_BARE=1` in the environment → the plain binary, silently.

## What it does not protect against

The wrapper only changes *which* command `pi` runs. Every gap below is still
there, and the sandbox is a bubblewrap namespace, not a virtual machine:

- **`PI_BARE=1` disables all of it.** A command that needs no sandbox is one
  environment variable away, by design — that is the escape hatch, not a bug.
- **Network exfiltration** with networking on (the default): anything readable
  can be posted out. Only `--no-net` stops that.
- **Provider credentials and env vars** still reach `pi` (`auth.json` is
  rewritten in flight, but the permitted keys stay readable by generated code).
- **Read-only is not hidden** when you start in `$HOME`: the home tree is
  mounted read-only, so `.bash_history`, browser profiles and `.config` stay
  readable. Start in the project directory to make them absent.
- **Same uid**: files written under the read-write binds are yours for good.
- Shell functions do not apply to scripts and non-interactive shells. A wrapper
  is only a default for the human at the keyboard; `pi` invoked from a script,
  a `systemd` unit or an agent still needs `pisandbox -- pi` explicitly.

Everything else is under [What it protects](#what-it-protects) and
[Known gaps](#known-gaps).

## Launch

```
~/.pi/sandbox/pi-sandbox.sh [--no-net] [--rw DIR]... -- [pi arguments...]
~/.pi/sandbox/pi-sandbox.sh -- -p "review this repo"
~/.pi/sandbox/pi-sandbox.sh --no-net -- --continue
```

Every argument after `--` goes to pi. Always use `--`, otherwise the launcher
refuses the argument as unknown. `install.sh` symlinks `pisandbox` into
`~/.local/bin`; if it is missing, add `alias pisandbox='~/.pi/sandbox/pi-sandbox.sh'`.

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
(a sealed syscall sandbox, no DNS): the session can then reach only loopback, so
an agent has no model to talk to. `--no-net` is for `--exec` runs — build and
test untrusted code without giving it a way out.
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
