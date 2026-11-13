#!/usr/bin/env bash
# secret-guard pre-commit scan.
# Blocks commits that stage secret-looking files or high-confidence secret values.
# Override: SKIP_SECRET_SCAN=1  or  git commit --no-verify
# Reports pattern names and file:line only — never the matched value.
set -u
[ "${SKIP_SECRET_SCAN:-}" = "1" ] && exit 0

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME_PAT="$DIR/patterns-names"
SAFE_PAT="$DIR/patterns-safe"
CONTENT_PAT="$DIR/patterns-content"
if [ ! -f "$NAME_PAT" ] || [ ! -f "$SAFE_PAT" ] || [ ! -f "$CONTENT_PAT" ]; then
	echo "secret-guard: pattern files missing in $DIR" >&2
	exit 1
fi

FOUND=0
REPORTED=0
report() {
	if [ "$REPORTED" -lt 10 ]; then printf 'secret-guard: blocked commit — %s\n' "$1"; fi
	REPORTED=$((REPORTED + 1))
	FOUND=1
}

files="$(git diff --cached --name-only --diff-filter=ACM -z | tr '\0' '\n')"

while IFS= read -r f; do
	[ -z "$f" ] && continue
	base="$(basename -- "$f")"

	# 1) filename check
	if printf '%s\n' "$f" | grep -qEf "$NAME_PAT" && ! printf '%s\n' "$base" | grep -qiEf "$SAFE_PAT"; then
		report "secret-looking filename staged: $f"
		continue
	fi

	# 2) content check (staged index version)
	content="$(git show :"$f" 2>/dev/null)" || continue
	[ -z "$content" ] && continue

	while IFS=$'\t' read -r name pat; do
		[ -z "$name" ] && continue
		while IFS= read -r line; do
			rest="${line#*:}"
			if printf '%s\n' "$rest" | grep -qiEf "$SAFE_PAT" >/dev/null; then
				continue
			fi
			report "possible $name in $f:${line%%:*}"
		done < <(printf '%s\n' "$content" | grep -nE -e "$pat")
	done < "$CONTENT_PAT"
done <<< "$files"

exit "$FOUND"
