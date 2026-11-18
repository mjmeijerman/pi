---
name: jev
description: "Decision model for harness questions that should not be guesses — how many workers a task needs, which sandbox mode to run a worker in, yes-no-unsure calls, and sandbox permission requests. TypeSafe's Jev over HTTPS: needs TYPESAFE_API_KEY and network, costs money per call, answers in about 200 ms. Use before spawning workers, before choosing a sandbox mode, when a sandboxed worker asks for a permission, and anytime the safe answer is not obvious."
---

# jev

A wrapper around TypeSafe's Jev decision model at `https://api.typesafe.ai/v1/systemone`. It answers one narrow typed question per call with a probability for every option, and returns `yes`, `no` or `unsure` — `unsure` means hand the question to the human instead of guessing. That is a good outcome, not a failure.

It is remote: it needs a key and network, and it costs money — $0.042 per MTok of input, output free. Measured on this machine: 193–268 ms per `plan`, against 3–8 s for the chat model it replaced. There is no local fallback: `local-run` and the `local_llm` tool stay on ollama `qwen3.8:27b`, no network, no cost, and jev never moves to them.

Binary: `jev` on PATH (`~/.local/bin/jev` → `~/big-boss-pi/bin/jev` → `jev.mjs`).
Key: `TYPESAFE_API_KEY`, else the `TYPESAFE_API_KEY=` line of `JEV_KEY_FILE` (default `~/.pi/agent/env.secret`, mode 600). Never printed, never logged.
Env overrides: `JEV_MODEL` (default `jev-latest`, currently `jev-1.14.0`), `JEV_ENDPOINT`, `JEV_TIMEOUT` (ms, default 20000), `JEV_MIN_CONFIDENCE` (default 0.5).

## Subcommands

| Command | Question it answers | Output |
| --- | --- | --- |
| `jev ask "<question>"` | Should this go ahead? | `yes` / `no` / `unsure` |
| `jev permit "<request>"` | Allow this sandbox permission request? | `yes` (allow) / `no` (refuse) / `unsure` (ask the human) |
| `jev mode "<worker task>"` | Which sandbox mode should this worker run in? | `bare` / `sandboxed` / `no-net` |
| `jev count "<task>"` | How many parallel workers does this need? | `1`–`4` |
| `jev route "<task>"` | Local or remote at all? | `local` (exit 0) / `remote` (exit 1) |
| `jev thinking "<task>"` | How much thinking effort does this worker need? | `low` / `medium` / `high` |
| `jev plan "<task>"` | count, mode, route and thinking for one spawn | all four on one line, one request |

`--json` prints `{"decision":…,"reason":…,"confidence":…}` (or `{"mode":…}` / `{"count":…}` / `{"route":…}` / `{"thinking":…}`); `plan` prints `{"count":…,"mode":…,"route":…,"thinking":…,"defaults":[…],"answered":{…},"reason":…,"confidence":…}`. Without it you get one line: `jev: <answer>` (plan: `jev: count=1 mode=sandboxed route=remote thinking=low`).

## Exit codes

- `0` yes, or a valid mode/count/thinking answer (`route`: 0 local; `plan`: a plan, possibly with defaults)
- `1` no (`route`: 1 remote)
- `3` unsure, no key, or the model is unreachable — ask the user
- `2` usage error (missing subcommand or question text)

`ask`, `permit`, `mode`, `count`, `route` and `thinking` exit `3` with a null answer when the probability of the chosen option is below `JEV_MIN_CONFIDENCE`. `permit` exits `3` on `ask` too.

## Confidence

- Choice questions (`mode`, `count`, `route`, `thinking`, `permit`): the threshold applies to the chosen option's own probability — the chance that this option is the right one.
- `ask` is a Noul, so the threshold applies to `|2p-1|`: how far the answer is from a coin flip.
- `plan` asks four Choice questions in one request. A field below the threshold takes the conservative default — count 1, mode `sandboxed`, route `remote`, thinking `medium` — one stderr line names the field and its probability, `"defaults"` lists it, and the call still exits 0. A weak count costs one worker, not the spawn. An option jev did not offer is a broken answer, not a weak one: exit 3, the field named (Radar Vol. 35, blip 62).

## When to use it

- **How many workers** a task needs, before fanning out. Never more than 4; past 4 the human cannot review the output.
- **Which mode** a worker gets, before spawning it.
- **How much thinking** a worker needs, before spawning it. Jev answers an abstract effort, never a pi level name, because it cannot know which levels the model supports: the caller maps `low`/`medium`/`high` onto the levels that model actually has (`bin/delegate` reads `thinkingLevelMap` from the pi model catalogue and picks the nearest supported level, ties to the lower one).
- **Yes-no-unsure** questions where guessing would be a policy violation or a costly mistake.
- **Sandbox permission requests** from a running worker: pipe the request through `permit` instead of deciding yourself.
- **A whole spawn**: `jev plan` is one request, not four.

## Mode rules

- A worker that needs a model cannot run `no-net`. No network means no model. `no-net` is only for executing untrusted repository scripts.
- `sandboxed` is the default: read-only analysis, small edits, tests in a normal repository.
- `bare` only when the work needs host access the sandbox refuses — Herdr control sockets, a GUI, docker, the ssh agent, or paths the sandbox does not mount.
- At most 4 parallel workers. Answer 4 and say why when a task looks bigger.

## Examples

Let it fill in the worker count, then spawn:

```
jev count "audit three unrelated repos for leaked secrets" --json
→ {"count":3,"reason":"count 0.98","confidence":0.98}
```

Check a mode before delegating:

```
jev mode "read src/, run the test suite, report failures"
→ jev: sandboxed
```

Pick the thinking effort before spawning — mechanical work gets low, hard work gets high:

```
jev thinking "rename the get_user helper in three files"
→ jev: low

jev thinking "work out why the queue drops messages under load"
→ jev: high
```

A thin task text is not a middle-of-the-road guess:

```
jev thinking "fix it"
→ jev: unsure how much thinking this needs — ask the user
```

One call for the whole spawn. When a field is weak, its default is used and stderr names it as `jev: defaulted <field> <probability> (below <threshold>) — using …` instead of stopping the spawn:

```
jev plan "summarise this log entry"
→ jev: count=1 mode=sandboxed route=local thinking=medium
```

A sandboxed run fails because the path is invisible — the sandbox does not mount it, so the right answer is bare, not a code change:

```
jev mode "inspect herdr panes over the control socket"
→ jev: bare

jev permit "read /home/mark/big-boss-pi/specs"
→ jev: yes
```

No key, no network, or HTTP 401 is exit `3` with one line naming the endpoint or the key file — never the key. Ask the user; do not fall back to guessing or to a local model.
