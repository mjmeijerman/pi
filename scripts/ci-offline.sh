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
# own temp directories, its own git config, no network and no model. This
# runner is deliberately dumb — it globs, runs each suite in its own process,
# and keeps going after a red one so a second failure is visible in the same
# run instead of hiding behind the first. The exit status is the count of
# failed suites, capped at 1.
#
# Run it by hand, or as `make offline-test`; harness-check.yml runs the same
# command, so a local verdict and the CI verdict cannot disagree.
#
# Usage: scripts/ci-offline.sh   (no options, nothing to configure)
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

shopt -s nullglob
suites=("$DIR"/test-*.sh "$DIR"/tests/test-*.sh)
shopt -u nullglob

if [ "${#suites[@]}" -eq 0 ]; then
	printf 'ci-offline: no scripts/test-*.sh found — the gate tests are missing, not green\n' >&2
	exit 1
fi

ran=0
failed=0
for suite in "${suites[@]}"; do
	ran=$((ran + 1))
	printf '\n== ci-offline: bash %s\n' "${suite#"$DIR"/}"
	if ! bash "$suite"; then
		failed=$((failed + 1))
		printf '== ci-offline: FAILED %s\n' "${suite#"$DIR"/}" >&2
	fi
done

printf '\n== ci-offline: %d suite(s), %d failed\n' "$ran" "$failed"
[ "$failed" -eq 0 ]
