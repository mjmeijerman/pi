#!/usr/bin/env bash
# ============================================================================
# harness-check.sh — the playbook's willpower rules, turned into checks.
#
# Radar basis: #1 agent sandboxing (Adopt), #11 feedback flywheel, #25 agent
# suggestion box, #29 harness quality evaluation, #36 agent instruction bloat,
# #39 documentation sprawl, #99 Safe Chain. Added by the 2026-11 audit:
# #16 open-weight models, #19 small language models, #30 local coding models,
# #40 blanket frontier model usage (a cheap default route is the point).
#
# radar-blip-valid holds this file to its own rule: a cited blip must exist in
# docs/radar-blips.tsv, so a fabricated number fails instead of reading well.
#
# The rule this file enforces on itself: anything a script can check must not
# be a paragraph in AGENTS.md. Read-only — no writes, no network — with two
# exceptions, both named so they cannot hide and both offline: --write-skills-lock
# regenerates agent/skills.lock, --write-packages-lock regenerates
# agent/packages.lock, and each touches that one path and nothing else.
#
# Usage:
#   scripts/harness-check.sh              # every check, one line each
#   scripts/harness-check.sh --quick      # budgets only (<1 s), used by the hook
#   scripts/harness-check.sh --json       # same checks, one JSON document
#   scripts/harness-check.sh --root DIR   # check DIR instead of this repo
#   scripts/harness-check.sh --verify-release-age
#                                         # only the npm quarantine gate. The
#                                         # sandbox forwards the setting as
#                                         # NPM_CONFIG_MIN_RELEASE_AGE; a bare run
#                                         # is the fallback when it cannot
#   scripts/harness-check.sh --verify-config
#                                         # only the config-file shapes (blip 102)
#   scripts/harness-check.sh --verify-spec-deltas
#                                         # only the spec-delta rule, for tests
#   scripts/harness-check.sh --write-skills-lock
#                                         # regenerate agent/skills.lock — the
#                                         # only mode here that writes it
#   scripts/harness-check.sh --verify-skills-lock
#                                         # only the skill pin check, for tests
#   scripts/harness-check.sh --write-packages-lock
#                                         # regenerate agent/packages.lock from
#                                         # what is installed; offline
#   scripts/harness-check.sh --verify-packages-lock
#                                         # only the package pin check, for tests
#   scripts/harness-check.sh --verify-doc-facts
#                                         # only the transport table check, for
#                                         # tests and for one honest line
#   scripts/harness-check.sh --verify-mise-pins
#                                         # only the mise.toml projections, for tests
#   scripts/harness-check.sh --help
#
# Exit 0 when nothing FAILs (a baselined violation reports WARN), 1 on any FAIL.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The checkout this script runs from, kept apart from $ROOT: a --root DIR run
# checks DIR's config files, but the shapes still come from here.
HARNESS_ROOT="$ROOT"
JSON=0
QUICK=0
VERIFY_RELEASE_AGE=0
VERIFY_CONFIG=0
VERIFY_DOC_FACTS=0
VERIFY_SPEC_DELTAS=0
WRITE_SKILLS_LOCK=0
VERIFY_SKILLS_LOCK=0
WRITE_PACKAGES_LOCK=0
VERIFY_PACKAGES_LOCK=0
VERIFY_MISE_PINS=0

PASS_N=0
WARN_N=0
FAIL_N=0
JSON_ITEMS=()
BASELINE_KEYS=""
BASELINE_HITS=""

AGENTS_MD_LIMIT=3072
SKILL_LINES_LIMIT=150
# npm 11 reads a bare min-release-age as DAYS, not minutes: @npmcli/config sets
# `before = new Date(Date.now() - 86400000 * value)` and documents the hint as
# `<days>`. 2 days = the playbook's 48-hour quarantine. 1440 here would mean
# four years (blip 99).
MIN_RELEASE_AGE=2
# Promptfoo grades the model, not the files, so nothing else notices when the suite
# stops running. `make evals` writes agent/evals/last-run.txt; older than this many
# days is a WARN, not a FAIL, because the run is advisory (blip 29, blip 110).
EVAL_MAX_AGE_DAYS=14
# The suggestion box is only useful if something reads it. `/retro` ran only when a
# person typed it, so the log grew unread (blips 25 and 11). `make retro` writes
# agent/retro/last-run.txt weekly from systemd/pi-retro.timer; older than this many days
# is a WARN, same as the evals, because the digest is advisory.
RETRO_MAX_AGE_DAYS=14
# `agent/prompts/learn.md` ends with a hard rule: a `learn/*` branch with no pull
# request is an unfinished run. Nothing read that rule, so on 2026-11-15 three
# branches (learn/learn-11-19, learn/learn-11-51, learn/learn-12-07) sat with one
# commit each and no PR while every learner reported a green harness check. The
# grace period keeps a learner's own fresh branch out of its own run (blip 11).
LEARN_BRANCH_GRACE_MIN="${PI_LEARN_BRANCH_GRACE_MIN:-60}"

# The help text is the header itself, to the closing rule: a fixed line range
# silently truncated it the moment a usage line was added above it.
usage() {
	awk 'NR > 2 && /^# ======/ { exit } NR > 2' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}
die() {
	printf 'harness-check: %s\n' "$*" >&2
	exit 2
}
section() { [ "$JSON" = 1 ] || printf '\n== %s ==\n' "$*"; }

# JSON strings here only ever carry paths and short messages: escape the two
# characters that would break a JSON string.
json_escape() {
	local s=$1
	s=${s//\\/\\\\}
	s=${s//\"/\\\"}
	printf '%s' "$s"
}

record() { # status check path message
	local status=$1 check=$2 path=$3 msg=$4
	case "$status" in
	PASS) PASS_N=$((PASS_N + 1)) ;;
	WARN) WARN_N=$((WARN_N + 1)) ;;
	FAIL) FAIL_N=$((FAIL_N + 1)) ;;
	esac
	JSON_ITEMS+=("$(printf '{"check":"%s","path":"%s","status":"%s","message":"%s"}' \
		"$(json_escape "$check")" "$(json_escape "$path")" \
		"$(json_escape "$status")" "$(json_escape "$msg")")")
	if [ "$JSON" = 1 ]; then
		return 0
	fi
	printf '%-4s %-24s %-52s %s\n' "$status" "$check" "$path" "$msg"
}

# --- baseline: a ratchet that can only shrink -------------------------------
# One `path:check` per line, `#` starts a comment. A violation listed here is
# reported as WARN instead of FAIL, so new violations cannot land while old
# ones are being paid off. Delete the line when the violation is gone.
load_baseline() {
	local file="$ROOT/scripts/harness-baseline.txt"
	[ -f "$file" ] || return 0
	BASELINE_KEYS="$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$file" | grep -v '^$' || true)"
}

baselined() { # path check
	[ -n "$BASELINE_KEYS" ] || return 1
	printf '%s\n' "$BASELINE_KEYS" | grep -qxF -e "$1:$2" || return 1
	# Remember that this entry still pays for itself, so check_stale_baseline
	# can point at the ones that do not.
	BASELINE_HITS="${BASELINE_HITS}$1:$2"$'\n'
	return 0
}

# Every baseline line that suppressed nothing this run is stale: the violation
# it was written for is gone, so the ratchet is looser than it needs to be.
# Loud, never fatal — a stale line only asks for a deletion.
check_stale_baseline() {
	local key
	[ -n "$BASELINE_KEYS" ] || return 0
	while IFS= read -r key; do
		[ -n "$key" ] || continue
		case $'\n'"${BASELINE_HITS}" in
		*$'\n'"${key}"$'\n'*) continue ;;
		esac
		record WARN stale-baseline "$key" \
			"no longer violates anything — delete this line, the ratchet only shrinks"
	done <<<"${BASELINE_KEYS}"
}

verdict() { # check path ok message   (ok: 1 pass, 0 violation)
	local check=$1 path=$2 ok=$3 msg=$4
	if [ "$ok" = 1 ]; then
		record PASS "$check" "$path" "$msg"
	elif baselined "$path" "$check"; then
		record WARN "$check" "$path" "$msg (baselined, see scripts/harness-baseline.txt)"
	else
		record FAIL "$check" "$path" "$msg"
	fi
}

# ------------------------------------------------------------------ budgets --

check_agents_md() {
	local file="$ROOT/agent/AGENTS.md" bytes
	if [ ! -f "$file" ]; then
		verdict agents-md-size agent/AGENTS.md 0 "missing"
		return
	fi
	bytes=$(wc -c <"$file" | tr -d '[:space:]')
	verdict agents-md-size agent/AGENTS.md \
		"$([ "$bytes" -le "$AGENTS_MD_LIMIT" ] && echo 1 || echo 0)" \
		"$bytes B / $AGENTS_MD_LIMIT B"
}

check_skill_lines() {
	local files=() file lines
	shopt -s nullglob
	files=("$ROOT"/agent/skills/*/SKILL.md)
	shopt -u nullglob
	if [ "${#files[@]}" -eq 0 ]; then
		if [ -d "$ROOT/agent/skills" ]; then
			verdict skill-lines - 0 "agent/skills exists but holds no SKILL.md"
		else
			verdict skill-lines - 1 "no skills directory (not a harness checkout)"
		fi
		return
	fi
	for file in "${files[@]}"; do
		lines=$(wc -l <"$file" | tr -d '[:space:]')
		verdict skill-lines "${file#"$ROOT"/}" \
			"$([ "$lines" -le "$SKILL_LINES_LIMIT" ] && echo 1 || echo 0)" \
			"$lines lines / $SKILL_LINES_LIMIT"
	done
}

# -------------------------------------------------------------- skills lock --
# A skill arrives from somewhere else — a marketplace, a copy-paste, another
# agent's output — and until now nothing pinned it: the file could change under
# the harness and no diff would say so (blip #72 agent package manager, blip #7
# plugin marketplace). agent/skills.lock is the pin: one line per file a skill
# loads, the sha256 of its content, and the commit that last touched it.
#
# The hash is the gate; the commit column is provenance for the reader. Checking
# the commit too would turn a rebase or a squash merge red for a file whose bytes
# never changed, which teaches people to regenerate without reading.
SKILLS_LOCK_REL="agent/skills.lock"
LOCK_REGEN="bash scripts/harness-check.sh --write-skills-lock"

sha256_of() { # path -> hex digest
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

last_commit_of() { # repo-relative path -> 12-char commit, or '-' outside git
	local sha
	sha=$(git -C "$ROOT" log -1 --format=%H -- "$1" 2>/dev/null | head -1)
	if [ -z "$sha" ]; then
		printf '%s' '-'
	else
		printf '%s' "${sha:0:12}"
	fi
}

skills_lock_target() { # every file a skill loads, repo-relative, one per line
	local skill dir token raw rel
	shopt -s nullglob
	for skill in "$ROOT"/agent/skills/*/SKILL.md; do
		rel="${skill#"$ROOT"/}"
		printf '%s\n' "$rel"
		dir=$(dirname "$skill")
		# A reference is any token in SKILL.md that names a real file in the
		# skill's own directory: `references/sources.md` as a path, or
		# `clubs-achterhoek.tsv` as a bare name. Tokens that resolve to nothing —
		# URLs, WORK/repo, prose like tests/lint — are not references, so no list
		# of references has to be maintained by hand, and a newly referenced file
		# is locked by the next regenerate instead of being forgotten.
		while IFS= read -r raw; do
			[ -n "$raw" ] || continue
			# A token at the end of a sentence carries the full stop with it
			# (`clubs.tsv.`); the file name does not.
			token=$(printf '%s' "$raw" | sed 's/[.-]*$//')
			[ -n "$token" ] || continue
			[ -f "$dir/$token" ] || continue
			printf '%s\n' "${dir#"$ROOT"/}/$token"
		done < <(grep -oE '[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*' "$skill" | sort -u)
	done
	shopt -u nullglob
}

write_skills_lock() {
	local lock="$ROOT/$SKILLS_LOCK_REL" tmp rel count
	if [ ! -d "$ROOT/agent/skills" ]; then
		die "no agent/skills directory in $ROOT — nothing to lock"
	fi
	mkdir -p "$(dirname "$lock")" || die "cannot create $(dirname "$lock")"
	tmp=$(mktemp) || die "cannot create a temporary file"
	{
		printf '%s\n' \
			'# agent/skills.lock — what each skill loads, pinned by content.' \
			'# Generated, never hand-edited: bash scripts/harness-check.sh --write-skills-lock' \
			'# Verified by: bash scripts/harness-check.sh (FAIL on a changed sha256, on a' \
			'# skill file with no entry, and on an entry whose file is gone).' \
			'# Fields, tab-separated: sha256, commit that last touched the file' \
			'# (provenance only, - outside git), path. Radar: #72 agent package manager,' \
			'# #7 plugin marketplace — a skill from elsewhere is pinned like a dependency.'
		while IFS= read -r rel; do
			[ -n "$rel" ] || continue
			printf '%s\t%s\t%s\n' "$(sha256_of "$ROOT/$rel")" "$(last_commit_of "$rel")" "$rel"
		done < <(skills_lock_target | sort -u)
	} >"$tmp"
	# A failed mv used to leave the old lock in place and still print "N entries
	# written": a write that did not happen, reported as one that did.
	if [ -d "$lock" ]; then
		rm -f -- "$tmp"
		die "cannot write $lock: the path is a directory, not the lock file"
	fi
	mv "$tmp" "$lock" || die "cannot write $lock (the new table is still in $tmp)"
	count=$(grep -vc '^#' "$lock" || true)
	printf '%s: %s entries written\n' "$SKILLS_LOCK_REL" "$count"
	if [ -d "$ROOT/agent/skills" ] && [ "$count" -eq 0 ]; then
		printf 'harness-check: no files under agent/skills were locked — is this a harness checkout?\n' >&2
		return 1
	fi
	return 0
}

check_skills_lock() {
	local lock="$ROOT/$SKILLS_LOCK_REL" digest commit path rel count=0 bad=0 actual
	declare -A LOCKED=()
	if [ ! -d "$ROOT/agent/skills" ]; then
		verdict skills-lock - 1 "no skills directory (not a harness checkout)"
		return 0
	fi
	if [ ! -f "$lock" ]; then
		verdict skills-lock "$SKILLS_LOCK_REL" 0 \
			"missing — skills are unpinned; generate it: $LOCK_REGEN"
		return 0
	fi
	# Entries first: a changed hash or a deleted file is the loud case, and the
	# message carries the exact command that fixes it.
	while IFS=$'\t' read -r digest commit path; do
		case "$path" in '' | '#'*) continue ;; esac
		LOCKED["$path"]=$digest
		count=$((count + 1))
		if [ ! -f "$ROOT/$path" ]; then
			verdict skills-lock "$path" 0 \
				"locked file is gone (locked as ${digest:0:12}…, commit ${commit}) — restore it or regenerate: $LOCK_REGEN"
			bad=$((bad + 1))
			continue
		fi
		actual=$(sha256_of "$ROOT/$path")
		if [ "$actual" != "$digest" ]; then
			verdict skills-lock "$path" 0 \
				"sha256 ${actual:0:12}… on disk, ${digest:0:12}… in the lock — read the diff first, then regenerate: $LOCK_REGEN"
			bad=$((bad + 1))
		fi
	done <"$lock"
	if [ "$count" -eq 0 ]; then
		verdict skills-lock "$SKILLS_LOCK_REL" 0 "holds no entries — regenerate: $LOCK_REGEN"
		return 0
	fi
	# A skill file with no entry is the same failure from the other side: nothing
	# pins it, so a change to it would never be compared against anything.
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		if [ -z "${LOCKED[$rel]:-}" ]; then
			verdict skills-lock "$rel" 0 \
				"no lock entry — a skill file nothing pins; regenerate: $LOCK_REGEN"
			bad=$((bad + 1))
		fi
	done < <(skills_lock_target | sort -u)
	if [ "$bad" -eq 0 ]; then
		verdict skills-lock "$SKILLS_LOCK_REL" 1 "$count file(s) match their locked sha256"
	fi
	return 0
}

# ----------------------------------------------------------- packages lock --
# A package in `agent/settings.json` `packages` arrives by URL or branch: pi clones
# the default branch and installs whatever it points at that day, so a branch that
# moves changes the code this harness runs and no diff anywhere says so (blip #72
# agent package manager, blip #7 plugin marketplace, blip #17 review tier). Every
# other pin in this repo names a version or a hash; a package named none.
# agent/packages.lock is the pin: one line per package — the source exactly as
# settings.json writes it, git|npm, the commit sha (git) or version (npm) that is
# installed, npm's tarball integrity, where it is installed, and the date the line
# was written.
#
# Resolution reads the installed copy, not the network: `git rev-parse HEAD` in
# agent/git/<host>/<owner>/<repo>, and the version plus package-lock integrity of
# agent/npm/node_modules/<name>. That is what "actually installed" means, and it is
# why --write-packages-lock runs offline and why the lock is committed instead of
# generated in CI. Those trees are gitignored (.gitignore: agent/git/, agent/npm/),
# so a run from a worktree resolves against the pi home — $PI_AGENT_HOME, else
# ~/.pi/agent — and the lock's `where` column stays repo-relative for the reader.
#
# The one question that needs the network is whether the upstream head moved since
# the line was written: `git ls-remote <url> HEAD`, `npm view <pkg> version`. That
# is a WARN naming the command, never a FAIL: an offline run must stay green, and a
# FAIL nobody can reproduce offline is a FAIL somebody baselines away.
PACKAGES_LOCK_REL="agent/packages.lock"
PACKAGES_LOCK_REGEN="bash scripts/harness-check.sh --write-packages-lock"

packages_home() { # where pi installs packages — the agent directory
	printf '%s' "${PI_AGENT_HOME:-${HOME:-/nonexistent}/.pi/agent}"
}

settings_packages() { # every source named in agent/settings.json, one per line
	local file="$ROOT/agent/settings.json"
	[ -f "$file" ] || return 0
	if command -v node >/dev/null 2>&1; then
		node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch(e){process.exit(1)};if(!v||!Array.isArray(v.packages))return;for(const p of v.packages)console.log(String(p))})' \
			<"$file" 2>/dev/null
		return 0
	fi
	# No node (jq is not assumed): the packages array as written. A miss here is
	# loud in the check, not silent — a source settings.json names and the lock
	# does not is a FAIL.
	sed -n '/"packages"[[:space:]]*:[[:space:]]*\[/,/\]/p' "$file" |
		sed -n 's/^[[:space:]]*"\([^"]*\)"[,]*[[:space:]]*$/\1/p'
}

package_kind() { # source -> git | npm | unknown
	case $1 in
	npm:*) printf 'npm' ;;
	git:* | https://* | http://* | git@* | ssh://*) printf 'git' ;;
	*) printf 'unknown' ;;
	esac
}

package_url() { # git source -> what git ls-remote would be given
	local src=${1#git:}
	case $src in
	git@* | ssh://* | https://* | http://*) printf '%s' "$src" ;;
	*) printf 'https://%s' "$src" ;;
	esac
}

package_where() { # source -> install path, repo-relative
	local src=$1 url
	case $(package_kind "$src") in
	npm) printf 'agent/npm/node_modules/%s' "${src#npm:}" ;;
	git)
		url=$(package_url "$src")
		url=${url%.git}
		url=${url#https://}
		url=${url#http://}
		url=${url#ssh://}
		url=${url#git@}
		url=${url/:/\/}
		printf 'agent/git/%s' "$url"
		;;
	*) printf -- '-' ;;
	esac
}

package_install_dir() { # source -> absolute install directory
	local where
	where=$(package_where "$1")
	[ "$where" = '-' ] && return 0
	printf '%s/%s' "$(packages_home)" "${where#agent/}"
}

installed_pin() { # source -> sha (git) or version (npm) installed here, empty if none
	local src=$1 dir
	dir=$(package_install_dir "$src")
	[ -n "$dir" ] || return 0
	case $(package_kind "$src") in
	git)
		[ -d "$dir/.git" ] || return 0
		git -C "$dir" rev-parse HEAD 2>/dev/null | head -1
		;;
	npm)
		[ -f "$dir/package.json" ] || return 0
		# The version as installed. Two readings because package.json is written
		# both pretty and compact, and a miss here would silently look like "not
		# installed" instead of "unreadable".
		{
			sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/package.json" |
				head -1
			grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$dir/package.json" |
				head -1 | sed 's/.*"\([^"]*\)"$/\1/'
		} | head -1
		;;
	esac
}

installed_digest() { # source -> npm tarball integrity, '-' for git or when unrecorded
	local src=$1 name lock
	[ "$(package_kind "$src")" = npm ] || {
		printf -- '-'
		return 0
	}
	name=${src#npm:}
	lock="$(packages_home)/npm/package-lock.json"
	[ -f "$lock" ] || {
		printf -- '-'
		return 0
	}
	if command -v node >/dev/null 2>&1; then
		node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=process.argv[1];let v;try{v=JSON.parse(s)}catch(e){process.exit(0)};const p=(v.packages||{})["node_modules/"+k];if(p&&p.integrity)process.stdout.write(String(p.integrity))})' \
			"$name" <"$lock" 2>/dev/null
		return 0
	fi
	awk -v key="\"node_modules/$name\":" 'index($0, key) { f = 1; next } f && /"integrity"/ { print; exit }' "$lock" |
		sed -n 's/.*"integrity"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

package_head_check() { # source -> the command that answers "did upstream move?"
	case $(package_kind "$1") in
	git) printf 'git ls-remote %s HEAD' "$(package_url "$1")" ;;
	npm) printf 'npm view %s version' "${1#npm:}" ;;
	*) printf -- '-' ;;
	esac
}

write_packages_lock() {
	local lock="$ROOT/$PACKAGES_LOCK_REL" tmp src count=0
	local -a sources=() missing=()
	mapfile -t sources < <(settings_packages)
	for src in "${sources[@]}"; do
		[ -n "$src" ] || continue
		# A pin of "-" pins nothing and would overwrite a sha with a blank: refuse
		# the write instead of recording a package nobody resolved.
		if [ -z "$(installed_pin "$src")" ]; then
			missing+=("$src")
		fi
	done
	if [ "${#missing[@]}" -gt 0 ]; then
		die "nothing installed to pin for: ${missing[*]} — reconcile the packages first (pi install <source>, or pi update --extensions for all of them, on the host), then run this again: the lock would otherwise record a blank where a sha belongs"
	fi
	mkdir -p "$(dirname "$lock")" || die "cannot create $(dirname "$lock")"
	tmp=$(mktemp) || die "cannot create a temporary file"
	{
		printf '%s\n' \
			'# agent/packages.lock — what each package in agent/settings.json installs.' \
			'# Generated, never hand-edited: bash scripts/harness-check.sh --write-packages-lock' \
			'# Verified by: bash scripts/harness-check.sh (FAIL on a missing lock, on an' \
			'# installed sha or version that differs from the pin, on a package' \
			'# settings.json names with no entry, and on an entry settings.json dropped).' \
			'# The upstream head needs the network, so it is a WARN naming git ls-remote,' \
			'# never a FAIL. Fields, tab-separated: source (as written in settings.json),' \
			'# kind, pin (commit sha for git, version for npm), integrity (npm tarball' \
			'# hash, - for git), where it is installed, date resolved (UTC). Radar: #72' \
			'# agent package manager, #7 plugin marketplace — a package from elsewhere is' \
			'# pinned like a dependency.'
		while IFS= read -r src; do
			[ -n "$src" ] || continue
			printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
				"$src" "$(package_kind "$src")" "$(installed_pin "$src")" \
				"$(installed_digest "$src")" "$(package_where "$src")" "$(date -u +%F)"
			count=$((count + 1))
		done < <(settings_packages)
	} >"$tmp"
	if [ -d "$lock" ]; then
		rm -f -- "$tmp"
		die "cannot write $lock: the path is a directory, not the lock file"
	fi
	mv "$tmp" "$lock" || die "cannot write $lock (the new table is still in $tmp)"
	printf '%s: %s entries written\n' "$PACKAGES_LOCK_REL" "$count"
	if [ "$count" -eq 0 ]; then
		printf 'harness-check: agent/settings.json names no package — nothing was locked\n' >&2
		return 1
	fi
	return 0
}

check_packages_lock() {
	local lock="$ROOT/$PACKAGES_LOCK_REL" src pin pin_now head_cmd='' count=0 bad=0
	declare -A NAMED=() LOCKED=()
	local -a sources=()
	mapfile -t sources < <(settings_packages)
	if [ "${#sources[@]}" -eq 0 ]; then
		verdict packages-lock agent/settings.json 1 \
			"names no package — nothing to pin (not a harness checkout?)"
		return 0
	fi
	if [ ! -f "$lock" ]; then
		verdict packages-lock "$PACKAGES_LOCK_REL" 0 \
			"missing — ${#sources[@]} package(s) are unpinned; generate it: $PACKAGES_LOCK_REGEN"
		return 0
	fi
	while IFS=$'\t' read -r src _ _ _ _ _; do
		case "$src" in '' | '#'*) continue ;; esac
		count=$((count + 1))
	done <"$lock"
	if [ "$count" -eq 0 ]; then
		verdict packages-lock "$PACKAGES_LOCK_REL" 0 "holds no entries — regenerate: $PACKAGES_LOCK_REGEN"
		return 0
	fi
	while IFS=$'\t' read -r src _ pin _ _ _; do
		case "$src" in '' | '#'*) continue ;; esac
		LOCKED["$src"]=$pin
	done <"$lock"
	# One side: every source settings.json names is pinned, and the pin is still
	# what is installed. A reinstall after the branch moved is the silent change
	# this row exists for, and it lands here as a FAIL naming both sides.
	for src in "${sources[@]}"; do
		[ -n "$src" ] || continue
		NAMED["$src"]=1
		if [ -z "${LOCKED[$src]+set}" ]; then
			verdict packages-lock "$src" 0 \
				"no lock entry — a package nothing pins; regenerate: $PACKAGES_LOCK_REGEN"
			bad=$((bad + 1))
			continue
		fi
		pin=${LOCKED[$src]}
		if [ -z "$pin" ] || [ "$pin" = '-' ]; then
			verdict packages-lock "$src" 0 \
				"no pin recorded (the lock has '-' where a sha belongs) — install it, then regenerate: $PACKAGES_LOCK_REGEN"
			bad=$((bad + 1))
			continue
		fi
		head_cmd=${head_cmd:-$(package_head_check "$src")}
		pin_now=$(installed_pin "$src")
		if [ -z "$pin_now" ]; then
			record WARN packages-lock "$(package_where "$src")" \
				"not installed here, so ${pin:0:12}… was not compared — install it, or answer the upstream question: $(package_head_check "$src")"
			continue
		fi
		if [ "$pin_now" != "$pin" ]; then
			verdict packages-lock "$src" 0 \
				"installed ${pin_now:0:12}… but the lock pins ${pin:0:12}… — read the diff first, then regenerate: $PACKAGES_LOCK_REGEN"
			bad=$((bad + 1))
		fi
	done
	# Other side: an entry settings.json no longer names is a package the harness
	# stops loading, and a lock that still calls it installed is a claim nobody
	# checked. Same rule as the skill pin's deleted-file case.
	while IFS=$'\t' read -r src _ _ _ _ _; do
		case "$src" in '' | '#'*) continue ;; esac
		[ -n "${NAMED[$src]:-}" ] && continue
		verdict packages-lock "$PACKAGES_LOCK_REL" 0 \
			"$src is locked but agent/settings.json no longer names it — regenerate: $PACKAGES_LOCK_REGEN"
		bad=$((bad + 1))
	done <"$lock"
	if [ "$bad" -eq 0 ]; then
		verdict packages-lock "$PACKAGES_LOCK_REL" 1 \
			"$count package(s) match their locked pin; the upstream head is a network question: ${head_cmd:-no package to check}"
	fi
	return 0
}

# ---------------------------------------------------------------- doc facts --
# A doc that named the wrong transport used to be found by a person reading:
# agent/skills/jev/SKILL.md and agent/AGENTS.md described jev as a local ollama
# model for as long as the code said TypeSafe, because nothing compared prose to
# code (blip 36: check the text, not just the code; blip 62: the harness depends
# on a remote model, so its docs must say so).
#
# scripts/doc-facts.txt is the table: subject, the transport it must be described
# with, the transport it must not be, the files that talk about it, and the
# module the fact was read from. Two questions per row:
#   does one sentence put the subject and the forbidden transport in one clause?
#   does a file that talks about the subject ever name the right transport?
# Matching is per sentence, not per file: `local-run` sits two sentences from a
# jev paragraph and is still correct. Within a sentence, `;`, a dash and
# `, and/but/while/whereas/yet/or` are clause boundaries, so a true sentence
# that contrasts the two transports is allowed and only a pairing is reported.
# The module is read as well (comments dropped): the table's claim came from it,
# so a transport that moves in code fails here the day it moves.
DOC_FACTS_REL="scripts/doc-facts.txt"
# Where bin/ modules live when they are not in this checkout: install.sh puts the
# delegation workspace at ~/big-boss-pi by default (PI_BOSS_DIR).
DOC_FACTS_BIN="${DOC_FACTS_BIN:-${PI_BOSS_DIR:-$HOME/big-boss-pi}/bin}"

doc_facts_word() { # subject -> the same pattern, whole word, not inside a path
	# `agent/skills/jev/SKILL.md` names a file, not the decision model: a mention
	# has to be a word of its own, or a path in another clause invents a pairing.
	printf '(^|[^[:alnum:]_/.-])(%s)([^[:alnum:]_/.-]|$)' "$1"
}

doc_facts_sentences() { # stdin -> one sentence per line
	sed -E 's/[.!?]+([[:space:]]|$)/\n/g'
}

doc_facts_clauses() { # stdin -> one clause per line
	sed -E 's/(;|—|–)/\n/g; s/,[[:space:]]+(and|but|while|whereas|yet|or)[[:space:]]+/\n/g'
}

doc_facts_code_file() { # module name -> path, empty status 1 when absent
	local name=$1 cand
	for cand in "$ROOT/bin/$name" "$ROOT/agent/bin/$name" "$DOC_FACTS_BIN/$name"; do
		[ -f "$cand" ] && {
			printf '%s' "$cand"
			return 0
		}
	done
	return 1
}

doc_facts_code_body() { # module -> code, comments dropped (a comment is not the endpoint)
	# `//` only starts a comment after whitespace: `https://api.typesafe.ai` is the
	# endpoint this whole check is about, not a remark about it.
	sed -E -e '/^[[:space:]]*(\*|\/\/|\/\*)/d' -e 's@(^|[[:space:]])//.*@@'
}

doc_facts_scan_file() { # file, subject regex, forbidden regex -> line<TAB>sentence per pairing
	local file=$1 subj_re=$2 forb=$3 hit text sentence clause low lowc
	while IFS= read -r hit; do
		text=${hit#*:}
		hit=${hit%%:*}
		while IFS= read -r sentence; do
			[ -n "${sentence//[[:space:]]/}" ] || continue
			low=$(printf '%s' "$sentence" | tr '[:upper:]' '[:lower:]')
			[[ $low =~ $forb ]] || continue
			[[ $low =~ $subj_re ]] || continue
			# Same sentence is not enough: the two transports are allowed to
			# share one when a clause boundary separates them. Only a pairing is a
			# fault, and the whole sentence is printed so it can be read in place.
			while IFS= read -r clause; do
				lowc=$(printf '%s' "$clause" | tr '[:upper:]' '[:lower:]')
				[[ $lowc =~ $forb && $lowc =~ $subj_re ]] || continue
				printf '%s\t%s\n' "$hit" "$sentence"
				break
			done < <(printf '%s\n' "$sentence" | doc_facts_clauses)
		done < <(printf '%s\n' "$text" | doc_facts_sentences)
	done < <(grep -niE -e "$subj_re" "$file")
}

check_doc_facts() {
	local table="$ROOT/$DOC_FACTS_REL" subj req forb files code label rows=0 checked=0 codeok=0 fails=0
	local file rel ln sentence module subj_re req_label forb_label
	local -a listed=()
	local -A GONE=()
	if [ ! -f "$table" ]; then
		if [ -f "$HARNESS_ROOT/$DOC_FACTS_REL" ]; then
			table="$HARNESS_ROOT/$DOC_FACTS_REL"
		else
			verdict doc-facts "$DOC_FACTS_REL" 0 \
				"missing — nothing says which transport serves which subject any more"
			return 0
		fi
	fi
	while IFS=$'\t' read -r subj req forb files code; do
		case "$subj" in '' | '#'*) continue ;; esac
		if [ -z "$req" ] || [ -z "$forb" ] || [ -z "$files" ]; then
			verdict doc-facts "$DOC_FACTS_REL" 0 \
				"incomplete row for '${subj:-?}' — 5 tab-separated fields: subject, must name, must not name, files, module"
			fails=$((fails + 1))
			continue
		fi
		rows=$((rows + 1))
		label=${subj//\\/}
		label=${label//|/, }
		req_label=${req//\\/}
		req_label=${req_label//|/, }
		forb_label=${forb//\\/}
		forb_label=${forb_label//|/, }
		subj_re=$(doc_facts_word "$subj")
		listed=()
		read -ra listed <<<"$files"
		for file in "${listed[@]}"; do
			if [ ! -f "$ROOT/$file" ]; then
				# Two rows may list the same file; a stale entry is one fault.
				if [ -z "${GONE[$file]:-}" ]; then
					GONE[$file]=1
					verdict doc-facts "$file" 0 \
						"listed in $DOC_FACTS_REL but missing — the table is stale, or the file was renamed"
					fails=$((fails + 1))
				fi
				continue
			fi
			# A file that never mentions the subject has nothing to say about its
			# transport, so it is not forced to name one; add it when it does.
			grep -qiE -e "$subj_re" "$ROOT/$file" || continue
			if ! grep -qiE -e "$req" "$ROOT/$file"; then
				verdict doc-facts "$file" 0 \
					"talks about $label and never names '$req_label' — the transport sentence is missing or names the wrong one"
				fails=$((fails + 1))
				continue
			fi
			checked=$((checked + 1))
			while IFS=$'\t' read -r ln sentence; do
				record FAIL doc-facts "$file:$ln" \
					"$label sits with '$forb_label' in one clause — the sentence: $sentence"
				fails=$((fails + 1))
			done < <(doc_facts_scan_file "$ROOT/$file" "$subj_re" "$forb")
		done
		if [ -n "$code" ]; then
			if module=$(doc_facts_code_file "$code"); then
				rel=${module#"$ROOT"/}
				if ! doc_facts_code_body <"$module" | grep -qiE -e "$req"; then
					verdict doc-facts "$rel" 0 \
						"no '$req' in the code — $DOC_FACTS_REL promises $label is served by it, and the module disagrees"
					fails=$((fails + 1))
				elif doc_facts_code_body <"$module" | grep -qiE -e "$forb"; then
					verdict doc-facts "$rel" 0 \
						"the code now names '$forb' — $label moved transport; fix the code or the table the same day"
					fails=$((fails + 1))
				else
					codeok=$((codeok + 1))
				fi
			else
				record WARN doc-facts "$code" \
					"not found here or in $DOC_FACTS_BIN — the row for $label was not checked against code"
			fi
		fi
	done < <(grep -v '^[[:space:]]*#' "$table")
	if [ "$rows" -eq 0 ] && [ "$fails" -eq 0 ]; then
		verdict doc-facts "$DOC_FACTS_REL" 0 "holds no subjects — the table exists and says nothing"
	elif [ "$fails" -eq 0 ] && [ "$checked" -eq 0 ]; then
		record WARN doc-facts "$DOC_FACTS_REL" \
			"$rows subject(s) in the table, none of them discussed in a listed file — nothing was compared"
	elif [ "$fails" -eq 0 ]; then
		verdict doc-facts "$DOC_FACTS_REL" 1 \
			"$rows subject(s), $checked file(s) checked, $codeok module(s) agree; no sentence names the wrong transport"
	fi
	return 0
}

# --------------------------------------------------------- the version file --
# Radar Vol. 35 blip 68 (mise, Adopt) and blip 38 (CI hardening). mise.toml is the
# single source for the node and npm majors this repo demands, and nothing in a
# workflow can read a TOML file: `actions/setup-node`'s `node-version-file`
# understands .nvmrc, .node-version and package.json, and a matrix cannot compute a
# value at all. So the pin is projected into `.node-version` (which the four
# setup-node steps read) and written out once more in test.yml's matrix and in the
# one global npm install. Each projection is compared to mise.toml here, so a bump
# that misses one is a FAIL instead of a pipeline that tests a version nobody meant.
# Empty output from mise_major means "missing, unreadable or silent" and every
# caller turns that into a loud FAIL: a fallback nobody sees is how a check stops
# checking, which is the rule the earlier mise pin was written to.
mise_major() { # tool -> major declared in mise.toml, or empty when there is none
	local file="$ROOT/mise.toml" raw=""
	[ -r "$file" ] || return 0
	# The same shape setup.sh reads, and sed for the same reason: a bare
	# `node = "24"` is the only form mise writes, so a TOML parser is a dependency
	# bought for four lines.
	raw=$(sed -n 's/^[[:space:]]*'"$1"'[[:space:]]*=[[:space:]]*["'"'"']\{0,1\}\([0-9][0-9.]*\).*/\1/p' "$file" 2>/dev/null | head -n 1 || true)
	printf '%s\n' "${raw%%.*}"
}

check_mise_pins() {
	local node_pin npm_pin file got hits nf_lines nf_count nf_bad nf_bad_why nf_ok row value where why
	local mise_path mise_ver mise_node
	node_pin=$(mise_major node)

	# 0. the tool that owns the pin, before any question about the pin itself.
	#    Blip 68 was adopted as a file and for two released pins `command -v mise`
	#    was empty on the machine — every row below happily compared mise.toml to
	#    .node-version while nothing anywhere could act on it. So this row asks
	#    the question the others assume.
	#    Three states, and the difference is the point: absent is a WARN, because a
	#    fresh clone is not a broken repo and CI has no mise either; a binary that
	#    is on PATH and cannot answer `--version` is a FAIL, because that install
	#    is broken; installed-but-no-pinned-tool is a FAIL too, because this host
	#    runs `mise install` and the pin is present here — a machine with the
	#    binary and not the tool has an install that stopped halfway, not a laptop
	#    that has not got round to it. That middle state was a WARN until the pin
	#    was actually installed; it is a FAIL from the moment the tool is there to
	#    miss, which is the only reading under which this row tells the truth in
	#    both directions.
	mise_path=$(command -v mise 2>/dev/null || true)
	if [ -z "$mise_path" ]; then
		record WARN mise-installed mise.toml \
			"mise is not on PATH — nothing on this machine installs mise.toml's pin; ./setup.sh installs the binary only, or: curl -fsSL https://mise.run | sh"
	else
		mise_ver=$(mise --version 2>/dev/null | head -n 1 || true)
		if [ -z "$mise_ver" ]; then
			verdict mise-installed mise.toml 0 \
				"mise at $mise_path answers no --version — that install is broken; reinstall: curl -fsSL https://mise.run | sh"
		else
			mise_node=$(cd "$ROOT" 2>/dev/null && mise which node 2>/dev/null | head -n 1 || true)
			if [ -z "$mise_node" ]; then
				verdict mise-installed mise.toml 0 \
					"$mise_ver at $mise_path resolves no node ${node_pin:-?} — this host installs mise.toml's pin, so the tool is missing and the install is half done: mise install (in the repo, once)"
			else
				verdict mise-installed mise.toml 1 \
					"$mise_ver at $mise_path resolves the pinned node ${node_pin:-?} to $mise_node"
			fi
		fi
	fi

	if [ -z "$node_pin" ]; then
		verdict mise-pin-node mise.toml 0 \
			"no node major — missing, unreadable, or has no node = \"NN\" line; .node-version and the CI matrix have no source"
		return
	fi

	# 1. the file the four setup-node steps read.
	file=".node-version"
	if [ ! -f "$ROOT/$file" ]; then
		verdict mise-pin-node-version "$file" 0 \
			"missing — actions/setup-node reads it in four jobs; write the pin: printf '%s\\n' $node_pin > .node-version"
	else
		got=$(sed -n '1s/^[[:space:]]*v\{0,1\}\([0-9][0-9.]*\).*/\1/p' "$ROOT/$file" 2>/dev/null)
		if [ "${got%%.*}" = "$node_pin" ]; then
			verdict mise-pin-node-version "$file" 1 "node $got, mise.toml pins $node_pin"
		else
			verdict mise-pin-node-version "$file" 0 \
				"node ${got:-unreadable} — mise.toml pins $node_pin; write the pin: printf '%s\\n' $node_pin > .node-version"
		fi
	fi

	# 2. the matrix in test.yml. YAML cannot read a file into a matrix and a job
	#    output would cost a second runner, so the first axis is a write-out —
	#    measured here rather than trusted. A missing line is a FAIL, not a pass:
	#    a pattern that stopped matching must not read as "nothing to compare".
	file=".github/workflows/test.yml"
	got=$(sed -n '/^[[:space:]]*node:[[:space:]]*\[/ {
		s/^[^[]*\[[[:space:]]*["'"'"']\{0,1\}\([0-9][0-9.]*\).*/\1/p
		q
	}' "$ROOT/$file" 2>/dev/null)
	if [ -z "$got" ]; then
		verdict mise-pin-matrix "$file" 0 \
			"no node: [\"NN\", ...] matrix line — the drift check would otherwise pass in silence"
	elif [ "${got%%.*}" = "$node_pin" ]; then
		verdict mise-pin-matrix "$file" 1 "first axis $got, mise.toml pins $node_pin"
	else
		verdict mise-pin-matrix "$file" 0 \
			"first axis $got — mise.toml pins $node_pin; the matrix is the one place YAML cannot derive, so it is checked here"
	fi

	# 3. and no workflow may go back to a literal, which is how the five copies
	#    this replaced came to exist. node-version-file is the only door.
	hits=$(grep -rnE "^[[:space:]]*node-version:[[:space:]]*[0-9\"']" "$ROOT/.github/workflows" 2>/dev/null | sed "s|^$ROOT/||" || true)
	if [ ! -d "$ROOT/.github/workflows" ]; then
		verdict mise-pin-workflows .github/workflows 0 \
			"missing — nothing here can prove a workflow does not restate the major"
	elif [ -z "$hits" ]; then
		verdict mise-pin-workflows .github/workflows 1 \
			"no workflow pins node with a literal; they all read node-version-file"
	else
		verdict mise-pin-workflows "$(printf '%s\n' "$hits" | head -n 1 | cut -d: -f1)" 0 \
			"$(printf '%s\n' "$hits" | wc -l | tr -d ' ') node-version literal(s) — read .node-version through node-version-file, so mise.toml stays the only source"
	fi

	# 3b. and the value has to work, not merely be present. setup-node resolves
	#     `node-version-file` against the workspace root and joins it
	#     unconditionally, so `${{ github.workspace }}/.node-version` becomes
	#     <root>/<root>/.node-version and the job dies before npm is installed —
	#     harness-check and mutation went red in 14 s and 7 s on exactly that.
	#     The row above counted the key and called it proof; mention is not
	#     resolution, which is the gap this row closes.
	nf_lines=$(grep -rn "^[[:space:]]*node-version-file:" "$ROOT/.github/workflows" 2>/dev/null | sed "s|^$ROOT/||" || true)
	nf_count=0
	nf_bad=""
	nf_bad_why=""
	nf_ok=""
	while IFS= read -r row; do
		[ -n "$row" ] || continue
		nf_count=$((nf_count + 1))
		value=${row#*node-version-file:}
		# The value, without its trailing comment, quotes or padding: a workflow may
		# write node-version-file: ".node-version"  # why.
		value=$(printf '%s' "$value" | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
		value=${value#\"}
		value=${value%\"}
		value=${value#\'}
		value=${value%\'}
		where=$(printf '%s\n' "$row" | cut -d: -f1)
		why=""
		case "$value" in
		/*) why="absolute ($value) — setup-node joins it onto the workspace root, so the path becomes <root>/<root>/$(basename "$value")" ;;
		*\${{*) why="an expression ($value) — github.workspace is already the root setup-node joins onto" ;;
		*..*) why="escapes the repo root ($value)" ;;
		'') why="empty — setup-node fails the job before npm runs" ;;
		*)
			if [ -f "$ROOT/$value" ]; then
				nf_ok="$nf_ok $value@$where"
			else
				why="no $value under the repo root — setup-node would fail the job"
			fi
			;;
		esac
		if [ -n "$why" ] && [ -z "$nf_bad" ]; then
			nf_bad="$where"
			nf_bad_why="$why"
		fi
	done < <(printf '%s\n' "$nf_lines")
	if [ "$nf_count" -eq 0 ]; then
		record WARN mise-pin-node-version-file .github/workflows \
			"no node-version-file: line anywhere — a job may take node from the matrix, but then nothing reads .node-version and this row compared nothing"
	elif [ -z "$nf_bad" ]; then
		verdict mise-pin-node-version-file .github/workflows 1 \
			"$nf_count value(s), each relative and resolving to a file at the repo root:$nf_ok"
	else
		verdict mise-pin-node-version-file "$nf_bad" 0 \
			"$nf_bad_why — write .node-version, relative, so setup-node's join lands on the repo root"
	fi

	# 4. the one global npm install (harness-check.yml), whose major must be the
	#    pinned one. An exact version, not a major, because that install replaces
	#    the npm that runs `npm ci` and is pinned on purpose (blip 99).
	npm_pin=$(mise_major npm)
	file=".github/workflows/harness-check.yml"
	got=$(sed -n 's/^.*npm install -g npm@\([0-9][0-9.]*\).*/\1/p' "$ROOT/$file" 2>/dev/null | head -n 1)
	if [ -z "$npm_pin" ]; then
		verdict mise-pin-npm mise.toml 0 \
			"no npm major — missing, unreadable, or has no npm = \"NN\" line; the CI install has no source"
	elif [ -z "$got" ]; then
		verdict mise-pin-npm "$file" 0 \
			"no npm install -g npm@X.Y.Z line — the drift check would otherwise pass in silence"
	elif [ "${got%%.*}" = "$npm_pin" ]; then
		verdict mise-pin-npm "$file" 1 "npm $got, mise.toml pins $npm_pin"
	else
		verdict mise-pin-npm "$file" 0 "npm $got — mise.toml pins npm $npm_pin"
	fi
}

# ------------------------------------------------------------------- config --

# min-release-age only exists from npm 11. An older npm still echoes the key back
# from .npmrc, so "the config says 2" proves nothing there: the npm version is
# half of the check, and the effective setting is the other half (blip 99, blip 42).
# The unit is days — measured, not assumed: --min-release-age=2 refused a package
# published today and accepted one published two days ago (blip 99).
#
# A stale /usr/bin/npm shadowing ~/.local/bin/npm is a PATH-order problem, not a
# missing quarantine: the newest readable npm is used and the shadowing is one
# WARN, so a real FAIL is not buried under an environment accident (blip 99,
# blip 29 harness quality evaluation).
npm_version_at() { # npm binary -> version, or nothing when it cannot be read
	[ -n "$1" ] && [ -x "$1" ] || return 1
	"$1" --version 2>/dev/null | tr -d '[:space:]' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' || return 1
}

npm_newer() { # a b -> true when b sorts above a (11.20.0 beats 10.9.9)
	[ "$1" != "$2" ] || return 1
	[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$2" ]
}

check_release_age() {
	local path_npm path_version best_npm best_version candidate candidate_version value source npm_pin
	if ! command -v npm >/dev/null 2>&1; then
		verdict npm-min-release-age - 0 "npm not installed"
		return
	fi
	path_npm=$(command -v npm)
	path_version=$(npm --version 2>/dev/null | tr -d '[:space:]')
	case "$path_version" in
	'' | undefined | null)
		verdict npm-min-release-age - 0 "cannot read the npm version — npm's config is masked inside the sandbox, so run this bare: bash scripts/harness-check.sh --verify-release-age"
		return
		;;
	[0-9]*.[0-9]*.[0-9]*) ;;
	*)
		verdict npm-min-release-age - 0 "unreadable npm version: $path_version"
		return
		;;
	esac
	# The newest readable npm wins: whatever PATH resolves, then setup.sh's install
	# target and the system prefix. The list is overridable so a test can control
	# the machine's other npm installs instead of hoping they are absent.
	best_npm=$path_npm
	best_version=$path_version
	for candidate in $(printf '%s' "${PI_NPM_CANDIDATES-$HOME/.local/bin/npm:/usr/local/bin/npm}" | tr ':' ' '); do
		[ -n "$candidate" ] || continue
		[ "$candidate" = "$path_npm" ] && continue
		candidate_version=$(npm_version_at "$candidate") || continue
		if npm_newer "$best_version" "$candidate_version"; then
			best_npm=$candidate
			best_version=$candidate_version
		fi
	done
	if [ "${path_version%%.*}" -lt 11 ] && [ "${best_version%%.*}" -ge 11 ]; then
		record WARN npm-min-release-age-path "$path_npm" \
			"PATH npm $path_version shadows $best_npm $best_version — put $(dirname "$best_npm") first on PATH"
	fi
	# The number the two messages below name is the pin, not a fourth copy of it:
	# mise.toml's `npm` is what this repo wants installed. The 11.10 floor in the
	# comment above is npm's own fact (the release min-release-age landed in) and
	# stays a literal, so a bump to npm 12 cannot make this check claim that npm 11
	# ignores a setting it honours. No pin is loud, never a silent 11: the WARN
	# names it and mise-pin-npm has already FAILed the run.
	npm_pin=$(mise_major npm)
	if [ -z "$npm_pin" ]; then
		record WARN npm-pin - \
			"mise.toml declares no npm major — the advice below falls back to npm 11 and mise-pin-npm FAILs this run"
		npm_pin=11
	fi
	if [ "${best_version%%.*}" -lt 11 ]; then
		# A dangling ~/.local/bin/npm is the fingerprint of an install that could
		# not finish: the shim is written, the target is not, and because the
		# candidate scan needs an executable it is skipped on every later run —
		# the FAIL survives the very install that was supposed to end it. Name
		# the removal, so the next attempt is not the same attempt (blip 99,
		# blip 1 agent sandboxing).
		local dangling=""
		for candidate in $(printf '%s' "${PI_NPM_CANDIDATES-$HOME/.local/bin/npm:/usr/local/bin/npm}" | tr ':' ' '); do
			[ -n "$candidate" ] && [ -L "$candidate" ] && [ ! -e "$candidate" ] || continue
			dangling=" — $candidate is a dangling symlink; remove it: rm $candidate"
			break
		done
		# Inside the sandbox a global install writes into masked or read-only
		# paths, so telling an agent to run it costs a turn and leaves a shim
		# behind. The host can do it; the sandbox can only ask for it.
		if [ -n "${PI_SANDBOX_MODE:-}" ]; then
			verdict npm-min-release-age - 0 "npm $best_version ignores min-release-age (needs npm ≥ $npm_pin) — the sandbox cannot install a global npm; from a host shell run: bash $ROOT/setup.sh$dangling"
		else
			verdict npm-min-release-age - 0 "npm $best_version ignores min-release-age (needs npm ≥ $npm_pin) — install one: npm i -g --prefix ~/.local npm@$npm_pin$dangling"
		fi
		return
	fi
	# Inside the sandbox npm's config file is bound to /dev/null, so the launcher
	# forwards the one number that matters as NPM_CONFIG_MIN_RELEASE_AGE. npm gives
	# the environment variable the last word anyway, so it is read first; the
	# config file is only consulted when it is absent or not a number of days.
	# Nothing readable is still unverifiable, not a pass: FAIL and name the bare
	# command that does read it (blip 99, blip 1 agent sandboxing).
	value=${NPM_CONFIG_MIN_RELEASE_AGE:-}
	source="from NPM_CONFIG_MIN_RELEASE_AGE"
	case "$value" in
	'' | *[!0-9]*)
		value=""
		source="from npm config"
		;;
	esac
	if [ -z "$value" ]; then
		value=$("$best_npm" config get min-release-age 2>/dev/null | tr -d '[:space:]')
	fi
	case "$value" in
	'' | undefined | null)
		verdict npm-min-release-age - 0 "npm $best_version cannot read min-release-age${PI_SANDBOX_MODE:+ (masked by the sandbox and NPM_CONFIG_MIN_RELEASE_AGE was not forwarded — run this bare)} — verify with: bash scripts/harness-check.sh --verify-release-age ; set with: npm config set min-release-age $MIN_RELEASE_AGE"
		return
		;;
	esac
	case "$value" in
	*[!0-9]*)
		verdict npm-min-release-age - 0 "not a number of days: $value"
		return
		;;
	esac
	if [ "$value" -ge "$MIN_RELEASE_AGE" ]; then
		verdict npm-min-release-age - 1 "npm $best_version, effective min-release-age=$value days ≥ $MIN_RELEASE_AGE days ($source)"
	else
		verdict npm-min-release-age - 0 "npm $best_version, effective min-release-age=$value days < $MIN_RELEASE_AGE days — run: npm config set min-release-age $MIN_RELEASE_AGE"
	fi
}

check_git_hooks() {
	local hooks_path template_dir count expected
	hooks_path=$(git config --global --get core.hooksPath 2>/dev/null || true)
	if [ -n "$hooks_path" ] && [ -d "$hooks_path" ]; then
		hooks_path=$(cd "$hooks_path" && pwd -P)
	fi
	expected="$HOME/.pi/git-hooks"
	[ -d "$expected" ] && expected=$(cd "$expected" && pwd -P)
	if [ "$hooks_path" = "$expected" ]; then
		verdict git-hooks-path - 1 "$hooks_path"
	else
		verdict git-hooks-path - 0 "core.hooksPath=${hooks_path:-unset} — run: bash git-hooks/install-hooks.sh"
	fi

	template_dir="$HOME/.git-templates/hooks"
	count=0
	[ -d "$template_dir" ] && count=$(find "$template_dir" -maxdepth 1 -type f | wc -l | tr -d '[:space:]')
	if [ "$count" -gt 0 ]; then
		verdict git-hooks-templates - 1 "$template_dir ($count files)"
	else
		verdict git-hooks-templates - 0 "$template_dir empty — run: bash git-hooks/install-hooks.sh (the template layer is inert without it)"
	fi
}

# ----------------------------------------------------------------- metadata --

check_doc_metadata() {
	local files=() file rel missing
	shopt -s nullglob
	files=("$ROOT"/docs/*.md "$ROOT"/specs/areas/*.md)
	shopt -u nullglob
	if [ "${#files[@]}" -eq 0 ]; then
		verdict doc-metadata - 0 "no docs/*.md or specs/areas/*.md found"
		return
	fi
	for file in "${files[@]}"; do
		rel="${file#"$ROOT"/}"
		missing=""
		grep -qE '^[[:space:]]*Owner:' "$file" || missing="Owner:"
		grep -qE '^[[:space:]]*Review:' "$file" || missing="${missing:+$missing and }Review:"
		if [ -z "$missing" ]; then
			verdict doc-metadata "$rel" 1 "Owner: and Review: present"
		else
			verdict doc-metadata "$rel" 0 "missing $missing"
		fi
	done
}

check_radar_basis() {
	local files=() file rel
	shopt -s nullglob
	files=("$ROOT"/agent/extensions/*.ts)
	shopt -u nullglob
	if [ "${#files[@]}" -eq 0 ]; then
		verdict extension-radar-basis - 0 "no extensions found"
		return
	fi
	for file in "${files[@]}"; do
		rel="${file#"$ROOT"/}"
		if grep -qi 'Radar basis' "$file"; then
			verdict extension-radar-basis "$rel" 1 "declares its Radar basis"
		else
			verdict extension-radar-basis "$rel" 0 "no 'Radar basis' header line — cite blips or delete the extension"
		fi
	done
}

# A Review: line can carry prose after the date ("2027-02-13 — quarterly"),
# so take the leading date token instead of the whole line. Parsing the line
# whole made every comparison fail silently and the check passed on nothing.
check_review_freshness() {
	local files=() file rel review due due_at today soon seen=0
	shopt -s nullglob
	files=("$ROOT"/docs/*.md "$ROOT"/specs/areas/*.md)
	shopt -u nullglob
	if [ "${#files[@]}" -eq 0 ]; then
		verdict review-freshness docs 0 "no docs/*.md or specs/areas/*.md to date"
		return
	fi
	today=$(date +%s)
	soon=$((today + 14 * 86400))
	for file in "${files[@]}"; do
		rel="${file#"$ROOT"/}"
		review=$(sed -n 's/^[[:space:]]*[Rr]eview:[[:space:]]*//p' "$file" | head -1)
		if [ -z "$review" ]; then
			verdict review-freshness "$rel" 0 "no Review: line — add 'Review: YYYY-MM-DD' or delete the doc"
			continue
		fi
		due=$(printf '%s' "$review" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
		if [ -z "$due" ]; then
			verdict review-freshness "$rel" 0 "Review: carries no YYYY-MM-DD date ($review)"
			continue
		fi
		due_at=$(date -d "$due" +%s 2>/dev/null) || {
			verdict review-freshness "$rel" 0 "Review: date $due is not a real date"
			continue
		}
		seen=$((seen + 1))
		if [ "$due_at" -lt "$today" ]; then
			verdict review-freshness "$rel" 0 \
				"review overdue since $due — rerun the audit or delete the doc (blips 36 and 39)"
		elif [ "$due_at" -le "$soon" ]; then
			record WARN review-freshness "$rel" "review due $due, inside 14 days — schedule the rerun"
		else
			verdict review-freshness "$rel" 1 "review due $due"
		fi
	done
	if [ "$seen" -eq 0 ]; then
		record WARN review-freshness docs "no Review: date could be parsed — the check compared nothing"
	fi
}

# --- spec deltas -----------------------------------------------------------
# Radar blip 82 (OpenSpec, Trial): the spec a change is measured against lives beside
# the code it describes, and the change itself is a delta — one file in specs/changes/
# named after its branch. Two rows come out of that:
#
#   spec-delta-area    the delta's `Area:` line has to name an area spec that exists.
#                      A delta amending nothing is the failure worth catching, and what
#                      the delta *says* stays a review question.
#   spec-delta-folded  a delta that reached trunk is a merged change, and merging folds
#                      the delta into its area spec and deletes the file (README there).
#                      So a delta still in trunk's tree is an unfolded one.
#
# The fold itself is a human step on purpose, and the row only makes it unmissable: with one
# `git rm specs/changes/<file>` done without the paste, the row goes quiet while the area spec
# says something else — so the FAIL names the area spec file rather than offering a command
# that would bury the body at the end of it. Appending English to English mechanically is how
# a spec ends up with two paragraphs that disagree, and no check can tell which one is true.

# The ref a delta is measured against, empty when this tree has no trunk to measure against
# (a checkout with no history at all, or a fixture from the tests).
spec_trunk_ref() {
	local ref
	for ref in trunk origin/trunk main origin/main master origin/master; do
		git -C "$ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 || continue
		printf '%s' "$ref"
		return 0
	done
	return 1
}

check_spec_deltas() {
	local dir="$ROOT/specs/changes" files=() file rel area spec seen=0 trunk
	trunk=$(spec_trunk_ref) || trunk=""
	shopt -s nullglob
	files=("$dir"/*.md)
	shopt -u nullglob
	for file in "${files[@]}"; do
		rel="${file#"$ROOT"/}"
		[ "${file##*/}" = README.md ] && continue
		seen=$((seen + 1))
		# `Area: merge-guard`, `Area: specs/areas/merge-guard.md` and a backticked
		# name all resolve to the same file: the line is written for a reader, so the
		# check accepts the forms a reader would write.
		area=$(sed -n 's/^[[:space:]]*[Aa]rea:[[:space:]]*//p' "$file" | head -1)
		area="${area%%[[:space:]]*}"
		area="${area#\`}"
		area="${area%\`}"
		area="${area#specs/areas/}"
		area="${area%.md}"
		spec="specs/areas/$area.md"
		if [ -z "$area" ]; then
			verdict spec-delta-area "$rel" 0 \
				"no 'Area:' line naming the area spec it amends — nothing resolves to specs/areas/"
			continue
		fi
		if [ ! -f "$ROOT/$spec" ]; then
			verdict spec-delta-area "$rel" 0 \
				"names area '$area' but $spec does not exist — add that area spec or name an existing one"
			# No fold row: there is no file to fold into, so the row would have to name
			# a target that does not exist. One FAIL, with the reason that blocks the
			# fold, beats a second row guessing at where the body should have gone.
			continue
		fi
		verdict spec-delta-area "$rel" 1 "amends $spec"
		if [ -z "$trunk" ]; then
			record WARN spec-delta-folded "$rel" \
				"no trunk ref to compare with — cannot tell a landed delta from one still on its branch"
		elif git -C "$ROOT" cat-file -e "$trunk:$rel" 2>/dev/null; then
			verdict spec-delta-folded "$rel" 0 \
				"landed on $trunk and still here — fold its body into $spec and git rm it"
		else
			verdict spec-delta-folded "$rel" 1 \
				"not on $trunk yet — fold into $spec and delete it as part of the merge"
		fi
	done
	if [ "$seen" -eq 0 ]; then
		verdict spec-delta-area specs/changes 1 "no change deltas yet — nothing to resolve"
	fi
}

# --- blip allowlist -------------------------------------------------------
# "Cite the blip number" is unverifiable while the number is free text: any
# integer reads as authoritative. The allowlist is docs/radar-blips.tsv, so a
# citation either resolves to a Vol. 35 blip or it fails.
RADAR_TSV_REL="docs/radar-blips.tsv"
declare -A RADAR_RING=()

load_radar_blips() { # fills RADAR_RING from the TSV, 1 when it is unusable
	local blip ring
	RADAR_RING=()
	[ -f "$ROOT/$RADAR_TSV_REL" ] || return 1
	while IFS=$'\t' read -r blip ring _; do
		case "$blip" in '' | blip) continue ;; esac
		[ -n "$ring" ] || continue
		RADAR_RING["$blip"]=$ring
	done <"$ROOT/$RADAR_TSV_REL"
	[ "${#RADAR_RING[@]}" -gt 0 ]
}

cite_numbers() { # file -> one blip number per line, deduped
	grep -oE '#[0-9]+|blip[[:space:]]+#?[0-9]+' "$1" 2>/dev/null |
		grep -oE '[0-9]+' | sort -un
}

check_radar_blips() {
	local files=() file rel n ring resolved=0 unknown=0 caution
	if ! load_radar_blips; then
		verdict radar-blip-valid "$RADAR_TSV_REL" 0 \
			"missing or empty — without the allowlist no citation can be checked"
		return
	fi
	shopt -s nullglob
	files=("$ROOT"/agent/extensions/*.ts "$ROOT"/scripts/*.sh \
		"$ROOT"/git-hooks/*.sh "$ROOT"/sandbox/*.sh)
	shopt -u nullglob
	[ -f "$ROOT/agent/AGENTS.md" ] && files+=("$ROOT/agent/AGENTS.md")
	for file in "${files[@]}"; do
		rel="${file#"$ROOT"/}"
		caution=""
		while IFS= read -r n; do
			[ -n "$n" ] || continue
			ring="${RADAR_RING[$n]:-}"
			if [ -z "$ring" ]; then
				unknown=$((unknown + 1))
				verdict radar-blip-valid "$rel" 0 \
					"cites blip #$n, which is not in docs/radar-blips.tsv — cite a real blip or drop the claim"
				continue
			fi
			resolved=$((resolved + 1))
			[ "$ring" = Caution ] && caution="${caution}${caution:+, }$n"
		done < <(cite_numbers "$file")
		if [ -n "$caution" ]; then
			verdict radar-blip-valid "$rel" 1 \
				"Caution-ring blips cited: $caution — deliberate, the file names the harm it avoids"
		fi
	done
	if [ "${#files[@]}" -eq 0 ]; then
		record FAIL radar-blip-valid - "no files scanned"
	elif [ "$unknown" -gt 0 ]; then
		record FAIL radar-blip-valid "$RADAR_TSV_REL" \
			"$resolved citation(s) resolved, $unknown unknown across ${#files[@]} files"
	elif [ "$resolved" -eq 0 ]; then
		verdict radar-blip-valid - 0 "no blip citations found in ${#files[@]} files"
	else
		verdict radar-blip-valid "$RADAR_TSV_REL" 1 \
			"$resolved citation(s) across ${#files[@]} files resolved against ${#RADAR_RING[@]} blips"
	fi
}

# -------------------------------------------------------------- model route --
# A flagship default for everyday edits is the blanket-frontier failure mode:
# it is read-only, it never picks a cheap route, and nothing notices.
FRONTIER_RE='gpt-5|gpt-4\.1|claude-opus|gemini-2\.5-pro|(^|[^a-z0-9])o[34]([^a-z0-9]|$)'

settings_field() { # file key -> value, node if present else a grep fallback
	local file=$1 key=$2
	if command -v node >/dev/null 2>&1; then
		node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=process.argv[1];try{const v=JSON.parse(s)[k];process.stdout.write(v==null?"":String(v))}catch(e){}})' \
			"$key" <"$file" 2>/dev/null
		return
	fi
	sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -1
}

check_model_route() {
	local file="$ROOT/agent/settings.json" model provider detail
	if [ ! -f "$file" ]; then
		record WARN model-route agent/settings.json \
			"missing — no default route to inspect, add one or the provider default wins"
		return
	fi
	if ! command -v node >/dev/null 2>&1; then
		record WARN model-route agent/settings.json \
			"node absent — falling back to a grep parse of defaultModel (jq is not assumed)"
	fi
	model=$(settings_field "$file" defaultModel | tr -d '[:space:]')
	provider=$(settings_field "$file" defaultProvider | tr -d '[:space:]')
	if [ -z "$model" ]; then
		record WARN model-route agent/settings.json \
			"defaultModel unset — the harness falls back to whatever the provider defaults to"
		return
	fi
	detail="${provider:+$provider/}$model"
	if printf '%s' "$model" | grep -qiE "$FRONTIER_RE"; then
		verdict model-route agent/settings.json 0 \
			"defaultModel $detail is a frontier flagship — route by task, not by default (blip 40)"
	else
		verdict model-route agent/settings.json 1 "defaultModel $detail — not a flagship, deliberate route"
	fi
}

# ------------------------------------------------------------ eval freshness --
# The one check here that cannot be answered by reading a file: the eval suite grades a
# model. It runs weekly from systemd/pi-evals.timer, and an advisory suite that nobody
# notices going quiet is the failure this catches. `make evals` writes the record.
check_eval_freshness() {
	local rec="agent/evals/last-run.txt" ran now age ran_at summary
	if [ ! -f "$ROOT/$rec" ]; then
		record WARN eval-freshness "$rec" \
			"no eval run recorded — the suite grades a model and has never run here; run: make evals"
		return
	fi
	ran=$(sed -n 's/^ran_epoch=//p' "$ROOT/$rec" | head -1)
	ran_at=$(sed -n 's/^ran_at=//p' "$ROOT/$rec" | head -1)
	summary=$(sed -n 's/^note=//p' "$ROOT/$rec" | head -1)
	case "$ran" in
	'' | *[!0-9]*)
		record WARN eval-freshness "$rec" \
			"ran_epoch missing or not a number — rerun make evals so the record is honest"
		return
		;;
	esac
	now=$(date +%s)
	age=$(((now - ran) / 86400))
	if [ "$age" -gt "$EVAL_MAX_AGE_DAYS" ]; then
		record WARN eval-freshness "$rec" \
			"last run $age days ago (${ran_at:-unknown}, ${summary:-no counts}) — older than ${EVAL_MAX_AGE_DAYS} days; run: make evals"
	else
		verdict eval-freshness "$rec" 1 \
			"last run $age day(s) ago (${ran_at:-unknown}, ${summary:-no counts}) — inside the ${EVAL_MAX_AGE_DAYS}-day window"
	fi
}

# ------------------------------------------------------------ retro freshness --
# Same shape as the eval check above and for the same reason: a scheduled report that
# quietly stops running leaves the suggestion box unread, which is the state this
# harness was in before the timer existed. `make retro` writes the record, and it is
# written even on an empty log, so a missing record means "never ran", not "nothing to
# say".
check_retro_freshness() {
	local rec="agent/retro/last-run.txt" ran now age ran_at summary digest
	if [ ! -f "$ROOT/$rec" ]; then
		record WARN retro-freshness "$rec" \
			"no retro run recorded — the suggestion box has never been aggregated here; run: make retro"
		return
	fi
	ran=$(sed -n 's/^ran_epoch=//p' "$ROOT/$rec" | head -1)
	ran_at=$(sed -n 's/^ran_at=//p' "$ROOT/$rec" | head -1)
	summary=$(sed -n 's/^note=//p' "$ROOT/$rec" | head -1)
	digest=$(sed -n 's/^digest=//p' "$ROOT/$rec" | head -1)
	case "$ran" in
	'' | *[!0-9]*)
		record WARN retro-freshness "$rec" \
			"ran_epoch missing or not a number — rerun make retro so the record is honest"
		return
		;;
	esac
	now=$(date +%s)
	age=$(((now - ran) / 86400))
	if [ "$age" -gt "$RETRO_MAX_AGE_DAYS" ]; then
		record WARN retro-freshness "$rec" \
			"last run $age days ago (${ran_at:-unknown}, ${summary:-no counts}) — older than ${RETRO_MAX_AGE_DAYS} days; run: make retro"
	else
		verdict retro-freshness "$rec" 1 \
			"last run $age day(s) ago (${ran_at:-unknown}, ${summary:-no counts}, digest ${digest:-unknown}) — inside the ${RETRO_MAX_AGE_DAYS}-day window"
	fi
}

# ------------------------------------------------------------ config shapes --
# Radar blip 102 (Varlock: validate config, do not hope). pi reads settings.json
# and models.json before any extension is asked anything and ignores a key it
# does not know, so a typo is a silent fallback: the route works until it does
# not. agent/config/schema.mjs holds the shapes; this check turns them into FAIL
# lines that carry the file, the path inside it and what was expected.
#
# Agent-owned settings blocks (observational-memory) are typed there too, so a
# typo inside a package's block is caught by the same line. keys.json is checked
# by shape and presence only — schema.mjs never formats a value.
check_config_schema() {
	local status where message schema="$ROOT/agent/config/schema.mjs"
	if [ ! -f "$schema" ]; then
		schema="$HARNESS_ROOT/agent/config/schema.mjs"
	fi
	if [ ! -f "$schema" ]; then
		verdict config-schema agent/config/schema.mjs 0 \
			"missing — nothing defines the config shapes any more (blip 102)"
		return
	fi
	if ! command -v node >/dev/null 2>&1; then
		record WARN config-schema agent/config/schema.mjs \
			"node absent — the config files were not validated (jq is not assumed)"
		return
	fi
	while IFS=$'\t' read -r status where message; do
		[ -n "$status" ] || continue
		case "$status" in
		PASS) verdict config-schema "$where" 1 "$message" ;;
		FAIL) verdict config-schema "$where" 0 "$message" ;;
		esac
	done < <(node "$schema" --root "$ROOT" 2>/dev/null)
}

# ----------------------------------------------------------- sandbox marker --
# A sandbox nobody can see becomes a sandbox nobody checks: once `install.sh`
# wraps `pi`, the contained session and the one launched with PI_BARE=1 look
# identical in Herdr. The marker the launcher exports is the only honest source,
# so this check keeps the launcher and the display from drifting apart.
check_self_learn() {
	local ext="agent/extensions/self-learn.ts" spec="agent/prompts/learn.md"
	if [ ! -f "$ROOT/$ext" ]; then
		record WARN self-learn "$ext" "missing — compactions teach the harness nothing (blip 18)"
		return
	fi
	if [ ! -f "$ROOT/$spec" ]; then
		verdict self-learn "$spec" 0 \
			"missing — the learner would be spawned without a spec to follow"
		return
	fi
	if ! grep -q 'PI_SELF_LEARN' "$ROOT/$ext"; then
		verdict self-learn "$ext" 0 \
			"does not guard against recursion — a learner could spawn learners"
		return
	fi
	verdict self-learn "$ext" 1 \
		"after a compaction, a separate pi session judges the harness; proposals land in ~/.pi/agent/proposals/"
}

# -------------------------------------------------- learn branch published --
check_learn_branch_published() {
	local check=learn-branch-published
	local log="$ROOT/agent/proposals/publish-log.jsonl"
	local now branch ts age proposal line compact attempted published seen=0 missing=0
	local common main
	git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || {
		verdict "$check" . 1 "not a git checkout — no branches to publish"
		return
	}
	# `agent/proposals/` is gitignored, so a learner's worktree has no publish log of
	# its own while the shared git dir does: read the log of the repo that owns it,
	# or every branch with a recorded PR would read as unpublished from a worktree.
	common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=""
	if [ -n "$common" ] && [ -d "$common" ]; then
		main="$(dirname "$common")/agent/proposals/publish-log.jsonl"
		[ -f "$main" ] && log="$main"
	fi
	now=$(date +%s)
	while IFS= read -r branch; do
		[ -n "$branch" ] || continue
		seen=$((seen + 1))
		# Already trunk's history: the lesson landed, the leftover branch is litter.
		git -C "$ROOT" merge-base --is-ancestor "refs/heads/$branch" trunk 2>/dev/null && continue
		ts=$(git -C "$ROOT" log -1 --format=%ct "refs/heads/$branch" 2>/dev/null) || continue
		[ -n "$ts" ] || continue
		age=$(((now - ts) / 60))
		# A learner still working on its own branch is not an unfinished run.
		[ "$age" -lt "$LEARN_BRANCH_GRACE_MIN" ] && continue
		proposal=$(git -C "$ROOT" log -1 --format=%B "refs/heads/$branch" 2>/dev/null \
			| grep -o 'agent/proposals/[A-Za-z0-9._/-]*\.md' | head -1)
		attempted=0
		published=0
		if [ -f "$log" ]; then
			while IFS= read -r line; do
				compact=${line// /}
				case "$compact" in *"\"branch\":\"$branch\""*) ;; *) continue ;; esac
				attempted=1
				case "$compact" in *'"pr":null'*) ;; *'"pr":'[0-9]*) published=1 ;; esac
			done <"$log"
		fi
		[ "$published" = 1 ] && continue
		missing=$((missing + 1))
		if [ "$attempted" = 1 ]; then
			verdict "$check" "$branch" 0 \
				"${age} min old, and agent/proposals/publish-log.jsonl has an attempt for it with no PR — re-ask from the host: scripts/learn-publish.sh ${branch#learn/} --check"
		else
			verdict "$check" "$branch" 0 \
				"${age} min old with no row in agent/proposals/publish-log.jsonl — publish it: scripts/learn-publish.sh ${branch#learn/}${proposal:+ --proposal $proposal} (or delete the branch if its lesson is dead)"
		fi
	done < <(git -C "$ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/learn/' 2>/dev/null)
	[ "$missing" -gt 0 ] && return 0
	if [ "$seen" -eq 0 ]; then
		verdict "$check" . 1 "no learn/* branches — every lesson learned here has landed or been dropped"
	else
		verdict "$check" . 1 "$seen learn/* branch(es): merged, younger than ${LEARN_BRANCH_GRACE_MIN} min, or carrying a PR in publish-log.jsonl"
	fi
}

check_sandbox_marker() {
	local launcher="sandbox/pi-sandbox.sh" badge="agent/extensions/sandbox-badge.ts"
	if [ ! -f "$ROOT/$launcher" ]; then
		record WARN sandbox-marker "$launcher" "missing — no launcher to read the marker from"
		return
	fi
	if ! grep -q 'setenv PI_SANDBOX_MODE' "$ROOT/$launcher"; then
		verdict sandbox-marker "$launcher" 0 \
			"does not export PI_SANDBOX_MODE — the badge would call every session bare"
		return
	fi
	if ! grep -q 'setenv PI_SANDBOX_NET' "$ROOT/$launcher"; then
		verdict sandbox-marker "$launcher" 0 \
			"does not export PI_SANDBOX_NET — --no-net runs would be indistinguishable"
		return
	fi
	if [ ! -f "$ROOT/$badge" ]; then
		verdict sandbox-marker "$badge" 0 \
			"missing — the marker is exported but nothing displays it (blip 1, blip 42)"
		return
	fi
	verdict sandbox-marker "$launcher" 1 \
		"exports PI_SANDBOX_MODE and PI_SANDBOX_NET, displayed by $badge"
}

# --------------------------------------------------------------------- run ---

while [ $# -gt 0 ]; do
	case "$1" in
	--json) JSON=1 ;;
	--quick) QUICK=1 ;;
	--verify-release-age) VERIFY_RELEASE_AGE=1 ;;
	--verify-config) VERIFY_CONFIG=1 ;;
	--verify-doc-facts) VERIFY_DOC_FACTS=1 ;;
	--verify-spec-deltas) VERIFY_SPEC_DELTAS=1 ;;
	--write-skills-lock) WRITE_SKILLS_LOCK=1 ;;
	--verify-skills-lock) VERIFY_SKILLS_LOCK=1 ;;
	--write-packages-lock) WRITE_PACKAGES_LOCK=1 ;;
	--verify-packages-lock) VERIFY_PACKAGES_LOCK=1 ;;
	--verify-mise-pins) VERIFY_MISE_PINS=1 ;;
	--root)
		[ $# -ge 2 ] || die "--root needs a directory"
		ROOT="$2"
		shift
		;;
	--root=*) ROOT="${1#--root=}" ;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (try --help)" ;;
	esac
	shift
done
ROOT="$(cd "$ROOT" 2>/dev/null && pwd)" || die "no such directory"
load_baseline

# The two writing modes in this file, each writing exactly one path.
if [ "$WRITE_SKILLS_LOCK" = 1 ]; then
	write_skills_lock || exit 1
	exit 0
fi
if [ "$WRITE_PACKAGES_LOCK" = 1 ]; then
	write_packages_lock || exit 1
	exit 0
fi

# The skill pin check on its own, so a test can assert on it without the whole
# report: the exit status is the answer.
if [ "$VERIFY_SKILLS_LOCK" = 1 ]; then
	section "skills — pinned content (blip #72)"
	check_skills_lock
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

# The package pin on its own, for the same reason as the skill pin above.
if [ "$VERIFY_PACKAGES_LOCK" = 1 ]; then
	section "packages — pinned by commit (blip #72)"
	check_packages_lock
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

# The mise.toml projections on their own, so a test can assert on them without
# the other twenty lines: the exit status is the answer.
if [ "$VERIFY_MISE_PINS" = 1 ]; then
	section "versions — the pin in mise.toml, projected (blip 68)"
	check_mise_pins
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

# One check, on demand, for a bare-mode run: the whole report is the release-age
# verdict, and its exit status is the answer.
if [ "$VERIFY_RELEASE_AGE" = 1 ]; then
	section "config — npm quarantine (blip 99)"
	check_release_age
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

# One check, on demand, for the config shapes alone: the whole report is the
# schema verdict and its exit status is the answer, so a broken file can be
# shown to someone without the other twenty lines in the way (blip 102).
if [ "$VERIFY_CONFIG" = 1 ]; then
	section "config — file shapes (blip 102)"
	check_config_schema
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

# The spec-delta rule on its own, the way the tests exercise it: a delta naming an
# area spec that exists is the passing case, and the exit status is the answer.
if [ "$VERIFY_SPEC_DELTAS" = 1 ]; then
	section "specs — change deltas (blip 82)"
	check_spec_deltas
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

# One check, on demand, for the transport table alone: tests assert on the exit
# status, and a reader gets one line instead of the whole report.
if [ "$VERIFY_DOC_FACTS" = 1 ]; then
	section "docs — the transport each subject is served by"
	check_doc_facts
	if [ "$JSON" = 1 ]; then
		printf '{"pass":%d,"warn":%d,"fail":%d,"results":[%s]}\n' \
			"$PASS_N" "$WARN_N" "$FAIL_N" "${JSON_ITEMS[*]}"
	else
		printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	fi
	[ "$FAIL_N" -eq 0 ]
	exit $?
fi

section "budgets — files that load on every turn"
check_agents_md
check_skill_lines
# Cheap (a sha256 per skill file) and part of the hook's --quick run on purpose:
# editing a skill and not regenerating the lock fails at commit time, while the
# edit is still one fix away.
check_skills_lock
# Same cost and the same argument: three git rev-parse calls in the installed tree,
# so a package list edited without a regenerated lock fails at commit time.
check_packages_lock
# Reading a handful of small docs costs milliseconds, and a sentence that names
# the wrong transport is exactly the rot that survives review: this runs in
# --quick so the commit hook says so, not a reader three months later.
check_doc_facts
# Six greps and no subprocess that leaves the tree, so it belongs in the hook's
# --quick run too: a bump that edits mise.toml is one command from being
# consistent, while the edit is still the one being made.
check_mise_pins

if [ "$QUICK" = 0 ]; then
	section "config — things an install step sets"
	check_release_age
	check_config_schema
	check_git_hooks
	check_model_route
	check_sandbox_marker
	check_self_learn
	check_learn_branch_published

	section "evals — a model graded against the harness's own rules"
	check_eval_freshness

	section "retro — the suggestion box aggregated on a schedule"
	check_retro_freshness

	section "metadata — ownership and provenance"
	check_doc_metadata
	check_radar_basis
	check_radar_blips
	check_review_freshness
	check_spec_deltas
	# --quick runs budgets only, so it would call every other entry stale.
	check_stale_baseline
fi

if [ "$JSON" = 1 ]; then
	printf '{"pass":%d,"warn":%d,"fail":%d,"results":[' "$PASS_N" "$WARN_N" "$FAIL_N"
	sep=""
	for item in "${JSON_ITEMS[@]}"; do
		printf '%s%s' "$sep" "$item"
		sep=","
	done
	printf ']}\n'
else
	printf '\n%d passed, %d warn, %d failed\n' "$PASS_N" "$WARN_N" "$FAIL_N"
	if [ "$FAIL_N" -gt 0 ]; then
		printf 'Fix the FAIL lines above. A violation that predates the check belongs in scripts/harness-baseline.txt, not in AGENTS.md.\n'
	fi
fi

[ "$FAIL_N" -eq 0 ]
