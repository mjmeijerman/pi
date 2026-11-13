---
name: Review before you ship
description: Check behavior, edge cases, and preserved features
---

- Does it do what was asked, on the path the user actually takes?
- What changed for existing users, and was that intended?
- Edge cases: empty input, large input, and failure of each external call.
- Clean up: dead code, debug output, secrets, commented-out blocks.
- Verification proportional to risk; report what you ran and what you skipped.
