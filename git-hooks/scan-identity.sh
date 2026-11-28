#!/usr/bin/env bash
# scan-identity.sh — weigert een push die met de sleutel van de eigenaar gebeurt, als dit een
# agent-sessie is.
#
# Waarom: deze machine heeft twee GitHub-identiteiten. `github.com` in ~/.ssh/config is de sleutel
# van Mark (id_ed25519), `github-vlek` is die van vlek-ai-agent (id_ed25519_vlek). Een agent die per
# ongeluk naar `git@github.com:` pusht, doet dat als Mark: de commit, de branch en de PR komen op
# zijn naam. Dat is niet terug te draaien door een commit te amenderen, dus het is een poort en geen
# gewoonte.
#
# Wat het toelaat: de alias `github-vlek` (elke vorm), alles wat niet naar github.com gaat, en de
# ruimte waarvan het record zegt dat de pushes van de eigenaar zelf zijn (`identity: "owner"`) —
# dat is de harness, die zijn eigen werk publiceert.
# Wat het blokkeert: github.com over ssh of https, in een sessie met PI_SESSION_ID of PI_WORKER.
# Noodgreep, bewust en zichtbaar in de geschiedenis: PI_ALLOW_HUMAN_IDENTITY=1 git push ...
#
# stdin: de ref-regels van git (worden gelezen zodat git geen SIGPIPE krijgt).
# $1: remote naam, $2: remote url.
set -u

remote=${1:-}
url=${2:-}

# De mens zelf: geen PI-sessie, geen rem.
if [ -z "${PI_SESSION_ID:-}${PI_WORKER:-}" ]; then
	cat >/dev/null 2>&1 || true
	exit 0
fi

cat >/dev/null 2>&1 || true

if [ "${PI_ALLOW_HUMAN_IDENTITY:-0}" = 1 ]; then
	printf 'scan-identity: door de rem heen (PI_ALLOW_HUMAN_IDENTITY=1), dit pusht als de eigenaar\n' >&2
	exit 0
fi

# record_field <space.json> <field> — one top-level string field, empty when it is not there.
# Only read for a github.com push in an agent session, so a push that is allowed anyway never
# pays for the node start.
record_field() {
	command -v node >/dev/null 2>&1 || return 0
	node -e '
		const fs = require("fs");
		let record = {};
		try { record = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
		const value = record[process.argv[2]];
		if (typeof value === "string") process.stdout.write(value);
	' "$1" "$2" 2>/dev/null
}

# owner_name <url> — `owner/name` of a remote, whichever form it is written in.
owner_name() {
	local url=${1:-}
	url=${url%/}
	url=${url%.git}
	case "$url" in
	*://*)
		url=${url#*://}
		url=${url#*@}
		url=${url#*/}
		;;
	*@*)
		url=${url#*@}
		url=${url#*:}
		;;
	esac
	url=${url%/}
	case "$url" in
	*/*) [ "${url#*/}" != "*/*" ] && [ -n "${url%%/*}" ] && printf '%s' "$url" ;;
	esac
	# A url that is not owner/name is an empty answer, never a failed one: `set -e` callers
	# assign this substitution, and "no repo" is an ordinary answer there.
	return 0
}

# record_of_push — the space record this push belongs to: `$PI_SPACE` when set, else the one whose
# remote is the url being pushed to. Nothing when no record matches, which keeps today's refusal.
record_of_push() {
	local file remote
	if [ -n "${PI_SPACE:-}" ]; then
		file=$_spaces/$PI_SPACE/space.json
		[ -f "$file" ] && printf '%s' "$file"
		return 0
	fi
	local wanted
	wanted=$(owner_name "$url")
	[ -n "$wanted" ] || return 0
	for file in "$_spaces"/*/space.json; do
		[ -f "$file" ] || continue
		remote=$(record_field "$file" remote)
		[ -n "$remote" ] || continue
		[ "$(owner_name "$remote")" = "$wanted" ] && {
			printf '%s' "$file"
			return 0
		}
	done
}

case "$url" in
*github-vlek*|*github.com/*vlek*)
	exit 0
	;;
git@github.com:*|ssh://git@github.com/*|https://github.com/*|https://*@github.com/*|git://github.com/*)
	# De ruimte die pusht. Een record met `identity: "owner"` is de eigenaar zelf: die ruimte mag
	# zijn eigen werk publiceren. Ieder ander record — en geen record — houdt de weigering hieronder.
	_hook_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
	_pi_home=${PI_HOME:-$(cd -- "$_hook_dir/.." && pwd)}
	_spaces=${PI_SPACE_ROOT:-$_pi_home}/state/spaces
	_record=$(record_of_push)
	if [ -n "$_record" ] && [ "$(record_field "$_record" identity)" = owner ]; then
		printf 'scan-identity: %s is de ruimte van de eigenaar zelf, deze push gaat als hij\n' "${PI_SPACE:-$_record}" >&2
		exit 0
	fi
	;;
*)
	exit 0
	;;
esac

cat >&2 <<MSG
scan-identity: deze push gaat naar github.com ($remote -> $url) en dat is de sleutel van Mark.
Een agent-sessie pusht als vlek-ai-agent, niet als hij. Twee manieren:

    git push vlek <branch>                       # als de remote 'vlek' bestaat
    git push git@github-vlek:<owner>/<repo>.git  # of met de alias in de opdracht

Zie ~/.ssh/config: Host github-vlek -> IdentityFile ~/.ssh/id_ed25519_vlek.
Bewust als Mark pushen (en dat in de geschiedenis laten staan):
    PI_ALLOW_HUMAN_IDENTITY=1 git push ...
MSG
exit 1
