#!/usr/bin/env bash
# The install instructions have to fail on a command a reader cannot paste.
#
# Why these exist: the first real Windows install failed twice, and both failures
# were the docs' fault. `INSTALL.md` said "you need git, and Node at the version
# in .node-version" — a file that does not exist until after the clone — and the
# Linux/macOS block carries `&&`, which Windows PowerShell 5.1 rejects with
# `the token && is not a valid statement separator`. A third failure was one step
# behind them: PowerShell resolves `npm` to `npm.ps1`, and the default
# `Restricted` execution policy refuses to run it. Then the next wall: `winget`
# wrote the machine PATH, the shell held the block Explorer copied before it, and
# `git --version` said `not recognized` — so `docs/install.md` has to carry that
# symptom and the `SetEnvironmentVariable` repair, both.
#
# Same shape as doc-facts.test.sh: every case plants the two documents it argues
# about in a throwaway tree, runs the real check against it with --root, and the
# last case runs it against this checkout so the guard cannot drift away from the
# docs without a red test.
#
# Cheap on purpose: no network, no model, no node. Run it by hand, or through
# `make scripts-test`.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
OUT=""
ERR=""
STATUS=0

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

case_start() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	DIR="$WORK/case$CASE_N"
	mkdir -p "$DIR/root/docs"
	OUT=""
	ERR=""
	STATUS=0
}

run() {
	OUT="$("$@" 2>"$DIR/stderr")"
	STATUS=$?
	ERR="$(cat "$DIR/stderr")"
}

doc() { # path, then the text on stdin
	mkdir -p "$DIR/root/$(dirname "$1")"
	cat >"$DIR/root/$1"
}

# good — both documents as they are supposed to look, so a case can plant exactly
# one fault and blame it. Everything the check asks for is here once: a Windows
# section before the clone, winget, the policy line, a check block with npm.cmd.
good() {
	doc INSTALL.md <<'DOC'
# Install pi on a bare machine

## 1. git and Node 24, before the clone

### Windows, in PowerShell

`winget` is on Windows 10 1809+ and on 11. This is not the bash block.

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
git --version
node --version
npm.cmd --version
where.exe git node
```

`node --version` has to print `v24.x`. Node ships `npm` as `npm.ps1`, and
`running scripts is disabled on this system` is the policy refusing it.

### macOS, in Terminal

```bash
xcode-select --install
git --version
node --version
npm --version
```

## 2. Clone, then run the installer

macOS and Linux — bash or zsh, not PowerShell:

```bash
git clone https://github.com/x/pi.git ~/.pi && cd ~/.pi && ./setup.sh
```

Windows — PowerShell, one command per line:

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
cd $env:USERPROFILE\.pi
node setup.mjs
```
DOC
	doc docs/install.md <<'DOC'
# Install reference

## Prerequisites, per OS

macOS and Linux, in bash or zsh:

```bash
git --version && node --version
```

## Troubleshooting

**`git` is not recognized, right after installing it (Windows).** The install
landed; the shell holds the PATH Explorer copied before it.

```powershell
$u = [Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path', "$u;C:\Program Files\Git\cmd", 'User')
```
DOC
}

check() { run bash "$ROOT_DIR/scripts/harness-check.sh" --root "$DIR/root" --verify-install-docs; }

expect_fail_with() { # needle...
	local needle
	if [ "$STATUS" -eq 0 ]; then
		fail "expected a non-zero exit, got 0" "output: ${OUT:-<empty>}"
		return 1
	fi
	for needle in "$@"; do
		if ! printf '%s' "$OUT" | grep -qF -- "$needle"; then
			fail "the report does not say '$needle'" "${OUT:-<empty>}"
			return 1
		fi
	done
	pass "exit $STATUS, and the report names the fault"
}

expect_pass_with() { # needle...
	local needle
	if [ "$STATUS" -ne 0 ]; then
		fail "expected exit 0, got $STATUS" "${OUT:-<empty>}" "${ERR:-<empty>}"
		return 1
	fi
	for needle in "$@"; do
		if ! printf '%s' "$OUT" | grep -qF -- "$needle"; then
			fail "the report does not say '$needle'" "${OUT:-<empty>}"
			return 1
		fi
	done
	pass "exit 0, and the report says why"
}

# ------------------------------------ the baseline fixture is actually clean ---
case_start "the shape the check asks for passes, so a failure below is the planted fault"
good
check
expect_pass_with 'PASS install-docs' 'every powershell block is pasteable'

# --------------------------------------------------- && in a powershell block --
case_start "a powershell block that joins commands with && is a FAIL, with the line"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

### Windows, in PowerShell

```powershell
winget install --id Git.Git -e --source winget
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi && cd $env:USERPROFILE\.pi
npm.cmd --version
where.exe git node
```

## Clone

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
```
DOC
check
expect_fail_with 'FAIL install-docs' 'INSTALL.md:8' 'joins commands with &&'

case_start "the reference doc is held to the same rule, not just the quick start"
good
doc docs/install.md <<'DOC'
# Install reference

```powershell
winget install --id Git.Git -e --source winget && node --version
```
DOC
check
expect_fail_with 'FAIL install-docs' 'docs/install.md:4' 'joins commands with &&'

# ----------------------------------- && in a bash block is correct, not a fault --
case_start "a bash block keeps && — that is how the Linux and macOS clone is written"
good
check
expect_pass_with 'PASS install-docs'

# --------------------------------------------- a missing Windows prerequisite --
case_start "INSTALL.md with no Windows section fails: a Windows reader brings Node or leaves"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

You need `git` and Node at the version in `.node-version`.

## Clone

```bash
git clone https://github.com/x/pi.git ~/.pi && cd ~/.pi && ./setup.sh
```
DOC
check
expect_fail_with 'FAIL install-docs' 'no Windows section'

case_start "a Windows section that is not a PowerShell section fails: prose is not a command"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

### Windows notes

Install git, Node and set the execution policy first.

## Clone

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
```
DOC
check
expect_fail_with 'FAIL install-docs' 'no Windows section'

case_start "a Windows section after the clone fails: pre-clone facts are unreadable pre-clone"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

## 1. Clone

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
```

## 2. Windows, in PowerShell

```powershell
winget install --id Git.Git -e --source winget
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
npm.cmd --version
where.exe git node
```
DOC
check
expect_fail_with 'FAIL install-docs' 'after the clone'

case_start "a Windows section with no Set-ExecutionPolicy line fails"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

### Windows, in PowerShell

```powershell
winget install --id Git.Git -e --source winget
npm.cmd --version
where.exe git node
```

## Clone

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
```
DOC
check
expect_fail_with 'FAIL install-docs' 'Set-ExecutionPolicy'

# ------------------------------------- npm without the .cmd form on Windows ---
case_start "npm in a powershell block without .cmd fails: that is npm.ps1, and the policy blocks it"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

### Windows, in PowerShell

```powershell
winget install --id Git.Git -e --source winget
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm.cmd --version
where.exe git node
```

## Clone

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
```
DOC
check
expect_fail_with 'FAIL install-docs' 'npm in a Windows context' 'npm install -g'

case_start "npm install in Windows prose fails too, not only in a fenced block"
good
doc INSTALL.md <<'DOC'
# Install pi on a bare machine

### Windows, in PowerShell

On Windows, run npm install -g @earendil-works/pi-coding-agent before setup.

```powershell
winget install --id Git.Git -e --source winget
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
npm.cmd --version
where.exe git node
```

## Clone

```powershell
git clone https://github.com/x/pi.git $env:USERPROFILE\.pi
```
DOC
check
expect_fail_with 'FAIL install-docs' 'npm in a Windows context'

case_start "naming npm.ps1 as the symptom is not a fault — that is the sentence that explains it"
good
check
expect_pass_with 'PASS install-docs'

# ----------------------------------- the Windows PATH entry cannot be deleted --
case_start "a troubleshooting entry without the symptom is a FAIL: the fix has no name"
good
doc docs/install.md <<'DOC'
# Install reference

## Troubleshooting

**`git` is not found on Windows.** Append to the user PATH and sign out.

```powershell
$u = [Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path', "$u;C:\Program Files\Git\cmd", 'User')
```
DOC
check
expect_fail_with 'FAIL install-docs' "'git is not recognized' + 'SetEnvironmentVariable' pair"

case_start "a troubleshooting entry without the repair is a FAIL: the symptom has no fix"
good
doc docs/install.md <<'DOC'
# Install reference

## Troubleshooting

**`git` is not recognized on Windows.** The shell holds the PATH Explorer copied
before the install; open a new window from the Start menu.

```powershell
git --version
```
DOC
check
expect_fail_with 'FAIL install-docs' "'git is not recognized' + 'SetEnvironmentVariable' pair"

# --------------------------------------------------- the real tree stays green --
case_start "this checkout passes the check, so the guard and the docs agree"
run bash "$ROOT_DIR/scripts/harness-check.sh" --root "$ROOT_DIR" --verify-install-docs
expect_pass_with 'PASS install-docs'

# ------------------------------------------------------------------- summary ---
printf '\n== install-docs: %d case(s), %d ok, %d failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
