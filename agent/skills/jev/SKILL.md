---
name: jev
description: "Local decision model for harness questions that should not be guesses — how many workers a task needs, which sandbox mode to run a worker in, yes-no-unsure calls, and sandbox permission requests. Runs on the local qwen3.8:27b via ollama, with no API cost and no network. Use before spawning workers, before choosing a sandbox mode, when a sandboxed worker asks for a permission, and anytime the safe answer is not obvious."
---

# jev

A decision model wrapper around the local `qwen3.8:27b` served by ollama at `http://localhost:11434`. No API cost, no network beyond localhost. It answers one narrow question per call against a fixed policy and returns `yes`, `no`, or `unsure` — `unsure` means hand the question to the human instead of guessing. That is a good outcome, not a failure.

Binary: `jev` on PATH (`/home/mark/.local/bin/jev` → `/home/mark/pi-master/bin/jev` → `jev.mjs`).
Env overrides: `JEV_MODEL`, `JEV_ENDPOINT`, `JEV_TIMEOUT` (ms, default 180000).

## Subcommands

| Command | Question it answers | Output |
| --- | --- | --- |
| `jev ask "<question>"` | Should this go ahead? | `yes` / `no` / `unsure` |
| `jev permit "<request>"` | Allow this sandbox permission request? | `yes` (allow) / `no` (refuse) / `unsure` (ask the human) |
| `jev mode "<worker task>"` | Which sandbox mode should this worker run in? | `bare` / `sandboxed` / `no-net` |
| `jev count "<task>"` | How many parallel workers does this need? | `1`–`4` |
| `jev route "<task>"` | Local or remote at all? | `local` (exit 0) / `remote` (exit 1) |
| `jev thinking "<task>"` | How much thinking effort does this worker need? | `low` / `medium` / `high` |

`--json` prints `{"decision":…,"reason":…}` (or `{"mode":…}` / `{"count":…}` / `{"route":…}` / `{"thinking":…}`) with `confidence` instead of a single line. Without it you get one line: `jev: <answer> — <reason>`.

## Exit codes

- `0` yes, or a valid mode/count/thinking answer (`route`: 0 local)
- `1` no (`route`: 1 remote)
- `3` unsure, or the model is unreachable — ask the user
- `2` usage error (missing subcommand or question text)

`mode`, `count` and `thinking` exit `3` with a null answer when the model's confidence is below 0.5.

## When to use it

- **How many workers** a task needs, before fanning out. Never more than 4; past 4 the human cannot review the output.
- **Which mode** a worker gets, before spawning it.
- **How much thinking** a worker needs, before spawning it. Jev answers an abstract effort, never a pi level name, because it cannot know which levels the model supports: the caller maps `low`/`medium`/`high` onto the levels that model actually has (`bin/delegate` reads `thinkingLevelMap` from the pi model catalogue and picks the nearest supported level, ties to the lower one).
- **Yes-no-unsure** questions where guessing would be a policy violation or a costly mistake.
- **Sandbox permission requests** from a running worker: pipe the request through `permit` instead of deciding yourself.

## Mode rules

- A worker that needs a model cannot run `no-net`. No network means no model. `no-net` is only for executing untrusted repository scripts.
- `sandboxed` is the default: read-only analysis, small edits, tests in a normal repository.
- `bare` only when the work needs host access the sandbox refuses — Herdr control sockets, a GUI, docker, the ssh agent, or paths the sandbox does not mount.
- At most 4 parallel workers. Answer 4 and say why when a task looks bigger.

## Examples

Let it fill in the worker count, then spawn:

```
jev count "audit three unrelated repos for leaked secrets" --json
→ {"count":3,"reason":"three independent repos, no shared state","confidence":0.9}
```

Check a mode before delegating:

```
jev mode "read src/, run the test suite, report failures"
→ jev: sandboxed — read-only analysis and tests need no host access
```

Pick the thinking effort before spawning — mechanical work gets low, hard work gets high:

```
jev thinking "rename the get_user helper in three files"
→ jev: low — mechanical rename, no design decisions

jev thinking "work out why the queue drops messages under load"
→ jev: high — hard debugging across components
```

A thin task text is not a middle-of-the-road guess:

```
jev thinking "fix it"
→ jev: unsure how much thinking this needs — ask the user
```

A sandboxed run fails because the path is invisible — the sandbox does not mount it, so the right answer is bare, not a code change:

```
jev mode "inspect herdr panes over the control socket"
→ jev: bare — Herdr sockets are host access the sandbox refuses

jev permit "read /home/mark/pi-master/specs"
→ jev: yes — read-only access to a path the sandbox did not mount
```
