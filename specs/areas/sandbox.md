# sandbox

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `sandbox/pi-sandbox.sh` or `install.sh` changes.

**What this file is.** What a sandboxed session can and cannot reach today, checked against
`sandbox/pi-sandbox.sh`, `sandbox/README.md`, `scripts/pisandbox`, `scripts/pi-bare` and
`install.sh` at trunk `d825563`. A policy change is a delta in `specs/changes/`, not an edit to the
sentence it contradicts.

## Plain `pi` is the sandboxed one

`install.sh` writes a `pi()` shell function between `# >>> pi sandbox >>>` and
`# <<< pi sandbox <<<` into `~/.bashrc` and `~/.zshrc` (`install.sh:221-290`), so `pi` means
`pisandbox -- pi` (`:265`) and safety does not depend on remembering a prefix. The block is
replaced on every install, never duplicated (`:232-236`), and the pre-wrapper file is kept as
`~/.bashrc.bak-pi` from the first run (`:228`). When `pisandbox` or `bwrap` is missing, the function
says so and runs the bare binary instead (`:260-264`); `PI_BARE=1` skips the wrapper (`:256-259`).

The wrapper itself is `sandbox/pi-sandbox.sh`, and `scripts/pisandbox` is only a path-shortcut exec
into it (`scripts/pisandbox:15`, the exec at `:38`). Options (`pi-sandbox.sh:17-29`, parsed
`:39-61`): `--no-net`, `--rw DIR` (repeatable), `--exec` (run the command after `--` instead of pi),
`--help`; everything after `--` goes to pi.

## The named way out

`scripts/pi-bare` is the sanctioned unsandboxed start: the same binary, `PI_BARE=1`
(`scripts/pi-bare:26`), and the session title starts with `bare` for as long as it runs. Herdr's
new-agent menu gets the row `Pi (bare)`, running `/home/mark/.local/bin/pi-bare`
(`sandbox/herdr-programs.json`). The point is that a default with no sanctioned exit gets bypassed
in a worse way (`scripts/pi-bare:6-11`).

## What is mounted

| Path | Mode | Where |
| --- | --- | --- |
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/etc` | read-only | `:138-140` |
| the node toolchain and the pi package prefix | read-only | `:147-152` |
| `$HOME` when the cwd is `$HOME` | read-only, with one notice | `:142-145` |
| `~/.local/bin`, and the pipx/uv stores its symlinks point into | read-only | `:159-161`, `:164-168` |
| the resolved target directory of each `~/.local/bin` symlink, when that target is not too broad | read-only | `:177-201` |
| `/tmp`, `/dev`, `/proc` | fresh tmpfs / device / proc | `:203` |
| `$HOME/.pi` | read-write | `:206` |
| `~/.gitconfig`, `~/.gitignore_global` | read-write single files | `:208-210` |
| `~/.git-templates`, `~/.config/git` | read-only | `:211-212` |
| `$HOME/projects`, `agent-office`, `achterhoek-uitagenda`, `pi-projects` when present | read-write | `:214-218` |
| any `--rw DIR` | read-write | `:220-224` |
| the cwd, when no row above covers it | read-write | `:226-239` |

A `--rw DIR` that resolves too broad — `/`, `/home`, `/tmp`, the home directory, an ancestor of it,
or anything under `~/.local`, `~/.config`, `~/.cache`, `~/.docker`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
`~/.kube` — is refused with the reason named (`too_broad`, `:101-113`; `resolve_rw`, `:117-125`).
The same test is why `herdr-app` is absent inside a session: it is a symlink into
`~/.local/share/herdr-app`, and the link loop skips a target under `~/.local` (`:193`), so the link
dangles.

## What is masked

- Directories that would hand out credentials are an empty tmpfs, when they exist: `~/.ssh`,
  `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config/gh`, `~/.docker`, `~/.config/1Password` (`:272-274`).
- `~/.netrc` and `~/.npmrc` are bound to `/dev/null` (`:275-277`).
- The provider credential store is rebuilt in a temp file holding only the providers named by
  `PI_SANDBOX_AUTH_PROVIDERS` (default: the configured default provider) (`:279-312`).
- npm's `min-release-age` is the one value forwarded out of `~/.npmrc`, as
  `NPM_CONFIG_MIN_RELEASE_AGE`, and only when it is all digits (`:241-265`).
- Every `.env`, `.env.*` and `*.env` file under a read-write tree is bound to `/dev/null`, up to
  500 files, with a printed count and a warning that git now reports tracked dotenv files as
  modified (`:314-337`). That warning is why `git commit -a` and `git add -A` are wrong inside.

`--no-net` adds `--unshare-net` (`:340`), and that mode cannot reach a model — an agent that needs
the network does not run in it. The base namespace set is `--die-with-parent`, `--new-session`,
`--unshare-pid`, `--unshare-ipc`, `--unshare-uts` (`:128-135`).

## What a session can see about itself

The launcher exports `PI_SANDBOX_MODE=bwrap` and `PI_SANDBOX_NET` (`:358-359`), and
`sandbox-badge.ts` puts one word in front of the terminal title — `sandbox`, `sandbox no-net` or
`bare` (`:36`, `:38`, `:67-70`) — with the same verdict on the status line (`:101`). It is TUI-only:
print and JSON modes have no title bar (`:95`). `scripts/harness-check.sh` fails when the launcher
stops exporting either marker, and when the badge file is missing (`check_sandbox_marker`,
`:1289-1312`).

## Known gaps, stated by the README and not argued away here

Read-only is not hidden (`sandbox/README.md`, "Known gaps"): a tool can still read what is mounted
read-only, it just cannot change it. `gh` inside the sandbox says "not logged into any GitHub
hosts" and npm reports every setting unset, because the config that carries them is masked — both
are the sandbox working, not a broken install (`sandbox/README.md:39-42`).

## Not established

- `sandbox/selftest.sh` (261 lines) was read, not run, for this spec; it is the thing that would
  confirm the mounts on this machine.
- The bwrap version on this host, and whether any mount above silently no-ops on it.
- Nothing here mounts `mise`: `grep -c mise sandbox/pi-sandbox.sh` is 0 and `command -v mise` finds
  no binary in a session, so the `mise.toml` pin (blip 68) is a host/CI toolchain, not something a
  sandboxed session can run `mise install` from.
