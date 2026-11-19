#!/usr/bin/env bash
# install.sh — thin shim; the engine is install.mjs (Linux, macOS and Windows).
#
#   ./install.sh                     config + hooks, non-interactive, no prompts
#   ./install.sh --no-install-pi     skip pi, install the rest (pi is installed by default)
#   ./install.sh --skip-prereqs      never check or install git, node and npm
#   ./install.sh --dry-run           print the plan, change nothing
#   ./install.sh --skills=a,b --extensions=c.ts
#
# The engine's step 0 is the prerequisites (git, node, npm) — this shim cannot
# do that itself, because it needs node to run at all. A machine with no node
# starts at ./setup.sh (or setup.ps1 on Windows), which installs node and then
# execs the engine.
#
# Interactive provisioning lives in setup.mjs (./setup.sh): it asks which skills,
# extensions and AGENT rules to keep, and then runs this engine. See README.md.
set -euo pipefail
command -v node >/dev/null 2>&1 || { printf 'install: node not found — run ./setup.sh (it installs node and git first), or install Node 24 yourself (mise.toml pins it), then re-run\n' >&2; exit 1; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.mjs" "$@"
