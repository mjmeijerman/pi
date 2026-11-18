/**
 * config-guard: the timing budget, which a mutant can quietly move.
 *
 * `inspectConfig` reports how long the check took; the session-start budget is 50 ms.
 * Replacing the subtraction with an addition leaves every message identical and every
 * other test green, so the only thing that notices is the number itself.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { inspectConfig } from "../config-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the measured cost is a small non-negative duration, not an absolute timestamp", () => {
	const { ms } = inspectConfig(join(ROOT, "config"));
	assert.ok(ms >= 0, `a duration cannot be negative, got ${ms}`);
	assert.ok(ms < 1000, `three config reads must cost well under a second, got ${ms} ms`);
});
