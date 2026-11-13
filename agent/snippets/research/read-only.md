---
name: Read-only investigation
description: Investigate without changing the system
---

- Investigate, do not repair: no restarts, no config edits, no writes outside the OS temp directory.
- Propose fixes and wait for approval before applying them.
- Say so before running a "read-only" command that can still mutate state, such as a migration, lock file, or cache purge.
