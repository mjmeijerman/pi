#!/usr/bin/env bash
# setup.sh — thin shim; the interactive pass is setup.mjs and the engine install.mjs.
#
#   ./setup.sh            ask per skill, per extension, per AGENT rule, per key
#   ./setup.sh -y         accept every default (the full set)
#   ./setup.sh --rules=drop:3,7 --skills=github-workflow --no-keys --dry-run
#
# Answers are recorded in ~/.pi/state/setup.json, so a dropped rule stays dropped
# and --reask asks again. See README.md for the flags and the per-OS behaviour.
set -euo pipefail
command -v node >/dev/null 2>&1 || { printf 'setup: node not found — install Node 24 (mise.toml pins it), then re-run\n' >&2; exit 1; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup.mjs" "$@"
