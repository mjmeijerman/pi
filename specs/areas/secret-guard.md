# secret-guard

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `agent/extensions/secret-guard.ts` changes.

**What this file is.** The behaviour the guard has today, checked against
`agent/extensions/secret-guard.ts` at trunk `d825563`; that file is byte-identical to `4e40c9a`,
where these line numbers were first taken. A change to this behaviour is a delta in
`specs/changes/`, not an edit to the sentence it contradicts — see `specs/changes/README.md`.

## It is always on

One extension in pi's auto-discovered global directory, so it loads in every session with no opt-in
(`:541`; pi auto-loads `~/.pi/agent/extensions/*.ts`). Two explicit ways past it, both
session-scoped: `/secretguard allow|block` (`:692`), and `SECRET_GUARD_PASSTHROUGH=1`, read once
at load (`:283`). `session_start` turns passthrough back off and clears the ledger (`:542-544`), so
an allowance never survives into a new session.

## Layers, and what each one answers

| Layer | Hook | Today's rule |
| --- | --- | --- |
| input | `:553` | secret values in what the user types are replaced with `[REDACTED:<pattern>]` before the model sees them |
| tool_call | `:569` | blocks a command carrying a likely secret value, a read of a credential file, a write into one, a write of secret content, and a send that follows a secret-file step in the same turn |
| tool_result | `:633` | secret values in tool output are redacted before the model reads them |
| before_agent_start | `:677` | the guard's rules are prepended to the system prompt (`:530-536`) |
| user_bash | `:682` | a `!` command of the user's that reads a credential file is refused, by the same reader test |
| flow | `:569`, `:388-402` | see "The flow ledger" below |

Detection table: `:36-54` — private key blocks, AWS `AKIA…`, `sk-…`, GitHub `ghp_`/`github_pat_…`,
Slack `xox[baprs]-…`, Google `AIza…`, Stripe `(sk|rk)_live_…`, JWT, DB URIs with a password, and two
assignment shapes: a quoted value, and an unquoted value of 16 or more characters.

Two exemptions, and what they are tested against. `SAFE_RE` (`:59`) spares a match containing
`example|sample|template|fixture|mock|dummy|placeholder|changeme`; `ENV_REF_RE` (`:62`) spares an
assignment whose value points at the environment (`process.env`, `os.environ`, …). For an assignment
both are tested against the **value**, not the key name (`findSecretValue`, `:364-383`), so a
placeholder key name does not spare the real key stored beside it.

A credential **file** is recognised by name (`:56-57`): `.env*` including a glued prefix
(`prod.env`), `.git-credentials`, `.netrc`, `.pypirc`, `.npmrc`, `id_rsa`/`id_ed25519`/`id_dsa`/
`id_ecdsa`, `credentials.*`, `secrets.*`, `kubeconfig`, `auth.json`, `*.pem|p12|pfx|jks|keystore|
key`, and anything under `.aws`, `.ssh`, `.gnupg`, `.kube`, `.config/gcloud`.

## The flow ledger, and why it resets per run

Every layer above judges one tool call, and each step of a toxic flow is harmless alone — copy
`.env` to `/tmp`, base64 it, POST it. So the guard keeps a ledger of the secret-shaped paths a
step touched and which step touched them (`:388-402`, `LEDGER_LIMIT = 16` at `:404`). A later step
in the same turn that sends file content off the machine is refused, and the refusal names the
earlier step and path (`:587-601`). A send is `git push`, or one of `curl`/`wget`/`scp`/`rsync`/
`nc`/`http(s)` aimed at another host (`SEND_RE` `:267`, `NET_TARGET_RE` `:271`, `isOutboundSend`
`:512-519`), carrying one of the body shapes in `sendsFileContent` (`:488-508`): an upload flag, an
`@file` body, a `$(cat f)` substitution, a reader piped in, a `< file` redirect other than
`/dev/null`, or an `scp`/`rsync` whose last operand is remote.

A **turn is one agent run — one user prompt**, not one model response: pi fires `turn_start` per
response and a flow spans several. So the ledger is reset by `input` (source `extension` excluded,
`:554`), `agent_start` (`:548-550`) and `session_start` (`:542-544`), and by `/secretguard allow`
(`:699`) — a read the user just allowed must not be held against a later send. That reset is the
answer to "why does the ledger reset per run": a ledger that outlived the prompt would refuse a
`git push` because an earlier, unrelated prompt read an `.env`.

Three shapes stay out of the ledger on purpose (`:459-475`): a path in a `#` comment, a quoted word
that is not path-shaped (prose, not an argument), and any segment whose verb is not a content mover
(`TOUCH_RE`, `:82`) — `git status` naming a file touches nothing.

## Audit log

`<agent-dir>/secret-guard.log` — one line per decision, carrying counts and pattern names, never a
value (`:21`, `:31`).

## Not established

- What `scripts/harness-check.sh` says about this extension: nothing — `grep -n secret-guard
  scripts/harness-check.sh` is empty. Its tests are `agent/extensions/__tests__/secret-guard*.test.ts`
  (five files), run by `agent/package.json`'s `test`, not by a `specs/` check.
- The ordering between the input and tool_call layers: read from the source here, no run of the
  extension was used to confirm it.
