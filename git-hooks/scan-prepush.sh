#!/usr/bin/env bash
# secret-guard pre-push scan.
# Scans every commit being pushed (file contents, filenames, commit messages)
# for secrets. This is the last gate before secrets leave your machine — it
# catches commits made with --no-verify or -f, merges, and cherry-picks.
# Override: SKIP_SECRET_SCAN=1  or  git push --no-verify
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

ZERO="0000000000000000000000000000000000000000"
MAX_COMMITS=300
FOUND=0
REPORTED=0
SCANNED=0
report() {
	if [ "$REPORTED" -lt 10 ]; then printf 'secret-guard: blocked push — %s\n' "$1"; fi
	REPORTED=$((REPORTED + 1))
	FOUND=1
}

scan_commit() {
	local c="$1"
	local short="${c:0:8}"
	SCANNED=$((SCANNED + 1))
	[ "$SCANNED" -gt "$MAX_COMMITS" ] && return

	# commit message
	local msg msg_err
	msg_err="$(mktemp)" || msg_err=/dev/null
	msg="$(git log -1 --format=%B "$c" 2>"$msg_err")" || {
		printf 'secret-guard: could not read the message of %s (%s) — that commit is unscanned\n' \
			"$short" "$(head -1 "$msg_err")" >&2
		SCAN_ERRORS=$((SCAN_ERRORS + 1))
		[ "$msg_err" = /dev/null ] || rm -f -- "$msg_err"
		return
	}
	[ "$msg_err" = /dev/null ] || rm -f -- "$msg_err"
	if [ -n "$msg" ]; then
		while IFS=$'\t' read -r name pat; do
			[ -z "$name" ] && continue
			if printf '%s\n' "$msg" | grep -qE -e "$pat" && ! printf '%s\n' "$msg" | grep -qiEf "$SAFE_PAT"; then
				report "possible $name in commit message of $short"
				break
			fi
		done < "$CONTENT_PAT"
	fi

	# Files this commit touches, not every file that happens to exist in its
	# tree. A file added long ago was scanned when it was added; rescanning it
	# on every later commit blocks pushes over something already in history,
	# which is how a public DH parameter file used to stop every push.
	local parent
	parent="$(git rev-parse -q --verify "$c^" 2>/dev/null)"
	if [ -n "$parent" ]; then
		changed() { git diff-tree -r --no-commit-id --name-only "$parent" "$c" 2>/dev/null; }
	else
		# Root commit: everything is new.
		changed() { git ls-tree -r --name-only "$c" 2>/dev/null; }
	fi

	# Filenames + contents of the changed files only.
	local f base content line rest status
	while IFS= read -r f; do
		[ -z "$f" ] && continue
		base="${f##*/}"
		# Deleted files have nothing left to scan.
		git cat-file -e "$c:$f" 2>/dev/null || continue
		if printf '%s\n' "$f" | grep -qEf "$NAME_PAT" && ! printf '%s\n' "$base" | grep -qiEf "$SAFE_PAT"; then
			report "secret-looking filename in $short: $f"
			continue
		fi
		content="$(git show "$c:$f" 2>/dev/null)" || continue
		[ -z "$content" ] && continue
		while IFS=$'\t' read -r name pat; do
			[ -z "$name" ] && continue
			while IFS= read -r line; do
				rest="${line#*:}"
				if printf '%s\n' "$rest" | grep -qiEf "$SAFE_PAT" >/dev/null; then continue; fi
				report "possible $name in $short:$f:${line%%:*}"
			done < <(printf '%s\n' "$content" | grep -nE -e "$pat")
		done < "$CONTENT_PAT"
	done < <(changed)
}

# pre-push feeds ref lines on stdin: "<local ref> <local sha> <remote ref> <remote sha>"
SCAN_ERRORS=0
while read -r local_ref local_sha remote_ref remote_sha; do
	[ -z "$local_ref" ] && continue
	[ "$local_sha" = "$ZERO" ] && continue # branch deletion — nothing to scan

	if [ "$remote_sha" = "$ZERO" ]; then
		# new branch: commits not reachable from any remote-tracking ref
		commits="$(git rev-list "$local_sha" --not --remotes 2>&1)"
		rc=$?
	else
		commits="$(git rev-list "$remote_sha..$local_sha" 2>&1)"
		rc=$?
	fi
	# A ref git cannot read is not an empty push: the old silent `continue` here
	# let a push through unscanned, with no line saying the scan never happened.
	if [ "$rc" -ne 0 ]; then
		printf 'secret-guard: could not list the commits of %s..%s — %s\n' \
			"${remote_sha:0:8}" "${local_sha:0:8}" "$(printf '%s' "$commits" | head -1)" >&2
		printf 'secret-guard: this push was NOT scanned. Override on purpose: SKIP_SECRET_SCAN=1 git push, or git push --no-verify\n' >&2
		SCAN_ERRORS=$((SCAN_ERRORS + 1))
		continue
	fi
	[ -z "$commits" ] && continue

	while IFS= read -r c; do
		[ -z "$c" ] && continue
		scan_commit "$c"
	done <<< "$commits"
done

if [ "$SCANNED" -gt "$MAX_COMMITS" ]; then
	echo "secret-guard: warning — push contains >$MAX_COMMITS commits; scan truncated"
fi

# A scan that could not read everything is a failure, not a pass: an unscanned
# push reported as clean is the silent exit this file exists to prevent.
if [ "$FOUND" -eq 0 ] && [ "$SCAN_ERRORS" -gt 0 ]; then
	FOUND=1
fi

exit "$FOUND"
