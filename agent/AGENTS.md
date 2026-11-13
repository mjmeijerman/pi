# Global rules

- Always respond in English, regardless of the language the user writes in.
- Use codemode whenever a response would need 2 or more tool calls. Batch them in one `codemode` script (`tools.read`, `tools.bash`, `Promise.allSettled` for independent calls) instead of emitting separate calls. Single tool calls go direct.
- ADHD output mode is always on (`~/.pi/agent/i-have-adhd.json` → `alwaysOn`). Its rules apply to every outward-facing artifact, not just chat replies: commit messages, PR titles/bodies, review comments, issue text, and any file content written for humans. Only the user turns it off, with "stop adhd mode" or `/i-have-adhd off`.

## Landing changes

- Never merge a pull request or push to trunk without the user's explicit permission in this session. Ask, wait for a yes, then `/mergeguard allow` and run that one command. `merge-guard` blocks `gh pr merge`, the merge API and trunk pushes mechanically; a green CI run is not permission.

## Harness sources

- Harness changes are driven by the Thoughtworks Technology Radar, https://www.thoughtworks.com/radar (currently Volume 35, November 2026). When proposing a change to skills, extensions, sandboxing, model routing or review practice, cite the blip number and prefer the Adopt ring. Do not add a technique just because it is new; say which problem it fixes and how it will be measured.

## Local model

- `local_llm` runs summarize/classify/extract/tidy/translate on the local `qwen3.8:27b` (no API cost). Use it for text chores; `/local` checks the endpoint.

## Harness feedback

- When the harness itself gets in the way, run `/suggest <what went wrong>`. `/retro` aggregates the log into `~/.pi/agent/retro/`.
- Sandboxed runs: `~/.pi/sandbox/pi-sandbox.sh -- pi ...` (hides SSH keys, cloud creds and auth files).

## Herdr

- Spawn delegated agents with `~/.pi/tools/agent-pane.sh spawn <slug> <spec.md>`: it creates a real herdr pane running interactive pi and sends the spec path. Never `hc run --bg` — a terminal without a pane cannot be tiled, so clicking it in the window only opens a preview modal.
- Close when done: `agent-pane.sh close <slug>` (also kills/removes the terminal). `agent-pane.sh list` shows panes.
- `herdr-app shot /tmp/x.png` captures the window; use it to check layout instead of guessing.

## Machine / screens

- X11, DISPLAY `:1`, root window 9840x3840 (multi-monitor, scaled). Do not grab the whole root — it is mostly empty.
- The Shotcut window sits on the right-hand screen (outer frame 3840x2096 at +2160+805 as of 2026-11-07). Never hardcode coordinates: run `xwininfo -root -tree` and pick the largest window whose title contains `Shotcut`.
- Screenshot helper: `/home/mark/agent-office/mjmeijerman/bakmark/scripts/shotcut-window.py [out.png] [width]`.
