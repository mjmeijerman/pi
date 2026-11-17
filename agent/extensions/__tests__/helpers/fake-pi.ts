/**
 * Fake ExtensionAPI + fake ExtensionContext.
 *
 * These are unit tests of guardrail logic, not of pi itself: extensions are
 * loaded as real modules and handed this object, which records everything they
 * register and lets a test fire events by hand.
 */

export type Handler = (event?: any, ctx?: any) => any;

export interface FakePi {
	pi: any;
	/** Event name → registered handlers (`pi.on`). */
	handlers: Map<string, Handler[]>;
	/** Bus listeners (`pi.events.on`). */
	busListeners: Map<string, Handler[]>;
	commands: Map<string, any>;
	shortcuts: Map<string, any>;
	sentMessages: { text: string; opts: any }[];
	/** Run every handler for an event and collect their results. */
	emit(name: string, event?: any, ctx?: any): Promise<any[]>;
	/** Fire an extension-bus event (`pi.events.emit`). */
	emitBus(name: string, data?: any): void;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

export function createFakePi(extra: Record<string, any> = {}): FakePi {
	const handlers = new Map<string, Handler[]>();
	const busListeners = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const sentMessages: { text: string; opts: any }[] = [];

	const pi: any = {
		on(name: string, handler: Handler) {
			push(handlers, name, handler);
		},
		events: {
			on(name: string, handler: Handler) {
				push(busListeners, name, handler);
			},
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		registerShortcut(key: string, def: any) {
			shortcuts.set(key, def);
		},
		sendUserMessage(text: string, opts?: any) {
			sentMessages.push({ text, opts });
		},
		...extra,
	};

	async function emit(name: string, event?: any, ctx?: any): Promise<any[]> {
		const results: any[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}

	function emitBus(name: string, data?: any): void {
		for (const handler of busListeners.get(name) ?? []) handler(data);
	}

	return { pi, handlers, busListeners, commands, shortcuts, sentMessages, emit, emitBus };
}

export interface FakeCtxOptions {
	mode?: string;
	hasUI?: boolean;
	editorText?: string;
	[key: string]: any;
}

export interface FakeCtx {
	ctx: any;
	notices: { message: string; level: string }[];
	statuses: Map<string, string | undefined>;
	setFooterCalls: any[];
	editorText: string;
	commandCalls: string[];
}

export function createFakeCtx(options: FakeCtxOptions = {}): FakeCtx {
	const notices: { message: string; level: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const setFooterCalls: any[] = [];
	const commandCalls: string[] = [];

	const ctx: any = {
		mode: "tui",
		hasUI: true,
		...options,
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level: level ?? "info" });
			},
			setStatus(key: string, value?: string) {
				statuses.set(key, value);
			},
			setFooter(footer: any) {
				setFooterCalls.push(footer);
			},
			getEditorText() {
				return ctx.editorText ?? "";
			},
			setEditorText(text: string) {
				ctx.editorText = text;
			},
			...options.ui,
		},
	};
	ctx.editorText = options.editorText ?? "";
	ctx.commandCalls = commandCalls;
	return { ctx, notices, statuses, setFooterCalls, get editorText() { return ctx.editorText; }, commandCalls };
}

/** Minimal EventEmitter-ish fake child process. */
export function createFakeChild() {
	const listeners = new Map<string, Handler[]>();
	const stdout = {
		on(name: string, handler: Handler) {
			push(listeners, `stdout:${name}`, handler);
		},
	};
	const stderr = {
		on(name: string, handler: Handler) {
			push(listeners, `stderr:${name}`, handler);
		},
	};
	const child: any = {
		stdout,
		stderr,
		exitCode: null,
		killed: false,
		signals: [] as string[],
		kill(signal?: string) {
			child.killed = true;
			child.signals.push(signal ?? "SIGTERM");
			return true;
		},
		on(name: string, handler: Handler) {
			push(listeners, name, handler);
		},
		once(name: string, handler: Handler) {
			const wrapped = (...args: any[]) => {
				child.removeListener(name, wrapped);
				handler(...args);
			};
			push(listeners, name, wrapped);
		},
		removeListener(name: string, handler: Handler) {
			const list = listeners.get(name) ?? [];
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		},
		emit(name: string, ...args: any[]) {
			for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
			return true;
		},
		emitStdout(text: string) {
			for (const handler of listeners.get("stdout:data") ?? []) handler(text);
		},
		emitStderr(text: string) {
			for (const handler of listeners.get("stderr:data") ?? []) handler(text);
		},
	};
	return child;
}

/** Poll until `predicate()` is truthy (or throw after `timeoutMs`). */
export async function waitFor<T>(predicate: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error("waitFor: timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Flush pending microtasks/macrotasks (setTimeout(0) hops). */
export async function tick(times = 1): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait until every child process spawned so far has exited.
 *
 * A fire-and-forget `execFile` is only over when its process is gone, and a child's
 * writes are visible before it exits. "No child left" is therefore the honest form of
 * "nothing more can land in the file it wrote" — a fixed `setTimeout` is only a guess
 * that happens to be wide enough until the box gets busy.
 */
export async function whenChildrenIdle(timeoutMs = 3000): Promise<void> {
	await waitFor(
		() => !process.getActiveResourcesInfo().some((name) => name.toLowerCase() === "processwrap"),
		timeoutMs,
	);
}
