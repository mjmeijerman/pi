#!/usr/bin/env bash
# finish-rename.sh — the last step of the pi-master → big-boss-pi rename, on request only.
#
# By default this script does nothing: it changes no service, closes no space, deletes no file.
#
#   finish-rename.sh                  print the state and what the next steps would be
#   finish-rename.sh --close-old-space  close the Herdr space named pi-master, then print how to
#                                       delete the rollback copy ($HOME/pi-master) afterwards
#
# It never deletes anything itself. Deleting the rollback copy is the user's call and the
# command is printed, not run.
set -uo pipefail

# Both roots are resolved at runtime, never written down: the old one is $HOME/pi-master on every
# platform, and the new one is this script's own tree, which is the only path that can be right on
# the machine that is running it.
self_root=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.." && pwd)
OLD_ROOT=${PI_MASTER_ROOT:-${HOME:-}/pi-master}
# The new root is this script's own tree, and only that: PI_BOSS_ROOT used to name it, but this
# script now lives in the tree it is describing, and a value left over from the move would print
# a workspace that is being deleted. OLD_ROOT keeps its override: it is a data path this script
# never changes, and a machine that moved the rollback copy may still say where it went.
NEW_ROOT=$self_root

usage() {
	cat <<EOF
usage: finish-rename.sh [--close-old-space] [--help]

  (no options)        explain the state; change nothing
  --close-old-space    close the Herdr space named pi-master and print the delete commands
  --help               this text

Never deletes a file or a directory. Never stops or starts a service.
EOF
}

close_old_space() {
	command -v herdr-app >/dev/null 2>&1 || {
		printf 'herdr-app is not on PATH; nothing closed\n' >&2
		return 1
	}
	local id
	id=$(herdr-app ls 2>/dev/null | node -e '
		let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
			let j={};try{j=JSON.parse(d)}catch{process.exit(1)}
			const hit=(j.spaces||[]).find(s=>s.name==="pi-master");
			if(hit)process.stdout.write(hit.id);
		})')
	if [ -z "$id" ]; then
		printf 'there is no space named pi-master; nothing to close\n'
		return 0
	fi
	if herdr-app do space.close --id "$id" --confirmed true >/dev/null 2>&1; then
		printf 'closed the pi-master space (%s)\n' "$id"
	else
		printf 'space.close failed for pi-master (%s)\n' "$id" >&2
		return 1
	fi
}

explain() {
	printf 'old workspace: %s\n' "$OLD_ROOT"
	[ -d "$OLD_ROOT" ] && printf '  present (rollback copy) — do not delete until the new tree has run a full session\n'
	printf 'new workspace: %s\n' "$NEW_ROOT"
	printf '\nservices:\n'
	systemctl --user is-active big-boss-pi-guard.service >/dev/null 2>&1 &&
		printf '  big-boss-pi-guard.service: active\n' || printf '  big-boss-pi-guard.service: not active\n'
	systemctl --user is-enabled pi-master-guard.service >/dev/null 2>&1 &&
		printf '  pi-master-guard.service: still enabled — disable it\n' ||
		printf '  pi-master-guard.service: disabled, unit file kept on disk\n'
}

case ${1:-} in
"") explain ;;
--close-old-space) close_old_space || exit 1 ;;
--help | -h) usage; exit 0 ;;
*) usage >&2; exit 2 ;;
esac

if [ "${1:-}" = "--close-old-space" ]; then
	cat <<EOF

the old space is closed. when you are ready to delete the rollback copy, you run:

  rm -rf $OLD_ROOT

and, if you want the old unit gone for good:

  rm ~/.config/systemd/user/pi-master-guard.service
  systemctl --user daemon-reload

nothing above has been run for you.
EOF
fi
