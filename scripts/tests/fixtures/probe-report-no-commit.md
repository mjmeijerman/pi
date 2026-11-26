# sweep-probe

Mission: a spawned sandboxed worker runs end to end on the current trunk (`db6dece`) and can report back, which is the live half of #265/#266 measured by this report existing.

Review tier: High — probe only, no diff; tier recorded because the spec says so.

Test change: none — no test touched, no source touched.

Radar: not applicable — no code diff; nothing in `bin/`, `scripts/`, `agent/extensions/`, `git-hooks/`, `sandbox/` or `.github/` changed.

Now possible: a person can spawn a sandboxed worker, get "probe ok" back from it, and see its report file written — proving spawn → run → report without a commit.

What now works: `cd /home/mark/.pi && echo "probe ok" && git rev-parse --short HEAD` runs inside the sandbox (`pi-sandbox`) on trunk `db6dece`.

What changed: nothing. No commit, no branch, no worktree. Only this report file.

Previous decision in this area: `/home/mark/.pi/state/spaces/harness/specs/archive/close-nothing.spawn.md` — the last spec about spawning/closing a worker without leaving work behind. Not relevant beyond that: this probe leaves nothing to close.

## Evidence

Command: `cd /home/mark/.pi && echo "probe ok" && git rev-parse --short HEAD && hostname`

Output (last 20 lines):

```
probe ok
db6dece
pi-sandbox
```

## Thrown away

nothing — the task forbade commits and edits, and no worktree was cut because nothing was built.

## What I would do differently next time

Nothing to change; a probe that touches nothing is the shortest honest version. If it should also prove the commit path, say so in the spec and it will cut a worktree and commit a no-op.
