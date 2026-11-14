#!/usr/bin/env bash
# ============================================================================
# setup.sh — provision everything that is NOT in this git repo.
#
#   git clone git@github.com:mjmeijerman/pi.git ~/.pi   # or anywhere
#   cd ~/.pi && ./setup.sh                              # answer the prompts
#   pi                                                   # done
#
# What is already in git: skills, extensions, settings.json, models.json,
# AGENTS.md, keybindings, i-have-adhd.json, sandbox/, scripts/, git hooks and
# their scanners. `install.sh` puts those on disk.
#
# What is NOT in git, and what this script therefore does:
#   1. system packages (bubblewrap, jq, alsa-utils, python3-venv, ...)
#   2. the DeepSeek API key that models.json resolves at request time
#   3. pi packages declared in settings.json (installed/reconciled by pi)
#   4. git identity and gh auth state
#   5. optional: the local Ollama model used by the `local_llm` tool
#   6. optional: the faster-whisper virtualenv used by the dictation extension
#   7. verification that the result matches the machine it came from
#
# Idempotent: safe to re-run. Never prints a secret, never overwrites a key
# without --force-key.
#
# Options:
#   -y, --yes          accept all prompts (still prompts for the API key)
#       --dry-run      print what would happen, change nothing
#       --no-apt       never call sudo apt-get; only report missing packages
#       --with-ollama  pull the local model (17 GB download)
#       --with-dictation  build the whisper venv (~2.5 GB of wheels)
#       --force-key    overwrite an existing deepseek.key
#       --no-verify    skip the verification block
#   -h, --help         this text
# ============================================================================
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PI_HOME="$(dirname "$AGENT_DIR")"
ASSUME_YES=0
DRY_RUN=0
DO_APT=1
WITH_OLLAMA=0
WITH_DICTATION=0
FORCE_KEY=0
DO_VERIFY=1
LOCAL_MODEL="${PI_LOCAL_MODEL:-qwen3.8:27b}"

# ---------------------------------------------------------------- output ----

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die() {
	printf '\033[31merror: %s\033[0m\n' "$*" >&2
	exit 1
}

run() {
	if [ "$DRY_RUN" = 1 ]; then
		printf '   [dry-run] %s\n' "$*"
		return 0
	fi
	"$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

# Major version of the npm on PATH, or 0 when there is no npm at all.
npm_major() {
	local v
	v=$(npm --version 2>/dev/null || true)
	printf '%s\n' "${v%%.*}" | grep -E '^[0-9]+$' >/dev/null 2>&1 || {
		echo 0
		return 0
	}
	printf '%s\n' "${v%%.*}"
}

ask() {
	local prompt=$1 reply
	if [ "$ASSUME_YES" = 1 ]; then
		return 0
	fi
	if [ ! -t 0 ]; then
		return 1
	fi
	read -rp "   $prompt [y/N] " reply
	case "$reply" in
	[yY] | [yY][eE][sS]) return 0 ;;
	*) return 1 ;;
	esac
}

# Default is yes: pressing Enter keeps the component. -y or a piped stdin also
# counts as yes, so an unattended run installs the full set.
ask_default_yes() {
	local prompt=$1 reply
	if [ "$ASSUME_YES" = 1 ]; then
		return 0
	fi
	if [ ! -t 0 ]; then
		printf '   %s -> yes (no tty)\n' "$(printf '%s' "$prompt" | head -1)"
		return 0
	fi
	read -rp "   install? [Y/n] " reply
	case "$reply" in
	[nN] | [nN][oO]) return 1 ;;
	*) return 0 ;;
	esac
}

# One-line description for a skill, read from its SKILL.md frontmatter.
skill_desc() {
	awk '/^description:/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$1/SKILL.md" 2>/dev/null | cut -c1-108
}

# One-line description for an extension, read from its header comments.
ext_desc() {
	local f=$1 d=""
	# Only a file-header comment counts. A comment deeper in the file describes
	# one detail, not the extension (dictation.ts was the offender).
	if [ "$(head -1 "$f")" = "/**" ]; then
		# Join the block-comment lines: many headers wrap over three lines, and
		# taking only line one cut the sentence in half (local-llm.ts).
		d=$(awk 'NR > 1 && NR <= 20 {
			if (/^ \* /) { sub(/^ \* /, ""); buf = (buf == "" ? $0 : buf " " $0); next }
			if (buf != "") exit
		} END { print buf }' "$f")
	fi
	if [ -z "$d" ]; then
		d=$(awk 'NR <= 3 && /^\/\/ [A-Za-z0-9]/ {sub(/^\/\/ /, ""); print; exit}' "$f")
	fi
	printf '%s' "$d"
}

# Skill descriptions are YAML: strip the surrounding quotes and cut on a word
# boundary so the prompt stays one readable line.
trim_desc() {
	local d=""
	d=$(printf '%s' "$1" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
	# Prefer the first sentence when it is long enough to be informative.
	local first
	first=$(printf '%s' "$d" | sed -n 's/^\([^.]\{25,\}\)\..*/\1/p' | head -1)
	[ -n "$first" ] && d="$first"
	if [ ${#d} -gt 96 ]; then
		d="${d:0:96}"
		d="${d% *}…"
	fi
	printf '%s' "$d"
}

usage() {
	sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ------------------------------------------------------------- arguments ----

while [ $# -gt 0 ]; do
	case "$1" in
	-y | --yes) ASSUME_YES=1 ;;
	--dry-run) DRY_RUN=1 ;;
	--no-apt) DO_APT=0 ;;
	--with-ollama) WITH_OLLAMA=1 ;;
	--with-dictation) WITH_DICTATION=1 ;;
	--force-key) FORCE_KEY=1 ;;
	--no-verify) DO_VERIFY=0 ;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (try --help)" ;;
	esac
	shift
done

# ---------------------------------------------------------------- preflight ---

step "preflight"
note "source : $SOURCE_DIR"
note "agent  : $AGENT_DIR"

[ -f "$SOURCE_DIR/install.sh" ] || die "run this from the cloned pi repo (install.sh not found)"
[ -d "$SOURCE_DIR/agent" ] || die "run this from the cloned pi repo (agent/ not found)"
case "$(uname -s)" in
Linux) note "system : Linux $(uname -r)" ;;
*) warn "this script assumes Linux; continuing, but apt and bwrap steps will be skipped" ;;
esac

have git || die "git is not installed"
have node || die "node is not installed (pi needs Node 24 or newer)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
	warn "node $(node -v) is older than 24; pi 1.5.x expects 24 or 26"
fi

if ! have pi; then
	note "pi is not on PATH yet; install.sh can install it with npm"
fi

# ------------------------------------------------------------ system deps ----

step "system packages"
# command -> apt package. Only the ones something in this repo actually calls.
declare -a NEED_PKGS=()
check_pkg() {
	local bin=$1 pkg=$2
	if ! have "$bin"; then
		NEED_PKGS+=("$pkg")
		note "missing: $bin  (apt: $pkg)"
	fi
}
check_pkg bwrap bubblewrap        # sandbox/pi-sandbox.sh
check_pkg jq jq                   # scripts/*.sh
check_pkg arecord alsa-utils      # dictation extension
check_pkg curl curl               # package installs, health checks
check_pkg gh gh                   # PR workflow, merge-guard

if [ "${#NEED_PKGS[@]}" -eq 0 ]; then
	note "all required packages present"
else
	mapfile -t uniq_pkgs < <(printf '%s\n' "${NEED_PKGS[@]}" | sort -u)
	note "install with: sudo apt-get install -y ${uniq_pkgs[*]}"
	if [ "$DO_APT" = 1 ] && have apt-get && ask "install them now with sudo apt-get?"; then
		run sudo apt-get install -y "${uniq_pkgs[@]}" || warn "apt-get failed; install them by hand"
	else
		note "skipped — re-run with sudo, or with --no-apt to keep it quiet"
	fi
fi

# ------------------------------------------------- 1. choose components ----

step "skills"
SKILLS_PICKED=""
if [ -d "$SOURCE_DIR/agent/skills" ]; then
	TOTAL=$(find "$SOURCE_DIR/agent/skills" -maxdepth 1 -mindepth 1 -type d | wc -l)
	IDX=0
	for dir in "$SOURCE_DIR/agent/skills"/*/; do
		name=$(basename "$dir")
		IDX=$((IDX + 1))
		desc=$(trim_desc "$(skill_desc "$dir")")
		[ -z "$desc" ] && desc="(no description in SKILL.md)"
		printf '   [%d/%d] %s\n         %s\n' "$IDX" "$TOTAL" "$name" "$desc"
		if ask_default_yes "$name"; then
			SKILLS_PICKED="$SKILLS_PICKED $name"
		else
			note "skipped: $name"
		fi
	done
fi
PI_SKILLS="${SKILLS_PICKED# }"
export PI_SKILLS
note "skills selected: ${PI_SKILLS:+${PI_SKILLS// /, }}"
[ -z "$PI_SKILLS" ] && note "skills selected: none"

step "extensions"
EXTS_PICKED=""
if [ -d "$SOURCE_DIR/agent/extensions" ]; then
	TOTAL=$(find "$SOURCE_DIR/agent/extensions" -maxdepth 1 -name '*.ts' | wc -l)
	IDX=0
	for file in "$SOURCE_DIR/agent/extensions"/*.ts; do
		[ -f "$file" ] || continue
		base=$(basename "$file")
		IDX=$((IDX + 1))
		desc=$(trim_desc "$(ext_desc "$file")")
		[ -z "$desc" ] && desc="(no header comment in the file)"
		printf '   [%d/%d] %s\n         %s\n' "$IDX" "$TOTAL" "${base%.ts}" "$desc"
		if ask_default_yes "$base"; then
			EXTS_PICKED="$EXTS_PICKED $base"
		else
			note "skipped: $base"
		fi
	done
fi
PI_EXTENSIONS="${EXTS_PICKED# }"
export PI_EXTENSIONS
note "extensions selected: ${PI_EXTENSIONS:+${PI_EXTENSIONS// /, }}"
[ -z "$PI_EXTENSIONS" ] && note "extensions selected: none"
if [ "$DRY_RUN" = 0 ]; then
	note "anything skipped but already present stays on disk; remove it by hand if you want it gone"
fi

# ------------------------------------------------- 2. config + hooks (git) ---

step "config from git"
if have pi; then
	run bash "$SOURCE_DIR/install.sh"
else
	run bash "$SOURCE_DIR/install.sh" --install-pi || die "install.sh failed; install pi first"
	hash -r 2>/dev/null || true # a just-installed pi may not be on PATH yet
fi

# Blip 99 (Safe Chain): a malicious npm version is normally installable for
# hours. This is the one-line mitigation, so it belongs in the config step and
# not in a paragraph telling the user to remember it.
# It takes two: npm only honours min-release-age from 11.10 on, and an older npm
# still echoes the value back from .npmrc, so setting it on npm 10 looks done and
# does nothing. So install a user-owned npm >= 11 first, under ~/.local — the
# prefix this script already uses, ahead of /usr/bin on PATH.
# Never sudo, never a distro npm under /usr: a failed install warns and leaves
# the existing npm alone.
if ! have npm; then
	warn "npm not found — min-release-age not set (blip 99); install node+npm, then re-run"
elif [ "$(npm_major)" -lt 11 ]; then
	note "npm $(npm --version) ignores min-release-age (needs npm >= 11) — installing npm@11 into $HOME/.local"
	if run npm install -g --prefix "$HOME/.local" npm@11; then
		hash -r 2>/dev/null || true # PATH lookup still points at the old npm
	else
		warn "npm@11 install failed — nothing changed under /usr; install one by hand: npm i -g --prefix ~/.local npm@11"
	fi
fi
if have npm && [ "$(npm_major)" -ge 11 ]; then
	# npm reads this in days, so 2 is the 48-hour window.
	# A read-only or root-owned ~/.npmrc must not abort the whole installer.
	run npm config set min-release-age 2 ||
		warn "could not write ~/.npmrc — set it once by hand: npm config set min-release-age 2"
	note "npm min-release-age: $(npm config get min-release-age 2>/dev/null || echo unset) (npm $(npm --version))"
elif have npm; then
	warn "still npm $(npm --version) — min-release-age not set and would be ignored (blip 99)"
fi

# --------------------------------------------------------------- 2. secrets --

step "provider API key"
# models.json reads this file at request time: "apiKey": "!cat ~/.pi/agent/deepseek.key".
# It is the only credential this repo needs; everything else goes through `pi auth`.
KEY_FILE="$AGENT_DIR/deepseek.key"
write_key() {
	local key=$1
	if [ "$DRY_RUN" = 1 ]; then
		note "[dry-run] would write $KEY_FILE (mode 600)"
		return 0
	fi
	(
		umask 077
		printf '%s\n' "$key" >"$KEY_FILE"
	)
	chmod 600 "$KEY_FILE"
	note "wrote $KEY_FILE (mode 600, never printed, never committed)"
}

if [ -s "$KEY_FILE" ] && [ "$FORCE_KEY" = 0 ]; then
	note "$KEY_FILE already exists — leaving it alone (use --force-key to replace)"
else
	KEY_IN="${DEEPSEEK_API_KEY:-}"
	if [ -z "$KEY_IN" ] && [ -t 0 ]; then
		printf '   Paste the DeepSeek API key (input hidden, empty to skip): '
		read -rs KEY_IN
		printf '\n'
	fi
	if [ -n "$KEY_IN" ]; then
		case "$KEY_IN" in
		sk-*) write_key "$KEY_IN" ;;
		*)
			warn "that does not look like a DeepSeek key (expected prefix 'sk-'); not written"
			note "set it later: umask 077; printf '%s\\n' 'sk-...' > $KEY_FILE"
			;;
		esac
	else
		note "skipped — the default model will fail until this file exists:"
		note "  umask 077; printf '%s\\n' 'sk-...' > $KEY_FILE"
	fi
	unset KEY_IN
fi

# ------------------------------------------------------------ 3. pi packages --

step "pi packages (declared in settings.json)"
if have pi; then
	PKG_LIST=$(node -e '
		const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		for (const p of s.packages || []) console.log(p);
	' "$AGENT_DIR/settings.json" 2>/dev/null || true)
	if [ -z "$PKG_LIST" ]; then
		note "none declared"
	else
		SKIPPED_PKGS=""
		while IFS= read -r pkg; do
			[ -z "$pkg" ] && continue
			printf '         %s\n' "$pkg"
			if ! ask_default_yes "$pkg"; then
				SKIPPED_PKGS="$SKIPPED_PKGS $pkg"
				note "skipped: $pkg"
			fi
		done <<<"$PKG_LIST"
		# Declining a package removes it from settings.json, otherwise
		# `pi update --extensions` would just install it again.
		if [ -n "$SKIPPED_PKGS" ]; then
			for pkg in $SKIPPED_PKGS; do
				run pi remove "$pkg" >/dev/null 2>&1 || warn "could not remove $pkg"
			done
		fi
	fi
	# Reconciles npm and git packages into ~/.pi/agent/{npm,git}. Fails loudly on
	# network trouble; the failure is not fatal because pi retries at startup.
	if ! run pi update --extensions; then
		warn "package reconciliation failed (offline?); pi retries on next start"
	fi
else
	note "skipped: pi is not installed yet"
fi

# ---------------------------------------------------------- 4. git identity --

step "git identity and GitHub auth"
GIT_NAME="$(git config --global --get user.name || true)"
GIT_EMAIL="$(git config --global --get user.email || true)"
if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
	note "$GIT_NAME <$GIT_EMAIL>"
else
	warn "git identity is not set globally"
	note "  git config --global user.name mjmeijerman"
	note "  git config --global user.email <your-email>"
fi
if have gh; then
	if gh auth status >/dev/null 2>&1; then
		note "gh: authenticated as $(gh api user -q .login 2>/dev/null || echo unknown)"
	else
		warn "gh is not authenticated"
		note "  gh auth login"
	fi
else
	note "gh not installed — the PR workflow and merge-guard need it"
fi

# ------------------------------------------------------ 5. local model (opt) --

step "local model for the local_llm tool (optional)"
if ! have ollama; then
	note "ollama is not installed — install it from ollama.com, then re-run with --with-ollama"
elif run curl -sf http://localhost:11434/v1/models >/dev/null 2>&1; then
	note "ollama endpoint is up"
	if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$LOCAL_MODEL"; then
		note "$LOCAL_MODEL already pulled"
	elif [ "$WITH_OLLAMA" = 1 ] || ask "pull $LOCAL_MODEL now (~17 GB)?"; then
		run ollama pull "$LOCAL_MODEL"
	else
		note "skipped — /local will fail until: ollama pull $LOCAL_MODEL"
	fi
else
	note "ollama is installed but not running — start it with: ollama serve"
fi

# ----------------------------------------------------------- 6. dictation ----

step "dictation virtualenv (optional)"
DICT_DIR="$AGENT_DIR/dictation"
if [ ! -f "$DICT_DIR/requirements.lock" ]; then
	note "no requirements.lock — dictation extension will report itself unavailable"
elif [ -x "$DICT_DIR/venv/bin/python" ]; then
	note "venv already exists: $DICT_DIR/venv"
elif [ "$WITH_DICTATION" = 1 ] || ask "build the faster-whisper venv now (~2.5 GB of wheels)?"; then
	PY_MINOR="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "?")"
	if [ "$PY_MINOR" != "3.13" ]; then
		warn "dictation/bin/whisper-py hardcodes the python3.13 site-packages path; you have $PY_MINOR"
	fi
	run python3 -m venv "$DICT_DIR/venv" || warn "venv creation failed (need python3-venv)"
	if [ -x "$DICT_DIR/venv/bin/pip" ]; then
		run "$DICT_DIR/venv/bin/pip" install --quiet --upgrade pip
		run "$DICT_DIR/venv/bin/pip" install --quiet -r "$DICT_DIR/requirements.lock" ||
			warn "pip install failed; dictation stays disabled"
	fi
else
	note "skipped — re-run with --with-dictation to build it"
fi

# --------------------------------------------------------------- 7. herdr ----

step "herdr (optional, for parallel panes)"
if have herdr; then
	note "herdr $(herdr --version 2>/dev/null | head -1)"
	CONF="$HOME/.config/herdr/config.toml"
	if [ ! -f "$CONF" ]; then
		run mkdir -p "$(dirname "$CONF")"
		if [ "$DRY_RUN" = 0 ]; then
			printf 'onboarding = false\n' >"$CONF"
			note "wrote $CONF (skips first-run onboarding)"
		else
			note "[dry-run] would write $CONF (skips first-run onboarding)"
		fi
	fi
	note "agent panes: $PI_HOME/scripts/agent-pane.sh list"
	note "prs mod: $HOME/.config/herdr-app/mods/prs — put it in a space with: herdr-app do tab.new --mod prs"
else
	note "herdr is not installed — scripts/agent-pane.sh and the herdr extension stay idle"
	note "install it with herdr's own installer; the harness only needs it on PATH"
fi

# --------------------------------------------------------- 8. verification ----

if [ "$DO_VERIFY" = 1 ]; then
	step "verification"
	count_dir() { [ -d "$1" ] && find "$1" -maxdepth 1 -mindepth 1 -type d | wc -l || echo 0; }
	note "skills      : $(count_dir "$AGENT_DIR/skills")"
	note "extensions  : $(find "$AGENT_DIR/extensions" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l)"
	note "hooksPath   : $(git config --global --get core.hooksPath || echo MISSING)"
	note "excludesFile: $(git config --global --get core.excludesFile || echo MISSING)"
	note "templateDir : $(git config --global --get init.templateDir || echo MISSING)"
	note "vuln-scan   : $(command -v git-vuln-scan || echo MISSING)"
	note "pisandbox   : $(command -v pisandbox || echo MISSING)"
	note "sandbox     : $PI_HOME/sandbox/pi-sandbox.sh $([ -x "$PI_HOME/sandbox/pi-sandbox.sh" ] && echo present || echo MISSING)"
	# Report-only: the harness check is a ratchet, not a gate on the install.
	if [ -x "$PI_HOME/scripts/harness-check.sh" ]; then
		HARNESS_OUT=$(bash "$PI_HOME/scripts/harness-check.sh" 2>&1 || true)
		note "harness-chk : $(printf '%s\n' "$HARNESS_OUT" | grep -E '^[0-9]+ passed' || echo 'could not run')"
	fi
	note "scripts     : $PI_HOME/scripts/agent-pane.sh $([ -x "$PI_HOME/scripts/agent-pane.sh" ] && echo present || echo MISSING)"
	note "api key     : $KEY_FILE $([ -s "$KEY_FILE" ] && echo present || echo MISSING)"
	if have pi; then
		note "pi          : $(pi --version 2>/dev/null | head -1)"
	fi
	if have bwrap && [ "$DRY_RUN" = 0 ]; then
		if bash "$PI_HOME/sandbox/selftest.sh" >/tmp/pi-sandbox-selftest.$$ 2>&1; then
			note "sandbox selftest: PASS"
		else
			warn "sandbox selftest FAILED — see /tmp/pi-sandbox-selftest.$$"
		fi
	fi
	if [ "$DRY_RUN" = 0 ] && [ -d "$AGENT_DIR/extensions/__tests__" ]; then
		if (cd "$AGENT_DIR" && npm test >/tmp/pi-ext-tests.$$ 2>&1); then
			note "extension tests: PASS ($(sed -n 's/^ℹ tests \([0-9]*\).*/\1/p' /tmp/pi-ext-tests.$$ | head -1) tests, $(sed -n 's/^ℹ fail \([0-9]*\).*/\1/p' /tmp/pi-ext-tests.$$ | head -1) failing)"
		else
			warn "extension tests FAILED — see /tmp/pi-ext-tests.$$"
		fi
	fi
fi

# ---------------------------------------------------------------- summary ----

step "done"
cat <<EOF
   Config, hooks and sandbox live under $PI_HOME.
   Start pi in a project directory:  cd ~/some-repo && pi

   Still manual, by design (they are per-machine identities, not config):
     git config --global user.name / user.email   (above if missing)
     gh auth login                                (above if missing)
     pi auth                                      (any provider besides DeepSeek)

   Useful first checks inside pi:
     /secretguard status     protection active
     /local                  local model reachable (if you pulled it)
     /retro                  harness feedback so far
EOF
