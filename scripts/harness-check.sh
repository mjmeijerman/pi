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
# be a paragraph in AGENTS.md. Read-only — no writes, no network.
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

usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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
	local path_npm path_version best_npm best_version candidate candidate_version value source
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
	if [ "${best_version%%.*}" -lt 11 ]; then
		verdict npm-min-release-age - 0 "npm $best_version ignores min-release-age (needs npm ≥ 11) — install one: npm i -g --prefix ~/.local npm@11"
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
	files=("$ROOT"/docs/*.md)
	shopt -u nullglob
	if [ "${#files[@]}" -eq 0 ]; then
		verdict doc-metadata - 0 "no docs/*.md found"
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
	local files=() file rel review due then today soon seen=0
	shopt -s nullglob
	files=("$ROOT"/docs/*.md)
	shopt -u nullglob
	if [ "${#files[@]}" -eq 0 ]; then
		verdict review-freshness docs 0 "no docs/*.md to date"
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
		then=$(date -d "$due" +%s 2>/dev/null) || {
			verdict review-freshness "$rel" 0 "Review: date $due is not a real date"
			continue
		}
		seen=$((seen + 1))
		if [ "$then" -lt "$today" ]; then
			verdict review-freshness "$rel" 0 \
				"review overdue since $due — rerun the audit or delete the doc (blips 36 and 39)"
		elif [ "$then" -le "$soon" ]; then
			record WARN review-freshness "$rel" "review due $due, inside 14 days — schedule the rerun"
		else
			verdict review-freshness "$rel" 1 "review due $due"
		fi
	done
	if [ "$seen" -eq 0 ]; then
		record WARN review-freshness docs "no Review: date could be parsed — the check compared nothing"
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

section "budgets — files that load on every turn"
check_agents_md
check_skill_lines

if [ "$QUICK" = 0 ]; then
	section "config — things an install step sets"
	check_release_age
	check_config_schema
	check_git_hooks
	check_model_route
	check_sandbox_marker
	check_self_learn

	section "evals — a model graded against the harness's own rules"
	check_eval_freshness

	section "retro — the suggestion box aggregated on a schedule"
	check_retro_freshness

	section "metadata — ownership and provenance"
	check_doc_metadata
	check_radar_basis
	check_radar_blips
	check_review_freshness
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
