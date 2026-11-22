#!/usr/bin/env bash
# records-lib.sh — one lock, one atomic write, for the JSON records the harness keeps.
#
# state/spaces/<slug>/delegations.json is written by `delegate spawn`, `delegate close` and the
# tab bookkeeping, and two of those can run at the same moment: each one did read → modify →
# `writeFileSync`, so the second write dropped the first one's new entry. That is how a live
# worker lost its record 16 minutes after spawn and `delegate finish` refused it — "it has no
# delegation record, so there is no worker to publish, wipe or close". A reader could also observe
# a half-written file, which the `try/catch` read turned into "no records at all".
#
# So every mutation of such a file is lock → read → modify → write `<file>.tmp.$$` → `mv -f` →
# unlock, and reads stay lock-free: the rename means a reader sees the whole old file or the whole
# new one, never a partial one. The lock is held for the milliseconds of one read-modify-write and
# never across a network call, a `git` operation or an `hc send`.
#
# Sourced, never executed: this file defines functions and no variables that outlive a call.
#   records_lock <file>            take the lock held beside <file>
#   records_unlock <file>          release the one records_lock took
#   records_read <file>            the file's JSON, or {} — never a hard failure
#   records_write <file>           stdin is the new JSON: temp file beside it, then mv -f
#   records_mutate <file> <node> [args…]   lock, run <node> with (file, args…), its stdout is the
#                                  new JSON, write it, unlock. One lock at a time, never nested.

# A lock directory (or file) older than this is broken: a killed process must not wedge a space
# forever. The critical section is milliseconds, so 30 s is generous rather than tight.
: "${RECORDS_STALE_SECONDS:=30}"
# How long records_lock waits before giving up: a writer that cannot get in 30 s is not waiting for
# milliseconds of work any more, and a silent wait is worse than the refusal that names the lock.
: "${RECORDS_LOCK_WAIT:=30}"

# records_age <path> — whole seconds since <path> was last modified, 0 when it cannot be read, so a
# lock that cannot be aged is treated as fresh and waited for rather than stolen.
records_age() {
	node -e 'try {
		const s = require("fs").statSync(process.argv[1]);
		process.stdout.write(String(Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000))));
	} catch { process.stdout.write("0"); }' "${1:-}" 2>/dev/null
}

# records_lock <file> — take `<file>.lock` with flock where flock is on PATH (Linux, CI), else the
# atomic `mkdir <file>.lock.d` retry loop (macOS, git-bash). A lock older than
# RECORDS_STALE_SECONDS is broken with one warning line naming the file and the age.
records_lock() {
	local file=${1:?records_lock needs a file} lock=$1.lock dir=$1.lock.d age broken=0 waited=0
	if command -v flock >/dev/null 2>&1; then
		eval "exec 9>>\"\$lock\"" || return 1
		if flock -w "$RECORDS_LOCK_WAIT" 9; then
			RECORDS_LOCK_KIND="flock"
			return 0
		fi
		exec 9>&-
		printf 'records: %s stayed locked for %ss, so nothing was written\n' "$lock" "$RECORDS_LOCK_WAIT" >&2
		return 1
	fi
	while :; do
		if mkdir "$dir" 2>/dev/null; then
			RECORDS_LOCK_KIND="mkdir"
			return 0
		fi
		age=$(records_age "$dir")
		if [ "${age:-0}" -ge "$RECORDS_STALE_SECONDS" ]; then
			broken=$((broken + 1))
			if [ "$broken" -gt 3 ]; then
				printf 'records: %s was stale three times running, so nothing was written\n' "$dir" >&2
				return 1
			fi
			printf 'records: warning: breaking the stale lock %s (%ss old) on %s\n' "$dir" "$age" "$file" >&2
			rm -rf "$dir"
			continue
		fi
		waited=$((waited + 1))
		if [ "$waited" -gt $((RECORDS_LOCK_WAIT * 10)) ]; then
			printf 'records: %s stayed locked for %ss, so nothing was written\n' "$dir" "$RECORDS_LOCK_WAIT" >&2
			return 1
		fi
		sleep 0.1
	done
}

# records_unlock <file> — release exactly what records_lock took, and only then.
records_unlock() {
	local file=${1:?records_unlock needs a file}
	case ${RECORDS_LOCK_KIND:-} in
	flock)
		flock -u 9 2>/dev/null
		exec 9>&-
		;;
	mkdir) rmdir "$file.lock.d" 2>/dev/null ;;
	esac
	RECORDS_LOCK_KIND=""
	return 0
}

# records_read <file> — the JSON in <file>, or `{}` when it is missing, empty or unparseable. A
# record that cannot be read is "no records", which is what every caller already handles; it is
# never a failure that stops a command.
records_read() {
	node -e '
		const fs = require("fs");
		let j = {};
		try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
		if (j === null || typeof j !== "object" || Array.isArray(j)) j = {};
		process.stdout.write(JSON.stringify(j, null, 2) + "\n");
	' "${1:?records_read needs a file}"
}

# records_write <file> — the new JSON on stdin, written to `<file>.tmp.$$` in the same directory
# and renamed onto <file>. Same directory, so the rename is atomic and no reader sees a partial
# file; a failed write leaves the old file exactly as it was.
records_write() {
	local file=${1:?records_write needs a file} tmp=$1.tmp.$$
	if ! cat >"$tmp"; then
		rm -f "$tmp"
		return 1
	fi
	if ! mv -f "$tmp" "$file"; then
		rm -f "$tmp"
		return 1
	fi
	return 0
}

# records_mutate <file> <node-script> [args…] — lock <file>, run the node script with the file as
# its first argument and [args…] after it, take its stdout as the new JSON, write atomically,
# unlock. The script reads the old JSON itself (inside the lock) and prints the whole new document;
# a script that exits non-zero changes nothing. Never nest two of these: one lock at a time.
records_mutate() {
	local file=${1:?records_mutate needs a file} script=${2:?records_mutate needs a script} out rc
	shift 2
	records_lock "$file" || return 1
	out=$(node -e "$script" "$file" "$@") && rc=0 || rc=$?
	if [ "$rc" -eq 0 ]; then
		printf '%s\n' "$out" | records_write "$file" || rc=$?
	fi
	records_unlock "$file"
	return "$rc"
}
