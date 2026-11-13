/**
 * Test double for the few `@earendil-works/pi-coding-agent` *runtime* exports
 * used by the extensions (everything else in the extensions is `import type`
 * and stripped at load time).
 *
 * Each helper mirrors the real implementation:
 *   getAgentDir            → dist/config.js (honours PI_CODING_AGENT_DIR, expands ~)
 *   isToolCallEventType    → dist/core/extensions/types.js
 *   isBashToolResult       → dist/core/extensions/types.js
 *   withFileMutationQueue  → dist/core/tools/file-mutation-queue.js (per-path serialisation)
 */
import { homedir } from "node:os";
import { join } from "node:path";

function expandTilde(input) {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function getAgentDir() {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandTilde(envDir);
	return join(homedir(), ".pi", "agent");
}

export function isToolCallEventType(toolName, event) {
	return event.toolName === toolName;
}

export function isBashToolResult(event) {
	return event.toolName === "bash";
}

export function isReadToolResult(event) {
	return event.toolName === "read";
}

export function isWriteToolResult(event) {
	return event.toolName === "write";
}

export function isEditToolResult(event) {
	return event.toolName === "edit";
}

const queues = new Map();

export async function withFileMutationQueue(filePath, fn) {
	const previous = queues.get(filePath) ?? Promise.resolve();
	const next = previous.then(fn, fn);
	queues.set(
		filePath,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}
