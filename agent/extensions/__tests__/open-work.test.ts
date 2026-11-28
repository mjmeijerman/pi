/**
 * open-work: the prompt says what is unfinished, every turn.
 *
 * The provider boundary is not what is tested here — the line builder is, because it is the thing
 * that must print exactly one line for a reported worker and nothing at all for a clean space. The
 * handler is exercised through the fake pi, with a real `bin/delegate` script and a fake `gh` on
 * PATH, so the probe and the whole line arrive from the record rather than from a stub.
 *
 * Every branch is fed the shape it is there for: a record with a missing field, a report that is
 * not a string, a cache entry at the exact edge of its ttl, a check with nothing in it yet. The
 * mutation gate scores those branches, and a branch no test can reach is a branch that can break
 * without saying so.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../open-work.ts");
const openWork = mod.default;
const {
	cacheFile,
	decisionFiles,
	defaultProbe,
	delegationFiles,
	mergeableWord,
	openLines,
	piRoot,
	prCandidates,
	prFact,
	readCache,
	repoSlug,
	readText,
	reportSize,
	rollupWord,
	statusWord,
	workersWithReports,
	writeCache,
} = mod;

/** The repo the fixture's space records: the probe's `-R` and the cache key both carry it. */
const REPO = "acme/demo";

const dirs: string[] = [];
function tmp(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-open-work-${name}-`));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

/** A record that is also a program: the hook spawns it for real. */
function script(file: string, content: string): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content, { mode: 0o755 });
	return file;
}

const ENV = ["PI_BOSS_ROOT", "PI_MASTER_ROOT", "PI_HOME"] as const;
function withoutRootEnv<T>(fn: () => T): T {
	const saved = ENV.map((key) => [key, process.env[key]] as const);
	for (const key of ENV) delete process.env[key];
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

interface Built {
	root: string;
	state: string;
	probe: any;
	calls: string[][];
	gh: (pr: number, answer?: any) => void;
}

/** A root with one space record, optionally the worker's report, and a stubbed `delegate status`. */
function built(
	options: {
		slug?: string;
		report?: boolean;
		decisions?: any[];
		prs?: Record<number, any>;
		worker?: boolean;
		word?: string;
		statusThrows?: boolean;
	} = {},
): Built {
	const root = tmp(options.slug ?? "space");
	const state = join(root, "state");
	const space = join(state, "spaces", "demo");
	mkdirSync(join(space, "reports"), { recursive: true });
	mkdirSync(join(space, "state"), { recursive: true });
	write(join(space, "space.json"), `${JSON.stringify({ name: "demo", remote: "git@github.com:acme/demo.git" })}\n`);
	const calls: string[][] = [];
	const slug = options.slug ?? "w1";
	const report = join(space, "reports", `${slug}.md`);
	if (options.report !== false) write(report, "# Report\n\nMission: fixture\n");
	write(
		join(space, "delegations.json"),
		options.worker === false ? "{}\n" : `${JSON.stringify({ [slug]: { slug, report, cwd: space } })}\n`,
	);
	if (options.decisions) {
		write(
			join(space, "state", "decisions.jsonl"),
			`${options.decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}
	const prs = { ...(options.prs ?? {}) };
	const probe = {
		state,
		delegate: join(root, "bin", "delegate"),
		run(cmd: string, args: string[]) {
			calls.push([cmd, ...args]);
			if (cmd === "gh") {
				const pr = Number(args[2]);
				const fact = prs[pr];
				if (!fact) throw new Error("no such pull request");
				return JSON.stringify(fact);
			}
			if (options.statusThrows) throw new Error("delegate is not there");
			return `${JSON.stringify({ slug: args[1], status: options.word ?? "reported", decided: "report", report })}\n`;
		},
	};
	function gh(pr: number, answer?: any): void {
		if (answer === undefined) delete prs[pr];
		else prs[pr] = answer;
	}
	return { root, state, probe, calls, gh };
}

function openPr(state = "OPEN", mergeable = "MERGEABLE"): any {
	return {
		state,
		mergeable,
		statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
	};
}

describe("open-work: the root", () => {
	test("with no environment, the checkout this file lives in", () => {
		// Two directories above the module, whatever this checkout is called: a worktree, a
		// stryker sandbox, an install.
		const expected = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		assert.equal(withoutRootEnv(() => piRoot()), expected);
	});

	test("PI_BOSS_ROOT wins, then PI_MASTER_ROOT, then PI_HOME", () => {
		withoutRootEnv(() => {
			process.env.PI_BOSS_ROOT = "/boss";
			process.env.PI_MASTER_ROOT = "/master";
			process.env.PI_HOME = "/home";
			assert.equal(piRoot(), "/boss");
			delete process.env.PI_BOSS_ROOT;
			assert.equal(piRoot(), "/master");
			delete process.env.PI_MASTER_ROOT;
			assert.equal(piRoot(), "/home");
		});
	});

	test("the default probe reads the root's state and its own bin/delegate", () => {
		withoutRootEnv(() => {
			process.env.PI_BOSS_ROOT = "/somewhere";
			const probe = defaultProbe();
			assert.equal(probe.state, "/somewhere/state");
			assert.equal(probe.delegate, "/somewhere/bin/delegate");
		});
	});

	test("the default probe runs a command and hands back its text", () => {
		const probe = defaultProbe();
		assert.equal(probe.run("/bin/echo", ["hi"]), "hi\n");
	});
});

describe("open-work: reading a record", () => {
	test("a plain file is its own text", () => {
		const dir = tmp("text");
		const file = write(join(dir, "a.json"), '{"a":1}\n');
		assert.equal(readText(file), '{"a":1}\n');
	});

	test("a byte-order mark is dropped: JSON.parse refuses it", () => {
		const dir = tmp("bom");
		const file = write(join(dir, "a.json"), '\uFEFF{"a":1}\n');
		assert.deepEqual(JSON.parse(readText(file)), { a: 1 });
	});

	test("a file that is not there, or not a file, reads as nothing", () => {
		const dir = tmp("missing");
		assert.equal(readText(join(dir, "nope.json")), "");
		assert.equal(readText(dir), "");
	});

	test("a report's size is its bytes, and zero when there is no report", () => {
		const dir = tmp("size");
		const file = write(join(dir, "r.md"), "abcd");
		assert.equal(reportSize(file), 4);
		assert.equal(reportSize(join(dir, "nope.md")), 0);
		assert.equal(reportSize(""), 0);
	});

	test("the delegations records are the state's own and then one per space, by name", () => {
		const state = join(tmp("delegations"), "state");
		assert.deepEqual(delegationFiles(state), [join(state, "delegations.json")]);
		mkdirSync(join(state, "spaces", "b", "reports"), { recursive: true });
		mkdirSync(join(state, "spaces", "a"), { recursive: true });
		assert.deepEqual(delegationFiles(state), [
			join(state, "delegations.json"),
			join(state, "spaces", "a", "delegations.json"),
			join(state, "spaces", "b", "delegations.json"),
		]);
	});

	test("the decisions records are the state's own and then one per space, by name", () => {
		const state = join(tmp("decisions"), "state");
		assert.deepEqual(decisionFiles(state), [join(state, "decisions.jsonl")]);
		mkdirSync(join(state, "spaces", "b"), { recursive: true });
		mkdirSync(join(state, "spaces", "a"), { recursive: true });
		assert.deepEqual(decisionFiles(state), [
			join(state, "decisions.jsonl"),
			join(state, "spaces", "a", "state", "decisions.jsonl"),
			join(state, "spaces", "b", "state", "decisions.jsonl"),
		]);
	});
});

describe("open-work: which workers are worth a status call", () => {
	test("a record written over several lines, and one with a byte-order mark, both parse", () => {
		const state = join(tmp("pretty"), "state");
		const report = write(join(state, "reports", "w1.md"), "# Report\n");
		write(join(state, "delegations.json"), JSON.stringify({ w1: { slug: "w1", report } }, null, 2));
		assert.deepEqual(workersWithReports(state), [{ slug: "w1", report }]);

		const bom = join(tmp("bom-worker"), "state");
		write(join(bom, "reports", "w2.md"), "# Report\n");
		write(join(bom, "delegations.json"), `\uFEFF${JSON.stringify({ w2: {} })}`);
		assert.deepEqual(workersWithReports(bom), [{ slug: "w2", report: join(bom, "reports", "w2.md") }]);
	});

	test("a record that is missing, not JSON, or not an object is skipped", () => {
		const state = join(tmp("broken"), "state");
		write(join(state, "spaces", "demo", "delegations.json"), "not json at all\n");
		assert.deepEqual(workersWithReports(state), []);
	});

	test("an empty space name, a null entry and a non-object entry are no worker", () => {
		const state = join(tmp("shapes"), "state");
		const report = write(join(state, "reports", "ok.md"), "# Report\n");
		// reports/s.md and reports/n.md exist, so a guard that lets a number or a null through
		// would put a worker on the line out of a record that holds no worker at all.
		write(join(state, "reports", "s.md"), "# Report\n");
		write(join(state, "reports", "n.md"), "# Report\n");
		write(
			join(state, "delegations.json"),
			JSON.stringify({ "": { report }, n: null, s: 5, ok: {} }),
		);
		assert.deepEqual(workersWithReports(state), [{ slug: "ok", report: join(state, "reports", "ok.md") }]);
	});

	test("a report field that is empty or not a string falls back to reports/<slug>.md", () => {
		const state = join(tmp("fallback"), "state");
		const fallback = write(join(state, "reports", "w1.md"), "# Report\n");
		write(join(state, "delegations.json"), JSON.stringify({ w1: { report: "" }, w2: { report: 5 } }));
		write(join(state, "reports", "w2.md"), "# Report\n");
		assert.deepEqual(workersWithReports(state), [
			{ slug: "w1", report: fallback },
			{ slug: "w2", report: join(state, "reports", "w2.md") },
		]);
	});

	test("a report field that is a path is the path", () => {
		const state = join(tmp("explicit"), "state");
		const elsewhere = write(join(state, "odd", "note.md"), "# Report\n");
		write(join(state, "delegations.json"), JSON.stringify({ w1: { report: elsewhere } }));
		assert.deepEqual(workersWithReports(state), [{ slug: "w1", report: elsewhere }]);
	});

	test("a report file that exists but is empty is not worth a status call", () => {
		const state = join(tmp("empty-report"), "state");
		const report = write(join(state, "reports", "w1.md"), "");
		write(join(state, "delegations.json"), JSON.stringify({ w1: { report } }));
		assert.deepEqual(workersWithReports(state), []);
	});
});

describe("open-work: the word bin/delegate gives", () => {
	function probeThat(run: (cmd: string, args: string[]) => string): any {
		return { state: "/s", delegate: "/s/bin/delegate", run };
	}

	test("the last line of the answer is the word", () => {
		const probe = probeThat(() => `warning: something\n${JSON.stringify({ status: "reported", report: "/r" })}\n`);
		assert.deepEqual(statusWord(probe, "w1", "/fallback"), { word: "reported", report: "/r" });
	});

	test("a field the tool did not print is empty, not the word from the previous line", () => {
		assert.deepEqual(statusWord(probeThat(() => "{}\n"), "w1", "/fallback"), { word: "", report: "/fallback" });
	});

	test("a report the tool did not name falls back to the record's", () => {
		const probe = probeThat(() => `${JSON.stringify({ status: "reported", report: "" })}\n`);
		assert.deepEqual(statusWord(probe, "w1", "/fallback"), { word: "reported", report: "/fallback" });
	});

	test("a tool that does not answer leaves the word empty", () => {
		assert.deepEqual(
			statusWord(
				probeThat(() => {
					throw new Error("no delegate");
				}),
				"w1",
				"/fallback",
			),
			{ word: "", report: "/fallback" },
		);
		assert.deepEqual(statusWord(probeThat(() => "garbage\n"), "w1", "/fallback"), { word: "", report: "/fallback" });
	});
});

describe("open-work: which pull requests are open", () => {
	test("a published pull request is one candidate, smallest number first", () => {
		const state = join(tmp("candidates"), "state");
		write(
			join(state, "decisions.jsonl"),
			[
				JSON.stringify({ pr: 100, repo: REPO }),
				JSON.stringify({ pr: 9, repo: REPO }),
				JSON.stringify({ pr: "42", repo: REPO }),
				"",
				"not json",
				JSON.stringify({ no: "pr" }),
				JSON.stringify({ pr: null, repo: REPO }),
			].join("\n"),
		);
		assert.deepEqual(prCandidates(state), [
			{ pr: 9, repo: REPO },
			{ pr: 42, repo: REPO },
			{ pr: 100, repo: REPO },
		]);
	});

	test("a number that is not a whole positive count is no pull request", () => {
		const state = join(tmp("bad-candidates"), "state");
		write(
			join(state, "decisions.jsonl"),
			[
				JSON.stringify({ pr: 0, repo: REPO }),
				JSON.stringify({ pr: -1, repo: REPO }),
				JSON.stringify({ pr: 1.5, repo: REPO }),
				JSON.stringify({ pr: "abc", repo: REPO }),
				JSON.stringify({ pr: 7, repo: REPO }),
			].join("\n"),
		);
		assert.deepEqual(prCandidates(state), [{ pr: 7, repo: REPO }]);
	});

	test("a space's decisions count too, and a missing file is no candidate", () => {
		const state = join(tmp("space-candidates"), "state");
		write(join(state, "spaces", "demo", "space.json"), `${JSON.stringify({ remote: "git@github.com:acme/demo.git" })}\n`);
		write(join(state, "spaces", "demo", "state", "decisions.jsonl"), `${JSON.stringify({ pr: 5 })}\n`);
		assert.deepEqual(prCandidates(state), [{ pr: 5, repo: REPO }]);
		assert.deepEqual(prCandidates(join(state, "nowhere")), []);
	});

	test("a row's own repo is the one asked, as a slug or as a url", () => {
		const state = join(tmp("row-repo"), "state");
		write(
			join(state, "decisions.jsonl"),
			[
				JSON.stringify({ pr: 1, repo: "other/one" }),
				JSON.stringify({ pr: 2, repo: "https://github.com/other/two.git" }),
				JSON.stringify({ pr: 3, repo: "ssh://git@github.com/other/three.git" }),
			].join("\n"),
		);
		assert.deepEqual(prCandidates(state), [
			{ pr: 1, repo: "other/one" },
			{ pr: 2, repo: "other/two" },
			{ pr: 3, repo: "other/three" },
		]);
	});

	test("a row with no repo, in a space with no remote, is skipped rather than guessed", () => {
		const state = join(tmp("no-repo"), "state");
		write(join(state, "decisions.jsonl"), `${JSON.stringify({ pr: 262 })}\n`);
		write(join(state, "spaces", "demo", "state", "decisions.jsonl"), `${JSON.stringify({ pr: 13 })}\n`);
		write(join(state, "spaces", "demo", "space.json"), `${JSON.stringify({ name: "demo" })}\n`);
		write(join(state, "spaces", "other", "state", "decisions.jsonl"), `${JSON.stringify({ pr: 14 })}\n`);
		assert.deepEqual(prCandidates(state), []);
	});

	test("a repo slug is owner/name whatever form the remote is written in", () => {
		assert.equal(repoSlug("git@github.com:acme/demo.git"), REPO);
		assert.equal(repoSlug("https://github.com/acme/demo"), REPO);
		assert.equal(repoSlug("https://github.com/acme/demo/"), REPO);
		assert.equal(repoSlug("ssh://git@github.com/acme/demo.git"), REPO);
		assert.equal(repoSlug("git://github.com/acme/demo"), REPO);
		assert.equal(repoSlug("acme/demo"), REPO);
		assert.equal(repoSlug(""), "");
		assert.equal(repoSlug(undefined), "");
		assert.equal(repoSlug("/home/mark/projects/demo"), "");
		assert.equal(repoSlug("acme"), "");
		assert.equal(repoSlug("acme/demo/deep"), "");
	});
});

describe("open-work: the cache", () => {
	test("it lives at state/cache/open-prs.json", () => {
		const state = join(tmp("cache-path"), "state");
		assert.equal(cacheFile(state), join(state, "cache", "open-prs.json"));
	});

	test("a missing or unreadable cache is no cache", () => {
		const state = join(tmp("cache-missing"), "state");
		assert.deepEqual(readCache(state), {});
		write(cacheFile(state), "not json\n");
		assert.deepEqual(readCache(state), {});
	});

	test("a written cache is the one read back", () => {
		const state = join(tmp("cache-roundtrip"), "state");
		const fact = { checkedAt: 1, state: "OPEN", mergeable: "MERGEABLE", rollup: "green" };
		writeCache(state, { "42": fact });
		assert.equal(readFileSync(cacheFile(state), "utf8"), `{"42":${JSON.stringify(fact)}}\n`);
		assert.deepEqual(readCache(state), { "42": fact });
	});

	test("a cache that cannot be written is not an error", () => {
		const state = join(tmp("cache-blocked"), "state");
		write(join(state, "cache"), "a file where the directory should be\n");
		assert.doesNotThrow(() => writeCache(state, {}));
	});
});

describe("open-work: gh's answer, cached", () => {
	const fact = (over: any = {}): any => ({ checkedAt: 1000, state: "OPEN", mergeable: "MERGEABLE", rollup: "green", ...over });

	test("with nothing cached, gh is asked once and its answer is kept", () => {
		const calls: string[][] = [];
		const cache: Record<string, any> = {};
		const probe = {
			state: "/s",
			delegate: "/s/bin/delegate",
			now: () => 5000,
			run(cmd: string, args: string[]) {
				calls.push([cmd, ...args]);
				return JSON.stringify(openPr());
			},
		};
		const got = prFact(probe, 42, REPO, cache);
		assert.deepEqual(got, { checkedAt: 5000, state: "OPEN", mergeable: "MERGEABLE", rollup: "green" });
		assert.deepEqual(calls, [["gh", "pr", "view", "42", "-R", REPO, "--json", "number,state,mergeable,statusCheckRollup"]]);
		assert.deepEqual(cache[`${REPO}#42`], got);
	});

	test("an answer with no fields is an unknown fact, not a crash", () => {
		const probe = { state: "/s", delegate: "/s/bin/delegate", now: () => 1, run: () => "{}" };
		assert.deepEqual(prFact(probe, 42, REPO, {}), { checkedAt: 1, state: "", mergeable: "", rollup: "no checks" });
	});

	test("an answer that is not an object is an unknown fact too", () => {
		const probe = { state: "/s", delegate: "/s/bin/delegate", now: () => 1, run: () => "null" };
		assert.deepEqual(prFact(probe, 42, REPO, {}), { checkedAt: 1, state: "", mergeable: "", rollup: "no checks" });
	});

	test("a fresh cache is the answer, with no gh call at all", () => {
		const calls: string[][] = [];
		const probe = {
			state: "/s",
			delegate: "/s/bin/delegate",
			now: () => 30_000,
			run: (cmd: string, args: string[]) => {
				calls.push([cmd, ...args]);
				throw new Error("gh should not run");
			},
		};
		const known = fact({ checkedAt: 1 });
		assert.deepEqual(prFact(probe, 42, REPO, { [`${REPO}#42`]: known }), known);
		assert.deepEqual(calls, []);
	});

	test("an open pull request's cache is stale at a minute, fresh a second before", () => {
		const fresh = fact({ checkedAt: 1 });
		const ask = (now: number) => {
			let asked = 0;
			const probe = {
				state: "/s",
				delegate: "/s/bin/delegate",
				now: () => now,
				run: () => {
					asked += 1;
					return JSON.stringify(openPr());
				},
			};
			prFact(probe, 42, REPO, { [`${REPO}#42`]: fresh });
			return asked;
		};
		assert.equal(ask(1 + 59_999), 0);
		assert.equal(ask(1 + 60_000), 1);
		assert.equal(ask(1 + 60_001), 1);
	});

	test("a settled pull request's cache lives for a day, not a minute", () => {
		const day = 24 * 3600_000;
		const ask = (now: number, state: string) => {
			let asked = 0;
			const probe = {
				state: "/s",
				delegate: "/s/bin/delegate",
				now: () => now,
				run: () => {
					asked += 1;
					return JSON.stringify(openPr());
				},
			};
			prFact(probe, 42, REPO, { [`${REPO}#42`]: fact({ checkedAt: 0, state }) });
			return asked;
		};
		assert.equal(ask(day - 1, "MERGED"), 0);
		assert.equal(ask(day - 1, "CLOSED"), 0);
		assert.equal(ask(day, "MERGED"), 1);
		assert.equal(ask(day, "CLOSED"), 1);
		assert.equal(ask(60_000, "MERGED"), 0);
	});

	test("a gh that fails or answers nonsense leaves what was known", () => {
		const stale = fact({ checkedAt: 0 });
		const probe = {
			state: "/s",
			delegate: "/s/bin/delegate",
			now: () => 24 * 3600_000 * 2,
			run: () => {
				throw new Error("gh is not there");
			},
		};
		assert.deepEqual(prFact(probe, 42, REPO, { [`${REPO}#42`]: stale }), stale);
		assert.equal(prFact(probe, 42, REPO, {}), undefined);
		const nonsense = { ...probe, run: () => "not json" };
		assert.deepEqual(prFact(nonsense, 42, REPO, { [`${REPO}#42`]: stale }), stale);
		assert.equal(prFact(nonsense, 42, REPO, {}), undefined);
	});

	test("with no clock handed in, the wall clock is the clock", () => {
		const calls: string[][] = [];
		const probe = {
			state: "/s",
			delegate: "/s/bin/delegate",
			run: (cmd: string, args: string[]) => {
				calls.push([cmd, ...args]);
				throw new Error("gh should not run");
			},
		};
		const known = fact({ checkedAt: Date.now() - 1000 });
		assert.deepEqual(prFact(probe, 42, REPO, { [`${REPO}#42`]: known }), known);
		assert.deepEqual(calls, []);
	});
});

describe("open-work: the words", () => {
	test("rollup is red, pending, green or no checks", () => {
		assert.equal(rollupWord(undefined), "no checks");
		assert.equal(rollupWord(null), "no checks");
		assert.equal(rollupWord("SUCCESS"), "no checks");
		assert.equal(rollupWord([]), "no checks");
		assert.equal(rollupWord([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "green");
		assert.equal(rollupWord([{ status: "COMPLETED", conclusion: "success" }]), "green");
		assert.equal(rollupWord([{ state: "SUCCESS" }]), "green");
		assert.equal(rollupWord([{ status: "COMPLETED" }]), "green");
		assert.equal(rollupWord([{ conclusion: "SUCCESS" }]), "green");
		assert.equal(rollupWord([{ status: "IN_PROGRESS" }]), "pending");
		assert.equal(rollupWord([{ status: "completed", conclusion: "SUCCESS" }]), "green");
		assert.equal(rollupWord([{ state: "PENDING" }]), "pending");
		assert.equal(rollupWord([{ state: "QUEUED" }]), "pending");
		assert.equal(rollupWord([{}]), "pending");
		assert.equal(rollupWord([null]), "pending");
		assert.equal(rollupWord([undefined]), "pending");
		assert.equal(rollupWord([{ status: "COMPLETED", conclusion: "SUCCESS" }, null]), "pending");
	});

	test("every failing conclusion is red, upper or lower", () => {
		for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"]) {
			assert.equal(rollupWord([{ status: "COMPLETED", conclusion }]), "red", conclusion);
			assert.equal(rollupWord([{ status: "COMPLETED", conclusion: conclusion.toLowerCase() }]), "red", conclusion);
		}
		for (const state of ["FAILURE", "ERROR"]) {
			assert.equal(rollupWord([{ state }]), "red", state);
			assert.equal(rollupWord([{ state: state.toLowerCase() }]), "red", state);
		}
	});

	test("one red check out of two is red; one pending out of two is pending", () => {
		const green = { status: "COMPLETED", conclusion: "SUCCESS" };
		assert.equal(rollupWord([green, { status: "COMPLETED", conclusion: "FAILURE" }]), "red");
		assert.equal(rollupWord([green, { state: "QUEUED" }]), "pending");
		assert.equal(rollupWord([green, {}]), "pending");
		assert.equal(rollupWord([green, green]), "green");
	});

	test("mergeable is mergeable, conflicts or unknown, whatever the case", () => {
		assert.equal(mergeableWord("MERGEABLE"), "mergeable");
		assert.equal(mergeableWord("mergeable"), "mergeable");
		assert.equal(mergeableWord("CONFLICTING"), "conflicts");
		assert.equal(mergeableWord("conflicting"), "conflicts");
		assert.equal(mergeableWord("UNKNOWN"), "unknown");
		assert.equal(mergeableWord(""), "unknown");
	});
});

describe("open-work: the lines", () => {
	test("a reported worker produces exactly one line", () => {
		const { probe, calls, state } = built({ slug: "w1" });
		const lines = openLines(probe);
		assert.deepEqual(lines, [
			`worker w1: reported, report at ${join(state, "spaces", "demo", "reports", "w1.md")} — next: bin/delegate finish w1`,
		]);
		// One subprocess, and it is the tool that decides the word — no second opinion here.
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].slice(1), ["status", "w1", "--json"]);
	});

	test("a clean space produces none, and no subprocess at all", () => {
		const root = tmp("clean");
		mkdirSync(join(root, "state", "spaces"), { recursive: true });
		const calls: string[][] = [];
		const lines = openLines({
			state: join(root, "state"),
			delegate: join(root, "bin", "delegate"),
			run: (cmd: string, args: string[]) => {
				calls.push([cmd, ...args]);
				throw new Error("no call should happen for an empty record");
			},
		});
		assert.deepEqual(lines, []);
		assert.deepEqual(calls, []);
	});

	test("a worker the tool does not call reported produces no line", () => {
		const { probe, calls } = built({ slug: "w1", word: "working" });
		assert.deepEqual(openLines(probe), []);
		assert.equal(calls.length, 1);
	});

	test("a worker with no report file is not even asked about", () => {
		const root = tmp("no-report");
		const state = join(root, "state");
		write(join(state, "spaces", "demo", "delegations.json"), `${JSON.stringify({ w9: { slug: "w9" } })}\n`);
		assert.deepEqual(workersWithReports(state), []);
		const calls: string[][] = [];
		openLines({
			state,
			delegate: join(root, "bin", "delegate"),
			run: (cmd: string, args: string[]) => {
				calls.push([cmd, ...args]);
				return "";
			},
		});
		assert.deepEqual(calls, []);
	});

	test("an open PR produces one line, and the cache remembers the answer", () => {
		const { probe, calls, state } = built({
			worker: false,
			decisions: [{ timestamp: "2026-01-01T00:00:00.000Z", command: "publish", pr: 42, slug: "w1" }],
			prs: { 42: openPr() },
		});
		assert.deepEqual(openLines(probe), [`PR #42 (${REPO}): green, mergeable — next: gh pr view 42 -R ${REPO}`]);
		assert.ok(calls.some((call) => call[0] === "gh"));
		const cached = readCache(state);
		assert.equal(cached[`${REPO}#42`].state, "OPEN");
		assert.equal(cached[`${REPO}#42`].rollup, "green");
	});

	test("a merged or a closed PR produces no line", () => {
		const decision = { pr: 42, slug: "w1" };
		const merged = built({ worker: false, decisions: [decision], prs: { 42: openPr("MERGED", "UNKNOWN") } });
		assert.deepEqual(openLines(merged.probe), []);
		const closed = built({ worker: false, decisions: [decision], prs: { 42: openPr("CLOSED", "UNKNOWN") } });
		assert.deepEqual(openLines(closed.probe), []);
	});

	test("a PR whose answer cannot be had produces no line and writes no cache", () => {
		const { probe, state } = built({ worker: false, decisions: [{ pr: 42, slug: "w1" }] });
		assert.deepEqual(openLines(probe), []);
		assert.equal(existsSync(cacheFile(state)), false);
	});

	test("a worker and a PR are two lines, worker first", () => {
		const { probe } = built({
			slug: "w1",
			decisions: [{ pr: 42, slug: "w1" }],
			prs: { 42: openPr() },
		});
		const lines = openLines(probe);
		assert.equal(lines.length, 2);
		assert.ok(lines[0].startsWith("worker w1: reported"), lines[0]);
		assert.equal(lines[1], `PR #42 (${REPO}): green, mergeable — next: gh pr view 42 -R ${REPO}`);
	});

	test("a row's own repo is the one asked, even when the space names another", () => {
		const { probe, calls } = built({
			worker: false,
			decisions: [{ pr: 42, repo: "other/one" }],
			prs: { 42: openPr() },
		});
		assert.deepEqual(openLines(probe), [
			"PR #42 (other/one): green, mergeable — next: gh pr view 42 -R other/one",
		]);
		const asked = calls.filter((call) => call[0] === "gh");
		assert.equal(asked.length, 1);
		assert.deepEqual(asked[0].slice(1), [
			"pr",
			"view",
			"42",
			"-R",
			"other/one",
			"--json",
			"number,state,mergeable,statusCheckRollup",
		]);
	});

	test("a row with no repo anywhere is no line, and asks nothing", () => {
		const root = tmp("no-repo-line");
		const state = join(root, "state");
		write(join(state, "decisions.jsonl"), `${JSON.stringify({ pr: 262 })}\n`);
		const calls: string[][] = [];
		const lines = openLines({
			state,
			delegate: join(root, "bin", "delegate"),
			run: (cmd: string, args: string[]) => {
				calls.push([cmd, ...args]);
				throw new Error("nothing should be asked without a repo");
			},
		});
		assert.deepEqual(lines, []);
		assert.deepEqual(calls, []);
	});

	test("a probe whose stderr is loud prints nothing and answers nothing", () => {
		// A child process, because the leak was in the child's stderr reaching the pane: the only
		// way to see what a real `gh` does to this process is to run the probe in one.
		const dir = tmp("loud-stderr");
		const bin = join(dir, "bin");
		script(
			join(bin, "gh"),
			"#!/usr/bin/env bash\nprintf 'GraphQL: Could not resolve to a PullRequest with the number of 262. (repository.pullRequest)\\n' >&2\nexit 1\n",
		);
		const module = new URL("../open-work.ts", import.meta.url).href;
		const child = `const m = await import(${JSON.stringify(module)});` +
			`const fact = m.prFact(m.defaultProbe(), 42, ${JSON.stringify(REPO)}, {});` +
			`process.stdout.write(JSON.stringify({ fact: fact === undefined ? null : fact }));`;
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_BOSS_ROOT: dir },
			encoding: "utf8",
		});
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stderr, "", "a failing probe has nothing to say in the pane");
		assert.deepEqual(JSON.parse(run.stdout), { fact: null });
	});
});

describe("open-work: the hook", () => {
	function withRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
		withoutRootEnv(() => undefined);
		const saved = process.env.PI_BOSS_ROOT;
		process.env.PI_BOSS_ROOT = root;
		return fn().finally(() => {
			if (saved === undefined) delete process.env.PI_BOSS_ROOT;
			else process.env.PI_BOSS_ROOT = saved;
		});
	}

	test("a clean space leaves the prompt untouched", async () => {
		const root = tmp("hook-clean");
		mkdirSync(join(root, "state", "spaces"), { recursive: true });
		script(join(root, "bin", "delegate"), "#!/usr/bin/env bash\nexit 1\n");
		await withRoot(root, async () => {
			const fake = createFakePi();
			openWork(fake.pi);
			const { ctx } = createFakeCtx();
			const [out] = await fake.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
			assert.equal(out, undefined);
		});
	});

	test("a root with no state at all is a clean space too", async () => {
		const root = tmp("hook-nothing");
		await withRoot(root, async () => {
			const fake = createFakePi();
			openWork(fake.pi);
			const { ctx } = createFakeCtx();
			const [out] = await fake.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
			assert.equal(out, undefined);
		});
	});

	test("a reported worker adds its one line to the prompt", async () => {
		const root = tmp("hook-reported");
		const state = join(root, "state");
		const space = join(state, "spaces", "demo");
		const report = write(join(space, "reports", "w1.md"), "# Report\n\nMission: fixture\n");
		write(join(space, "delegations.json"), `${JSON.stringify({ w1: { slug: "w1", report } })}\n`);
		script(
			join(root, "bin", "delegate"),
			`#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify({ slug: "w1", status: "reported", report })}'\n`,
		);
		await withRoot(root, async () => {
			const fake = createFakePi();
			openWork(fake.pi);
			const { ctx } = createFakeCtx();
			const [out] = await fake.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
			assert.equal(
				out.systemPrompt,
				`BASE\n\nworker w1: reported, report at ${report} — next: bin/delegate finish w1`,
			);
		});
	});

	test("a worker and a PR are two added lines, one under the other", async () => {
		const root = tmp("hook-two");
		const state = join(root, "state");
		const space = join(state, "spaces", "demo");
		const report = write(join(space, "reports", "w1.md"), "# Report\n");
		write(join(space, "delegations.json"), `${JSON.stringify({ w1: { slug: "w1", report } })}\n`);
		write(join(space, "space.json"), `${JSON.stringify({ name: "demo", remote: "git@github.com:acme/demo.git" })}\n`);
		write(join(space, "state", "decisions.jsonl"), `${JSON.stringify({ pr: 42, slug: "w1" })}\n`);
		script(
			join(root, "bin", "delegate"),
			`#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify({ slug: "w1", status: "reported", report })}'\n`,
		);
		const bin = join(root, "fake-bin");
		script(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify(openPr())}'\n`);
		const savedPath = process.env.PATH;
		process.env.PATH = `${bin}:${savedPath}`;
		try {
			await withRoot(root, async () => {
				const fake = createFakePi();
				openWork(fake.pi);
				const { ctx } = createFakeCtx();
				const [out] = await fake.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
				assert.equal(
					out.systemPrompt,
					[
						"BASE",
						"",
						`worker w1: reported, report at ${report} — next: bin/delegate finish w1`,
						`PR #42 (${REPO}): green, mergeable — next: gh pr view 42 -R ${REPO}`,
					].join("\n"),
				);
				assert.equal(readCache(state)[`${REPO}#42`].rollup, "green");
			});
		} finally {
			process.env.PATH = savedPath;
		}
	});
});
