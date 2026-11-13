#!/usr/bin/env bash
# selftest.sh — prove the pi-sandbox policy actually holds.
#
# Runs non-interactive commands inside the sandbox (never an interactive pi
# session) and prints one PASS/FAIL line per assertion. Exits non-zero when
# anything fails.
set -uo pipefail

here=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
launcher=$here/pi-sandbox.sh
timeout_s=60

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
out=$(inside --exec -- sh -c 'ls -A /home/mark/.ssh 2>&1')
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
out=$(inside --exec -- sh -c 'ls -A /home/mark/.gnupg /home/mark/.aws /home/mark/.config/gh 2>&1')
entries=$(printf '%s\n' "$out" | grep -v -e 'No such file or directory' -e '^$' -e '^Cannot access' | grep -v -E '^/home/mark/\.(gnupg|aws|config/gh):?$' || true)
if [ -z "$entries" ]; then
	ok "~/.gnupg, ~/.aws and ~/.config/gh are hidden"
else
	bad "~/.gnupg, ~/.aws and ~/.config/gh are hidden" "$entries"
fi

# 6. dotenv files are visible as empty files.
host_env=/home/mark/projects/jurysysteem/.env
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

# 7. write allowed inside the sandbox work dir.
out=$(inside --exec -- sh -c 'echo ok > /home/mark/.pi/sandbox/.write-test && echo wrote')
rc=$?
rm -f "$here/.write-test"
if [ "$rc" -eq 0 ]; then
	ok "writing to /home/mark/.pi/sandbox/ succeeds"
else
	bad "writing to /home/mark/.pi/sandbox/ succeeds" "$out"
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

# 11. the rest of the home directory simply is not there.
out=$(inside --exec -- sh -c 'ls /home/mark' 2>&1)
allowed='^(achterhoek-uitagenda|pi-projects|projects|git-templates|gitconfig|pi)$'
unexpected=$(printf '%s\n' "$out" | sed 's/^\.//' | grep -v -E "$allowed" || true)
if [ -z "$unexpected" ]; then
	ok "only the allow-listed home entries are visible"
else
	bad "only the allow-listed home entries are visible" "$(printf '%s' "$unexpected" | tr '\n' ' ')"
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
	printf 'all checks passed\n'
	exit 0
fi
printf '%d check(s) failed\n' "$failures"
exit 1
