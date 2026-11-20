#!/usr/bin/env bash
# The transport table has to fail on a wrong sentence, not wait for a reader.
#
# Why these exist: agent/skills/jev/SKILL.md and agent/AGENTS.md described jev as
# a local ollama model for as long as bin/jev-model.mjs said TypeSafe, because
# nothing compared prose to code. A check for that is only worth its line in
# harness-check.sh if it fires on a planted wrong sentence AND stays quiet on a
# true one: `local_llm` on ollama is correct, and `local-run` legitimately sits
# one clause away from a jev paragraph. So every case here plants the docs it
# argues about in a throwaway tree and runs the real check against it with
# --root, and the last case runs it against this checkout so the table cannot
# drift away from the docs without a red test.
#
# Cheap on purpose: no network, no model, no node, temp dirs under one mktemp -d.
# Run it by hand, or through `make scripts-test`.
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
	mkdir -p "$DIR/root"
	OUT=""
	ERR=""
	STATUS=0
}

# run — the command's verdict in STATUS, its two streams in OUT and ERR.
run() {
	OUT="$("$@" 2>"$DIR/stderr")"
	STATUS=$?
	ERR="$(cat "$DIR/stderr")"
}

# table — writes the five-field table into the current case's tree. The
# subject line is one row; tabs matter, so it cannot be a heredoc with spaces.
table() { # subject must-name must-not-name files module
	mkdir -p "$DIR/root/scripts"
	printf '# planted by doc-facts.test.sh — same fields as the real table\n' \
		>"$DIR/root/scripts/doc-facts.txt"
	printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" \
		>>"$DIR/root/scripts/doc-facts.txt"
}

doc() { # path, then the text on stdin
	mkdir -p "$DIR/root/$(dirname "$1")"
	cat >"$DIR/root/$1"
}

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

check() { run bash "$ROOT_DIR/scripts/harness-check.sh" --root "$DIR/root" --verify-doc-facts; }

# ------------------------------------------- a planted wrong sentence fails ---
case_start "a doc that says jev runs on localhost is a FAIL with the line and the sentence"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'agent/AGENTS.md' 'jev-model.mjs'
doc agent/AGENTS.md <<'DOC'
# Global rules

- `jev` decides instead of guessing: it runs on `localhost:11434` with no API cost.
- TypeSafe is named elsewhere in this file, so the row is not missing its mention.
DOC
check
expect_fail_with 'FAIL doc-facts' 'agent/AGENTS.md:3' 'runs on `localhost:11434`'

case_start "the mirror case fails too: the local tool described as the remote one"
table 'local-run|local_llm' '11434|ollama|qwen3\.8:27b' 'typesafe' 'agent/AGENTS.md' 'local-model.mjs'
doc agent/AGENTS.md <<'DOC'
- `local_llm` runs on the local `qwen3.8:27b` (no API cost).
- `local_llm` asks TypeSafe over HTTPS, and every call is billed.
DOC
check
expect_fail_with 'FAIL doc-facts' 'agent/AGENTS.md:2' 'sits with'

# ------------------------------- the same words in a different clause are fine --
case_start "a true contrast in one sentence is not an accusation"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'agent/AGENTS.md' 'jev-model.mjs'
table 'local-run|local_llm' '11434|ollama|qwen3\.8:27b' 'typesafe' 'agent/AGENTS.md' 'local-model.mjs'
doc agent/AGENTS.md <<'DOC'
- `jev` decides instead of guessing. TypeSafe's Jev over HTTPS — a key, network, a cost per call — not local.
- `local_llm` runs on the local `qwen3.8:27b` (no API cost).
- There is no local fallback: `local-run` stays on ollama `qwen3.8:27b`, and jev never moves to it.
DOC
check
expect_pass_with 'PASS doc-facts'

# ------------------------------------------------- a missing mention fails too --
case_start "a file that talks about jev and never names its transport fails"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'agent/AGENTS.md' 'jev-model.mjs'
doc agent/AGENTS.md <<'DOC'
- `jev` decides instead of guessing, and it answers in about 200 ms.
DOC
check
expect_fail_with 'FAIL doc-facts' "never names 'typesafe'"

# ------------------------- radar blip 92 style: naming ollama is allowed here ---
case_start "a doc that only talks about the local model is left alone"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'docs/radar-conformance.md' 'jev-model.mjs'
doc docs/radar-conformance.md <<'DOC'
| 92. FreeToken | n/a | — | An inference engine for MoE models larger than consumer GPU memory; the local model is `qwen3.8:27b` served by Ollama on the host, which fits. |
DOC
check
expect_pass_with 'nothing was compared'

# --------------------------------------- a transport that moves in code fails ---
case_start "a module whose endpoint is no longer the table's transport fails"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'agent/AGENTS.md' 'jev-model.mjs'
doc agent/AGENTS.md <<'DOC'
- `jev` decides instead of guessing: TypeSafe's Jev over HTTPS, a key and a cost per call.
DOC
mkdir -p "$DIR/root/bin"
printf 'export const ENDPOINT = "http://localhost:11434/api/chat";\n' >"$DIR/root/bin/jev-model.mjs"
check
expect_fail_with 'FAIL doc-facts' 'bin/jev-model.mjs' 'the module disagrees'

case_start "a module that names both transports fails as a move, not a silence"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'agent/AGENTS.md' 'jev-model.mjs'
doc agent/AGENTS.md <<'DOC'
- `jev` decides instead of guessing: TypeSafe's Jev over HTTPS, a key and a cost per call.
DOC
mkdir -p "$DIR/root/bin"
printf '// fallback: http://localhost:11434/api/chat\nexport const ENDPOINT = "https://api.typesafe.ai/v1/systemone";\nexport const LEGACY = "http://localhost:11434/api/chat";\n' \
	>"$DIR/root/bin/jev-model.mjs"
check
expect_fail_with 'FAIL doc-facts' 'bin/jev-model.mjs' 'moved transport'

# ------------------------------------------------------- a stale table fails -----
case_start "a table row pointing at a file that is gone fails instead of passing"
table 'jev' 'typesafe' 'localhost|11434|ollama' 'agent/AGENTS.md' 'jev-model.mjs'
check
expect_fail_with 'FAIL doc-facts' 'agent/AGENTS.md' 'the table is stale'

# --------------------------- a pull request opened with a body the gate rejects --
# The playbook is the instruction a person and a boss agent follow before opening a
# PR by hand, and the gate red it produced (pr-tier on 5 branches, 2026-11-20) is
# the measure: a filled body has no `Mission:` or `Review tier:` line, so the
# command in the doc decides whether the gate can pass. planted, not real: the
# real tree is the last case.
case_start "a doc that opens a pull request with a filled body fails"
table 'gh pr create' '--body-file' '--fill' 'docs/agent-playbook.md' ''
doc docs/agent-playbook.md <<'DOC'
# Opening the pull request

The body is a file, so `--body-file` is what to pass.

```bash
git push -u origin fix/date-parser-tz
gh pr create --base trunk --fill
gh pr checks <n>
```
DOC
check
expect_fail_with 'FAIL doc-facts' 'docs/agent-playbook.md:' 'sits with'

case_start "the same doc passes once the body is a file the gate can read"
table 'gh pr create' '--body-file' '--fill' 'docs/agent-playbook.md' ''
doc docs/agent-playbook.md <<'DOC'
```bash
make pr-check BODY=/tmp/pr-body.md
gh pr create --base trunk --body-file /tmp/pr-body.md
```
DOC
check
expect_pass_with 'PASS doc-facts'

# --------------------------------------------------- the real tree stays green --
case_start "this checkout passes the check, so the table and the docs agree"
run bash "$ROOT_DIR/scripts/harness-check.sh" --root "$ROOT_DIR" --verify-doc-facts
expect_pass_with 'PASS doc-facts'

# ------------------------------------------------------------------- summary ---
printf '\n== doc-facts: %d case(s), %d ok, %d failed\n' "$CASE_N" "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
