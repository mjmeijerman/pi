---
name: Production change with a plan
description: State scope, rollback, and verification before touching prod
---

- Before the change: what changes, what does not, the source of truth, and how you verify it.
- Name the rollback or backup first, and test it when that is cheap.
- Roll out small, watch logs and metrics during the change, report deviations immediately.
- "Deployed" is not "verified": do not call it done before it is stable.
