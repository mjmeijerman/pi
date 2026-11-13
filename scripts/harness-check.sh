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
#   scripts/harness-check.sh --help
#
# Exit 0 when nothing FAILs (a baselined violation reports WARN), 1 on any FAIL.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON=0
QUICK=0

PASS_N=0
WARN_N=0
FAIL_N=0
JSON_ITEMS=()
BASELINE_KEYS=""
BASELINE_HITS=""

AGENTS_MD_LIMIT=3072
SKILL_LINES_LIMIT=150
MIN_RELEASE_AGE=1440

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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

check_release_age() {
	local value
	if ! command -v npm >/dev/null 2>&1; then
		verdict npm-min-release-age - 0 "npm not installed"
		return
	fi
	# Inside the sandbox the npm config file is bound to /dev/null, so npm reports
	# the setting as unset no matter what it says on the host. Failing here would
	# be a check reading its own blindfold: say so instead (blip 99, blip 42).
	if [ -n "${PI_SANDBOX_MODE-}" ]; then
		verdict npm-min-release-age - 1 "not readable inside the sandbox (npm config is masked) — verify outside"
		return
	fi
	value=$(npm config get min-release-age 2>/dev/null | tr -d '[:space:]')
	case "$value" in
	'' | undefined | null) value=$(npm config get minimum-release-age 2>/dev/null | tr -d '[:space:]') ;;
	esac
	case "$value" in
	'' | undefined | null)
		verdict npm-min-release-age - 0 "unset — run: npm config set min-release-age 2880"
		return
		;;
	esac
	case "$value" in
	*[!0-9]*)
		verdict npm-min-release-age - 0 "not a number: $value"
		return
		;;
	esac
	if [ "$value" -ge "$MIN_RELEASE_AGE" ]; then
		verdict npm-min-release-age - 1 "$value min ≥ $MIN_RELEASE_AGE"
	else
		verdict npm-min-release-age - 0 "$value min < $MIN_RELEASE_AGE — run: npm config set min-release-age 2880"
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

# ----------------------------------------------------------- sandbox marker --
# A sandbox nobody can see becomes a sandbox nobody checks: once `install.sh`
# wraps `pi`, the contained session and the one launched with PI_BARE=1 look
# identical in Herdr. The marker the launcher exports is the only honest source,
# so this check keeps the launcher and the display from drifting apart.
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

section "budgets — files that load on every turn"
check_agents_md
check_skill_lines

if [ "$QUICK" = 0 ]; then
	section "config — things an install step sets"
	check_release_age
	check_git_hooks
	check_model_route
	check_sandbox_marker

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
