#!/usr/bin/env bash
# ============================================================================
# ci-offline.sh — every gate test that needs no network, run in one command.
#
# Radar basis: #29 harness quality evaluation (a gate whose passing case was
# never run is a gate that can go dead quietly), #38 CI hardening, #72 agent
# package manager, #7 agent plugin marketplace.
#
# scripts/test-*.sh is the contract, and scripts/tests/test-*.sh is the same
# contract in its own folder once a suite grows past one file: one file per behaviour, plain bash, its
# own temp directories, its own git config, no network and no model. This runner is deliberately
# dumb — it globs, runs each suite in its own process, and keeps going after a red one so a second
# failure is visible in the same run instead of hiding behind the first. The exit status is the
# count of failed suites, capped at 1.
#
# The suites do not depend on each other, so they run at most --jobs at a time: the wall clock is
# the slowest suite instead of their sum (63s → about 20s on a 30-suite checkout). Each suite writes
# to its own log under $TMPDIR/pi-ci-offline/<run>/ and its block is printed whole, in the order the
# suites were globbed, the moment it and every suite before it have finished. That is why the report
# a human reads is unchanged: `== ci-offline: bash <suite>`, the suite's own output, and on a red
# one `== ci-offline: FAILED <suite>`. `--jobs 1` is the serial run, byte for byte the old order.
#
# A suite that writes inside the checkout would race another one, so every suite is expected to make
# its own temp directory; `git status --porcelain` after a parallel run is the check that none does.
#
# Run it by hand, or as `make offline-test`; harness-check.yml runs the same command, so a local
# verdict and the CI verdict cannot disagree.
#
# Usage: scripts/ci-offline.sh [--jobs N]   (N defaults to $(nproc))
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JOBS=$(nproc 2>/dev/null || echo 4)
while [ "$#" -gt 0 ]; do
	case $1 in
	--jobs)
		[ "$#" -ge 2 ] || {
			printf 'ci-offline: --jobs needs a number\n' >&2
			exit 2
		}
		JOBS=$2
		shift 2
		;;
	--jobs=*)
		JOBS=${1#--jobs=}
		shift
		;;
	-h | --help)
		sed -n '2,/^# Usage:/p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		printf 'ci-offline: unknown argument: %s\n' "$1" >&2
		exit 2
		;;
	esac
done
case $JOBS in '' | *[!0-9]* | 0)
	printf 'ci-offline: --jobs takes a positive number, not %s\n' "$JOBS" >&2
	exit 2
	;;
esac

shopt -s nullglob
suites=("$DIR"/test-*.sh "$DIR"/tests/test-*.sh)
shopt -u nullglob

if [ "${#suites[@]}" -eq 0 ]; then
	printf 'ci-offline: no scripts/test-*.sh found — the gate tests are missing, not green\n' >&2
	exit 1
fi

total=${#suites[@]}
RUN=${TMPDIR:-/tmp}/pi-ci-offline/$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$RUN" || {
	printf 'ci-offline: cannot create %s\n' "$RUN" >&2
	exit 2
}

LOG=()
PID=()
used=0
finished=0
printed=0
failed=0

# The last block, flushed in glob order: a suite whose log exists and whose rc is written is done,
# so its block can be printed the moment everything before it has been.
ci_flush() {
	local body rc
	while [ "$printed" -lt "$total" ] && [ "$printed" -lt "${#LOG[@]}" ]; do
		[ -f "${LOG[printed]}.rc" ] || return 0
		body=${suites[printed]#"$DIR"/}
		read -r rc <"${LOG[printed]}.rc" || rc=1
		case $rc in '' | *[!0-9]*) rc=1 ;; esac
		printf '\n== ci-offline: bash %s\n' "$body"
		cat -- "${LOG[printed]}"
		if [ -s "${LOG[printed]}" ] && [ -n "$(tail -c 1 -- "${LOG[printed]}")" ]; then
			printf '\n'
		fi
		if [ "$rc" -ne 0 ]; then
			failed=$((failed + 1))
			printf '== ci-offline: FAILED %s\n' "$body" >&2
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

	# Poll rather than `wait -n`, which bash 4.3 has none of: the rc file is the signal, so a suite
	# that finished is counted immediately and its block appears without waiting for its batch.
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
	ci_flush
done
ci_flush

printf '\n== ci-offline: %d suite(s), %d failed\n' "$total" "$failed"
[ "$failed" -eq 0 ]
