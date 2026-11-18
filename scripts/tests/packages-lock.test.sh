#!/usr/bin/env bash
# Tests for the package pin: `scripts/harness-check.sh --write-packages-lock`
# writes agent/packages.lock from what is installed, `--verify-packages-lock
# reads it back and refuses drift.
#
# Why these exist: a package in agent/settings.json `packages` is fetched by URL or
# branch, so the code this harness runs can change with no diff anywhere (blip #72
# agent package manager, blip #7 plugin marketplace, blip #17). Every promise the
# lock makes is one case here, run against the real harness-check.sh in a throwaway
# root and a throwaway PI_AGENT_HOME — a fixture copy of the script would drift away
# from the script that ships, and a fixture that read the machine's own installed
# packages would pass or fail depending on whose laptop ran it.
#
# Every case is offline and self-contained: temp roots under one mktemp -d, git
# config neutralised, no network, and PI_AGENT_HOME pointing inside the fixture.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$ROOT_DIR/scripts/harness-check.sh"
[ -f "$CHECK" ] || {
	printf 'FATAL: %s is missing\n' "$CHECK" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

PASS_N=0
FAIL_N=0
CASE_N=0
CASE=""
ROOT=""
AGENT=""

pass() { PASS_N=$((PASS_N + 1)); printf 'ok   %s: %s\n' "$CASE" "$1"; }
fail() {
	FAIL_N=$((FAIL_N + 1))
	printf 'FAIL %s: %s\n' "$CASE" "$1"
	shift
	while [ "$#" -gt 0 ]; do printf '       %s\n' "$1"; shift; done
}

# A fresh harness-shaped root plus an empty pi home, one per case. The two
# packages are one of each kind on purpose: a git source and an npm source are
# pinned by different things, so both paths have to be exercised.
new_root() {
	CASE_N=$((CASE_N + 1))
	CASE=$1
	ROOT="$WORK/case$CASE_N/root"
	AGENT="$WORK/case$CASE_N/agent"
	mkdir -p "$ROOT/agent" "$AGENT"
	cat >"$ROOT/agent/settings.json" <<'EOF'
{
  "packages": [
    "git:https://github.com/acme/one.git",
    "npm:demo-pkg"
  ]
}
EOF
	export PI_AGENT_HOME="$AGENT"
}

# The installed copy of the git package: a real repository, so the pin is a real
# commit and moving it is a real reinstall.
install_git() {
	mkdir -p "$AGENT/git/github.com/acme/one"
	git init -q "$AGENT/git/github.com/acme/one" >/dev/null 2>&1
	printf 'v1\n' >"$AGENT/git/github.com/acme/one/index.js"
	git -C "$AGENT/git/github.com/acme/one" add -A >/dev/null 2>&1
	git -C "$AGENT/git/github.com/acme/one" -c commit.gpgsign=false \
		commit -q -m 'package v1' >/dev/null 2>&1
	git -C "$AGENT/git/github.com/acme/one" rev-parse HEAD
}

# A second commit: the branch moved and pi reinstalled it.
advance_git() {
	printf 'v2\n' >>"$AGENT/git/github.com/acme/one/index.js"
	git -C "$AGENT/git/github.com/acme/one" add -A >/dev/null 2>&1
	git -C "$AGENT/git/github.com/acme/one" -c commit.gpgsign=false \
		commit -q -m 'package v2' >/dev/null 2>&1
	git -C "$AGENT/git/github.com/acme/one" rev-parse HEAD
}

# The installed copy of the npm package, with the tarball hash npm records in its
# own lock — the lock file's `integrity` column has to come from there, not from a
# guess about the contents of node_modules.
install_npm() {
	mkdir -p "$AGENT/npm/node_modules/demo-pkg"
	printf '{"name":"demo-pkg","version":"%s"}\n' "$1" \
		>"$AGENT/npm/node_modules/demo-pkg/package.json"
	cat >"$AGENT/npm/package-lock.json" <<EOF
{
  "packages": {
    "node_modules/demo-pkg": {
      "version": "$1",
      "resolved": "https://registry.npmjs.org/demo-pkg/-/demo-pkg-$1.tgz",
      "integrity": "sha512-AAAAdemoPkgTarballHash=="
    }
  }
}
EOF
}

write_lock() { bash "$CHECK" --root "$ROOT" --write-packages-lock; }
verify_lock() { bash "$CHECK" --root "$ROOT" --verify-packages-lock; }
lock_file() { printf '%s/agent/packages.lock' "$ROOT"; }
field() { awk -F'\t' -v s="$1" -v n="$2" '$1==s{print $n}' "$(lock_file)"; }

# ---------------------------------------------------------------- no lock yet --
new_root 'a root with no lock'
install_git >/dev/null
install_npm 1.2.3
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'fails when agent/packages.lock is missing'; else fail 'expected a failing verify, got exit 0' "$out"; fi
case $out in
*--write-packages-lock*) pass 'names the exact regenerate command' ;;
*) fail 'the message does not name the regenerate command' "$out" ;;
esac
case $out in
*'2 package(s) are unpinned'*) pass 'counts the packages that are unpinned' ;;
*) fail 'the message does not count the unpinned packages' "$out" ;;
esac

# ------------------------------------------------ a root that names no package --
CASE_N=$((CASE_N + 1))
CASE='a root that names no package'
ROOT="$WORK/case$CASE_N/root"
AGENT="$WORK/case$CASE_N/agent"
mkdir -p "$ROOT/agent" "$AGENT"
export PI_AGENT_HOME="$AGENT"
printf '{"theme":"dark"}\n' >"$ROOT/agent/settings.json"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'a root with no packages is not a failure'; else fail 'a root without packages failed the lock check' "$out"; fi

# ------------------------------------- writing refuses an unresolved package --
new_root 'writing with nothing installed'
out=$(write_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'refuses to write a lock with no resolved pin'; else fail 'wrote a lock with nothing to pin' "$out"; fi
case $out in
*'nothing installed to pin for:'*) pass 'says what could not be resolved' ;;
*) fail 'does not say what could not be resolved' "$out" ;;
esac
if [ -f "$(lock_file)" ]; then fail 'a failed write still created the lock' "$(cat "$(lock_file)")"; else pass 'no lock file was left behind'; fi

# ------------------------------------------------------------------ writes it --
new_root 'writing the lock'
git_sha=$(install_git)
install_npm 1.2.3
out=$(write_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'write exits 0'; else fail 'write failed' "$out"; fi
if [ -f "$(lock_file)" ]; then pass 'agent/packages.lock exists'; else fail 'no agent/packages.lock was written'; fi
if [ "$(field 'git:https://github.com/acme/one.git' 3)" = "$git_sha" ]; then
	pass "pins the installed git commit ($git_sha)"
else
	fail 'the git pin is not the installed commit' "lock: $(field 'git:https://github.com/acme/one.git' 3)" "git:  $git_sha"
fi
if [ "$(field 'git:https://github.com/acme/one.git' 2)" = git ]; then
	pass 'records the kind as git'
else
	fail 'the kind column is not git' "$(cat "$(lock_file)")"
fi
if [ "$(field 'git:https://github.com/acme/one.git' 5)" = 'agent/git/github.com/acme/one' ]; then
	pass 'records where the git package is installed'
else
	fail 'the where column for the git source is wrong' "lock: $(field 'git:https://github.com/acme/one.git' 5)"
fi
if [ "$(field 'npm:demo-pkg' 3)" = 1.2.3 ]; then
	pass 'pins the installed npm version'
else
	fail 'the npm pin is not the installed version' "lock: $(field 'npm:demo-pkg' 3)"
fi
if [ "$(field 'npm:demo-pkg' 4)" = 'sha512-AAAAdemoPkgTarballHash==' ]; then
	pass "pins npm's tarball integrity"
else
	fail 'the integrity column does not match npm package-lock.json' "lock: $(field 'npm:demo-pkg' 4)"
fi
if [ "$(field 'npm:demo-pkg' 5)" = 'agent/npm/node_modules/demo-pkg' ]; then
	pass 'records where the npm package is installed'
else
	fail 'the where column for the npm source is wrong' "lock: $(field 'npm:demo-pkg' 5)"
fi
case "$(field 'npm:demo-pkg' 6)" in
[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) pass 'records the date it was resolved (UTC)' ;;
*) fail 'the date column is not YYYY-MM-DD' "lock: $(field 'npm:demo-pkg' 6)" ;;
esac
if grep -q '^#' "$(lock_file)"; then pass 'carries a header that says it is generated'; else fail 'the lock has no header' "$(cat "$(lock_file)")"; fi
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'a freshly written lock verifies'; else fail 'fresh lock does not verify' "$out"; fi
cp "$(lock_file)" "$WORK/first-lock"
out=$(write_lock 2>&1)
if diff -q "$WORK/first-lock" "$(lock_file)" >/dev/null; then
	pass 'rewriting the same install produces the same table'
else
	fail 'a second write over an unchanged install changed the file' "$(diff "$WORK/first-lock" "$(lock_file)")"
fi

# ------------------------------------------------- the branch moved under us --
new_root 'a reinstalled branch that moved'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
new_sha=$(advance_git)
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'a moved branch fails the check'; else fail 'a reinstalled package with a new sha passed' "$out"; fi
case $out in
*'git:https://github.com/acme/one.git'*) pass 'the FAIL names the source' ;;
*) fail 'the FAIL does not name the source' "$out" ;;
esac
case $out in
*"${new_sha:0:12}"*) pass 'the FAIL shows the sha installed now' ;;
*) fail 'the FAIL does not show the new sha' "$out" ;;
esac
case $out in
*--write-packages-lock*) pass 'the FAIL carries the regenerate command' ;;
*) fail 'the FAIL has no regenerate command' "$out" ;;
esac
write_lock >/dev/null
out=$(verify_lock 2>&1) || fail 'regenerating after a reviewed change does not verify' "$out"
pass 'regenerating clears it'

# --------------------------------------------------- a version that moved too --
new_root 'an npm version that moved'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
install_npm 1.2.4
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'a new npm version fails the check'; else fail 'a bumped npm package passed' "$out"; fi
case $out in
*'npm:demo-pkg'*) pass 'the FAIL names the npm source' ;;
*) fail 'the FAIL does not name the npm source' "$out" ;;
esac

# ------------------------------------ a package settings.json stopped naming --
new_root 'a package settings.json dropped'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
cat >"$ROOT/agent/settings.json" <<'EOF'
{
  "packages": [
    "git:https://github.com/acme/one.git"
  ]
}
EOF
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'an entry settings.json dropped fails'; else fail 'a stale entry passed' "$out"; fi
case $out in
*'npm:demo-pkg is locked but agent/settings.json no longer names it'*) pass 'says which package settings.json dropped' ;;
*) fail 'the FAIL does not name the dropped package' "$out" ;;
esac

# --------------------------------------- a package settings.json added, no entry --
new_root 'a package with no lock entry'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
cat >"$ROOT/agent/settings.json" <<'EOF'
{
  "packages": [
    "git:https://github.com/acme/one.git",
    "npm:demo-pkg",
    "git:github.com/acme/two"
  ]
}
EOF
mkdir -p "$AGENT/git/github.com/acme/two"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass 'a source with no entry fails'; else fail 'an unpinned package passed' "$out"; fi
case $out in
*'git:github.com/acme/two'*) pass 'the FAIL names the unpinned package' ;;
*) fail 'the FAIL does not name the unpinned package' "$out" ;;
esac
case $out in
*'no lock entry'*) pass 'says there is no lock entry' ;;
*) fail 'the FAIL does not say a lock entry is missing' "$out" ;;
esac

# ------------------------------------------------------ a blank pin in the lock --
new_root 'a lock that records no pin'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
awk -F'\t' -v OFS='\t' '$1=="npm:demo-pkg"{$3="-"} {print}' "$(lock_file)" >"$WORK/blank"
mv "$WORK/blank" "$(lock_file)"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then pass "'-' in the pin column fails"; else fail 'a lock with no pin passed' "$out"; fi
case $out in
*'no pin recorded'*) pass 'says no pin was recorded' ;;
*) fail 'the FAIL does not say the pin is missing' "$out" ;;
esac

# ------------------------------------------------ not installed on this machine --
new_root 'a lock whose packages are not installed here'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
rm -rf "${AGENT:?}/git" "${AGENT:?}/npm"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'an uninstalled package is not a FAIL (offline runs stay green)'; else fail 'a package that is not installed here failed the run' "$out"; fi
case $out in
*'not installed here'*) pass 'warns that the pin was not compared' ;;
*) fail 'no WARN says the pin was not compared' "$out" ;;
esac
case $out in
*'git ls-remote https://github.com/acme/one.git HEAD'*) pass 'names the command that answers it' ;;
*) fail 'the WARN does not name git ls-remote' "$out" ;;
esac
case $out in
*'npm view demo-pkg version'*) pass 'names the npm equivalent' ;;
*) fail 'the WARN does not name npm view' "$out" ;;
esac

# -------------------------------------------------------- an empty pi home --
new_root 'a pi home that holds nothing'
install_git >/dev/null
install_npm 1.2.3
write_lock >/dev/null
export PI_AGENT_HOME="$WORK/case$CASE_N/elsewhere"
out=$(verify_lock 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then pass 'an empty pi home is a WARN, not a FAIL'; else fail 'an empty pi home failed the run' "$out"; fi

# ------------------------------------------------------------------- summary --
printf '\n%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" -eq 0 ]
