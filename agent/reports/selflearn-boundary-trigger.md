# self-learn: learner trigger for boundary-committed compactions

**Mission**: the person running pi with the observational-memory extension gets a harness that
still learns from the sessions that actually compact. Visible as: after an om compaction in a
session with two or more identical tool failures, `~/.pi/agent/proposals/runs.jsonl` gains a
`"kind":"spawned"` line — a file that does not exist today for the om path.

## What now works

- A compaction pi commits at a turn boundary (om's path, no `session_compact` event) starts the
  same gated learner. Detected on `turn_start` and `before_agent_start` by a new
  `compaction` entry id on `ctx.sessionManager.getBranch()`.
- One entry, one learner: ids are recorded by the boundary scan and by the `session_compact`
  handler, and baselined on `session_start` so a resumed session's history is not "new".
- The gate is untouched (repeated failure signature or `/suggest` note, max 2 per session,
  10 min gap), so most compactions still do nothing.
- Detection is wrapped in try/catch on both sides and never throws into the host session.

Verify with: `cd agent && npm test` — 505 tests, 0 failures, including two new wiring tests.

## Changed

- Branch `fix/selflearn-boundary-trigger`, commit `a52d8a8328f61627f744779810af58172cea2d44`
  (worktree: `/home/mark/selflearn-boundary-trigger-worktree`).
- `agent/extensions/self-learn.ts`: `compactionEntryIds()`, per-session seen-id set with
  session-start baseline, `turn_start` + `before_agent_start` handler, `session_compact`
  marks ids seen in a `finally`.
- `agent/extensions/__tests__/self-learn.test.ts`: two wiring tests (boundary-only compaction
  fires the gate once and a repeat for the same id does not; a pi-native compaction is not
  counted twice). The shared `setup()` now counts gate evaluations via `countNotes`.
- Not pushed, no PR. The boss publishes it. **Review tier: high** (touches
  `agent/extensions/`), so it needs a line-by-line read before merge.

## Open

`## Open` — not tested against a live om compaction in a real pi session: the om checkout was
off-limits and the trigger is simulated with a fake `sessionManager.getBranch()`. The risk is
event ordering in the real runtime (if pi emits `turn_start` before `appendCompaction` the
detection lands one turn later, which still fires).

One next action: publish the branch as a PR
(`git -C /home/mark/selflearn-boundary-trigger-worktree push -u origin fix/selflearn-boundary-trigger`)
with the high-tier note in the body.

## Evidence

```sh
$ cd /home/mark/selflearn-boundary-trigger-worktree/agent && npm test 2>&1 | tail -20
    ok 2 - pi-tui width helpers come from the real package
      ---
      duration_ms: 0.02625
      type: 'test'
      ...
    1..2
ok 81 - stub fidelity
  ---
  duration_ms: 0.09959
  type: 'suite'
  ...
1..81
# tests 505
# suites 59
# pass 505
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms: 780.627182
```

## Thrown away

First version of the boundary test advanced the shared fake clock by 30 minutes per signal to
defeat the ten-minute gap. That wrote future-dated `runs.jsonl` entries into the shared scratch
directory and broke two later tests. Rewrote it to count `learn()` evaluations instead, so the
dedupe is proven without touching the clock. Also dropped an unused `scanBoundary` test seam.

## What I would do differently next time

Run the whole suite after the first draft of a test, not just the one file — the shared
`runs.jsonl` debounce means a test can break its neighbours across the file boundary.
