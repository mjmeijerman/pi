# Harness evals (promptfoo)

Eleven fixed prompts that test whether the harness instructions **change behaviour**:
that a Radar blip number is cited, that a page-summarising chore goes to the local
model instead of a worker, that nothing is committed on trunk without an explicit yes,
that a PR body states its review tier, that a High-tier merge waits for a human, that a
Dutch request is answered in English, that a secret is refused, and that answers lead
with the action.

It does not test that the files exist — that is what `scripts/harness-check.sh` and the
extension tests already do.

## This is a monthly manual run, not PR CI

Run it when the monthly calendar entry fires, or after a real change to `AGENTS.md` or a
skill:

```bash
make evals
```

It is deliberately not wired into `.github/workflows/`:

- It grades a **model**, so it is slow (about two minutes) and its output is advisory.
  A red run means "read it", not "the build is broken".
- It needs ollama with `qwen3.8:27b` on the machine, which GitHub runners do not have.
- A prompt that fails on a Tuesday can pass on a Thursday without any file changing.
  Gating merges on that teaches you to ignore it.

## What runs

- `promptfooconfig.yaml` — provider, eleven cases, assertions.
- `prompts/harness.js` — builds each prompt from the real `agent/AGENTS.md` plus one
  skill file, read at eval time, so the suite tests what is on disk today.
- `asserts.js` — the deterministic assertions. They check behaviour, not wording:
  "cites a blip that exists in `docs/radar-blips.tsv`", not "cites blip 2".

Cost: zero. The provider is the local `qwen3.8:27b` with thinking disabled (the thinking
dump would otherwise land in the answer and break the "first line is the action" check).
To grade with the remote model the harness actually uses, edit the `providers:` line and
export that provider's API key.

promptfoo is not in `package.json`: `make evals` runs a pinned `npx promptfoo@0.125.1`,
so it never sits on the PR path or in the install.

## No model-graded assertions

One `llm-rubric` was tried on the Dutch case and removed. The local grader read an
opening clause — "Ik moet in het Engels antwoorden, dus:" — as a violation of "answer in
English" and flipped the case run to run. The deterministic function-word check agreed
with what the output actually was. Every assertion here is `contains`, `icontains`,
`regex`, `not-contains` or `javascript`; add a rubric only where nothing deterministic
can express the behaviour, and expect to argue with it.

## Current state of the harness (measured 2026-11-13)

10 of 11 pass. The failure is real: asked how to run the extension tests, the model opens
with "From the repo root:" and puts the command on line two. `AGENTS.md`'s ADHD rule says
the first line is the action. Fixing the instruction is a change to `AGENTS.md` (High
review tier), not a change to this eval.

## Adding a case

1. Append a test to `promptfooconfig.yaml` with `vars.request` (and `vars.skill` if a
   skill should be in context).
2. Add the assertion to `asserts.js` if it needs more than `contains`/`regex`.
3. Run `make evals` and read the failure before adjusting the assertion. An assertion
   that was bent to fit one output tests nothing.
