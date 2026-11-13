/**
 * sandbox-badge: the terminal title says whether this agent is contained.
 *
 * Radar basis: #1 agent sandboxing (Adopt), #95 Herdr (Assess).
 *
 * Why the title: Herdr shows each agent's terminal title in the pane header and
 * in the Agents list, so the title is the one surface where "is this session
 * actually sandboxed?" is visible without clicking anything. A sandbox you
 * cannot see is a sandbox you stop trusting: after `install.sh` wraps `pi`,
 * every session looks identical, and the one that bypassed the wrapper with
 * `PI_BARE=1` looks exactly like the one that did not (blip 42's failure mode).
 *
 *   ⛨  the session runs inside bubblewrap (PI_SANDBOX_MODE is set by pi-sandbox.sh)
 *   ⚠  the session runs with your real home directory, SSH keys and cloud creds
 *
 * `PI_SANDBOX_NET=off` appends "· no net" when the run also unshared the network.
 *
 * Nothing else: no timers, no network, no file reads. The env read is the
 * sandbox launcher's own claim, which is the only claim worth displaying — a
 * probe would report what the session can see, not what the wrapper decided.
 */
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Set by `sandbox/pi-sandbox.sh` inside the sandbox, absent outside it. */
export const MODE_ENV = "PI_SANDBOX_MODE";
/** `on` or `off`: `--no-net` sets it to `off`. */
export const NET_ENV = "PI_SANDBOX_NET";

/** Contained. */
export const SANDBOXED_GLYPH = "⛨";
/** Not contained: the bare binary with the real home directory. */
export const BARE_GLYPH = "⚠";

export interface Containment {
	/** `bwrap` when the launcher said so, null when it said nothing. */
	mode: string | null;
	/** `off` when the run has no network, `on` or null otherwise. */
	net: string | null;
}

/** Read the launcher's claim from an environment object (pure, testable). */
export function readContainment(env: Record<string, string | undefined>): Containment {
	const mode = env[MODE_ENV]?.trim();
	const net = env[NET_ENV]?.trim();
	return {
		mode: mode && mode.length > 0 ? mode : null,
		net: net && net.length > 0 ? net : null,
	};
}

/** The single character that answers the question at a glance. */
export function badgeGlyph(containment: Containment): string {
	return containment.mode ? SANDBOXED_GLYPH : BARE_GLYPH;
}

/**
 * pi's own title is `π - <session> - <cwd>` (or `π - <cwd>`). The badge goes
 * first, not last: the Agents list truncates on the right, and a marker that
 * gets cut off is a marker that lies by omission.
 */
export function badgeTitle(base: string, containment: Containment): string {
	const net = containment.mode && containment.net === "off" ? " · no net" : "";
	return `${badgeGlyph(containment)} ${base}${net}`;
}

/**
 * The footer line, for the case the agents list cannot show: Herdr names a row
 * after the lead agent of its tab, so two sessions in one tab share one title.
 * The status is per session and therefore never borrows its neighbour's badge.
 */
export function badgeStatus(containment: Containment): string {
	const where = containment.mode ? `sandboxed (${containment.mode})` : "bare: real home and credentials";
	return containment.mode && containment.net === "off" ? `${where} · no net` : where;
}

/** What pi would have titled this session, so the badge does not rename it. */
export function baseTitle(cwd: string, sessionName?: string | null): string {
	const dir = path.basename(cwd || process.cwd());
	return sessionName ? `π - ${sessionName} - ${dir}` : `π - ${dir}`;
}

export default function sandboxBadge(pi: ExtensionAPI) {
	const containment = readContainment(process.env);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function apply(ctx: any): void {
		// TUI only: print/JSON modes have no title bar, and RPC still reports
		// hasUI=true, so mode is the reliable gate.
		if (ctx?.mode !== "tui") return;
		if (typeof ctx?.ui?.setTitle !== "function") return;
		const title = badgeTitle(baseTitle(process.cwd(), pi.getSessionName?.()), containment);
		try {
			ctx.ui.setTitle(title);
			if (typeof ctx.ui.setStatus === "function") {
				ctx.ui.setStatus("sandbox", `${badgeGlyph(containment)} ${badgeStatus(containment)}`);
			}
		} catch {
			// A title that cannot be set must never break the session.
		}
	}

	// pi may set its own title after the extension loads; one deferred write
	// lands after that without a polling loop.
	function applySoon(ctx: any): void {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			apply(ctx);
		}, 0);
	}

	pi.on("session_start", (_event, ctx) => applySoon(ctx));
	// A rename or a resume re-titles the terminal, and so does a fresh turn.
	pi.on("agent_start", (_event, ctx) => applySoon(ctx));
	pi.on("session_info_changed", (_event, ctx) => applySoon(ctx));
}
