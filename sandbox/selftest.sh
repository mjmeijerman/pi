#!/usr/bin/env bash
# selftest.sh — prove the pi-sandbox policy actually holds.
#
# Radar Vol. 35: blip 1 (agent sandboxing, Adopt), blip 29 (harness quality
# evaluation — the policy is only as good as the check that it still holds).
#
# Runs non-interactive commands inside the sandbox (never an interactive pi
# session) and prints one PASS/FAIL line per assertion. Exits non-zero when
# anything fails.
#
# cwd-independent: the launcher's policy changes with the current directory, so
# this creates its own work directory under $HOME and runs every assertion from
# there. It prints the directory it chose.
set -uo pipefail

here=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
launcher=$here/pi-sandbox.sh
timeout_s=60
: "${HOME:?HOME is not set}"

failures=0
ok() {
	printf 'PASS  %s\n' "$1"
}
bad() {
	printf 'FAIL  %s\n' "$1"
	[ -n "${2:-}" ] && printf '      %s\n' "$2"
	failures=$((failures + 1))
}

# inside [launcher flags...] -- script...
# stdout only: the launcher prints its own notices on stderr, and a notice is not
# sandbox content. Commands that need error text merge it themselves with 2>&1.
inside() {
	timeout "$timeout_s" "$launcher" "$@" 2>/dev/null
}

[ -x "$launcher" ] || {
	printf 'FAIL  launcher not executable: %s\n' "$launcher"
	exit 1
}

# Pick a work directory inside $HOME/.pi: it sits in the sandbox's read-write
# bind, so the result does not depend on where the operator was standing when
# they ran this, and it is not a broad parent the launcher is right to refuse.
rundir=$(mktemp -d "$HOME/.pi/.sandbox-selftest.XXXXXX") || {
	printf 'FAIL  cannot create a work directory under %s/.pi\n' "$HOME"
	exit 1
}
cleanup() {
	rm -rf "$rundir"
	rm -f "$HOME/.pi/.sandbox-write-test" "$HOME/.sandbox-write-test"
}
# shellcheck disable=SC2329 # invoked through the EXIT trap below
trap cleanup EXIT
printf 'work directory: %s\n\n' "$rundir"
cd "$rundir" || exit 1

# 1. pi is on PATH inside the sandbox.
out=$(inside --exec -- sh -c 'command -v pi')
rc=$?
if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
	ok "pi is on PATH inside the sandbox ($out)"
else
	bad "pi is on PATH inside the sandbox" "rc=$rc out=$out"
fi

# 2. ... and it actually starts.
out=$(inside --no-net -- --version)
rc=$?
if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
	ok "pi --version runs inside the sandbox ($(printf '%s' "$out" | tail -n 1))"
else
	bad "pi --version runs inside the sandbox" "rc=$rc out=$out"
fi

# 3. ~/.ssh is empty or absent.
out=$(inside --exec -- sh -c 'ls -A "$HOME/.ssh" 2>&1')
rc=$?
if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
	ok "~/.ssh is hidden ($([ "$rc" -ne 0 ] && echo absent || echo empty))"
else
	bad "~/.ssh is hidden" "visible entries: $out"
fi

# 4. pi's credential store holds only the allowed providers.
out=$(inside --exec -- sh -c 'node -e "const j=JSON.parse(require(\"node:fs\").readFileSync(process.env.HOME+\"/.pi/agent/auth.json\",\"utf8\"));const s=j.providers||j;console.log(Object.keys(s).join(\",\")||\"empty\")"' 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
	ok "credential store unreadable (absent)"
elif [ "$out" = "empty" ] || [ "$out" = "deepseek" ]; then
	ok "credential store limited to: ${out:-empty}"
else
	bad "credential store limited to the default provider" "unexpected providers: $out"
fi

# 5. other credential stores are gone too.
out=$(inside --exec -- sh -c 'ls -A "$HOME/.gnupg" "$HOME/.aws" "$HOME/.config/gh" 2>&1')
entries=$(printf '%s\n' "$out" | grep -v -e 'No such file or directory' -e '^$' -e '^Cannot access' | grep -v -E "^$HOME/[.]?(gnupg|aws|config/gh):?$" || true)
if [ -z "$entries" ]; then
	ok "~/.gnupg, ~/.aws and ~/.config/gh are hidden"
else
	bad "~/.gnupg, ~/.aws and ~/.config/gh are hidden" "$entries"
fi

# 6. dotenv files are visible as empty files.
host_env=$HOME/projects/jurysysteem/.env
if [ -s "$host_env" ]; then
	out=$(inside --exec -- sh -c "wc -c < '$host_env' 2>&1")
	rc=$?
	if [ "$rc" -ne 0 ] || [ "$(printf '%s' "$out" | tr -d ' ')" = 0 ]; then
		ok "dotenv files are masked ($(basename "$host_env") reads empty)"
	else
		bad "dotenv files are masked" "$host_env still has $out bytes"
	fi
else
	ok "dotenv files are masked (no populated sample on this host, skipped)"
fi

# 7. write allowed inside the sandbox work dir ($HOME/.pi is always read-write,
#    whether or not this script lives there).
out=$(inside --exec -- sh -c 'echo ok > "$HOME/.pi/.sandbox-write-test" && echo wrote')
rc=$?
if [ "$rc" -eq 0 ]; then
	ok "writing to $HOME/.pi/ succeeds"
else
	bad "writing to $HOME/.pi/ succeeds" "$out"
fi

# 8. write refused outside the writable set.
out=$(inside --exec -- sh -c 'touch /usr/local/.t 2>&1 && echo wrote')
rc=$?
if [ "$rc" -ne 0 ]; then
	ok "writing to /usr/local/ is refused"
else
	bad "writing to /usr/local/ is refused" "the file was created"
fi

# 9. network is blocked with --no-net.
out=$(inside --no-net --exec -- sh -c 'curl -sS -m 5 https://example.com >/dev/null 2>&1 && echo net-ok')
rc=$?
if [ "$rc" -ne 0 ]; then
	ok "network blocked with --no-net"
else
	bad "network blocked with --no-net" "curl succeeded"
fi

# 10. network works by default.
out=$(inside --exec -- sh -c 'curl -sS -m 10 https://example.com >/dev/null 2>&1 && echo net-ok')
rc=$?
if [ "$rc" -eq 0 ]; then
	ok "network allowed by default"
else
	bad "network allowed by default" "curl exited $rc"
fi

# 11. the rest of the home directory simply is not there: only the trees the
#     launcher names are bound, so a checkout sitting in $HOME is not visible.
out=$(inside --exec -- sh -c 'ls "$HOME"' 2>&1)
allowed='^(achterhoek-uitagenda|pi-projects|projects|git-templates|gitconfig|pi)$'
unexpected=$(printf '%s\n' "$out" | sed 's/^\.//' | grep -v -E "$allowed" || true)
if [ -z "$unexpected" ]; then
	ok "only the allow-listed home entries are visible"
else
	bad "only the allow-listed home entries are visible" "$(printf '%s' "$unexpected" | tr '\n' ' ')"
fi

# 12. started in $HOME itself, the sandbox comes up and says so on stderr.
out=$(cd "$HOME" && timeout "$timeout_s" "$launcher" --exec -- true 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
	ok "the sandbox starts from \$HOME"
else
	bad "the sandbox starts from \$HOME" "rc=$rc out=$out"
fi
case $out in
*'$HOME is read-only inside the sandbox'*) ok "the \$HOME case prints the read-only notice" ;;
*) bad "the \$HOME case prints the read-only notice" "$out" ;;
esac

# 13. ... with $HOME unwritable and $HOME/.pi still writable.
out=$(cd "$HOME" && timeout "$timeout_s" "$launcher" --exec -- sh -c '
	echo x > "$HOME/.sandbox-write-test" 2>/dev/null && echo home-wrote
	echo y > "$HOME/.pi/.sandbox-write-test" 2>/dev/null && echo pi-wrote
' 2>/dev/null)
case $out in
*home-wrote*) bad "writing to \$HOME is refused when started in \$HOME" "the file was created" ;;
*) ok "writing to \$HOME is refused when started in \$HOME" ;;
esac
case $out in
*pi-wrote*) ok "\$HOME/.pi stays writable when started in \$HOME" ;;
*) bad "\$HOME/.pi stays writable when started in \$HOME" "out=$out" ;;
esac

# 14. broad parents are still refused, with the documented message.
refused=()
for d in / /home /tmp; do
	out=$(cd "$d" 2>/dev/null && timeout "$timeout_s" "$launcher" --exec -- true 2>&1)
	rc=$?
	case $out in
	*'cannot be mounted read-write'*)
		[ "$rc" -ne 0 ] || refused+=("$d: exited 0")
		;;
	*) refused+=("$d: ${out:-no output}") ;;
	esac
done
if [ "${#refused[@]}" -eq 0 ]; then
	ok "broad parents (/, /home, /tmp) are refused with the documented message"
else
	bad "broad parents (/, /home, /tmp) are refused with the documented message" "$(printf '%s' "${refused[*]}")"
fi

# 15. the tools AGENTS.md tells the agent to run are on PATH.
missing=()
for c in gh uvx gitleaks trivy semgrep hc; do
	out=$(inside --exec -- sh -c "command -v $c" 2>/dev/null)
	[ -n "$out" ] || missing+=("$c")
done
if [ "${#missing[@]}" -eq 0 ]; then
	ok "the local tool binaries (~/.local/bin) are on PATH inside"
else
	bad "the local tool binaries (~/.local/bin) are on PATH inside" "missing: ${missing[*]}"
fi

# 16. ... but their credentials are not. A sandbox that hands out a GitHub token
# has stopped being a sandbox: masked config means the tool says so instead.
out=$(inside --exec -- sh -c 'gh auth status 2>&1 | head -2' 2>/dev/null)
case $out in
*'not logged into any GitHub hosts'*)
	ok "gh inside the sandbox has no stored credentials"
	;;
*) bad "gh inside the sandbox has no stored credentials" "${out:-no output}" ;;
esac

# 17. jev answers the route check inside. It reaches the sandbox through a symlink
#     in ~/.local/bin, so a link that dangles here is a harness defect: the
#     routing check is mandatory before a worker starts.
out=$(inside --exec -- sh -c "jev route 'summarise this log entry' 2>&1")
rc=$?
case $out in
*'jev: local'* | *'jev: remote'*) ok "jev answers the route check inside the sandbox ($out)" ;;
*) bad "jev answers the route check inside the sandbox" "rc=$rc ${out:-no output}" ;;
esac

# 18. There is no "only the binary's directory, not the repo" check any more, and
#     its absence is the assertion: the tools that used to resolve into a separate
#     checkout are on PATH from ~/.pi/bin now, and ~/.pi is bound whole, so there
#     is no outside-tree bind left to be too wide. Check 11 is what holds that
#     line — a checkout in $HOME is not in the allow-list.

printf '\n'
if [ "$failures" -eq 0 ]; then
	printf 'all checks passed\n'
	exit 0
fi
printf '%d check(s) failed\n' "$failures"
exit 1
