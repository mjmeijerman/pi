#!/usr/bin/env bash
# ============================================================================
# scripts-test.sh — the bash half of `make scripts-test`, run in parallel.
#
# Radar basis: #29 harness quality evaluation (a gate whose passing case was
# never run is a gate that can go dead quietly) and #38 CI hardening.
#
# scripts/tests/*.test.sh are the gate tests that need a shell rather than node.
# They do not depend on each other and each builds its own temp directory, so
# running them one after another made the wall clock their sum: 58s in CI and
# 47s locally, a third of it this loop. Same shape as `scripts/ci-offline.sh
# --jobs`: at most JOBS at a time, each suite logging into $TMPDIR, and the
# blocks printed whole in glob order, so two runs of the same tree read the same
# however they finish. `JOBS=1` is the serial run, byte for byte.
#
# The exit status is the failure count capped at 1, so a red suite is named
# (`== scripts-test: FAILED <suite> (exit N)`, on stderr) and the rest still run
# — one failure no longer hides the next.
#
# A suite that writes inside the checkout would race another one, so every suite
# is expected to make its own temp directory; `git status --porcelain` after a
# parallel run is the check that none does.
#
# Usage: scripts/scripts-test.sh [--jobs N] [--dir DIR]
#   N defaults to $JOBS, then $(nproc). DIR defaults to scripts/tests.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/scripts/tests"

JOBS=${JOBS:-$(nproc 2>/dev/null || echo 4)}
while [ "$#" -gt 0 ]; do
	case $1 in
	--jobs)
		[ "$#" -ge 2 ] || {
			printf 'scripts-test: --jobs needs a number\n' >&2
			exit 2
		}
		JOBS=$2
		shift 2
		;;
	--jobs=*)
		JOBS=${1#--jobs=}
		shift
		;;
	--dir)
		[ "$#" -ge 2 ] || {
			printf 'scripts-test: --dir needs a path\n' >&2
			exit 2
		}
		DIR=$2
		shift 2
		;;
	--dir=*)
		DIR=${1#--dir=}
		shift
		;;
	-h | --help)
		sed -n '2,/^# Usage:/p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		printf 'scripts-test: unknown argument: %s\n' "$1" >&2
		exit 2
		;;
	esac
done
case $JOBS in '' | *[!0-9]* | 0)
	printf 'scripts-test: --jobs takes a positive number, not %s\n' "$JOBS" >&2
	exit 2
	;;
esac

DIRABS="$(cd "$DIR" 2>/dev/null && pwd)" || {
	printf 'scripts-test: no such directory: %s\n' "$DIR" >&2
	exit 2
}

shopt -s nullglob
suites=("$DIRABS"/*.test.sh)
shopt -u nullglob

# The block header is a path the reader can paste: relative to the checkout
# when the suites live in it, absolute otherwise.
DIRPRINT=$DIR
case $DIRABS/ in
"$PWD"/*) DIRPRINT=${DIRABS#"$PWD"/} ;;
esac

if [ "${#suites[@]}" -eq 0 ]; then
	# An empty glob is a verdict of its own: the gate tests are missing, not green.
	printf 'scripts-test: no %s/*.test.sh found — the gate tests are missing, not green\n' "$DIRPRINT" >&2
	exit 1
fi

total=${#suites[@]}
RUN=${TMPDIR:-/tmp}/pi-scripts-test/$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$RUN" || {
	printf 'scripts-test: cannot create %s\n' "$RUN" >&2
	exit 2
}

LOG=()
PID=()
used=0
finished=0
printed=0
failed=0

# The block for suite N, in glob order: a suite whose rc file exists is done, so
# its block appears the moment every suite before it has been printed.
st_flush() {
	local body rc
	while [ "$printed" -lt "$total" ] && [ "$printed" -lt "${#LOG[@]}" ]; do
		[ -f "${LOG[printed]}.rc" ] || return 0
		body=$DIRPRINT/$(basename -- "${suites[printed]}")
		read -r rc <"${LOG[printed]}.rc" || rc=1
		case $rc in '' | *[!0-9]*) rc=1 ;; esac
		printf '== scripts-test: bash %s\n' "$body"
		cat -- "${LOG[printed]}"
		if [ -s "${LOG[printed]}" ] && [ -n "$(tail -c 1 -- "${LOG[printed]}")" ]; then
			printf '\n'
		fi
		if [ "$rc" -ne 0 ]; then
			failed=$((failed + 1))
			printf '== scripts-test: FAILED %s (exit %s)\n' "$body" "$rc" >&2
		fi
		printed=$((printed + 1))
	done
}

while [ "$finished" -lt "$total" ]; do
	while [ "$used" -lt "$JOBS" ] && [ "$finished" -lt "$total" ] && [ "$((${#LOG[@]}))" -lt "$total" ]; do
		i=$((${#LOG[@]}))
		LOG[i]=$RUN/$i.log
		(
			bash "${suites[i]}" >"${LOG[i]}" 2>&1
			printf '%s\n' "$?" >"${LOG[i]}.rc"
		) &
		PID[i]=$!
		used=$((used + 1))
	done

	[ "$used" -gt 0 ] || break

	# Poll rather than `wait -n`, which bash 4.3 has none of: the rc file is the
	# signal, so a finished suite is counted immediately instead of waiting for
	# its whole batch.
	for _ in $(seq 1 50); do
		moved=0
		for ((i = 0; i < ${#LOG[@]}; i++)); do
			[ -n "${PID[i]:-}" ] || continue
			[ -f "${LOG[i]}.rc" ] || continue
			wait "${PID[i]}" 2>/dev/null || true
			PID[i]=""
			used=$((used - 1))
			finished=$((finished + 1))
			moved=1
		done
		[ "$moved" = 0 ] || break
		sleep 0.02
	done
	st_flush
done
st_flush

[ "$failed" -eq 0 ] || printf '== scripts-test: %d of %d bash suite(s) failed\n' "$failed" "$total" >&2
[ "$failed" -eq 0 ]
