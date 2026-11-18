# specs/changes

A change is one file here, named after its branch: branch `feat/x` → `feat-x.md`.
It amends one area spec and says which on its `Area:` line — `Area: merge-guard` resolves to
`specs/areas/merge-guard.md`, and `scripts/harness-check.sh` fails a delta naming an area spec
that does not exist.
Merging folds the delta into that area spec and deletes the delta file; nothing here accumulates.

Template — five lines, then the delta:

```markdown
# feat/x — <what changes>

Area: merge-guard
Test change: <why the tests had to change, or delete this line>

<What the behaviour is now, what it becomes, and where the claim came from.>
```
