#!/usr/bin/env bash
# ============================================================================
# pi instance installer — reproduces this exact setup on another machine.
#
# Usage (run from anywhere):
#   ~/.pi/install.sh            # machine where ~/.pi already exists (self-heal)
#   <clone-dir>/install.sh      # after cloning your ~/.pi repo to a new PC
#
# Installs:
#   - pi agent skills, extensions, settings.json, AGENTS.md, models.json,
#     i-have-adhd.json, keybindings.json, package.json
#   - ~/.pi/sandbox and ~/.pi/scripts (referenced by AGENTS.md as absolute paths)
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
# A pnpm/fnm install is often on disk but not on this shell's PATH (a bash login
# shell never reads the PNPM_HOME export from ~/.zshrc), so look there before
# declaring pi missing. Same resolution the pi() wrapper uses.
if ! command -v pi >/dev/null 2>&1; then
	for candidate in "${PNPM_HOME:-$HOME/.local/share/pnpm}/bin/pi" "$HOME/.local/bin/pi"; do
		if [ -x "$candidate" ]; then
			PATH="${candidate%/*}:$PATH"
			export PATH
			echo "== pi found on disk, added to PATH: $candidate"
			break
		fi
	done
fi

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

# Skills and extensions can be filtered by setup.sh through PI_SKILLS /
# PI_EXTENSIONS (space-separated names). Unset means "everything", which keeps
# plain `./install.sh` behaviour unchanged.
if [ -d "$SOURCE_DIR/agent/skills" ] && [ "$SOURCE_DIR/agent/skills" != "$AGENT_DIR/skills" ]; then
	mkdir -p "$AGENT_DIR/skills"
	if [ -n "${PI_SKILLS:-}" ]; then
		for s in $PI_SKILLS; do
			[ -d "$SOURCE_DIR/agent/skills/$s" ] && cp -R "$SOURCE_DIR/agent/skills/$s" "$AGENT_DIR/skills/"
		done
	else
		cp -R "$SOURCE_DIR/agent/skills/." "$AGENT_DIR/skills/"
	fi
fi

if [ -d "$SOURCE_DIR/agent/extensions" ] && [ "$SOURCE_DIR/agent/extensions" != "$AGENT_DIR/extensions" ]; then
	mkdir -p "$AGENT_DIR/extensions"
	# lib/ and __tests__/ always come along: extensions import lib, and the test
	# suite is how setup.sh verifies the install afterwards.
	cp -R "$SOURCE_DIR/agent/extensions/lib" "$AGENT_DIR/extensions/" 2>/dev/null || true
	cp -R "$SOURCE_DIR/agent/extensions/__tests__" "$AGENT_DIR/extensions/" 2>/dev/null || true
	if [ -n "${PI_EXTENSIONS:-}" ]; then
		for e in $PI_EXTENSIONS; do
			[ -f "$SOURCE_DIR/agent/extensions/$e" ] && cp "$SOURCE_DIR/agent/extensions/$e" "$AGENT_DIR/extensions/"
		done
	else
		cp "$SOURCE_DIR/agent/extensions"/*.ts "$AGENT_DIR/extensions/"
	fi
fi
for f in settings.json AGENTS.md models.json i-have-adhd.json keybindings.json package.json; do
	src="$SOURCE_DIR/agent/$f"
	dst="$AGENT_DIR/$f"
	if [ -f "$src" ] && [ "$src" != "$dst" ]; then
		cp "$src" "$dst"
	fi
done
# The dictation extension needs its script, lock file and wrapper; the venv
# (machine-specific, ~2.5 GB) and recorded audio stay out.
DICT_SRC="$SOURCE_DIR/agent/dictation"
DICT_DST="$AGENT_DIR/dictation"
if [ -d "$DICT_SRC" ] && [ "$DICT_SRC" != "$DICT_DST" ]; then
	mkdir -p "$DICT_DST/bin"
	cp "$DICT_SRC/transcribe.py" "$DICT_SRC/requirements.lock" "$DICT_DST/" 2>/dev/null || true
	cp "$DICT_SRC/bin/whisper-py" "$DICT_DST/bin/" 2>/dev/null || true
fi
echo "== copied skills/extensions/settings -> $AGENT_DIR"

# --- 1b. things AGENTS.md and the skills reference by absolute path --------
# ~/.pi/sandbox/pi-sandbox.sh and ~/.pi/scripts/agent-pane.sh are referenced
# from agent/AGENTS.md, so they have to sit next to the agent dir, not in the
# clone. Runtime state (pane map, session archive) is never copied.
for sub in sandbox scripts; do
	src="$SOURCE_DIR/$sub"
	dst="$HOME/.pi/$sub"
	if [ -d "$src" ] && [ "$src" != "$dst" ]; then
		mkdir -p "$dst"
		cp -R "$src/." "$dst/"
		rm -f "$dst/.agent-panes.json"
		echo "== copied $sub -> $dst"
	fi
done

# --- 1c. herdr-app mods ----------------------------------------------------
# Only when the app is installed, and only into folders that do not exist yet:
# a mod is a file the person may have edited in place, and install.sh must not
# undo that.
HERDR_MODS="${HERDR_MODS:-$HOME/.config/herdr-app/mods}"
if [ -d "$SOURCE_DIR/herdr-mods" ] && [ -d "$HOME/.config/herdr-app" ]; then
	for mod in "$SOURCE_DIR/herdr-mods"/*/; do
		name=$(basename "$mod")
		if [ -d "$HERDR_MODS/$name" ]; then
			echo "== kept existing herdr mod: $name"
		else
			mkdir -p "$HERDR_MODS/$name"
			cp -R "$mod/." "$HERDR_MODS/$name/"
			echo "== installed herdr mod: $name -> $HERDR_MODS/$name"
		fi
	done
fi

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

# pisandbox: the sandbox without the absolute path (Radar blip 1, Adopt). An
# opt-in safety measure that costs a 40-character path is one nobody uses.
PI_BIN_DIR="$HOME/.local/bin"
mkdir -p "$PI_BIN_DIR"
if [ -f "$HOME/.pi/scripts/pisandbox" ]; then
	chmod +x "$HOME/.pi/scripts/pisandbox"
	ln -sf "$HOME/.pi/scripts/pisandbox" "$PI_BIN_DIR/pisandbox"
	echo "== pisandbox -> $PI_BIN_DIR/pisandbox"
else
	echo "!! scripts/pisandbox not found — skipping"
fi

# --- 4b. sandbox by default for interactive pi (Radar blip 1, Adopt) -------
# AGENTS.md called sandboxing "the default, not opt-in" while `pi` on PATH stayed
# the raw binary: a wrapper you have to remember to type is willpower, not a
# default. This installs a shell function that runs pisandbox, with PI_BARE=1 as
# the documented escape hatch and a fallback to the plain binary whenever the
# sandbox itself is missing — a broken sandbox must never make pi unusable.
PI_WRAPPER_BEGIN='# >>> pi sandbox >>>'
PI_WRAPPER_END='# <<< pi sandbox <<<'

install_pi_wrapper() {
	rc="$1"
	[ -f "$rc" ] || return 0
	# One backup, kept from the first run: that is the pre-wrapper file.
	[ -f "$rc.bak-pi" ] || cp "$rc" "$rc.bak-pi"
	tmp="$(mktemp)"
	# Drop a previous managed block, then append the current one: re-running
	# install.sh must replace, never duplicate.
	awk -v b="$PI_WRAPPER_BEGIN" -v e="$PI_WRAPPER_END" '
		BEGIN { keep = 1 }
		$0 == b { keep = 0; next }
		$0 == e { keep = 1; next }
		keep' "$rc" >"$tmp"
	cat >>"$tmp" <<'WRAPPER'
# >>> pi sandbox >>>
# Managed by ~/.pi/install.sh — edit there, not here; re-run it to refresh.
# Radar blip 1 (Adopt, agent sandboxing): plain `pi` is sandboxed, so safety
# does not depend on remembering a prefix. Bypass one session: PI_BARE=1 pi
pi() {
	local _pi_bin="${PI_BIN:-$HOME/.local/share/pnpm/bin/pi}"
	[ -x "$_pi_bin" ] || _pi_bin="$HOME/.local/bin/pi"
	if [ ! -x "$_pi_bin" ]; then
		printf 'pi: binary not found (set PI_BIN=/path/to/pi)\n' >&2
		return 127
	fi
	# A bash login shell carries no PNPM_HOME, and pisandbox refuses to start
	# when it cannot find pi on PATH: put the shim's directory on PATH first.
	case ":$PATH:" in
	*":${_pi_bin%/*}:"*) ;;
	*) PATH="${_pi_bin%/*}:$PATH" ;;
	esac
	export PATH
	if [ "${PI_BARE:-}" = 1 ]; then
		"$_pi_bin" "$@"
		return
	fi
	if [ ! -x "$HOME/.pi/scripts/pisandbox" ] || ! command -v bwrap >/dev/null 2>&1; then
		printf 'pi: sandbox unavailable (pisandbox or bwrap missing) — running unsandboxed\n' >&2
		"$_pi_bin" "$@"
		return
	fi
	"$HOME/.pi/scripts/pisandbox" -- pi "$@"
}
# <<< pi sandbox <<<
WRAPPER
	if cmp -s "$tmp" "$rc"; then
		rm -f "$tmp"
		echo "== pi sandbox wrapper already current -> $rc"
		return 0
	fi
	cat "$tmp" >"$rc"
	rm -f "$tmp"
	case "$rc" in
	*zshrc) syntax_check="zsh" ;;
	*) syntax_check="bash" ;;
	esac
	if command -v "$syntax_check" >/dev/null 2>&1 && ! "$syntax_check" -n "$rc" 2>/dev/null; then
		echo "!! $rc does not parse ($syntax_check -n) — the pi wrapper will not load"
		echo "   previous version kept as $rc.bak-pi"
	else
		echo "== pi sandbox wrapper -> $rc (PI_BARE=1 pi bypasses it)"
	fi
}

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
	install_pi_wrapper "$rc"
done

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
echo "   pisandbox --help                                    # sandbox one-liner"
echo "   bash scripts/harness-check.sh                        # harness budgets as checks"
echo
echo "Reminder if you ever forget the hooks: just run this script again."
