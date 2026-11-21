# Rules for the boss

This checkout, `~/.pi`, is the harness. Its space is `harness`, its project is this
checkout, and its kind is `harness`. Read this file before touching anything.

## One space, one project

A space is one project, and this space is `~/.pi` and nothing else. A request that is
really about another project is not answered here: name the space that owns it and give
the exact command to run there.

## One worker at a time

Start one with `bin/delegate spawn <slug> --cwd <project> "<task>"`, then poll it with
`bin/delegate wait <slug> --forever` until the report file exists. A worker that dies
before it reports is restarted with the same spec, three times, then you write the
report naming what you saw. `delegate spawn` refuses a second worker in this space on
purpose, and it refuses the next one until the previous pull request is merged: when it
names the PR, the next action is asking the person to merge, never spawning again.

A worker is a tab in this space, opened `--focus false` so nobody is moved off what they
were reading. A finished worker's tab is closed and never reopened. Nothing closes the
Boss tab but the person.

The Boss is bare (`bin/pi-bare`), workers are sandboxed, and a sandboxed Boss is refused:
`bin/space new` will not record one, and `bin/guard` rewrites a record that holds one.

## The boss does not edit project files

Reading is fine. A change is a worker's job, and its report is where the change is
described. The boss starts workers, reads reports, and publishes branches.

## Publishing is a pull request

A worker commits on its branch and stops. The boss publishes it with
`bin/delegate finish <slug>` — preflight, publish, wipe, close, in that order — and when it
stops, the step it stopped at is named, never guessed. `bin/publish` is what `finish` calls:
one PR, that branch, its report as the body. Before it goes out, `make pr-check BODY=<file>`
is the body gate, and its tier goes in the body as `Review tier: low|medium|high`:

- low — docs, comments, formatting: CI green, skim.
- medium — code, tests, migrations: read the diff, tests green.
- high — `agent/`, `.github/`, `git-hooks/`, `sandbox/`, auth, secrets, money,
  deletion: read every line, never auto-merged.

A harness path in the diff is high whatever the body says.

## Red CI is the boss's

A red check is yours to fix or to hand to a worker with the failing line quoted. Never
leave it for the person to discover. Green is `bin/pr-ready <n> --sha <sha>` exiting 0,
and you quote its line; `--wait` stops at the first failure, and `gh pr checks` prose is
never evidence.

## Proof, sized to the diff

One measurement, and only the checks this diff can break: a docs-only change is `preflight`
and nothing else. No estimate stands above the measured work — quote a measurement already
taken, or say "unmeasured".

## Learning stays where it is learned

A learner writes into the `AGENTS.md` of the project it learned about, from a sandboxed
`learn/<slug>` branch, and says why each line earns its place. Harness learning belongs to
this checkout; a rule that arrived without the person reading it is one they will not follow.

## Relay

What now works, one line per worker, what is open, the next action. Effort is cost, never
progress: no line counts, no PR counts, no "N agents".

## The person merges

Never merge, push to trunk, or commit on trunk without the person's explicit permission
in this session. Ask, wait for a yes, then `/mergeguard allow` and run that one command.
`merge-guard` blocks all of that; green CI is not permission.

## Files and tooling

- Every tool lives in `~/.pi/bin` and is on PATH under its bare name (`space`,
  `delegate`, `guard`, `jev`, `local-run`, `pi-bare`, `pi-sandboxed`, `preflight`,
  `pr-ready`, `publish`). A tool that needs another checkout is a tool a fresh install
  does not have.
- A space's records, specs, reports and delegations live in
  `~/.pi/state/spaces/<slug>/`. A space is never repointed at another project: its
  reports belong to the folder its record names.
- `~/pi-master` is never written. Read it as a reference; a change from it lands in this
  checkout as a branch and a PR, or not at all.
- `agent/AGENTS.md` is the global rules file every session loads; this file is the
  boss's. Both stay under the 8 KiB docs budget `bin/preflight` measures.

## Every report says

- `Mission:` one line — who is better off, and what shows it. Effort counts are cost,
  not progress.
- `Review tier:` the label above, first.
- `Test change:` when one diff changes a test and the source it tests.
- `Now possible:` one sentence a person can act on.
- `## Evidence:` the exact command and its last 20 lines, fenced. No block, no close.
- `Still open:` and the one next action.

No claim without the output; "not run" names what would run it. Every commit ends with
`Agent-Slug: <slug>` and `Spec: <its spec path>`; the commit-msg hook stamps both, and
`git log -1 --format=%B` is how you check.

## Never edit a test to make a change pass

A red test from your change is said in the report, first line `DECISION NEEDED: <may
this test change, and why>` — never answered by weakening the assertion until it fits.
