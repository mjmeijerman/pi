/**
 * secret-guard: the fd-prefixed redirect hole.
 *
 * A shell lets the redirect operator carry a stream number — `2>`, `1>>`, `3>`
 * — and `x 2> .env` overwrites a credential file exactly like `x > .env` does.
 * The shipped operator test only accepted a bare `>` or `>>`, so the scan
 * skipped the whole `2> .env` pair and the guard called the write a plain
 * non-secret command. These tests pin the widening: the number is part of the
 * operator, and a word that only *starts* like an operator (`2>&1`) is not one.
 *
 * The extension module is loaded for real; only the pi platform pieces are
 * stubbed. Secret-shaped paths here are `.env` and friends, never values, so
 * nothing in this file has to be assembled at runtime.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-secret-guard-fd-redirect-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.SECRET_GUARD_PASSTHROUGH;

const secretGuard = (await import("../secret-guard.ts")).default;

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

/** Send one bash command through the real extension; returns the refusal, if any. */
async function bash(command: string): Promise<string | undefined> {
	const fake = createFakePi();
	secretGuard(fake.pi);
	const { ctx } = createFakeCtx();
	const [result]: any = await fake.emit("tool_call", { toolName: "bash", input: { command } }, ctx);
	return result?.block ? String(result.reason) : undefined;
}

const REFUSAL = /reads a secret file/;

describe("secret-guard: redirect operator with a stream number", () => {
	/**
	 * The four shapes a shell accepts for "send a stream into this file". The
	 * bare two are the shipped behaviour and must not move; the numbered two are
	 * the hole: each one overwrote `.env` while the guard stayed quiet.
	 */
	test("a numbered fd redirect onto a credential file is refused", async () => {
		for (const command of ["x 2> .env", "x 1>> .env", "x 3> .env", "x 2>> .env", "x 10> .env.local"]) {
			assert.match((await bash(command)) ?? "", REFUSAL, command);
		}
	});

	test("an unnumbered redirect onto a credential file is still refused", async () => {
		for (const command of ["x > .env", "x >> .env", "x > config/prod.env"]) {
			assert.match((await bash(command)) ?? "", REFUSAL, command);
		}
	});

	test("the operator is a whole word, so a number-only word is not one", async () => {
		// `2>`, `1>>` and `3>` are operators; `2` alone is an argument, and an
		// argument before `.env` is only a read if the verb reads.
		assert.equal(await bash("echo 2 .env"), undefined);
		assert.equal(await bash("echo 1 .env"), undefined);
	});

	/**
	 * The other end of the same rule: a word that merely *ends* in `>` is not an
	 * operator either. The scan splits words on whitespace, so `foo>` never
	 * reaches the operator test as `>` — the number may not be a prefix and an
	 * arbitrary word may not be a suffix. A shell reads `x foo> .env` as a
	 * redirect; this guard reads a word, which is the boundary the existing
	 * "operator is the whole word, not a prefix" case already draws for `>.env`.
	 */
	test("a word ending in > is a word, not an operator", async () => {
		assert.equal(await bash("x foo> .env"), undefined);
	});

	/**
	 * `2>&1` is a stream copy, not a write: it duplicates stderr onto stdout and
	 * names no file. Reading the number as an operator prefix would make the word
	 * a redirect and the next word a target, which is how a mirror (`>&1`) turns
	 * into a false refusal on the command after it.
	 */
	test("a stream copy is not a redirect, even with a credential file after it", async () => {
		for (const command of ["x 2>&1 .env", "x >&2 .env", "x 2>&1", "x &> /dev/null"]) {
			assert.equal(await bash(command), undefined, command);
		}
	});

	/** `&>` reaches the scan already split by the `&` separator: still a write. */
	test("a redirect of both streams onto a credential file is refused", async () => {
		assert.match((await bash("x &> .env")) ?? "", REFUSAL);
		assert.match((await bash("x &>> config/prod.env")) ?? "", REFUSAL);
	});

	/** Widening the operator must not start a refusal on a harmless target. */
	test("a numbered redirect onto an ordinary file stays allowed", async () => {
		for (const command of ["x 2> /tmp/log.txt", "x 1>> build.log", "x 2> .env.example", "x 3> out.txt"]) {
			assert.equal(await bash(command), undefined, command);
		}
	});

	/** The rest of the guard is unmoved by the wider operator. */
	test("reads and touches of a credential file keep their verdicts", async () => {
		assert.match((await bash("cat .env")) ?? "", REFUSAL);
		assert.equal(await bash("cp .env /tmp/loot"), undefined);
		assert.equal(await bash("ls -l .env.example"), undefined);
	});
});
