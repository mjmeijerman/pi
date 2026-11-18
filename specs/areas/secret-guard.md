# secret-guard

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `agent/extensions/secret-guard.ts` changes.

**What this file is.** The behaviour the guard has today, mined from
`agent/extensions/secret-guard.ts` at trunk `4e40c9a`. Line numbers are that file. A change to
this behaviour is a delta in `specs/changes/`, not an edit to the sentence it contradicts — see
`specs/changes/README.md`.

## It is always on

One extension, loaded in every session, no opt-in (`:541`). Two explicit ways past it, both
session-scoped: `/secretguard allow|block` (`:692`), and `SECRET_GUARD_PASSTHROUGH=1`, read once
at load (`:283`). Both are reset by `session_start` (`:542-547`), so an allowance never survives
into a new session.

## Layers, and what each one answers

| Layer | Hook | Today's rule |
| --- | --- | --- |
| input | `:553` | secret values in what the user types are replaced with `[REDACTED:<pattern>]` before the model sees them |
| tool_call | `:569` | blocks a command carrying a likely secret value, a read of a credential file, a write into one, a write of secret content, and a send that follows a secret-file step in the same turn |
| tool_result | `:633` | secret values in tool output are redacted before the model reads them |
| before_agent_start | `:677` | the guard's rules are prepended to the system prompt (`:528-537`) |
| flow | `:569`, `:388-402` | see "The flow ledger" below |

Detection table: `:36-54` — private key blocks, AWS `AKIA…`, `sk-…`, GitHub `ghp_/github_pat_…`,
Slack `xox[baprs]-…`, Google `AIza…`, Stripe `sk_live_…`, JWT, DB URIs with a password, and two
`password = "…"` assignment shapes. `SAFE_RE` (`:59`) exempts a name containing
`example|sample|template|fixture|mock|dummy|placeholder|changeme`.

A credential **file** is recognised by name (`:56-57`): `.env*` including a glued prefix
(`prod.env`), `.git-credentials`, `.netrc`, `.pypirc`, `.npmrc`, `id_rsa`/`id_ed25519`/`id_dsa`/
`id_ecdsa`, `credentials.*`, `secrets.*`, `kubeconfig`, `auth.json`, `*.pem|p12|pfx|jks|keystore|
key`, and anything under `.aws`, `.ssh`, `.gnupg`, `.kube`, `.config/gcloud`.

## The flow ledger, and why it resets per run

Every layer above judges one tool call, and each step of a toxic flow is harmless alone — copy
`.env` to `/tmp`, base64 it, POST it. So the guard keeps a ledger of the secret-shaped paths a
step touched and which step touched them (`:388-402`, `LEDGER_LIMIT = 16` at `:404`). A later step
in the same turn that sends file content off the machine is refused, and the refusal names the
earlier step and path (`:591-604`): `curl`/`wget`/`scp`/`rsync`/`git push`, a reader piped into a
send, a redirect other than `/dev/null`, a content-from-file flag, or an `scp`/`rsync` target that
is remote (`:267-281`, `:505-520`).

A **turn is one agent run — one user prompt**, not one model response: pi fires `turn_start` per
response and a flow spans several. So the ledger is reset by `input` (source `extension` excluded),
`agent_start` and `session_start` (`:412`, `:542-560`). That reset is the answer to "why does the
ledger reset per run": a ledger that outlived the prompt would refuse a `git push` because an
earlier, unrelated prompt read an `.env`.

Three shapes stay out of the ledger on purpose (`:459-475`): a path in a `#` comment, a bare name
that is not path-shaped, and a read the user allowed with `/secretguard allow`.

## Audit log

`<agent-dir>/secret-guard.log` — one line per decision, carrying counts and pattern names, never a
value (`:21`, `:33`).

## Not established

- What `scripts/harness-check.sh` says about this extension: nothing checks its behaviour; the
  tests are `agent/extensions/__tests__/secret-guard*.test.ts` (five files) and run under the
  extension suite, not under a `specs/` check.
- The poison-detection ordering between the input and tool_call layers: both are read here from
  the source, no run of the extension was used to confirm it.
