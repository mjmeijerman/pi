// Desktop notification when Pi finishes a task or needs your input.
// Uses the freedesktop notification service over D-Bus via `gdbus`
// (works with GNOME Shell, which has no notify-send installed here).

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const APP_NAME = "π";
const EXPIRE_MS = 8000;

function where(): string {
	const cwd = basename(process.cwd()) || process.cwd();
	const pane = process.env.HERDR_PANE_ID;
	return pane ? `${cwd} · ${pane}` : cwd;
}

function notify(summary: string, body: string, urgency: 1 | 2): void {
	if (process.platform !== "linux") return;

	const args = [
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		APP_NAME,
		"0",
		"",
		summary,
		body,
		"[]",
		`{'urgency': <byte ${urgency}>}`,
		String(EXPIRE_MS),
	];

	execFile("gdbus", args, { timeout: 5000, env: process.env }, (err, stdout) => {
		if (!process.env.PI_NOTIFY_NO_LOG) {
			try {
				appendFileSync(
					"/tmp/pi-notify.log",
					`${new Date().toISOString()} ${summary} -> ${err ? `ERR ${err.message}` : stdout.trim()}\n`,
				);
			} catch {
				/* ignore */
			}
		}
	});
}

export default function (pi: any) {
	// Run fully settled: no retries, no compaction retry, no queued follow-ups left.
	pi.on("agent_settled", async (event: any) => {
		if (event?.aborted) return; // user pressed Escape — they are already looking
		notify("π is klaar", `${where()} — wacht op je input`, 1);
	});

	// Blocking prompts: confirm/select/input/editor/custom.
	pi.on("ui_prompt_start", async (event: any) => {
		const kind = typeof event?.kind === "string" ? event.kind : "prompt";
		const title = typeof event?.title === "string" && event.title ? `: ${event.title}` : "";
		notify("π heeft je input nodig", `${where()} — ${kind}${title}`, 2);
	});
}
