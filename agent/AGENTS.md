# Global rules

- Always respond in English, regardless of the language the user writes in.
- Use codemode when a response needs 2+ tool calls: one script (`tools.read`, `tools.bash`, `Promise.allSettled` for independent calls) beats separate calls. Single calls go direct.
- ADHD output mode is always on (`~/.pi/agent/i-have-adhd.json` → `alwaysOn`). Its rules apply to anything written for humans: commits, PR bodies, review comments, any file. Only the user turns it off: "stop adhd mode" or `/i-have-adhd off`.

## Sandbox

- `pi` runs sandboxed by default (`install.sh` wraps it); `pi-bare` quits it; `pisandbox --no-net` is for repo scripts, not agents — no net means no model (blip 1).

## Landing changes

- Never merge, push to trunk, or commit while on trunk without the user's explicit permission in this session. Ask, wait for a yes, then `/mergeguard allow` and run that one command. `merge-guard` blocks `gh pr merge`, the merge API, trunk pushes and commits; green CI is not permission.
- Body gates: run `make pr-check BODY=<file>` before the PR goes out — seconds, same `pr-tier` verdict. The tier goes in the PR body (blips 17, 42): High = `agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`, `sandbox/`, auth, secrets, money, deletion → read line by line, never auto-merged; Medium = application code, tests, migrations → diff read, tests green; Low = docs, comments, formatting → CI green, skim. A mission is a literal `Mission:` line (20+ chars), and a harness path in the diff is High whatever the body says.
- Vague request, more than one file, or a design choice → `/grill` first; no code before the answers (blip 13).

## Harness sources

- Harness changes follow the Thoughtworks Radar — thoughtworks.com/radar, Vol. 35. Cite the blip number, prefer the Adopt ring, name the problem it fixes and how it is measured.

## Models

- `local_llm` runs summarize/classify/extract/tidy/translate on the local `qwen3.8:27b` (no API cost). Use it for text chores; `/local` checks the endpoint.
- `jev` decides instead of guessing (0 yes, 1 no, 3 unsure). TypeSafe's Jev over HTTPS — a key, network, a cost per call — not local.

## Harness feedback

- When the harness itself gets in the way, run `/suggest <what went wrong>`. `/retro` aggregates the log into `~/.pi/agent/retro/`.

## Herdr

- Spawn delegated agents with `~/.pi/scripts/agent-pane.sh spawn <slug> <spec.md>`: a hidden `hc` worker — no pane, focus does not move.
- `show <slug>` borrows the pane you are in to watch it, `hide <slug>` puts it back, `close <slug>` ends it, `list` shows them.
- `herdr-app shot /tmp/x.png` captures the window; use it to check layout instead of guessing.

## Machine / screens

- X11, DISPLAY `:1`, root window 9840x3840 (multi-monitor, scaled). Never grab the whole root.
- Shotcut: right-hand screen. Never hardcode coordinates — run `xwininfo -root -tree`, pick the largest window whose title contains `Shotcut`.
- Screenshot helper: `~/projects/bakmark/scripts/shotcut-window.py [out.png] [width]`.
