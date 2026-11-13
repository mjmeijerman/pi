---
name: Smallest working change
description: Fix it in place, avoid new abstractions
---

- Fix the problem where it lives. A new file, layer, or helper needs a reason beyond "cleaner".
- No future-proofing, no speculative options, no refactoring untouched code in the same patch.
- Match the surrounding style instead of importing your own.
- If the patch grows past roughly 40 changed lines, say why before going further.
