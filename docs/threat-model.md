# Threat model — the pi harness

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-15 — half-yearly, or whenever `sandbox/pi-sandbox.sh` changes.

Radar Vol. 35 basis: blip 6 (threat modeling, Adopt) says the sandbox scope is
informed by a threat model, not by taste. Blip 22 (toxic flow analysis for AI) is why
the unit of analysis below is a *flow* — a page read, a command run, a value returned —
and not a single tool call. Blip 31 (MITRE ATLAS, Assess) is why the attacker paths are
grouped by adversary tactic instead of by file. The instrument is a coding harness
running commands as the user: the adversary is not assumed to be the model, it is
assumed to be anyone who can put text in front of the model.

This document is the scope statement for `sandbox/pi-sandbox.sh` and for every
place the harness deliberately does not use it. Where the two disagree, the script is
right and this doc is stale.

## 1. Assets

Ranked by what a single successful exfiltration buys the attacker.

| Asset | Path | Why it matters | Contained? |
| --- | --- | --- | --- |
| SSH private keys | `~/.ssh/` (`id_*`, `known_hosts`) | Write access to every git remote the user can reach, including this repo's `origin` | masked (`--tmpfs`) |
| GitHub CLI token | `~/.config/gh/hosts.yml` | Same as above, over HTTPS, with `repo` scope and PR-merge rights | masked (`--tmpfs`) |
| Provider credentials | `~/.pi/agent/auth.json` | Billing on the model account; the key is the wallet | rewritten in flight to the allowed providers only |
| Cloud and vault credentials | `~/.aws/`, `~/.kube/`, `~/.config/1Password/`, `~/.gnupg/`, `~/.docker/` | Infrastructure takeover, or the vault that holds everything else | masked (`--tmpfs`) |
| The harness itself | `~/.pi` — read-write in every sandboxed session | `agent/AGENTS.md`, `agent/extensions/*.ts`, `agent/skills/*`, `git-hooks/*`: whoever writes here sets the rules for every later session | **not protected** — by design, the agent must edit its own harness |
| Git remotes | `git@github.com:mjmeijerman/pi.git`, project remotes | Ability to push, i.e. to turn any of the above into code that runs on the next checkout | not mounted inside the sandbox (`~/.ssh` masked); reachable from bare sessions |
| Project source | `~/projects`, `~/agent-office`, `~/achterhoek-uitagenda`, `~/pi-projects`, `--rw DIR`, cwd | Client code and any secrets committed by accident | read-write, intentionally |
| Session transcripts | `~/.pi/agent/sessions/*.jsonl` | Every prompt, every tool output, every path the user typed | read-write, inside `~/.pi` |

Two consequences fall out of the table. First, the sandbox protects *credentials*, not
*the harness*: `~/.pi` is writable because a harness that cannot edit itself cannot
improve itself (blip 18), and that trade is the largest single residual risk here.
Second, the highest-value asset that remains readable inside a session is the
transcript, which contains tokens nobody meant to put there.

## 2. Attacker paths

Grouped by tactic, with the ATLAS tactic named where one applies (blip 31). The
`AML.T…` identifier is a pointer to the tactic family, not a claim that pi is
catalogued in ATLAS.

### 2.1 Indirect prompt injection via fetched content (Execution)

Untrusted web pages and PDFs are read into the session by `fetch_content`,
`get_search_content`, `web_search`, `source_check`, and by `curl`/`pdftotext` from a
shell. The text arrives in the same channel as the user's instructions, so an
instruction embedded in a page is indistinguishable from one the user typed. This is
the path the ATLAS prompt-injection family (`AML.T0051`) names, and it is the only
attacker path here that needs no code execution to start: reading a page *is* the
exploit.

What the model can do once the injection lands is bounded by the sandbox, not by the
model's judgement. Reading `.env` returns an empty file (`--ro-bind /dev/null`);
reading `~/.ssh/id_ed25519` returns an empty directory (`--tmpfs`); `gh` reports "not
logged into any GitHub hosts". What it can still do: read every file under the
read-write binds, write to `~/.pi/agent/skills/` or `agent/AGENTS.md` for the next
session, and — with networking on — post whatever it read to an attacker host.

### 2.2 Package installs (Resource Development → Execution)

`npm`/`pnpm` installs, `uvx`/`uv tool run` of an arbitrary package, MCP servers and pi
packages declared in `agent/settings.json` (`packages`, blip 7). A package's
`postinstall` runs as the user, inside the same namespace, with the same binds. Two
mitigations apply: npm's 48-hour release quarantine (`min-release-age=2` days, blip 99)
and the fact that `~/.npm` and `~/.cache` are not mounted, so installs generally fail
inside the sandbox rather than succeed at machine scope. Neither is a provenance
check: nothing verifies who published what, and the deferred install still happens the
first time someone runs it bare.

### 2.3 Model-issued shell commands (Execution → Exfiltration)

The `bash` tool is the primary capability and the primary risk. A command composed
from injected text reads and writes with the user's uid. Real constraints:
`--die-with-parent`, `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--new-session`,
a fresh `/tmp` (`--tmpfs /tmp`), its own `/dev` and `/proc`; `--unshare-net` only when
`pisandbox --no-net` is passed. Unconstrained: filesystem reach under the read-write
binds, `127.0.0.1` (a local Ollama or dev server), the X11 socket if someone adds it,
and, whenever networking is on, egress.

Blip 22's point lands here: each step of a toxic flow is harmless on its own. `curl`
a page (fine), read a file (fine), `curl` again with the file in the body (exfiltration).
The sandbox cuts the flow at the third step only when it is `--no-net`; `secret-guard`
cuts a *value* leaving a tool call, not a flow whose earlier steps were all allowed.

### 2.4 Malicious agent skills (Persistence → Defense Evasion)

`agent/skills/*/SKILL.md` and pi packages are prompt text that loads on demand, and
`agent/AGENTS.md` loads every turn. A skill copied from elsewhere — or written by an
agent that read an injected page — persists the attacker's instructions past the
session that carried them, in exactly the place the harness trusts most. Nothing
scans a skill for hidden Unicode, nothing pins its provenance, and `harness-check.sh`
checks skill *length*, not skill *intent*. This is the path with the longest dwell
time: the payload survives compaction, restarts and the next branch.

### 2.5 Harness self-modification (Impact)

`agent/extensions/*.ts` runs as code in the pi process with full Node access, and
`~/.pi` is read-write. An extension edit does not need the sandbox to fail; it makes
the sandbox optional for everything that runs afterwards. `merge-guard` and the risk
tiers in `agent/AGENTS.md:14` are the current answer, and they are a *human* control,
not a technical one (blip 17, blip 42).

## 3. What the sandbox actually does

From `sandbox/pi-sandbox.sh` (read 2026-11, commit on `docs/threat-model`). Argument
order matters: **masks come after binds so they win.**

Read-only binds: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/etc` (skipped
when absent); the node prefix (`~/.local/share/fnm/node-versions/<v>/installation`)
and the pi pnpm prefix, unless `/usr` already covers them; `~/.local/bin` (so `gh`,
`uv`, `uvx`, `gitleaks`, `semgrep`, `trivy`, `herdr`, `hc`, `git-vuln-scan` exist
inside *without* their config); `~/.local/share/pipx` and `~/.local/share/uv` (so the
symlinks into those stores resolve); `~/.git-templates` and `~/.config/git` when
present. The whole of `$HOME` is bound read-only **only** when the session starts in
`$HOME` itself, with a stderr notice.

Read-write binds: `~/.pi`; `~/.gitconfig` and `~/.gitignore_global`; then, for any of
`~/projects`, `~/agent-office`, `~/achterhoek-uitagenda`, `~/pi-projects` that exist;
every `--rw DIR`; and the current directory when nothing above already covers it. The
launcher refuses to start when the cwd or a `--rw` target is too broad — `/`, `/home`,
`/root`, `/tmp`, `/var`, `/run`, `/dev`, `/proc`, `/sys`, `$HOME` itself, or any of
`~/.local`, `~/.config`, `~/.cache`, `~/.docker`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
`~/.kube`, and any ancestor of `$HOME`.

Masks, applied last: `--tmpfs` over `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`,
`~/.config/gh`, `~/.docker`, `~/.config/1Password`; `--ro-bind /dev/null` over
`~/.netrc` and `~/.npmrc`; `~/.pi/agent/auth.json` replaced by a temp file holding
only `PI_SANDBOX_AUTH_PROVIDERS` (default: the `defaultProvider` from
`agent/settings.json`), or `/dev/null` if that filter fails; and every `.env`,
`.env.*` and `*.env` file under each read-write tree bound to `/dev/null`, up to 500
files. Namespace: `--die-with-parent --new-session --unshare-pid --unshare-ipc
--unshare-uts --hostname pi-sandbox`, `--tmpfs /tmp`, `--dev /dev`, `--proc /proc`.
`--unshare-net` only with `--no-net`. Marker: `PI_SANDBOX_MODE=bwrap`,
`PI_SANDBOX_NET=on|off`, displayed by `agent/extensions/sandbox-badge.ts`.

## 4. What it does NOT cover

This is the part that has to be read, because the sandbox looks total from inside.

1. **Bare-mode sessions, in full.** `PI_BARE=1 pi`, `scripts/pi-bare`, and the
   "Pi (bare)" entry in Herdr's new-agent menu (`sandbox/herdr-programs.json`) run the
   raw binary: real `$HOME` read-write, real `~/.ssh`, real `~/.config/gh`, real
   `auth.json`, real network, no masks. Every asset in §1 is exposed in those
   sessions.
2. **The big-boss-pi boss runs bare on purpose.** It must reach Herdr's unix sockets,
   and this launcher mounts neither `XDG_RUNTIME_DIR` nor `/tmp/.X11-unix` — a fresh
   `/tmp` (`--tmpfs`) removes the socket path that Herdr and `hc` use. The boss is
   therefore the one session with full credential reach *and* the authority to spawn
   other agents, which makes it the highest-value target in the whole setup and the
   one place where a prompt injection is not contained at all. Workers it spawns
   (`scripts/agent-pane.sh`) inherit the boss's containment, not the sandbox's.
3. **Network egress, when networking is on** — the default. Anything readable can be
   posted out. `--no-net` is the only hard stop, and the model cannot reach a provider
   under it, so it is for `--exec` runs, not for interactive sessions.
4. **Read, not just write, when starting in `$HOME`.** The home tree is mounted
   read-only, so `.bash_history`, browser profiles and `~/.config` are *readable* —
   credential masks still apply, but "read-only" is not "hidden".
5. **Provider credentials that remain.** `auth.json` keeps the allowed provider's key,
   and provider API keys in the environment are inherited: generated code can read
   them and use them.
6. **Local services.** `127.0.0.1` is reachable, so a local Ollama or any dev server is
   exposed to sandboxed code.
7. **Same uid.** Anything written under a read-write bind is the user's, permanently.
   There is no rollback and no separate identity.
8. **The harness's own rules.** `~/.pi` is writable, so `AGENTS.md`, extensions, hooks
   and skills are all modifiable from inside the sandbox (§2.4, §2.5).
9. **The launcher being skipped.** The wrapper is a shell function in the rc file. A
   script, `systemd` unit, IDE or `env -i` invocation gets the bare binary. Absence of
   `PI_SANDBOX_MODE` is the only signal, and nothing refuses to run without it.
10. **Supply chain.** No provenance check on packages, skills or pi packages (§2.2).

## 5. Decisions

Each item is a decision the owner makes, not a task an agent may take on its own.
Ranked by residual risk per hour of work.

1. **`~/.pi` stays read-write inside the sandbox — accept, and keep the tier gate.**
   Accepting self-modification is what makes the harness improvable. The control stays
   human review at High tier (blip 17, blip 42). If that review ever lapses, this
   decision must be revisited before anything else here.
2. **The boss stays bare — accept, and narrow what the boss may read.** The Herdr
   socket requirement is real (§4.2). Decide whether the boss session is allowed to
   fetch untrusted pages and PDFs at all; the cheapest fix is a rule in the boss's spec
   that research goes to a worker, not to the boss.
3. **Skills and `AGENTS.md` get a provenance line or they do not land.** Decide whether
   every `agent/skills/*/SKILL.md` carries an origin (authored here, or package +
   version). Cost: one line per skill. Closes half of §2.4.
4. **Add a hidden-Unicode and prompt-injection scan to `harness-check.sh`** (blip 72's
   supply-chain gap, blip 110's eval gap). Decide: a `git diff` scan at
   `git-hooks/pre-commit`, or a full-file scan in CI. Recommendation: pre-commit scan on
   changed lines.
5. **`--no-net` for any autonomous run.** Decide whether `pisandbox --no-net` is
   mandatory for `pi -p` one-shots and unattended runs, where no human reads the output
   anyway. Cost: one flag in the launcher path the workers use.
6. **Mount `XDG_RUNTIME_DIR` read-only for Herdr sockets, or keep the boss bare
   permanently.** Decide which of the two you are betting on; the current state is the
   second without having said so.
7. **Re-measure at the next review.** Confirm the mask list in §3 still matches
   `sandbox/pi-sandbox.sh` (the script wins), and re-run `bash scripts/harness-check.sh`.
   Cost: 15 minutes.
