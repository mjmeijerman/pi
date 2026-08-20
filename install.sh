#!/usr/bin/env bash
# ============================================================================
# pi instance installer — reproduces this exact setup on another machine.
#
# Usage (run from anywhere):
#   ~/.pi/install.sh            # machine where ~/.pi already exists (self-heal)
#   <clone-dir>/install.sh      # after cloning your ~/.pi repo to a new PC
#
# Installs:
#   - pi agent skills, extensions, settings.json, AGENTS.md, models.json
#   - global git hooks: secret scans on pre-commit, commit-msg, and pre-push
#   - global gitignore for secret files
#
# Idempotent. Never touches auth.json, sessions, bin, models-store.json.
# Override target with PI_AGENT_DIR=/path/to/agent.
# ============================================================================
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
GIT_HOOKS_DIR="$HOME/.pi/git-hooks"

echo "== pi instance installer =="
echo "   source : $SOURCE_DIR"
echo "   agent  : $AGENT_DIR"

# --- 0. pi binary -----------------------------------------------------------
if ! command -v pi >/dev/null 2>&1; then
	if [ "${1:-}" = "--install-pi" ] && command -v npm >/dev/null 2>&1; then
		echo "== installing pi via npm (global) =="
		npm install -g --ignore-scripts @earendil-works/pi-coding-agent
	else
		echo "!! 'pi' not found on PATH. Install it first, e.g.:"
		echo "   npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
		echo "   (or: pnpm add -g @earendil-works/pi-coding-agent)"
		echo "   Then re-run this script (add --install-pi to auto-install)."
		exit 1
	fi
fi

# --- 1. agent config ---------------------------------------------------------
mkdir -p "$AGENT_DIR"
for sub in skills extensions; do
	src="$SOURCE_DIR/agent/$sub"
	dst="$AGENT_DIR/$sub"
	if [ -d "$src" ] && [ "$src" != "$dst" ]; then
		mkdir -p "$dst"
		cp -R "$src/." "$dst/"
	fi
done
for f in settings.json AGENTS.md models.json; do
	src="$SOURCE_DIR/agent/$f"
	dst="$AGENT_DIR/$f"
	if [ -f "$src" ] && [ "$src" != "$dst" ]; then
		cp "$src" "$dst"
	fi
done
echo "== copied skills/extensions/settings -> $AGENT_DIR"

# --- 2. git hooks ------------------------------------------------------------
if [ -d "$SOURCE_DIR/git-hooks" ] && [ "$SOURCE_DIR/git-hooks" != "$GIT_HOOKS_DIR" ]; then
	mkdir -p "$GIT_HOOKS_DIR"
	cp -R "$SOURCE_DIR/git-hooks/." "$GIT_HOOKS_DIR/"
fi
if [ -f "$GIT_HOOKS_DIR/install-hooks.sh" ]; then
	bash "$GIT_HOOKS_DIR/install-hooks.sh"
else
	echo "!! git-hooks missing in $SOURCE_DIR and $GIT_HOOKS_DIR — skipping hooks"
fi
echo "== git hooks active : $(git config --global --get core.hooksPath)"

# --- 3. global gitignore -----------------------------------------------------
if [ -f "$SOURCE_DIR/gitignore_global" ] && [ "$SOURCE_DIR/gitignore_global" != "$HOME/.pi/gitignore_global" ]; then
	cp "$SOURCE_DIR/gitignore_global" "$HOME/.pi/gitignore_global"
fi
if [ -f "$HOME/.pi/gitignore_global" ]; then
	git config --global core.excludesFile "$HOME/.pi/gitignore_global"
fi
echo "== global gitignore: $(git config --global --get core.excludesFile)"

# --- 4. git-vuln-scan (pre-push agent scan) + git templates -------------------
if [ -f "$SOURCE_DIR/git-vuln-scan" ] && [ "$SOURCE_DIR/git-vuln-scan" != "$HOME/.local/bin/git-vuln-scan" ]; then
	BIN_DIR="$HOME/.local/bin"
	mkdir -p "$BIN_DIR"
	cp "$SOURCE_DIR/git-vuln-scan" "$BIN_DIR/git-vuln-scan"
	chmod +x "$BIN_DIR/git-vuln-scan"
fi
if [ -f "$HOME/.local/bin/git-vuln-scan" ]; then
	echo "== git-vuln-scan installed -> $HOME/.local/bin/git-vuln-scan"
else
	echo "!! git-vuln-scan not found — skipping"
fi

if [ -d "$SOURCE_DIR/git-templates" ] && [ "$SOURCE_DIR/git-templates" != "$HOME/.git-templates" ]; then
	rm -rf "$HOME/.git-templates"
	cp -R "$SOURCE_DIR/git-templates" "$HOME/.git-templates"
fi
if [ -f "$HOME/.git-templates/hooks/pre-push" ]; then
	git config --global init.templateDir "$HOME/.git-templates"
	echo "== git template hooks: $(git config --global --get init.templateDir)"
fi

echo
echo "Done. Restart pi (or run /reload) to load the extensions."
echo
echo "Verify:"
echo "   /secretguard status                                 # protection active"
echo "   git config --global --get core.hooksPath            # prints $GIT_HOOKS_DIR"
echo "   git config --global --get core.excludesFile         # global gitignore"
echo "   git config --global --get init.templateDir          # pre-push vuln scan"
echo "   git-vuln-scan                                       # should print usage help"
echo
echo "Reminder if you ever forget the hooks: just run this script again."
