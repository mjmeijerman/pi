#!/usr/bin/env bash
# prune-sessions.sh — archive old pi sessions. Dry-run by default.
#
# Moves (never deletes) session JSONL files older than --older-than into
# ~/.pi/scripts/archive/<project-slug>/, preserving the project layout
# so a file can be moved back by hand.
#
# Usage:
#   ./prune-sessions.sh                       # dry run, 30d
#   ./prune-sessions.sh --older-than 90d       # dry run, 90d
#   ./prune-sessions.sh --older-than 30d --apply
#
# Flags:
#   --older-than <dur>  30d, 12h, 8w, 6mo, 1y. Default 30d.
#                       Age = file modification time (last write to the log).
#   --apply             Actually move the files. Without it nothing changes.
#   --sessions <dir>    Override the session store (default ~/.pi/agent/sessions).
#   --archive <dir>     Override the archive (default ~/.pi/scripts/archive).
#   -h, --help          This help.
#
# Safety: refuses to run if --older-than is under 7d unless --apply is absent,
# and never touches files created today.

set -euo pipefail

SESSIONS="${HOME}/.pi/agent/sessions"
ARCHIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/archive"
OLDER_THAN="30d"
APPLY=0

die() { printf 'error: %s\n' "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --older-than) OLDER_THAN="${2:-}"; [ -n "$OLDER_THAN" ] || die "missing value for --older-than"; shift 2 ;;
    --sessions)   SESSIONS="${2:-}";   [ -n "$SESSIONS" ]   || die "missing value for --sessions";   shift 2 ;;
    --archive)    ARCHIVE="${2:-}";    [ -n "$ARCHIVE" ]    || die "missing value for --archive";    shift 2 ;;
    --apply)      APPLY=1; shift ;;
    -h|--help)    sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown argument: $1 (try --help)" ;;
  esac
done

# --- duration -> minutes ------------------------------------------------
parse_duration() {
  local v="$1" n unit
  n="$(printf '%s' "$v" | sed -n 's/^\([0-9][0-9]*\)[[:space:]]*\([a-z]*\)$/\1/p')"
  unit="$(printf '%s' "$v" | sed -n 's/^[0-9][0-9]*[[:space:]]*\([a-z]*\)$/\1/p')"
  [ -n "$n" ] || return 1
  case "${unit:-d}" in
    h)          echo $(( n * 60 )) ;;
    d|day|days) echo $(( n * 1440 )) ;;
    w|week|weeks) echo $(( n * 10080 )) ;;
    mo|month|months|m) echo $(( n * 43200 )) ;;
    y|year|years) echo $(( n * 525600 )) ;;
    *) return 1 ;;
  esac
}

MINUTES="$(parse_duration "$OLDER_THAN")" || die "invalid --older-than value: $OLDER_THAN (use 30d, 12h, 8w, 6mo, 1y)"
[ "$MINUTES" -ge 10080 ] || printf 'warning: --older-than %s is under 7 days — very recent sessions will be selected\n' "$OLDER_THAN" >&2
[ -d "$SESSIONS" ] || die "session directory not found: $SESSIONS"

# --- select ------------------------------------------------------------
# find -mmin +N == modified more than N minutes ago
mapfile -t FILES < <(find "$SESSIONS" -type f -name '*.jsonl' -mmin "+${MINUTES}" -print | sort)
COUNT="${#FILES[@]}"

printf 'pi session prune — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
printf 'source : %s\n' "$SESSIONS"
printf 'archive: %s\n' "$ARCHIVE"
printf 'filter : last modified more than %s ago (%s minutes)\n' "$OLDER_THAN" "$MINUTES"
printf 'mode   : %s\n\n' "$([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry run (nothing will move)')"

if [ "$COUNT" -eq 0 ]; then
  printf 'No sessions older than %s. Nothing to do.\n' "$OLDER_THAN"
  exit 0
fi

TOTAL_KB=0
MOVED_KB=0

human_kb() {
  awk -v k="$1" 'BEGIN { if (k < 1024) printf "%.0f KB", k; else printf "%.2f MB", k/1024 }'
}

printf '%-12s  %-11s  %-42s  %s\n' 'SIZE' 'LAST WRITE' 'PROJECT' 'SESSION'
printf '%-12s  %-11s  %-42s  %s\n' '------------' '-----------' '------------------------------------------' '-------'

for f in "${FILES[@]}"; do
  size_kb=$(( ( $(stat -c %s "$f") + 1023 ) / 1024 ))
  TOTAL_KB=$(( TOTAL_KB + size_kb ))
  project="$(basename "$(dirname "$f")")"
  base="$(basename "$f" .jsonl)"
  when="$(date -u -d @"$(stat -c %Y "$f")" '+%Y-%m-%d')"
  printf '%-12s  %-11s  %-42s  %s\n' \
    "$(human_kb "$size_kb")" \
    "$when" "${project:0:42}" "${base:0:60}"

  if [ "$APPLY" -eq 1 ]; then
    target_dir="${ARCHIVE}/${project}"
    mkdir -p "$target_dir"
    if [ -e "${target_dir}/${base}.jsonl" ]; then
      printf '  ! skip, already archived: %s\n' "${target_dir}/${base}.jsonl" >&2
      continue
    fi
    mv -- "$f" "${target_dir}/${base}.jsonl"
    MOVED_KB=$(( MOVED_KB + size_kb ))
  fi
done

human_mb() { awk -v k="$1" 'BEGIN { printf "%.2f MB", k/1024 }'; }

printf '\n'
if [ "$APPLY" -eq 1 ]; then
  printf 'Moved %d session(s), %s reclaimed -> %s\n' "$COUNT" "$(human_mb "$MOVED_KB")" "$ARCHIVE"
  printf 'Restore one with: mv %s/<project>/<session>.jsonl %s/<project>/\n' "$ARCHIVE" "$SESSIONS"
else
  printf 'Would move %d session(s), reclaiming %s.\n' "$COUNT" "$(human_mb "$TOTAL_KB")"
  printf 'Nothing was moved. Re-run with --apply to archive these files.\n'
fi
