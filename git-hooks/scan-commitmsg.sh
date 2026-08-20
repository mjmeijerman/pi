#!/usr/bin/env bash
# secret-guard commit-msg scan. Blocks commit messages containing secret values.
set -u
[ "${SKIP_SECRET_SCAN:-}" = "1" ] && exit 0

MSG_FILE="${1:-}"
[ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ] || exit 0

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENT_PAT="$DIR/patterns-content"
[ -f "$CONTENT_PAT" ] || exit 0

while IFS=$'\t' read -r name pat; do
	[ -z "$name" ] && continue
	if grep -qE -e "$pat" "$MSG_FILE"; then
		echo "secret-guard: blocked commit — possible $name in commit message"
		exit 1
	fi
done < "$CONTENT_PAT"

exit 0
