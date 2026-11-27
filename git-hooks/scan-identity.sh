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
# Wat het toelaat: de alias `github-vlek` (elke vorm), en alles wat niet naar github.com gaat.
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

case "$url" in
*github-vlek*|*github.com/*vlek*)
	exit 0
	;;
git@github.com:*|ssh://git@github.com/*|https://github.com/*|https://*@github.com/*|git://github.com/*)
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
