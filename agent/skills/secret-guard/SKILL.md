---
name: secret-guard
description: Protects secrets (passwords, API keys, tokens, private keys, credentials) from leaking to the model, git, logs, network, or third parties. Use for any task touching credentials, keys, .env files, deployments, auth, or commits.
---

# Secret Guard

You operate under a strict no-secrets policy. Mechanical guards (the secret-guard extension and global git hooks) enforce the most critical rules — follow everything below even where no guard exists. Never try to bypass a guard.

## Golden rules

1. Secrets never go into context, files, git, logs, URLs, or network traffic.
2. Never echo a secret value — even if the user pasted it. Warn and advise rotation instead.
3. If a secret may have leaked anywhere (chat, git history, pastebin, log), say so immediately and recommend rotation. Git history is permanent; assume compromise once a secret touched a remote.

## Secret files (never read their contents)

`.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa`/`id_ed25519`/…, `credentials.*`, `secrets.*`, `auth.json`, `kubeconfig`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `~/.aws/*`, `~/.ssh/*`, `~/.gnupg/*`, `~/.kube/*`, gcloud credentials.

If you need to know whether such a file exists or which keys it defines, describe it without reading values. The user can move values into env vars if you need them.

## Recognize secret values

- Private keys: `-----BEGIN … PRIVATE KEY-----`
- AWS: `AKIA…` access keys, `AWS_SECRET_ACCESS_KEY`
- `sk-…` API keys, `ghp_…`/`github_pat_…` GitHub tokens, `xox…` Slack tokens, `AIza…` Google keys, `(sk|rk)_live_` Stripe keys, JWTs (`eyJ…`), `mongodb/postgres/…://user:pass@` URLs
- `password=` / `api_key=` / `token=` assignments with real-looking values

## Code and config

- Never hardcode secrets. Use environment variables; commit `.env.example` with placeholders, never `.env`.
- Generated code must reference `process.env` / config / a secret manager — never literals.
- No secrets in URLs, query strings, headers, screenshots, or pastebins.

## Git

- Before any commit, think about the staged diff (the global hook also scans it). Never add secret files, even with `-f`. Never put secrets in commit messages.
- If a secret is committed, pushed, or shared: stop, tell the user, recommend rotation.

## Tool use

- Never print secret files; the extension blocks this — don't work around blocks.
- Never run commands that exfiltrate secrets (e.g. `curl`/`scp`/`rsync` carrying tokens).
- If tool output (env, logs, diffs) shows a secret, treat it as redacted and never repeat it.

## If the user pastes a secret

The extension redacts it before it reaches you. If you see one anyway (passthrough mode), warn the user, advise rotation, and never repeat the value.

## Overrides

`/secretguard allow` enables passthrough for one session when the user genuinely needs a secret processed. Only use secrets with explicit user intent after warning them.
