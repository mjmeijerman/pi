# pr-gates

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or whenever `scripts/pr-gate.sh` or `.github/workflows/pr-tier.yml` changes.

**What this file is.** The gates a pull-request body has to pass today, mined from
`scripts/pr-gate.sh` and `.github/workflows/pr-tier.yml` at trunk `4e40c9a`. A gate change is a
delta in `specs/changes/`, not an edit to the rule below.

## One implementation, two callers

`scripts/pr-gate.sh` is the only place the body rules are written. CI runs it from
`.github/workflows/pr-tier.yml` (`pr-tier.yml:29`, `:80-82`), and `make pr-check BODY=<file>` runs
the same file locally (Makefile, target `pr-check`), so a local green and a CI green cannot
disagree. Before that split each rule lived in the workflow only, so the first news of a bad body
was a red check minutes after the push (`pr-gate.sh:9-13`).

Usage (`pr-gate.sh:11-33`): `--body FILE` with the changed paths derived from the merge base of
`origin/trunk` and `HEAD`; `--base REV --head REV`; `--branch REV [--base REV]`; `--paths FILE`;
`--gate mission|tier|test-change` for one gate, the way each CI job runs it.

Exit codes (`:46-50`): `0` every gate that ran passed; `1` a gate failed or was handed no
file list it needs; `2` bad usage, unreadable input, a diff that cannot be resolved, or an empty
diff.

## The gates

**mission** (`:280-345`). A literal `Mission:` line, at least 20 characters after the prefix,
with emphasis stripped (`:277-279`). A `## Mission` heading cannot match, because the prefix
requires `mission:` at the start of a line. Missing, the template placeholder, or too short is
red. The reason text says why: effort is not mission (blip 41).

**tier** (`:352-405`). A `Review tier: High|Medium|Low` line in the body. Independently of what
the body claims, the tier must be **High** when any changed path starts with `agent/extensions/`,
`git-hooks/`, `sandbox/`, `.github/`, or is exactly `agent/AGENTS.md` (`:382-390`, `:397-400`).
That path mapping exists here and nowhere else, because a second copy is how the two answers
drift apart.

**test change** (`:410-470`). A diff that changes a test file *and* a source file needs a
`Test change: <reason>` line. Recognised test suffixes: `.test.ts`, `.test.tsx`, `.test.js`,
`.test.mjs`, `.test.cjs`, `.test.py`, `.test.sh`; the whole-match glob keeps `contest.sh` as
source (`:428-436`). Test-only, source-only, and no-tests-at-all diffs ask for nothing. The label
must start a line, and the template placeholder is refused rather than counted as a reason
(`:465`).

## An empty diff is never green

A gate that needs the changed files and did not get them is red (`require_diff`, `:258-273`), and
a diff that resolves to zero changed files is `unverifiable: no changed files between BASE and
HEAD`, exit 2, naming `git diff --name-only origin/trunk...<branch>` and
`make pr-check BRANCH=...` (`:38-42`). That case is not hypothetical: a checkout sitting on trunk
diffed trunk against trunk, the rules saw nothing, `make pr-check` printed green, and CI went red
on the real branch (PR 88, fixed in `edd52a5`).

## Gaps, and what was not established

- `.github/workflows/pr-tier.yml` was read for which commit it runs the gate from; the rest of
  its job matrix (permissions, triggers, concurrency) was not audited for this spec.
- Whether the tier gate's High-path list matches the High tier `agent/AGENTS.md` describes: all
  five prefixes match (`agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`,
  `sandbox/`), while the categories AGENTS.md also calls High — auth, secrets, money, deletion —
  are not path-checked by any gate here.
