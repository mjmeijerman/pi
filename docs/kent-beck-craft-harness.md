# Kent Beck — "Software Engineering in the Age of AI" (Prodacity 2026, Rise8)

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-02-13 — quarterly, alongside the Radar audit (`docs/radar-conformance.md` §6).

Action points for this harness. Source: talk transcript, fetched 2026-11-13 with yt-dlp
(`F8fBgDCf2Y4`, 51:52, 6365 words). Plan: implement tomorrow.

## The one-line thesis

A genie produces **plausible**, not **working**. Value = features it has now **plus** futures
(options to change). Agent speed burns futures faster than it adds features, so the harness
must force a **wipe of the knife between cuts**: verify, consolidate, then continue.

## The five claims worth coding against

1. "The genie is better at coding than humans" is balderdash. Cheap C-compiler stories fall apart
   on Hello World. Output volume is not correctness.
2. Effort → output → outcome → **mission**. LOC, PR count, token spend are effort and are
   *definitionally* not mission metrics. Early metrics invite Goodhart: measures don't just stop
   measuring, they deform the system.
3. Spec-driven → one-shot → waterfall. Royce himself drew the feedback arrow. One-shot is fine for
   a small app, never for something with users, data migrations and continuity.
4. The genie subverts tests: returns constants, deletes assertions, "works, boss". Trust must be
   rebuilt with **examples + automated tests + foolproofed design**, not with bigger specs.
5. Between features there is a moment. Feature work burns futures; that moment is the only place to
   buy them back. Fully agentic ("dark factory") always derails — spectacularly, which is why it
   fools people.

## Action points, ranked

Each: what the talk says → what changes here → where → how we know it worked.

### 1. No "done" without executed evidence (highest value, ~2h)

Plausible ≠ working. A report claiming success is worthless; a report with a command and its
output is proof.

- Report template gets a mandatory `## Evidence` block: the exact command + the last 20 lines.
- `delegate close` refuses a report with no Evidence block or with `<fill in>` left in it.
- Spec template forbids "should work", "looks correct", "tests pass" without output.

**Where:** `bin/delegate` (spec/report templates + `cmd_close` guard), `reports/*.md`.
**Measured:** share of merged PRs whose report has real output (target 100%); count of claims
reverted within a week (target: trends to 0).

### 2. A mandatory wipe step between features (~3h)

The Casals rest between the notes. After a worker reports a feature, the boss does not
immediately spawn the next one — it spends one bounded pass buying futures back.

- New `delegate wipe <slug>`: prints a 5-line consolidation checklist (deleted code? duplicated?
  could a new feature land here in 30 min? what did we learn? what would we re-implement?).
- `AGENTS.md` job list gains that step between "read report" and "close"/"spawn next".
- Skipping it is allowed, but must be recorded in `state/decisions.jsonl` with a reason.

**Where:** `bin/delegate`, `AGENTS.md`.
**Measured:** after each feature, time to land a follow-up feature in the same area. If it grows
run over run, futures are being burned.

### 3. Tests the genie cannot subvert (~4h, the expensive one)

- Mutation testing on changed lines only (`make mutate` already exists) — a worker's PR is not
  green until the changed lines' mutants are killed.
- A worker may not edit a test that its own change breaks; only the spec may authorise that.
- Optional second-opinion worker: writes acceptance tests from the spec text only, never sees the
  implementation.

**Where:** `Makefile` (`mutate`), `.github/`, `git-hooks/`, spec template.
**Measured:** mutant kill score on changed lines; incidents of "returned a constant" / deleted
assertion (target 0, counted in `retro/`).

### 4. Cap work in flight; review is the bottleneck (~1h)

The genie produces feedback faster than we can gather it. Throughput is limited by review, not by
generation.

- Hard cap: 1 PR in review per human at a time, `jev count` workers (already ≤4), no second spawn
  on the same area while a report is unread.
- Boss relays at most 5 items per turn (already the ADHD cap — now make it a delegation rule too).

**Where:** `AGENTS.md`, `git-hooks/merge-guard`.
**Measured:** review latency (open → first human comment) and the age of the oldest open PR
(target < 2 days).

### 5. Specs are starting points, not contracts (~2h)

One-shot is waterfall with extra steps, and it dies on continuity and data migration.

- Spec template header: `Iteration: expected >=2 cycles. You may throw this away.`
- Report must state what the worker would do differently next time, not just what it did.
- No "write a bigger spec until the software is correct" escape hatch; if the spec is ambiguous,
  the worker raises `DECISION NEEDED` early instead of guessing.

**Where:** `bin/delegate` templates.
**Measured:** share of specs that ran >=2 cycles; rework caused by misunderstood spec (should drop).

### 6. Make throwing away normal and credited (~1h)

Ward turned off the computer; the next morning the afternoon's work came back in 15 clear minutes.
With a genie, re-implementation is cheap — so make it a first-class, praised outcome.

- Report section `## Thrown away`: what was deleted or rewritten on purpose, and why.
- `retro` counts it as a win, not a loss.

**Where:** report template, `bin/delegate stats`, `retro/`.
**Measured:** rewrite events per feature (up is healthy), and net LOC after a wipe (down is fine).

### 7. Report the mission, never the output (~1h)

- Every spec starts with one line: **who is better off, and how we'd see it**. Repeated verbatim in
  the PR body and in the relay to the user.
- Ban from reports and relays: LOC, token counts, "N agents", file counts as progress signals.
- `delegate stats` may show them as *cost*, never as *progress*.

**Where:** spec template, PR body rules, `bin/delegate stats`.
**Measured:** share of open PRs with a mission line and a stated way to observe it (target 100%).

### 8. Trust is adversarial by default (~1h, mostly template text)

If a genie wrote it, assume it is plausible until proven otherwise.

- Worker spec opening: "You are the genie. Your work is plausible by default. Prove it runs."
- Boss relay never repeats a worker's success claim without its evidence line.

**Where:** `bin/delegate` spec template, `AGENTS.md` relay rules.
**Measured:** the same as #1 — this is the framing that makes #1 stick.

### 9. Keep readability, drop polish-as-obligation (~30m)

Craft's leverage moved, it didn't vanish: naming, decomposition and whitespace now pay off over
years rather than in the moment. An unreadable system is worse than a readable one — but polish
that delays feedback is not craft, it is hiding.

- Review checklist: can a human answer "what does this do" in 5 minutes? That is a merge gate.
- Indentation/style bikeshedding is not a gate; formatters own it.

**Where:** PR review template, `.github/`.
**Measured:** sampled reviewer time-to-understand; formatting comments in review (target 0).

### 10. No dark factory, ever (~0h — already a rule, now named)

Every worker's output ends at a human decision or a human merge. That is the existing PR rule; this
talk is the argument for keeping it when it feels slow.

**Measured:** PRs merged with no human read (target 0, red flag if nonzero).

## Tomorrow, in order

1. Edit the spec + report templates in `bin/delegate`: mission line, Evidence block, Thrown away
   section, iteration header. (~1h)
2. Add the `cmd_close` guard that rejects a report without evidence. (~30m)
3. Add `delegate wipe <slug>` and put it in the `AGENTS.md` job list. (~1h)
4. Turn on mutation testing for changed lines in `make verify`. (~2h, may slip to the next day)
5. Open one PR per change, review tier in the body. Low for templates, medium for the guard.

## Deliberately not doing

- A bigger spec gate (that is waterfall with a genie).
- Formal-method specs: still one-shot, and the spec→implementation gap stays unbridged. Use
  examples + tests + foolproofing instead.
- Effort dashboards: Goodhart bait.

## Quotes worth keeping

- "It's C compiler-ish, but it doesn't actually compile C programs that then run."
- "You can't wipe the knife while you're cutting."
- "I rest between the notes." (Casals — Beck admits the story is made up; it's still the point)
- "This is a learning process that throws off software as a side effect."
- "The definition of productivity is the ratio of output to input — and mission is neither."
