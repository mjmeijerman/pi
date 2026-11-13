/**
 * pi-master guard — the delegation workspace does not edit files.
 *
 * Radar Vol. 35: blip 21 (subagents, Trial) and blip 17 (risk-tiered human oversight).
 * The pi-master workspace is the place that *starts* work; if an agent there starts
 * editing files directly it has quietly become a second, unsupervised project session.
 * The rule in /home/mark/pi-master/AGENTS.md says delegate; this makes the rule real.
 *
 * Covered: the write and edit tools, and shell commands that write into the workspace
 * (redirects, tee, rm/mv/cp/chmod/sed -i and friends). Not covered: a program that writes
 * there through its own logic, or a syscall. This is a rule, not a sandbox — the honest
 * limit is stated in the workspace README.
 *
 * Scoped by working directory, not installed per project: the extension loads everywhere
 * and does nothing anywhere except under /home/mark/pi-master. Workers, which run in their
 * own project directories, keep write and edit.
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKSPACE = "/home/mark/pi-master";

/** True when this session runs inside the delegation workspace. */
function inWorkspace(cwd: string | undefined): boolean {
	const dir = (cwd || "").replace(/\/+$/, "");
	return dir === WORKSPACE || dir.startsWith(`${WORKSPACE}/`);
}

const WORKSPACE_PATH = /(?:~|\/home\/mark)\/pi-master(?:\/|\b)/;
const WRITE_VERB = /(^|[\s;&|(])(rm|rmdir|mv|cp|dd|tee|truncate|touch|mkdir|chmod|chown|ln|sed\s+-[a-z]*i)([\s]|$)|>>?\s*\S*(?:~|\/home\/mark)\/pi-master/;
const ALLOWED = /^\s*(delegate|jev|hc|herdr-app|herdr)\b/;

/** Reason this shell command would write into the workspace, or null. */
export function shellWriteReason(command: string): string | null {
	if (!WORKSPACE_PATH.test(command)) return null;
	if (ALLOWED.test(command)) return null;
	if (!WRITE_VERB.test(command)) return null;
	return "a shell write into /home/mark/pi-master";
}

const BLOCKED =
	"pi-master-guard: this workspace only delegates. Spawn a worker with " +
	"`delegate spawn <slug> --cwd <dir> \"<task>\"` and let it write files. " +
	"Specs and reports are written by delegate itself.";

export default function piMasterGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!inWorkspace(ctx.cwd)) return;

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			ctx.ui.notify("pi-master: delegate instead of editing here", "warning");
			return { block: true, reason: BLOCKED };
		}

		if (isToolCallEventType("bash", event)) {
			const reason = shellWriteReason(event.input.command);
			if (!reason) return;
			ctx.ui.notify("pi-master: blocked a shell write — delegate instead", "warning");
			return { block: true, reason: `pi-master-guard: ${reason} is not delegation. ${BLOCKED}` };
		}
	});
}
