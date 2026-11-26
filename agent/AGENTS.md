# Global rules

- Always respond in English, regardless of the language the user writes in.
- Use codemode for 2+ tool calls: one script (`tools.read`, `tools.bash`, `Promise.allSettled` when independent) beats separate calls; single calls go direct.
- ADHD mode is always on (`~/.pi/agent/i-have-adhd.json`); it governs commits, PR bodies, review comments, files. Only the user turns it off.

## Sandbox

- `pi` runs sandboxed by default (`install.sh` wraps it); `pi-bare` quits it; `pisandbox --no-net` is for repo scripts, not agents — no net means no model (blip 1). Native Windows has no bwrap, so there `pi` and its workers run bare.

## Landing changes

- Never merge, push to trunk, or commit on trunk without the user's explicit permission in this session. Ask, wait for a yes, then `/mergeguard allow` and run that one command. `merge-guard` blocks all of those; green CI is not permission.
- Body gates: run `make pr-check BODY=<file>` before the PR goes out — seconds, same `pr-tier` verdict; the tier goes in the body (blips 17, 42): High = `agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`, `sandbox/`, auth, secrets, money, deletion → read line by line, never auto-merged; Medium = code, tests, migrations → diff read, tests green; Low = docs, comments, formatting → CI green, skim. A mission is a literal `Mission:` line (20+ chars); a harness path in the diff is High whatever the body says.
- Green, mergeable, prose review answered is `bin/pr-ready <n> --sha <sha>` exiting 0, quoted; `gh pr checks` prose proves nothing. A hand-over is gated by CI run locally: `bin/preflight --ci` (all of `gh pr checks`, in parallel); `delegate finish` refuses without it. A worker starting or reporting is not news.
- Vague request, more than one file, or a design choice → `/grill` first; no code before the answers (blip 13).

## Harness sources

- Harness changes cite a Thoughtworks Radar blip (Vol. 35, Adopt preferred): the problem it fixes and how it is measured.

## Models

- `local_llm` runs summarize/classify/extract/tidy/translate on the local `qwen3.8:27b` (no API cost); `/local` checks the endpoint.
- `jev` decides instead of guessing (0 yes, 1 no, 3 unsure). TypeSafe's Jev over HTTPS — a key, network, a cost per call — not local.

## Harness feedback

- When the harness gets in the way, run `/suggest <what went wrong>`; `/retro` aggregates the log into `~/.pi/agent/retro/`.

## Herdr

- Spawn agents with `~/.pi/scripts/agent-pane.sh spawn <slug> <spec.md>`: hidden, no pane, focus stays. A worker is a tab of its space; `close` closes the tab, not the space.
- `show <slug>` borrows your pane, `hide <slug>` puts it back, `close <slug>` ends it, `list` shows them.
- `herdr-app shot /tmp/x.png` captures the window; check layout with it, never guess.

## Machine / screens

- X11, DISPLAY `:1`, root window 9840x3840 (multi-monitor, scaled); never grab the whole root.
- Shotcut (Linux/X11): right-hand screen. No hardcoded coordinates: run `xwininfo -root -tree`, pick the largest `Shotcut` window.
- Screenshot helper: `~/projects/bakmark/scripts/shotcut-window.py [out.png] [width]` — `%USERPROFILE%\projects\bakmark\scripts\shotcut-window.py` on native Windows.
