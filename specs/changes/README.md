# specs/changes

A change is one file here, named after its branch: branch `feat/x` → `feat-x.md`.
It amends one area spec and says which on its `Area:` line — `Area: merge-guard` resolves to
`specs/areas/merge-guard.md`, and `scripts/harness-check.sh` fails a delta naming an area spec
that does not exist.
Merging folds the delta into that area spec and deletes the delta file; nothing here accumulates.
`scripts/harness-check.sh` says so in two rows: `spec-delta-area` for the link above, and
`spec-delta-folded` while a delta is still in trunk's tree after the change landed.

Template — five lines, then the delta:

```markdown
# feat/x — <what changes>

Area: merge-guard
Test change: <why the tests had to change, or delete this line>

<What the behaviour is now, what it becomes, and where the claim came from.>
```

## Folding, which is a person's job

`spec-delta-folded` FAILs when a delta in `specs/changes/` is also in trunk's tree: it reached
trunk, so it was merged, so the fold was due. The row names the delta and the area spec and stops
there, because appending English to English automatically is how one file ends up saying two
different things, and no check can tell which half is true. A tree with no trunk ref to compare
against (a tarball checkout) gets a WARN rather than a quiet PASS.

The fold is three steps, in one commit:

1. Paste the delta's body into `specs/areas/<area>.md` under the heading it belongs to, in the
   tense the rest of that file uses, carrying the line numbers it cites with it.
2. Delete what it replaces. Leave the area spec's `Owner:` and `Review:` lines alone; a stale
   `Review:` date is the ratchet that asks for the next audit, not something a delta fixes.
3. `git rm specs/changes/<branch>.md`, so the row goes quiet in the same commit that adds the text.
