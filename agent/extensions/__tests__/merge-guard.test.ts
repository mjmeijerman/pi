/**
 * merge-guard: an agent may not land a change on its own.
 *
 * The decision function is pure and tested directly; the handler is exercised
 * through the fake pi/context so the block, the one-shot allowance and the
 * session reset are all covered.
 */
import "./helpers/hooks.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../merge-guard.ts");
const mergeGuard = mod.default;
const { mergeReason, trunkCommitReason, currentBranch, gitSegments } = mod;

/** A throwaway repo whose HEAD is on `branch`, for the branch-dependent rules. */
function repoOn(branch: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-merge-guard-${branch.replace(/[^a-z0-9]+/gi, "-")}-`));
	execFileSync("git", ["init", "-q", "-b", branch, dir]);
	// A CI runner has no global git identity, so supply one for this commit only.
	execFileSync("git", [
		"-C", dir,
		"-c", "user.name=merge-guard-test",
		"-c", "user.email=merge-guard@example.invalid",
		"commit", "-q", "--allow-empty", "-m", "init",
	]);
	return dir;
}

function setup() {
	const fake = createFakePi();
	mergeGuard(fake.pi);
	const { ctx, notices } = createFakeCtx();
	return { ...fake, ctx, notices };
}

async function run(command: string) {
	const { emit, ctx } = setup();
	const [result] = await emit("tool_call", { toolName: "bash", input: { command } }, ctx);
	return result;
}

describe("merge-guard: decision", () => {
	const blocked = [
		["gh pr merge 4 --squash --delete-branch", "gh pr merge"],
		["gh pr merge --admin", "gh pr merge"],
		["gh  pr   merge 4", "gh pr merge"],
		["git push origin trunk", "trunk"],
		["git push -u origin HEAD:main", "trunk"],
		["git push --force-with-lease origin master", "trunk"],
		["gh api -X PUT repos/o/r/pulls/4/merge", "merge API"],
		["gh api repos/o/r/pulls/4/merges -X POST", "merge API"],
	];

	for (const [command, why] of blocked) {
		test(`blocks \`${command}\` (${why})`, () => {
			assert.ok(mergeReason(command), `expected a reason for: ${command}`);
		});
	}

	const allowed = [
		"gh pr create --base trunk --title t",
		"gh pr view 4",
		"gh pr checks 4",
		"gh pr diff 4",
		"git status",
		"git switch -c feat/x",
		"git commit -m 'feat: x'",
		"git push -u origin feat/x",
		"git push origin HEAD:feat/x",
		"git log --oneline trunk..HEAD",
		"git fetch origin trunk",
		"git push --dry-run origin trunk",
		"gh pr merge --help",
		`echo "gh pr merge 4"`,
		`git commit -m 'never git push origin trunk'`,
		"npm test",
		// The regression that blocked a real push: the PR body below is stdin.
		["git push -u origin feat/x && gh pr create --base trunk --body-file - <<'EOF'",
			"## What",
			"merges with `gh pr merge` once approved, base trunk",
			"EOF"].join("\n"),
		["git commit -F - <<'EOF'", "feat(x): y", "", "gh pr merge 3", "trunk", "EOF"].join("\n"),
		["cat <<EOF", "git push origin trunk", "EOF"].join("\n"),
	];

	for (const command of allowed) {
		test(`allows \`${command}\``, () => {
			assert.equal(mergeReason(command), null, `unexpected block: ${command}`);
		});
	}
	const blockedCommands = [
		["git status && git push origin trunk", "trunk"],
		[["git status", "git push origin main"].join("\n"), "trunk"],
		["gh pr view 4 ; gh pr merge 4", "gh pr merge"],
	];

	for (const [command, why] of blockedCommands) {
		test(`blocks a later segment: \`${command.replace(/\n/g, " ; ")}\` (${why})`, () => {
			assert.ok(mergeReason(command), `expected a reason for: ${command}`);
		});
	}
});

describe("merge-guard: branch rules", () => {
	const dirs = ["trunk", "main", "master", "feat/x"].map(repoOn);
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	test("currentBranch reads the real repository", () => {
		assert.equal(currentBranch(dirs[0]), "trunk");
		assert.equal(currentBranch(dirs[3]), "feat/x");
		assert.equal(currentBranch(tmpdir()), null, "outside a repo there is no branch");
	});

	for (const branch of ["trunk", "main", "master"]) {
		test(`a commit on ${branch} needs permission`, () => {
			assert.match(trunkCommitReason('git commit -m "x"', branch), new RegExp(branch));
		});
		test(`a merge on ${branch} needs permission`, () => {
			assert.ok(trunkCommitReason("git merge feat/x", branch));
		});
	}

	test("a commit on a feature branch is free", () => {
		assert.equal(trunkCommitReason('git commit -m "x"', "feat/x"), null);
		assert.equal(trunkCommitReason("git merge trunk", "feat/x"), null);
	});

	test("a push with no refspec on trunk pushes trunk", () => {
		assert.match(trunkCommitReason("git push", "trunk"), /push from trunk/);
		assert.match(trunkCommitReason("git push -u origin", "main"), /push from main/);
		assert.match(trunkCommitReason("git push origin HEAD", "master"), /push from master/);
	});

	test("pushing another branch while on trunk is free", () => {
		assert.equal(trunkCommitReason("git push -u origin feat/x", "trunk"), null);
		assert.equal(trunkCommitReason("git push origin HEAD:refs/heads/feat/x", "main"), null);
		assert.equal(trunkCommitReason("git push --dry-run origin trunk", "trunk"), null);
	});

	test("a heredoc body cannot smuggle a commit onto trunk", () => {
		const command = ["git status", "cat <<'EOF'", 'git commit -m "x"', "EOF"].join("\n");
		assert.equal(trunkCommitReason(command, "trunk"), null);
	});

	test("outside a repository nothing is blocked by the branch rule", () => {
		assert.equal(trunkCommitReason('git commit -m "x"', null), null);
	});

	test("--help and quoted mentions are not commits", () => {
		assert.equal(trunkCommitReason("git commit --help", "trunk"), null);
		assert.equal(trunkCommitReason('echo "git commit -m x"', "trunk"), null);
	});
});

describe("merge-guard: handler", () => {
	test("a merge command is blocked, not run", async () => {
		const result = await run("gh pr merge 1 --squash");
		assert.equal(result?.block, true);
		assert.match(result.reason, /user's explicit go-ahead/);
	});

	test("an ordinary command passes through untouched", async () => {
		assert.equal(await run("git push -u origin feat/x"), undefined);
	});

	test("/mergeguard allow unlocks exactly one merge", async () => {
		const { emit, ctx, commands, notices } = setup();
		const command = commands.get("mergeguard");
		assert.ok(command, "/mergeguard must be registered");

		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);

		await command.handler("allow", ctx);
		assert.match(notices.at(-1).message, /will run once/);

		assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx)[0], undefined);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("the allowance survives unrelated commands and is spent by the merge", async () => {
		const { emit, ctx, commands } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		await emit("tool_call", { toolName: "bash", input: { command: "git status" } }, ctx);
		await emit("tool_call", { toolName: "bash", input: { command: "git push -u origin feat/x" } }, ctx);
		// still allowed: the approval was for the merge, not for these
		assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "git push origin trunk" } }, ctx)[0], undefined);
		// and now it is gone
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("a new session revokes the allowance", async () => {
		const { emit, ctx, commands } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		await emit("session_start", {}, ctx);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("/mergeguard status reports the state", async () => {
		const { ctx, commands, notices } = setup();
		await commands.get("mergeguard").handler("", ctx);
		assert.match(notices.at(-1).message, /landing blocked/);
		await commands.get("mergeguard").handler("allow", ctx);
		await commands.get("mergeguard").handler("status", ctx);
		assert.match(notices.at(-1).message, /one landing allowed/);
	});

	test("a commit on trunk is blocked through the handler", async () => {
		const dir = repoOn("trunk");
		try {
			const { emit } = setup();
			const { ctx } = createFakeCtx({ cwd: dir });
			const [result] = await emit("tool_call", { toolName: "bash", input: { command: 'git commit -m "x"' } }, ctx);
			assert.equal(result?.block, true);
			assert.match(result.reason, /on trunk/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the same commit on a feature branch runs", async () => {
		const dir = repoOn("feat/x");
		try {
			const { emit } = setup();
			const { ctx } = createFakeCtx({ cwd: dir });
			const [result] = await emit("tool_call", { toolName: "bash", input: { command: 'git commit -m "x"' } }, ctx);
			assert.equal(result, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("non-bash tools are ignored", async () => {
		const { emit, ctx } = setup();
		const [result] = await emit("tool_call", { toolName: "write", input: { path: "notes.md", content: "gh pr merge 1" } }, ctx);
		assert.equal(result, undefined);
	});
});

/**
 * The false positive this fixes: the branch rule read the session cwd, so a commit in a
 * completely different repository was refused whenever the session happened to sit on
 * `main`. The rule now judges the repository the command targets.
 */
describe("merge-guard: the repository the command targets", () => {
	const trunkDir = repoOn("trunk");
	const featureDir = repoOn("feat/x");
	const detachedDir = (() => {
		const dir = repoOn("trunk");
		execFileSync("git", ["-C", dir, "switch", "-q", "--detach"]);
		return dir;
	})();
	const plainDir = mkdtempSync(join(tmpdir(), "pi-merge-guard-not-a-repo-"));
	after(() => {
		for (const dir of [trunkDir, featureDir, detachedDir, plainDir]) rmSync(dir, { recursive: true, force: true });
	});

	const session = "/home/mark/big-boss-pi";

	/** The resolver the handler installs: the branch of the directory, else the session's. */
	const resolver = (dir: string | null) => currentBranch(dir ?? session);

	test("git -C puts the commit in the named repository", () => {
		assert.equal(trunkCommitReason(`git -C ${featureDir} commit -m "x"`, resolver, session), null);
		assert.match(
			trunkCommitReason(`git -C ${trunkDir} commit -m "x"`, resolver, session) ?? "",
			/a commit on trunk/,
		);
	});

	test("a cd earlier in the command does too", () => {
		assert.equal(trunkCommitReason(`cd ${featureDir} && git commit -m "x"`, resolver, session), null);
		assert.match(
			trunkCommitReason(`cd ${trunkDir} && git commit -m "x"`, resolver, session) ?? "",
			/a commit on trunk/,
		);
	});

	test("a command that names no directory still uses the session cwd", () => {
		assert.match(trunkCommitReason('git commit -m "x"', { [session]: "main" }, session) ?? "", /a commit on main/);
		assert.equal(trunkCommitReason('git commit -m "x"', { [session]: "feat/x" }, session), null);
		// No session cwd known and no branch named: nothing to block on.
		assert.equal(trunkCommitReason('git commit -m "x"', null), null);
	});

	test("a detached HEAD is not a trunk commit", () => {
		assert.equal(trunkCommitReason(`git -C ${detachedDir} commit -m "x"`, resolver, session), null);
	});

	test("a path that is not a repository is not a trunk commit", () => {
		assert.equal(trunkCommitReason(`git -C ${plainDir} commit -m "x"`, resolver, session), null);
		assert.equal(trunkCommitReason("git -C /nonexistent/repo commit -m x", resolver, session), null);
	});

	test("a bare branch name cannot describe a directory the command names", () => {
		// The old shape: a string only ever described the session's own repository.
		assert.equal(trunkCommitReason(`git -C ${trunkDir} commit -m "x"`, "trunk", session), null);
		assert.match(trunkCommitReason('git commit -m "x"', "trunk", session) ?? "", /a commit on trunk/);
	});

	test("the segments say which directory they target", () => {
		assert.deepEqual(gitSegments(`cd ${featureDir} && git commit -m "x"`).map((s) => s.dir), [featureDir]);
		assert.deepEqual(gitSegments(`git -C ${trunkDir} commit -m "x"`).map((s) => s.dir), [trunkDir]);
		assert.deepEqual(gitSegments("git status").map((s) => s.dir), [null]);
		// `-c` is a git config flag, not a directory.
		assert.deepEqual(gitSegments("git -c user.name=x commit -m y").map((s) => s.dir), [null]);
	});

	test("through the handler: a commit in another repo on a feature branch runs", async () => {
		const { emit } = setup();
		const { ctx } = createFakeCtx({ cwd: trunkDir }); // the session sits on trunk
		const [result] = await emit(
			"tool_call",
			{ toolName: "bash", input: { command: `git -C ${featureDir} commit -m "x"` } },
			ctx,
		);
		assert.equal(result, undefined);
	});

	test("through the handler: -C into a trunk repo is blocked", async () => {
		const { emit } = setup();
		const { ctx } = createFakeCtx({ cwd: featureDir });
		const [result] = await emit(
			"tool_call",
			{ toolName: "bash", input: { command: `git -C ${trunkDir} commit -m "x"` } },
			ctx,
		);
		assert.equal(result?.block, true);
		assert.match(result.reason, /on trunk/);
	});

	test("through the handler: cd into a trunk repo is blocked", async () => {
		const { emit } = setup();
		const { ctx } = createFakeCtx({ cwd: featureDir });
		const [result] = await emit(
			"tool_call",
			{ toolName: "bash", input: { command: `cd ${trunkDir} && git commit -m "x"` } },
			ctx,
		);
		assert.equal(result?.block, true);
		assert.match(result.reason, /on trunk/);
	});
});
