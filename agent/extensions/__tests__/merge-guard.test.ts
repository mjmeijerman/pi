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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mod = await import("../merge-guard.ts");
const mergeGuard = mod.default;
const { mergeReason, trunkCommitReason, currentBranch, gitSegments, parkReason } = mod;

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
		["gh  api -X PUT repos/o/r/pulls/4/merge", "merge API, however spaced"],
		// A quoted fragment glued to a word is a separator, not glue.
		[`gh"x"pr merge 4`, "gh pr merge"],
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
		// A pull writes nothing and merges no reviewed change: it is not a landing.
		"git pull",
		"git pull --ff-only",
		"git pull origin trunk",
		"git push --dry-run origin trunk",
		"gh pr merge --help",
		`echo "gh pr merge 4"`,
		`git commit -m 'never git push origin trunk'`,
		"npm test",
		// A quoted mention is text, in either quote style and however many spaces
		// the segment splitter has to look past.
		`echo 'gh pr merge 4'`,
		`echo 'a && git push origin trunk'`,
		"git push origin 'trunk'",
		"gh api repos/o/r/pulls/4",
		// The regression that blocked a real push: the PR body below is stdin.
		["git push -u origin feat/x && gh pr create --base trunk --body-file - <<'EOF'",
			"## What",
			"merges with `gh pr merge` once approved, base trunk",
			"EOF"].join("\n"),
		["git commit -F - <<'EOF'", "feat(x): y", "", "gh pr merge 3", "trunk", "EOF"].join("\n"),
		["cat <<EOF", "git push origin trunk", "EOF"].join("\n"),
		// An indented closing delimiter with trailing spaces still ends the body.
		["cat <<EOF", "git push origin trunk", "  EOF  "].join("\n"),
		// A space between << and the delimiter is allowed.
		["cat << EOF", "git push origin trunk", "EOF"].join("\n"),
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

	test("a global git flag never becomes the subcommand", () => {
		// Each flag takes a separate argument, so the token after it is not the verb.
		for (const command of [
			"git -c user.name=x commit -m y",
			"git --git-dir /tmp/x/.git commit -m y",
			"git --work-tree /tmp/x commit -m y",
			"git --namespace ns commit -m y",
			"git --exec-path /tmp/x commit -m y",
			"git --no-pager commit -m y",
			"git  commit -m y",
		]) {
			assert.match(trunkCommitReason(command, "trunk") ?? "", /a commit on trunk/, command);
		}
	});

	test("a pull on trunk is free, and its reason never says merge", () => {
		// The false positive this pins: `git pull --ff-only` was refused as a trunk merge,
		// so a boss told to pull the merged trunk was stuck behind its own guard.
		for (const command of ["git pull", "git pull --ff-only", "git pull origin trunk", "git pull --rebase"]) {
			assert.equal(trunkCommitReason(command, "trunk"), null, command);
			assert.equal(mergeReason(command), null, command);
		}
		// The verbs that do land a change stay blocked on the same branch.
		assert.ok(trunkCommitReason("git merge origin/trunk", "trunk"));
		assert.ok(trunkCommitReason("git push", "trunk"));
		assert.ok(trunkCommitReason('git commit -m "x"', "trunk"));
	});

	test("a git command with no subcommand is not a commit", () => {
		assert.equal(mergeReason("git -c user.name=x"), null);
		assert.equal(trunkCommitReason("git -c user.name=x", "trunk"), null);
	});

	test("a commit on a feature branch is free", () => {
		assert.equal(trunkCommitReason('git commit -m "x"', "feat/x"), null);
		assert.equal(trunkCommitReason("git merge trunk", "feat/x"), null);
	});

	test("a push with no refspec on trunk pushes trunk", () => {
		assert.match(trunkCommitReason("git push", "trunk"), /push from trunk/);
		assert.match(trunkCommitReason("git push -u origin", "main"), /push from main/);
		assert.match(trunkCommitReason("git push origin HEAD", "master"), /push from master/);
	});

	test("a refspec list that includes trunk is not a branch push", () => {
		assert.match(trunkCommitReason("git push origin trunk feat/x", "trunk") ?? "", /push from trunk/);
		assert.match(trunkCommitReason("git push origin feat/x trunk", "main") ?? "", /push from main/);
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

describe("merge-guard: stash rules", () => {
	test("the reason names the verb it would run", () => {
		assert.equal(parkReason("git stash"), "a `git stash`");
		assert.equal(parkReason("git stash -u"), "a `git stash`");
		assert.equal(parkReason("git stash drop"), "a `git stash drop`");
		// A token that ends with a dash is a verb, not a flag.
		assert.equal(parkReason("git stash drop-"), "a `git stash drop-`");
	});

	const blocked = [
		["git stash", "a bare stash saves"],
		["git stash -u", "push is the default verb"],
		["git stash push -u -m 'boss: unblock worker spawn'", "the form delegate suggests"],
		["git -C /home/mark/.pi stash -u", "the exact command delegate prints"],
		["cd /home/mark/.pi && git stash push", "a cd before the stash"],
		["git stash save 'wip'", "the deprecated verb still parks"],
		["git stash drop stash@{0}", "dropping a stash deletes work"],
		["git stash clear", "clearing deletes every stash"],
	];

	for (const [command, why] of blocked) {
		test(`blocks \`${command}\` (${why})`, () => {
			assert.ok(parkReason(command), `expected a reason for: ${command}`);
		});
	}

	const allowed = [
		"git stash list",
		"git stash show -p stash@{0}",
		"git stash pop",
		"git stash apply stash@{0}",
		"git stash branch recover stash@{0}",
		"git stash --help",
		`echo "git stash -u"`,
		"git status --short",
	];

	for (const command of allowed) {
		test(`allows \`${command}\``, () => {
			assert.equal(parkReason(command), null, `unexpected block: ${command}`);
		});
	}
});

describe("merge-guard: handler", () => {
	test("a stash is blocked, and the reason names the worktree instead", async () => {
		const { emit, ctx, notices } = setup();
		const [result] = await emit("tool_call", { toolName: "bash", input: { command: "git -C /home/mark/.pi stash -u" } }, ctx);
		assert.equal(result?.block, true);
		assert.equal(notices.at(-1)?.message, "merge-guard: blocked a stash — the checkout is in use");
		assert.equal(notices.at(-1)?.level, "warning");
		const reason = String(result?.reason);
		assert.match(reason, /parks uncommitted work in a checkout/);
		assert.match(reason, /cut a worktree from origin\/trunk instead/);
		assert.match(reason, /worktree add/);
		assert.match(reason, /\/mergeguard allow and retry/);
	});

	test("a one-shot stash allowance is spent by that stash", async () => {
		const { emit, ctx, commands, notices } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		const [stashed] = await emit("tool_call", { toolName: "bash", input: { command: "git stash -u" } }, ctx);
		assert.equal(stashed, undefined);
		assert.equal(notices.at(-1)?.message, "merge-guard: allowed once, as you approved");
		assert.equal(notices.at(-1)?.level, "info");
		const [again] = await emit("tool_call", { toolName: "bash", input: { command: "git stash -u" } }, ctx);
		assert.equal(again?.block, true, "the allowance must not survive the stash it approved");
	});

	test("/mergeguard allow unlocks one stash, and the pop after it stays free", async () => {
		const { emit, ctx, commands } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		const [allowed] = await emit("tool_call", { toolName: "bash", input: { command: "git stash -u" } }, ctx);
		assert.equal(allowed, undefined);
		const [popped] = await emit("tool_call", { toolName: "bash", input: { command: "git stash pop" } }, ctx);
		assert.equal(popped, undefined);
	});
	test("a merge command is blocked, not run", async () => {
		const { emit, ctx, notices } = setup();
		const [result] = await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1 --squash" } }, ctx);
		assert.equal(result?.block, true);
		assert.match(result.reason, /user's explicit go-ahead/);
		assert.match(result.reason, /protected branch/);
		// The refusal offers the way forward a blocked pull used to deny.
		assert.match(result.reason, /pull the remote instead: git pull --ff-only/);
		assert.equal(notices.at(-1)?.message, "merge-guard: blocked a merge — ask the user first");
		assert.equal(notices.at(-1)?.level, "warning");
	});

	test("an allowed merge says so once", async () => {
		const { emit, ctx, commands, notices } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		const [allowed] = await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx);
		assert.equal(allowed, undefined);
		assert.equal(notices.at(-1)?.message, "merge-guard: allowed once, as you approved");
		assert.equal(notices.at(-1)?.level, "info");
	});

	test("the command's own words are what the user sees", async () => {
		const { ctx, commands, notices } = setup();
		const command = commands.get("mergeguard");
		assert.equal(
			command.description,
			"Show merge-guard state, or allow the next merge/trunk commit: /mergeguard allow",
		);
		await command.handler("allow", ctx);
		assert.equal(notices.at(-1)?.message, "merge-guard: the next merge, trunk push or trunk commit will run once");
		await command.handler("banana", ctx);
		assert.equal(notices.at(-1)?.message, "usage: /mergeguard [status|allow]");
		assert.equal(notices.at(-1)?.level, "warning");
	});

	test("the command argument is trimmed and case-folded", async () => {
		const { ctx, commands, notices } = setup();
		await commands.get("mergeguard").handler("  ALLOW  ", ctx);
		assert.equal(notices.at(-1)?.message, "merge-guard: the next merge, trunk push or trunk commit will run once");
		await commands.get("mergeguard").handler(" STATUS ", ctx);
		assert.equal(notices.at(-1)?.message, "merge-guard: one landing allowed");
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

		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0], undefined);
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 1" } }, ctx))[0]?.block, true);
	});

	test("the allowance survives unrelated commands and is spent by the merge", async () => {
		const { emit, ctx, commands } = setup();
		await commands.get("mergeguard").handler("allow", ctx);
		await emit("tool_call", { toolName: "bash", input: { command: "git status" } }, ctx);
		await emit("tool_call", { toolName: "bash", input: { command: "git push -u origin feat/x" } }, ctx);
		// still allowed: the approval was for the merge, not for these
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "git push origin trunk" } }, ctx))[0], undefined);
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
		assert.equal(notices.at(-1)?.level, "info");
		await commands.get("mergeguard").handler("status", ctx);
		assert.equal(notices.at(-1)?.message, "merge-guard: one landing allowed");
		assert.equal(notices.at(-1)?.level, "info");
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

	// The session cwd only has to be a directory that exists: the rule reads it as a
	// default path, never as a repository.
	const session = plainDir;

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
		// No space between the flag and its path is still a path.
		assert.deepEqual(gitSegments(`git -C${trunkDir} commit -m x`).map((s) => s.dir), [trunkDir]);
	});

	test("cd takes its path however it is spaced, and after --", () => {
		assert.match(
			trunkCommitReason(`cd  ${trunkDir} && git commit -m x`, resolver, session) ?? "",
			/a commit on trunk/,
		);
		assert.match(
			trunkCommitReason(`cd -- ${trunkDir} && git commit -m x`, resolver, session) ?? "",
			/a commit on trunk/,
		);
		assert.match(
			trunkCommitReason(`cd --  ${trunkDir} && git commit -m x`, resolver, session) ?? "",
			/a commit on trunk/,
		);
	});

	test("an indented cd on its own line still carries over", () => {
		const command = ["git status", `  cd ${trunkDir} && git commit -m x`].join("\n");
		assert.match(trunkCommitReason(command, { [trunkDir]: "trunk", [session]: "feat/x" }, session) ?? "", /a commit on trunk/);
	});

	test("a relative path is resolved against the session cwd", () => {
		assert.match(trunkCommitReason("git -C sub commit -m x", { [`${session}/sub`]: "trunk" }, session) ?? "", /a commit on trunk/);
		// With no cwd to resolve against, the token is used as written.
		assert.match(trunkCommitReason("git -C relative commit -m x", { relative: "trunk" }) ?? "", /a commit on trunk/);
	});

	test("a ~ path is expanded before the lookup", () => {
		assert.match(
			trunkCommitReason("git -C ~/repo commit -m x", { [`${homedir()}/repo`]: "trunk" }) ?? "",
			/a commit on trunk/,
		);
	});

	test("a bare branch name is only consulted for the session cwd", () => {
		// The map with no directory named falls back to the empty key.
		assert.equal(trunkCommitReason("git commit -m x", { "": "feat/x" }), null);
		assert.match(trunkCommitReason("git commit -m x", { "": "trunk" }) ?? "", /a commit on trunk/);
	});

	test("currentBranch reports null on a detached HEAD", () => {
		assert.equal(currentBranch(detachedDir), null);
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

/**
 * The parser's own shapes: a hole where a segment used to be, a word that only
 * looks like a `cd`, a `~` that is not an expansion, extra whitespace. Each one
 * decides which directory a git command is judged in, so each one is a guard
 * rule and not a formatting detail.
 */
describe("merge-guard: command shapes the parser has to survive", () => {
	test("an empty segment is dropped, not carried", () => {
		// A trailing `&&` leaves a hole. Kept, the hole becomes a segment that
		// inherits the directory of the command before it.
		assert.deepEqual(
			gitSegments("git status &&").map((s) => s.segment),
			["git status"],
		);
		assert.deepEqual(
			gitSegments("; git status").map((s) => s.segment),
			["git status"],
		);
	});

	test("a cd only counts when it starts the segment", () => {
		// `echo cd /nowhere` prints two words; it does not change directory, and
		// it certainly does not move the next command into /nowhere.
		assert.deepEqual(
			gitSegments("echo cd /nowhere && git status").map((s) => s.dir),
			[null, null],
		);
	});

	test("-C is read after a global flag that takes its own argument", () => {
		assert.match(
			trunkCommitReason("git -c user.name=x -C /p commit -m y", { "/p": "trunk" }) ?? "",
			/a commit on trunk/,
		);
		assert.match(
			trunkCommitReason("git --git-dir=/r/.git -C /p commit -m x", { "/p": "trunk" }) ?? "",
			/a commit on trunk/,
		);
	});

	test("only a leading ~ is an expansion", () => {
		// A directory whose name contains a tilde is a directory, not a home.
		assert.match(
			trunkCommitReason("git -C /tmp/a~b commit -m x", { "/tmp/a~b": "trunk" }) ?? "",
			/a commit on trunk/,
		);
		assert.match(
			trunkCommitReason("git -C ~/repo commit -m x", { [`${homedir()}/repo`]: "trunk" }) ?? "",
			/a commit on trunk/,
		);
	});

	test("a relative path ending in / resolves against the session cwd", () => {
		const session = mkdtempSync(join(tmpdir(), "pi-merge-guard-session-"));
		try {
			assert.match(
				trunkCommitReason("git -C sub/ commit -m x", { [`${session}/sub`]: "trunk" }, session) ?? "",
				/a commit on trunk/,
			);
		} finally {
			rmSync(session, { recursive: true, force: true });
		}
	});

	test("a path is normalised before the branch lookup", () => {
		// `..` in a directory the command names is the same repository as the
		// normalised path, and the lookup has to agree.
		assert.match(
			trunkCommitReason("git -C /tmp/a/../trunk commit -m x", { "/tmp/trunk": "trunk" }) ?? "",
			/a commit on trunk/,
		);
	});

	test("whitespace between `stash` and its verb is never a verb", () => {
		// Splitting on a single space leaves an empty token in front of the verb,
		// and an empty verb would be reported as parked work.
		assert.equal(parkReason("git stash  list"), null);
		assert.equal(parkReason("git stash   show"), null);
		assert.equal(parkReason("git stash  pop"), null);
	});
});
