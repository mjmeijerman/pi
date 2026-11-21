# Global rules

- Always respond in English, whatever language the user writes.
- Use codemode for 2+ tool calls (one script; `Promise.allSettled` for parallel); a single call goes direct.
- ADHD mode is always on (`~/.pi/agent/i-have-adhd.json`): governs commits, PR bodies, review comments, files; only the user turns it off.

## Sandbox

- `pi` runs sandboxed by default (`install.sh` wraps it); `pi-bare` quits it; `pisandbox --no-net` is for repo scripts, not agents: no net, no model (blip 1).

## Landing changes

- Never merge, push, or commit on trunk without the user's explicit permission in this session: ask, wait for yes, then `/mergeguard allow` and run that command. `merge-guard` blocks all of it; green CI is not permission.
- Body gates: `make pr-check BODY=<file>` before it goes out: seconds, same `pr-tier` verdict; the tier goes in the body (blips 17, 42): High = `agent/extensions/`, `agent/AGENTS.md`, `.github/`, `git-hooks/`, `sandbox/`, auth, secrets, money, deletion → line by line, never auto-merged; Medium = code, tests, migrations → diff read, tests green; Low = docs, comments, formatting → CI green, skim. A mission is a literal `Mission:` line (20+ chars); a harness path in the diff is High whatever the body says.
- Green is `bin/pr-ready <n> --sha <sha>` exiting 0, quoted. No hand-rolled poll loop: `--wait` stops at the first failure; `gh pr checks` prose is no evidence. Stay on it: once a branch is published, a report is not the end — stay in this turn until the PR is green and mergeable (`gh pr view --json mergeable`); red CI or `CONFLICTING` is yours: fix it there or hand back with the failing line. Two exits: green and mergeable, or the person decides. A worker starting or reporting is not news.
- Vague request, more than one file, or a design choice → `/grill` first; no code before they answer (blip 13).

## Harness sources

- Harness changes cite a Thoughtworks Radar blip (Vol. 35, Adopt preferred): the problem it fixes and how it is measured.

## Models

- `local_llm` summarizes/classifies/extracts/tidies/translates on local `qwen3.8:27b` (no API cost); `/local` checks it.
- `jev` decides, never guesses (0 yes, 1 no, 3 unsure): TypeSafe's Jev over HTTPS, a key, network, a cost per call — not local.

## Harness feedback

- When the harness gets in the way, run `/suggest <what went wrong>`; `/retro` aggregates it into `~/.pi/agent/retro/`.

## Herdr

- Spawn agents with `~/.pi/scripts/agent-pane.sh spawn <slug> <spec.md>`: hidden, no pane, focus stays. A worker is a tab of its space; `close` closes the tab, not the space.
- `show` borrows your pane, `hide` puts it back, `close` ends it, `list` shows them.
- `herdr-app shot /tmp/x.png` captures the window; check layout there, never guess.

## Machine / screens

- X11, DISPLAY `:1`, root 9840x3840 (multi-monitor, scaled); never grab all of it.
- Shotcut: right-hand screen; no hardcoded coordinates: `xwininfo -root -tree`, largest `Shotcut` window.
- Screenshot: `~/projects/bakmark/scripts/shotcut-window.py [out.png] [width]`.
