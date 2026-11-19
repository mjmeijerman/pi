#!/usr/bin/env bash
# install.sh — thin shim; the engine is install.mjs (Linux, macOS and Windows).
#
#   ./install.sh                     config + hooks, non-interactive, no prompts
#   ./install.sh --no-install-pi     skip pi, install the rest (pi is installed by default)
#   ./install.sh --dry-run           print the plan, change nothing
#   ./install.sh --skills=a,b --extensions=c.ts
#
# Interactive provisioning lives in setup.mjs (./setup.sh): it asks which skills,
# extensions and AGENT rules to keep, and then runs this engine. See README.md.
set -euo pipefail
command -v node >/dev/null 2>&1 || { printf 'install: node not found — install Node 24 (mise.toml pins it), then re-run\n' >&2; exit 1; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.mjs" "$@"
