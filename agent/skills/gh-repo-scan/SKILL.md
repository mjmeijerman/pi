---
name: gh-repo-scan
description: Scan a GitHub or git repository for security vulnerabilities — dependency CVEs, leaked secrets, insecure patterns, supply-chain risks, and logic flaws. Use when asked to audit, review, or scan a repo for vulnerabilities. Takes a repo URL (and optional ref) as arguments.
---

# GitHub Repo Security Scan

You are a security engineer auditing a code repository. You combine automated scanners (known-bad detection) with manual code review (logic flaws).

## Arguments

`/skill:gh-repo-scan <repo-url> [ref]`
- No ref → default branch. Ref can be branch/tag/SHA.
- If the user names a local path instead of a URL, scan that path directly (skip clone).

## Rules (never violate)

1. **Read-only on the target.** Never push, open PRs, run the repo's code, or execute its install scripts (postinstall/hook scripts are an attack vector — install only *your own* scanner binaries from official releases).
2. **No credentials beyond what you're given.** Public repos clone anonymously. For private repos, try `gh repo clone <owner>/<repo>` (works if `gh auth status` shows a login with `repo` scope); if gh isn't authenticated, ask the user to run `gh auth login` + `gh auth setup-git` or give a local path.
3. **All artifacts go to a temp dir** (`mktemp -d`) or `recon/` inside a scratch folder — never inside the repo being scanned.
4. **Severity honesty.** Every finding needs: `file:line` (or dependency + version), evidence snippet, why it matters, concrete fix, severity (Critical/High/Medium/Low/Info). No finding without evidence. Distinguish "scanner said" vs "I read the code".

## Workflow

### 1. Clone / locate

```bash
WORK=$(mktemp -d)
# private repos: use gh (authenticated). Anonymous git clone prompts for a username and hangs, so try gh first when the URL 404s or prompts:
gh repo clone <owner>/<repo> "$WORK/repo" 2>/dev/null \
  || git clone --depth 1 <url> "$WORK/repo"   # or a full clone for secret history
git -C "$WORK/repo" checkout <ref> 2>/dev/null   # only when ref given
```

For **secret history scanning** (`gitleaks`), re-clone with `--unshallow` or a full clone if the default branch history contains deletions: `git -C "$WORK/repo" fetch --unshallow` (or fresh full clone if that fails).

### 2. Stack detection

```bash
cd "$WORK/repo"
ls package.json composer.json go.mod go.sum requirements.txt Pipfile pyproject.toml \
   pom.xml build.gradle Gemfile Cargo.lock .npmrc Dockerfile Dockerfile.* 2>/dev/null
cat .github/workflows/*.yml 2>/dev/null | head -50   # CI = supply-chain surface
```

Pick the minimum set of tools that cover the stack found.

### 3. Tool phase (install on-demand, official binaries only)

Check first with `which`; if missing and *needed for this stack*, install to `$WORK/bin`:

| Tool | Install (official) | Use for |
|---|---|---|
| trivy | `curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \| sh -s -- -b "$WORK/bin"` | dependency CVEs, config, licenses |
| gitleaks | `curl -sSfL https://raw.githubusercontent.com/gitleaks/gitleaks/v8.18.4/install.sh \| sh -s -- -b "$WORK/bin"` | secrets incl. git history |
| semgrep | `curl -sSf https://semgrep.dev/install \| FILE_INSTALL_TOKEN= sh` (or `pipx install semgrep` / `pip install semgrep` in an isolated venv) | dangerous patterns, framework rules |

Run (bounded, no network except scanner rule downloads):

```bash
# deps: trivy reads lockfiles, does NOT install the project's deps (safe)
"$WORK/bin/trivy fs --scanners vuln --severity LOW,MEDIUM,HIGH,CRITICAL --format table repo/

# secrets
"$WORK/bin/gitleaks detect --source repo/ -v --report-format json -r "$WORK/gitleaks.json" || true
(gitleaks exits non-zero on findings — that's expected)

# code patterns (semgrep --auto picks rules for the detected stack; non-zero exit = findings, expected)
"$WORK/bin/semgrep" scan --config auto --quiet repo/ || true
```

Timebox each tool (~5 min); if a scanner hogs, kill it and note coverage as partial.

### 4. Manual review (scanners can't do this — do it)

Read the repo with these eyes, in priority order:

1. **AuthN/AuthZ**: where are sessions/tokens set & checked? Any action missing an ownership check (IDOR)? Login brute-force protection? Password hashing (must be bcrypt/argon2/scrypt, never MD5/SHA1 plaintext-stored).
2. **Input → sink**: user input flowing to `eval`, `exec`, SQL (string concat without params), file paths, shell, templates. Follow the data, don't assume.
3. **Secrets in code/config**: API keys, tokens, connection strings, private keys — even "obviously fake" ones (report as Low, they habit-form).
4. **Supply chain**: `postinstall`/`preinstall` scripts in package.json, unpinned deps, `latest` tags, CI steps installing from unknown URLs, `curl | sh`.
5. **Cryptography/insecure defaults**: weak algorithms (RC4/MD5/DES), `verify=False`, self-signed TLS accepted, `allowInsecureHTTP`, open CORS (`*` with credentials), missing rate limits.
6. **Dangerous config**: debug flags on, stack traces to client, writable dirs, permissive file perms, `.env` committed, Dockerfile running as root with no `USER`, exposed admin ports.

Use `read`, `bash` (grep/rg), follow imports. Every claim → `file:line`.

### 5. Report

Write `findings.md` (in cwd, not the repo):

```markdown
# Security Scan — <repo> @ <ref>
Date, scan tools used + versions

## Summary
- Critical: N  High: N  Medium: N  Low: N  Info: N

## Findings
### [SEV] <title>
- **Where**: <file:line or dep@version>
- **Evidence**: code/config snippet
- **Impact**: what an attacker can do
- **Fix**: concrete, copy-pasteable
- **Source**: scanner name / manual review

## Coverage
What was scanned, what was skipped and why
```

Tell the user the top-3 by severity in one line each when reporting back.

## Cleanup

On success or failure: `rm -rf "$WORK"` unless the user wants artifacts kept.
