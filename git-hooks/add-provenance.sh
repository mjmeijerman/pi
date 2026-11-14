#!/usr/bin/env bash
# add-provenance.sh — commit-msg: append the agent's trailers while the message
# is still being written, instead of refusing the commit afterwards.
#
# Radar basis: #79 (Trial) — a commit that names the agent that wrote it can be
# resolved; one that does not is a claim nobody can check once it has landed.
#
# Why at commit time: `delegate close` refuses a report whose commit has no
# Agent-Slug trailer, and that check is correct but late — by then the branch is
# usually merged, and amending a merged commit means rewriting trunk, which the
# harness forbids. The hook sees every message its worker writes, so the trailer
# is there long before the check could fail.
#
# Behaviour, and each line of it is a test in scripts/tests/commit-msg-provenance.test.sh:
#   - no slug in the environment (AGENT_SLUG, or PI_AGENT_SLUG) -> nothing runs,
#     the message is byte-identical, a human commit is untouched
#   - trailers already there -> nothing runs, so an amend, rebase or re-run
#     never duplicates or rewrites them
#   - a comment-only (or empty) message -> nothing runs: git still aborts on it
#     rather than committing a message whose only content is a trailer
#   - otherwise the trailers go last, after any trailer already in the message
#   - silent on success, one line on stderr and a non-zero exit when it cannot
#     do its job. `git commit --no-verify` bypasses it, like every hook.
set -u

SLUG="${AGENT_SLUG:-${PI_AGENT_SLUG:-}}"
[ -n "$SLUG" ] || exit 0

MSG_FILE="${1:-}"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
	printf 'add-provenance: AGENT_SLUG=%s is set but there is no commit message file to stamp (%s)\n' \
		"$SLUG" "${MSG_FILE:-no file argument}" >&2
	exit 1
fi

# The slug is a path segment in the Spec trailer, so a value that is not a slug
# is refused loudly instead of written into the message.
case "$SLUG" in
[!a-z0-9]* | *[!a-z0-9-]*)
	printf 'add-provenance: AGENT_SLUG="%s" is not a worker slug (lowercase letters, digits, dashes)\n' \
		"$SLUG" >&2
	exit 1
	;;
esac

need_slug=1
need_spec=1
grep -qE '^Agent-Slug:[[:space:]]*[^[:space:]]' "$MSG_FILE" && need_slug=0
grep -qE '^Spec:[[:space:]]*[^[:space:]]' "$MSG_FILE" && need_spec=0
[ "$need_slug" = 0 ] && [ "$need_spec" = 0 ] && exit 0

# Nothing but comments and blank lines: git will discard this message, and a
# trailer appended to it would turn a refused empty commit into an empty one
# that commits.
if ! grep -qvE '^[[:space:]]*(#|$)' "$MSG_FILE"; then
	exit 0
fi

TMP="$MSG_FILE.add-provenance.$$"
# Trailing blank lines are not part of the message; dropping them is what puts
# the trailers on the last line, after any trailer the author already wrote.
if ! awk '{ line[NR] = $0 } END { n = NR; while (n > 0 && line[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print line[i] }' \
	"$MSG_FILE" >"$TMP"; then
	printf 'add-provenance: could not rewrite %s, so the message carries no trailers\n' "$MSG_FILE" >&2
	rm -f -- "$TMP"
	exit 1
fi

# A body that already ends in a trailer block keeps one block: git joins the new
# lines to it, the way `git interpret-trailers` would. A trailer block is the
# last run of `token: value` lines, and it starts after a blank line — so the
# single line "feat: prefixed" is a subject, not a trailer, and still gets the
# blank line that separates a body from the trailers below it.
sep=1
if [ -s "$TMP" ]; then
	sep=$(awk '
		{ line[NR] = $0 }
		END {
			if (NR == 0) { print 1; exit }
			if (line[NR] !~ /^[A-Za-z0-9-]+:[[:space:]]/) { print 1; exit }
			if (NR > 1 && (line[NR - 1] ~ /^[[:space:]]*$/ ||
				line[NR - 1] ~ /^[A-Za-z0-9-]+:[[:space:]]/)) { print 0; exit }
			print 1
		}' "$TMP")
fi

{
	if [ "$sep" = 1 ] && [ -s "$TMP" ]; then printf '\n'; fi
	if [ "$need_slug" = 1 ]; then printf 'Agent-Slug: %s\n' "$SLUG"; fi
	if [ "$need_spec" = 1 ]; then printf 'Spec: specs/%s.md\n' "$SLUG"; fi
} >>"$TMP"

if ! mv -- "$TMP" "$MSG_FILE"; then
	printf 'add-provenance: could not replace %s, so the message carries no trailers\n' "$MSG_FILE" >&2
	exit 1
fi

exit 0
