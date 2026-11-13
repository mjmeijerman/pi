# Global rules

- Always respond in English, regardless of the language the user writes in.
- Use codemode whenever a response would need 2 or more tool calls. Batch them in one `codemode` script (`tools.read`, `tools.bash`, `Promise.allSettled` for independent calls) instead of emitting separate calls. Single tool calls go direct.
- ADHD output mode is always on (`~/.pi/agent/i-have-adhd.json` → `alwaysOn`). Its rules apply to every outward-facing artifact, not just chat: commit messages, PR bodies, review comments, issue text, any file written for humans. Only the user turns it off, with "stop adhd mode" or `/i-have-adhd off`.

## Sandbox

- `pi` runs sandboxed by default (`install.sh` wraps it); `PI_BARE=1 pi` bypasses, `pisandbox --no-net -- pi` adds network isolation for unfamiliar repos (blip 1).

## Landing changes

- Never merge, push to trunk, or commit while on trunk without the user's explicit permission in this session. Ask, wait for a yes, then `/mergeguard allow` and run that one command. `merge-guard` blocks `gh pr merge`, the merge API, trunk pushes, and trunk commits; green CI is not permission.
- State the review tier in the PR body before you open it, and refuse to merge at high (blips 17, 42). High: `agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`, `sandbox/`, anything touching auth, secrets, money or data deletion → user reads it line by line, never auto-merged. Medium: application code, tests, migrations → diff read, tests green. Low: docs, comments, formatting, patch bumps → CI green, skim.
- Vague request, more than one file, or a design choice → `/grill` first; no code before the answers (blip 13).

## Harness sources

- Harness changes follow the Thoughtworks Radar (https://www.thoughtworks.com/radar), Volume 35. Cite the blip number, prefer the Adopt ring, name the problem it fixes and how it is measured.

## Local model

- `local_llm` runs summarize/classify/extract/tidy/translate on the local `qwen3.8:27b` (no API cost). Use it for text chores; `/local` checks the endpoint.

## Harness feedback

- When the harness itself gets in the way, run `/suggest <what went wrong>`. `/retro` aggregates the log into `~/.pi/agent/retro/`.

## Herdr

- Spawn delegated agents with `~/.pi/scripts/agent-pane.sh spawn <slug> <spec.md>`: creates a real herdr pane running interactive pi and sends the spec path. Never `hc run --bg` — a terminal without a pane cannot be tiled.
- Close with `agent-pane.sh close <slug>`; `agent-pane.sh list` shows panes.
- `herdr-app shot /tmp/x.png` captures the window; use it to check layout instead of guessing.

## Machine / screens

- X11, DISPLAY `:1`, root window 9840x3840 (multi-monitor, scaled). Never grab the whole root.
- Shotcut sits on the right-hand screen. Never hardcode coordinates: run `xwininfo -root -tree` and pick the largest window whose title contains `Shotcut`.
- Screenshot helper: `/home/mark/agent-office/mjmeijerman/bakmark/scripts/shotcut-window.py [out.png] [width]`.
