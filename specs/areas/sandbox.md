# sandbox

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `sandbox/pi-sandbox.sh` or `install.sh` changes.

**What this file is.** What a sandboxed session can and cannot reach today, mined from
`sandbox/pi-sandbox.sh`, `sandbox/README.md`, `scripts/pisandbox`, `scripts/pi-bare` and
`install.sh` at trunk `4e40c9a`. A policy change is a delta in `specs/changes/`, not an edit to the
sentence it contradicts.

## Plain `pi` is the sandboxed one

`install.sh` writes a `pi()` shell function between `# >>> pi sandbox >>>` and
`# <<< pi sandbox <<<` into `~/.bashrc` and `~/.zshrc` (`install.sh:221-249`), so `pi` means
`pisandbox -- pi` and safety does not depend on remembering a prefix. The block is replaced on
every install, never duplicated, and the pre-wrapper file is kept as `~/.bashrc.bak-pi`.

The wrapper itself is `sandbox/pi-sandbox.sh`, and `scripts/pisandbox` is only a path-shortcut
exec into it (`scripts/pisandbox:14`). Options (`pi-sandbox.sh:10-27`): `--no-net`, `--rw DIR`
(repeatable), `--exec` (run the command after `--` instead of pi), `--help`; everything after
`--` goes to pi.

## The named way out

`scripts/pi-bare` is the sanctioned unsandboxed start: the same binary, no wrapper, `PI_BARE=1`
(`scripts/pi-bare:26`), and the session title shows ⚠ for as long as it runs. Herdr's new-agent
menu lists it next to `Pi` from `sandbox/herdr-programs.json`. The point is that a default with no
sanctioned exit gets bypassed in a worse way (`scripts/pi-bare:3-8`).

## What is mounted

| Path | Mode | Where |
| --- | --- | --- |
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/etc` | read-only | `:138-141` |
| `$HOME` when the cwd is `$HOME` | read-only, with one notice | `:143-146` |
| `~/.local/bin` and the resolved targets of its symlinks, when the target is not too broad | read-only | `:160-200` |
| `$HOME/.pi` | read-write | `:206` |
| `$HOME/projects`, `agent-office`, `achterhoek-uitagenda`, `pi-projects` when present | read-write | `:210-215` |
| `~/.gitconfig`, `~/.gitignore_global` | read-write single files | `:207-210` |
| `~/.git-templates`, `~/.config/git` | read-only | `:211-215` |
| `/tmp`, `/dev`, `/proc` | fresh tmpfs / device / proc | `:203` |

A `--rw DIR` that resolves under `~/.local`, `~/.config`, `~/.ssh` or the whole home directory is
refused with the reason named (`too_broad`, `:101-124`). That refusal is why `herdr-app` is still
absent inside a session.

## What is masked

- Directories that would hand out credentials are an empty tmpfs: `~/.ssh`, `~/.gnupg`, `~/.aws`,
  `~/.kube`, `~/.config/gh`, `~/.docker`, `~/.config/1Password` (`:272-274`).
- `~/.netrc` and `~/.npmrc` are bound to `/dev/null` (`:275-277`).
- The provider credential store is rebuilt in a temp file holding only the providers named by
  `PI_SANDBOX_AUTH_PROVIDERS` (default: the configured default provider) (`:282-310`).
- Every `.env`, `.env.*` and `*.env` file under a read-write tree is bound to `/dev/null`, up to
  500 files, with a printed count and a warning that git now reports tracked dotenv files as
  modified (`:316-338`). That warning is why `git commit -a` and `git add -A` are wrong inside.

`--no-net` adds `--unshare-net` (`:340`), and that mode cannot reach a model — an agent that
needs the network does not run in it. The base namespace set is `--die-with-parent`,
`--new-session`, `--unshare-pid`, `--unshare-ipc`, `--unshare-uts` (`:130-137`).

## What a session can see about itself

The launcher exports `PI_SANDBOX_MODE=bwrap` and `PI_SANDBOX_NET` (`:358-359`), and
`sandbox-badge.ts` shows ⛨ or ⚠ in the title. `scripts/harness-check.sh` fails when the launcher
stops exporting the pair, or when the badge stops displaying it (`check_sandbox_marker`).

## Known gaps, stated by the README and not argued away here

Read-only is not hidden (`sandbox/README.md`, "Known gaps"): a tool can still read what is mounted
read-only, it just cannot change it. `gh` inside the sandbox says "not logged into any GitHub
hosts" and npm reports every setting unset, because the config that carries them is masked — both
are the sandbox working, not a broken install.

## Not established

- `sandbox/selftest.sh` (261 lines) was read, not run, for this spec; it is the thing that would
  confirm the mounts on this machine.
- The bwrap version on this host, and whether any mount above silently no-ops on it.
