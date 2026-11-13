/**
 * prs — pull requests on the left, the diff on the right, and the actions you
 * take on one: review it, or hand the work to the big-boss-pi agent.
 *
 * Left: open pull requests grouped by repository, review requests first. Click
 * one and the right side shows its diff — file headers with +/− counts, hunk
 * headers, line numbers, a green/red sign gutter.
 *
 * Right, below the diff: a note field with Approve / Request changes / Comment,
 * and four buttons that hand the job to the big-boss-pi agent that is already
 * running — review the PR, fix the pipeline, fix the merge conflicts, fix the
 * review comments. That agent does not do the work either: it hands it to a
 * worker whose cwd is the PR's clone. The buttons never start a second agent in
 * the big-boss-pi workspace; a second one there is a competing boss.
 *
 * The handover asks the core the app is already connected to: `hc ls --all --json`
 * names the live agent whose cwd is AGENT_FOLDER and that no worker spawn made
 * (workers carry a terminal name), and `hc send` puts the request in its pane.
 * The app's own command set has no agent.list or agent.prompt, so the mod does
 * not ask the app for them. With no boss running, the mod makes the space with
 * plain pi and sends the same text to the agent that appears.
 *
 * Keys: ↑/↓ move · a/x/c review · m merge (twice) · o browser · r refresh ·
 * esc cancel · 1..4 hand one of the four jobs to the boss agent.
 *
 * Props: `{ "open": "owner/repo#12" }` starts on that pull request.
 *
 * Radar basis: #17 risk-tiered human oversight and #42 human-in-the-loop
 * theater — the human reads the change and presses the key, and the one agent
 * that acts on it is the boss they already watch, never a second one the button
 * quietly started.
 */
import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar, Textarea, TextareaState } from "gpui-base";
import { appHome, exec, hc, home, nextCommand, props, run, settings, theme, writeTextFile } from "herdr";

const FRAGMENT = `fragment PR on PullRequest {
  number title url isDraft reviewDecision mergeable updatedAt headRefName
  author { login }
  repository { nameWithOwner defaultBranchRef { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

/** Two searches per owner we can see, so every repository with an open pull request shows up. */
function searchQuery(owners) {
	const parts = owners
		.map((qualifier, i) => `s${i}: search(query: "is:open is:pr archived:false ${qualifier}", type: ISSUE, first: 60) { nodes { ...PR } }`)
		.join("\n  ");
	return `query {
  viewer { login }
  ${parts}
  asked: search(query: "is:open is:pr archived:false review-requested:@me", type: ISSUE, first: 60) { nodes { ...PR } }
}
${FRAGMENT}`;
}

const CONFIRM_MS = 8000;
const MAX_DIFF_LINES = 4000;
// Rendered without virtualization: rows need their own click handler.
const SHOWN_LINES = 2000;
// Both note boxes stop growing at four rows and scroll inside instead.
const LINE_ROWS = 4;
const REVIEW_ROWS = 4;
/** Alpha suffixes on the theme's green and red: readable, not faded. */
const ADD_TINT = "52";
const DEL_TINT = "52";

/**
 * The one big-boss-pi workspace: where the agent that receives every button's
 * job lives, never the PR's own clone. That workspace's AGENTS.md makes its agent
 * pass the work to a worker with the clone as the worker's cwd. The mod only ever
 * prompts the agent already running there — starting another one in this folder
 * made a second boss that delegated to a third, competing agent.
 */
const AGENT_FOLDER = "/home/mark/big-boss-pi";

/** Finds a local clone by name, in the home directory, a dotted one, or one folder down. */
const FIND_CLONE = `
for d in "$HOME/$1" "$HOME/.$1" "$HOME/code/$1" "$HOME/src/$1" "$HOME/repos/$1" "$HOME/projects/$1" "$HOME/work/$1" "$HOME/git/$1" "$HOME"/*/"$1" "$HOME"/.*/"$1"; do
  [ -d "$d/.git" ] || continue
  git -C "$d" remote get-url origin 2>/dev/null | grep -q "$2" && { echo "$d"; exit 0; }
done
`;

async function gh(args, timeout) {
	const first = await exec("gh", args, { timeout });
	if (first.code !== 127 && !/ENOENT|no such file/i.test(first.stderr)) return first;
	return exec(`${home()}/.local/bin/gh`, args, { timeout });
}

function ago(iso) {
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	if (seconds < 90) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

/**
 * A unified diff as rows. Each file is one row carrying its own path and +/−
 * counts, so a long diff still says which file you are in and what it costs.
 */
function parseDiff(text) {
	const files = [];
	let file = null;
	let oldLine = 0;
	let newLine = 0;
	const ignore = /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to)|old mode|new mode|Binary files)/;
	for (const line of text.split("\n")) {
		const start = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (start) {
			file = { path: start[2], add: 0, del: 0, rows: [] };
			files.push(file);
			continue;
		}
		if (!file) {
			file = { path: "", add: 0, del: 0, rows: [] };
			files.push(file);
		}
		if (start || ignore.test(line)) continue;
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
		if (hunk) {
			oldLine = +hunk[1];
			newLine = +hunk[2];
			file.rows.push({ kind: "@", path: file.path, text: line });
			continue;
		}
		const kind = line[0];
		if (kind === "+") {
			file.add++;
			file.rows.push({ kind, path: file.path, side: "RIGHT", number: newLine++, text: untab(line.slice(1)) || " " });
		} else if (kind === "-") {
			file.del++;
			file.rows.push({ kind, path: file.path, side: "LEFT", number: oldLine++, text: untab(line.slice(1)) || " " });
		} else if (kind === " ") {
			oldLine++;
			file.rows.push({ kind, path: file.path, side: "RIGHT", number: newLine++, text: untab(line.slice(1)) || " " });
		} else file.rows.push({ kind: "", path: file.path, text: line });
	}
	const rows = [];
	for (const entry of files) {
		rows.push({ kind: "file", path: entry.path, text: entry.path, add: entry.add, del: entry.del });
		rows.push(...entry.rows);
	}
	// The index is the row's identity while the diff is on screen, not a line number.
	return rows.map((row, at) => ({ ...row, at }));
}

/**
 * The request a button sends to the boss agent: the job a worker must do, and the
 * clone that worker starts in. It reads as a request to that agent, so it never
 * says where the reader "starts" — the boss hands the job on.
 */
function task(kind, pr, quote, folder) {
	const label = kind === "line" ? "a comment on one changed line" : (ACTIONS.find((a) => a.key === kind)?.label ?? kind);
	const head = `The user pressed "${label}" in the Herdr prs mod, on pull request ${pr.repo}#${pr.number} — ${pr.title}.`;
	const repo = pr.repo;
	const n = pr.number;
	const clone = folder ?? `${home()}/code/${repo.split("/")[1]}`;
	const missing = folder ? "" : ` That clone does not exist yet: \`gh repo clone ${repo} ${clone}\` first.`;
	// The AGENTS.md in AGENT_FOLDER makes handing work to a worker that agent's job.
	const common = `\n\nDelegate it to a worker: the AGENTS.md in ${AGENT_FOLDER} is binding, so do NOT do this work yourself — do not check the branch out, do not edit files, do not commit or push. Ask Jev which route it is (\`jev route "<the job in one line>"\`) when that is not obvious, then hand the whole job to a worker: \`delegate spawn --cwd ${clone}\`, so a worker agent runs it in another Herdr space with the clone as its cwd.${missing} Then wait for that worker and relay its report — what changed, what is still open, what the worker could not do — instead of reporting on work you did. Never merge, never push to the trunk branch, and do not stop before the worker has reported.`;
	if (kind === "review")
		return `${head}\n\nReview it. Read \`gh pr view ${n} -R ${repo}\` and \`gh pr diff ${n} -R ${repo}\`, and read the code around the change before judging it. Then post one review: \`gh pr review ${n} -R ${repo} --comment --body-file -\` (use --request-changes if something must change before it lands), naming the files and lines you are unsure about. Do not touch the code.${common}`;
	if (kind === "checks")
		return `${head}\n\nIts checks are failing. List them with \`gh pr checks ${n} -R ${repo}\`, read the failing job with \`gh run view <run-id> --log-failed\`, then \`gh pr checkout ${n} -R ${repo}\` and reproduce it here. Fix the cause, not the assertion, unless the test is wrong — say which in the commit message. Run what CI runs, then push to the PR branch.${common}`;
	if (kind === "conflicts")
		return `${head}\n\nIt conflicts with its base branch. \`gh pr view ${n} -R ${repo} --json baseRefName,headRefName\`, then \`gh pr checkout ${n} -R ${repo}\` and merge the base branch in. Resolve each conflict by keeping both intents — the PR's and the base branch's — not by picking a side. Run the tests, then push to the PR branch.${common}`;
	if (kind === "line")
		return `${head}\n\nSomeone left this review note on \`${quote.path}\` at line ${quote.number}:\n\n> ${quote.body.replace(/\n/g, "\n> ")}\n\n\`gh pr checkout ${n} -R ${repo}\`, make that line right, then push to the PR branch and reply to the note with \`gh api repos/${repo}/pulls/comments/{id}/replies -f body=-\` (the id is in \`gh api repos/${repo}/pulls/${n}/comments\`) once it is done. If you think the note is wrong, do not change the code — reply with the reason instead.${common}`;
	if (quote)
		return `${head}\n\nThe review asked for changes:\n\n> ${quote.replace(/\n/g, "\n> ")}\n\nRead the comments with \`gh pr view ${n} -R ${repo} --comments\` and \`gh api repos/${repo}/pulls/${n}/comments\`, \`gh pr checkout ${n} -R ${repo}\`, fix them, and push to the PR branch. Reply to each note you address, and say why where you disagree.${common}`;
	return `${head}\n\nIt has review comments to address. Read them with \`gh pr view ${n} -R ${repo} --comments\` and \`gh api repos/${repo}/pulls/${n}/comments --jq '.[] | {path, line, body}'\`. \`gh pr checkout ${n} -R ${repo}\`, then fix each comment in code. Where you disagree, reply with the reason instead of silently skipping it. Push to the PR branch.${common}`;
}

const ACTIONS = [
	{ key: "review", label: "review the PR" },
	{ key: "checks", label: "fix pipeline" },
	{ key: "conflicts", label: "fix merge conflicts" },
	{ key: "comments", label: "fix review comments" },
];

export default class PullRequests extends View {
	init(_props, cx) {
		this.handle = cx.focus_handle();
		this.me = "";
		this.listScroll = ScrollHandle.new();
		this.prs = [];
		this.selected = 0;
		this.diff = { rows: [], width: 600, key: "", loading: false };
		this.error = "";
		this.notice = "";
		this.loading = true;
		this.pending = "";
		this.reviewAction = "";
		this.busy = "";
		this.folders = {};
		this.line = null;
		this.collapsed = new Set();
		this.tmp = `${appHome()}/review-note.json`;
		this.tmpLast = null;
		// Enter is a newline in both boxes: posting is only ever a button.
		this.note = TextareaState.new({ placeholder: "Review note — Enter starts a new line", rows: 1 });
		this.note.set_auto_grow(1, REVIEW_ROWS);
		this.note.set_soft_wrap(true);

		this.lineNote = TextareaState.new({ placeholder: "Comment on this line — Enter starts a new line", rows: 1 });
		this.lineNote.set_auto_grow(1, LINE_ROWS);
		this.lineNote.set_soft_wrap(true);

		this.refresh(cx);
		const start = props()?.open;
		if (start) cx.timer.after(1200, (cx) => this.select(start, cx));
		cx.timer.every(120000, (cx) => this.refresh(cx));
		cx.spawn(async (cx) => {
			for (;;) {
				const command = await nextCommand();
				if (command === "focus") {
					this.handle.focus();
					cx.notify();
				}
			}
		});
	}

	get current() {
		return this.prs[Math.min(this.selected, this.prs.length - 1)];
	}

	/** Grouped for the left column: one block per repository, review requests first. */
	get groups() {
		const byRepo = new Map();
		for (const pr of this.prs) {
			if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
			byRepo.get(pr.repo).push(pr);
		}
		return [...byRepo.entries()]
			.map(([repo, list]) => ({ repo, list, asked: list.some((pr) => pr.review) }))
			.sort((a, b) => (a.asked === b.asked ? a.repo.localeCompare(b.repo) : a.asked ? -1 : 1));
	}

	/** The owners to search: me, and every organisation I am in. */
	async owners() {
		if (this.ownerList) return this.ownerList;
		const result = await gh(["api", "graphql", "-f", 'query={ viewer { login organizations(first: 50) { nodes { login } } } }'], 30000);
		if (result.code !== 0) return ["user:@me"];
		try {
			const data = JSON.parse(result.stdout).data.viewer;
			const orgs = data.organizations.nodes.map((o) => `org:${o.login}`);
			this.ownerList = [`user:${data.login}`, ...orgs];
		} catch {
			this.ownerList = ["user:@me"];
		}
		return this.ownerList;
	}

	refresh(cx, done) {
		cx.spawn(async (cx) => {
			const result = await gh(["api", "graphql", "-f", `query=${searchQuery(await this.owners())}`], 60000);
			if (result.code !== 0) {
				this.error = (result.stderr || "gh api graphql failed").trim().split("\n")[0];
			} else {
				try {
					const data = JSON.parse(result.stdout).data;
					this.me = data.viewer.login;
					const shape = (n, review) => ({
						key: `${n.repository.nameWithOwner}#${n.number}`,
						repo: n.repository.nameWithOwner,
						number: n.number,
						title: n.title,
						url: n.url,
						branch: n.headRefName,
						base: n.repository.defaultBranchRef?.name ?? "",
						author: n.author?.login ?? "",
						review,
						draft: n.isDraft,
						decision: n.reviewDecision,
						mergeable: n.mergeable,
						checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "",
						updated: ago(n.updatedAt),
						updatedMs: Date.parse(n.updatedAt) || 0,
					});
					const asked = (data.asked?.nodes ?? []).filter((n) => n?.number).map((n) => shape(n, true));
					const askedKeys = new Set(asked.map((pr) => pr.key));
					const seen = new Set(askedKeys);
					const others = [];
					for (const [alias, value] of Object.entries(data)) {
						if (!alias.startsWith("s") || !value?.nodes) continue;
						for (const n of value.nodes) {
							if (!n?.number || seen.has(`${n.repository.nameWithOwner}#${n.number}`)) continue;
							seen.add(`${n.repository.nameWithOwner}#${n.number}`);
							others.push(shape(n, false));
						}
					}
					const order = (a, b) => b.updatedMs - a.updatedMs;
					this.prs = [...asked.sort(order), ...others.sort(order)];
					this.error = "";
				} catch (e) {
					this.error = `could not read gh output: ${e}`;
				}
			}
			this.loading = false;
			// Keep the selection on the same pull request when the list is rebuilt.
			const kept = this.current?.key;
			const index = kept ? this.prs.findIndex((pr) => pr.key === kept) : -1;
			this.selected = index >= 0 ? index : 0;
			if (this.current) this.listScroll?.scroll_to_item(this.flatIndex(this.current.key));
			cx.notify();
			const current = this.current;
			if (current && this.diff.key !== current.key) this.loadDiff(current, cx);
			if (done) done();
		});
	}

	loadDiff(pr, cx) {
		if (!pr) return;
		this.diff = { rows: [], width: 600, key: pr.key, loading: true };
		cx.notify();
		cx.spawn(async (cx) => {
			const result = await gh(["pr", "diff", String(pr.number), "-R", pr.repo], 120000);
			const lines = result.code === 0 ? result.stdout.split("\n") : [(result.stderr || "no diff").trim()];
			const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
			if (lines.length > MAX_DIFF_LINES) shown.push(`… ${lines.length - MAX_DIFF_LINES} more lines — press o for the whole diff`);
			const rows = parseDiff(shown.join("\n"));
			const width = Math.max(400, ...rows.map((r) => (r.text.length + 1) * 6.6 + 70));
			this.diff = { rows, width, key: pr.key, loading: false };
			cx.notify();
		});
	}

	/** The rows of the left column: a header per repository, then its pull requests. */
	get listRows() {
		const rows = [];
		for (const group of this.groups) {
			rows.push({ type: "group", repo: group.repo, count: group.list.length, asked: group.asked });
			if (this.collapsed.has(group.repo)) continue;
			for (const pr of group.list) rows.push({ type: "pr", pr });
		}
		return rows;
	}

	/** The row's position in the flat list, counting the repository headers. */
	flatIndex(key) {
		const index = this.listRows.findIndex((row) => row.type === "pr" && row.pr.key === key);
		return index < 0 ? 0 : index;
	}

	select(key, cx) {
		const index = this.prs.findIndex((pr) => pr.key === key);
		if (index < 0) return;
		this.selected = index;
		this.pending = "";
		this.reviewAction = "";
		this.line = null;
		this.listScroll?.scroll_to_item(this.flatIndex(key));
		this.loadDiff(this.prs[index], cx);
	}

	move(delta, cx) {
		if (!this.prs.length) return;
		const next = Math.min(this.prs.length - 1, Math.max(0, this.selected + delta));
		if (next === this.selected) return;
		this.selected = next;
		this.pending = "";
		this.reviewAction = "";
		this.line = null;
		this.listScroll?.scroll_to_item(this.flatIndex(this.current.key));
		this.loadDiff(this.current, cx);
	}

	/** Take one pull request out of the list now, keeping the selection where it was. */
	drop(key, cx) {
		const at = this.prs.findIndex((pr) => pr.key === key);
		if (at < 0) return;
		this.prs.splice(at, 1);
		if (this.selected >= at) this.selected = Math.max(0, this.selected - 1);
		if (this.selected >= this.prs.length) this.selected = Math.max(0, this.prs.length - 1);
		this.pending = "";
		this.reviewAction = "";
		this.line = null;
		if (this.diff.key === key) this.diff = { rows: [], width: 600, key: "", loading: false };
		const next = this.current;
		if (!next) {
			cx.notify();
			return;
		}
		this.listScroll?.scroll_to_item(this.flatIndex(next.key));
		this.loadDiff(next, cx);
	}

	arm(row, cx) {
		this.pending = row.key;
		cx.notify();
		cx.timer.after(CONFIRM_MS, (cx) => {
			if (this.pending === row.key) {
				this.pending = "";
				cx.notify();
			}
		});
	}

	merge(cx) {
		const pr = this.current;
		if (!pr || this.busy) return;
		this.busy = pr.key;
		this.notice = "";
		this.error = "";
		cx.notify();
		cx.spawn(async (cx) => {
			const result = await gh(["pr", "merge", String(pr.number), "-R", pr.repo, "--squash", "--delete-branch"], 120000);
			if (result.code !== 0) {
				this.busy = "";
				this.error = `merge failed: ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`;
				cx.notify();
				return;
			}
			// Gone this frame, before the local clone is touched: waiting for the
			// two-minute poll to drop the row made a finished merge look ignored.
			this.busy = "";
			this.drop(pr.key, cx);
			this.notice = `merged ${pr.key} · updating the local clone…`;
			cx.notify();
			const local = await this.syncLocal(pr);
			this.notice = `merged ${pr.key} · ${local}`;
			cx.notify();
			this.refresh(cx);
		});
	}

	/**
	 * After a merge: bring the local clone's trunk up to date and drop the merged
	 * branch. Nothing is forced — a dirty tree, a branch with local commits and a
	 * trunk that is not a fast-forward all change the sentence and nothing else.
	 */
	async syncLocal(pr) {
		const folder = await this.folderFor(pr.repo);
		if (!folder) return "no local clone to update";
		const git = async (...args) => (await exec("git", ["-C", folder, ...args], { timeout: 90000 }).catch(() => null)) ?? { code: 1, stdout: "", stderr: "" };
		const base = pr.base || "trunk";
		const branch = pr.branch || "";
		const said = [];
		// Read before the prune: a squash merge leaves the branch unreachable from trunk,
		// so "was anything of mine still only here" = where it pointed upstream.
		const remoteTip = (await git("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)).stdout.trim();
		const localTip = (await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).stdout.trim();
		// Untracked files do not block a checkout, so they must not count as dirty here.
		const dirty = (await git("status", "--porcelain", "--untracked-files=no")).stdout.trim();
		let current = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
		await git("fetch", "--prune", "origin");

		/** Bring the trunk branch up to date, checked out or not, and say what happened. */
		const updateBase = async () => {
			current = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
			if (current === base) {
				const pulled = await git("merge", "--ff-only", `origin/${base}`);
				return pulled.code === 0 ? `${base} updated` : `${base} not fast-forwarded, left alone`;
			}
			const exists = (await git("rev-parse", "--verify", "--quiet", `refs/heads/${base}`)).code === 0;
			if (!exists) {
				const made = await git("branch", base, `origin/${base}`);
				return made.code === 0 ? `${base} created from origin` : `${base} missing and could not be created`;
			}
			const ancestor = await git("merge-base", "--is-ancestor", base, `origin/${base}`);
			if (ancestor.code !== 0) return `${base} has local commits, left alone`;
			const moved = await git("branch", "-f", base, `origin/${base}`);
			return moved.code === 0 ? `${base} updated (not checked out)` : `${base} could not be moved`;
		};

		const onBranch = current === branch;
		if (onBranch && !dirty) {
			const switched = await git("checkout", base);
			if (switched.code === 0) current = base;
			else said.push(`could not switch to ${base}: ${(switched.stderr || "").trim().split("\n")[0]}`);
		} else if (onBranch && dirty) {
			said.push(`${branch} has uncommitted changes, staying on it`);
		}
		said.push(await updateBase());

		if (!branch || branch === base) return said.join(" · ");
		if (!localTip) {
			said.push(`${branch} was not in the clone`);
			return said.join(" · ");
		}
		if (current === branch) {
			said.push(`${branch} still checked out, kept`);
			return said.join(" · ");
		}
		const remoteGone = (await git("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)).code !== 0;
		const unpushed = remoteTip !== "" && localTip !== remoteTip;
		if (!remoteGone && unpushed) {
			said.push(`${branch} kept (has commits that were never pushed)`);
			return said.join(" · ");
		}
		const flag = unpushed ? "-d" : "-D";
		if ((await git("branch", flag, branch)).code === 0) said.push(`${branch} deleted`);
		else said.push(`${branch} kept (local commits)`);
		return said.join(" · ");
	}

	startReview(kind, cx) {
		const pr = this.current;
		if (!pr) return;
		if (pr.author === this.me) {
			this.error = `${pr.key} is yours — GitHub does not accept reviews on your own pull request`;
			cx.notify();
			return;
		}
		this.error = "";
		this.reviewAction = kind;
		cx.notify();
		this.note.focus();
	}

	sendReview(cx) {
		const pr = this.current;
		const kind = this.reviewAction;
		if (!pr || !kind) return;
		const body = this.note.value().trim();
		if (!body && kind !== "approve") {
			this.error = "this review needs a note — type one in the box below";
			cx.notify();
			return;
		}
		const flags = { approve: "--approve", changes: "--request-changes", comment: "--comment" };
		const args = ["pr", "review", String(pr.number), "-R", pr.repo, flags[kind]];
		if (body) args.push("--body", body);
		this.busy = pr.key;
		this.error = "";
		this.notice = "";
		cx.notify();
		cx.spawn(async (cx) => {
			const result = await gh(args, 120000);
			this.busy = "";
			if (result.code !== 0) {
				this.error = `review failed: ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`;
				cx.notify();
				return;
			}
			const verb = kind === "approve" ? "approved" : kind === "changes" ? "requested changes on" : "commented on";
			this.notice = `${verb} ${pr.key}`;
			this.reviewAction = "";
			const body2 = body;
			this.note.set_value("");
			this.handle.focus();
			// A review that asks for work is a request to do the work: an agent gets it.
			if (kind === "changes" || kind === "comment") this.handToBoss("comments", pr, body2, cx);
			this.refresh(cx);
		});
	}

	/** A note on one changed line, as a GitHub review comment, then an agent that fixes it. */
	postLineNote(cx) {
		const pr = this.current;
		const row = this.line;
		const body = this.lineNote.value().trim();
		if (!pr || !row) return;
		if (!body) {
			this.error = "type the comment first";
			cx.notify();
			return;
		}
		const payload = {
			event: "COMMENT",
			body: "",
			comments: [{ path: row.path, line: row.number, side: row.side, body }],
		};
		this.busy = pr.key;
		this.error = "";
		this.notice = "";
		cx.notify();
		cx.spawn(async (cx) => {
			const text = JSON.stringify(payload);
			await writeTextFile(this.tmp, text, this.tmpLast).catch(() => null);
			this.tmpLast = text;
			const result = await gh(["api", "repos/" + pr.repo + "/pulls/" + pr.number + "/reviews", "--input", this.tmp], 60000);
			this.busy = "";
			if (result.code !== 0) {
				this.error = `note not posted: ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`;
				cx.notify();
				return;
			}
			const quote = { path: row.path, number: row.number, body };
			this.lineNote.set_value("");
			this.notice = `comment posted on ${row.path}:${row.number} — the line stays picked`;
			this.handToBoss("line", pr, quote, cx);
			cx.timer.after(30, (cx) => this.lineNote.focus());
		});
	}

	async folderFor(repo) {
		if (this.folders[repo] !== undefined) return this.folders[repo];
		const name = repo.split("/")[1];
		const found = await exec("/bin/sh", ["-c", FIND_CLONE, "sh", name, repo], { timeout: 15000 }).catch(() => null);
		this.folders[repo] = found?.code === 0 && found.stdout.trim() ? found.stdout.trim().split("\n")[0] : null;
		return this.folders[repo];
	}

	/** The pi binary: the desktop session's PATH usually lacks wherever it was installed. */
	async piPath() {
		if (this.pi) return this.pi;
		const script =
			'for c in "$HOME/.local/share/pnpm/bin/pi" "$HOME/.local/bin/pi" /usr/local/bin/pi /usr/bin/pi; do [ -x "$c" ] && { echo "$c"; exit 0; }; done; command -v pi';
		const found = (await exec("/bin/sh", ["-c", script], { timeout: 8000 }).catch(() => null))?.stdout?.trim();
		this.pi = found || `${home()}/.local/share/pnpm/bin/pi`;
		return this.pi;
	}

	startAgent(kind, cx) {
		const pr = this.current;
		if (!pr) return;
		this.handToBoss(kind, pr, null, cx);
	}

	/**
	 * Hands one button's job to the big-boss-pi agent that is already running.
	 * Nothing here starts a second agent while the boss is there: a second one in
	 * that folder delegates on its own and competes with the first.
	 */
	handToBoss(kind, pr, quote, cx) {
		this.error = "";
		const name = `${pr.repo.split("/")[1]}#${pr.number} ${kind === "line" ? "note" : kind}`;
		cx.spawn(async (cx) => {
			// The clone is located only to be named: the boss hands the job to a worker
			// whose cwd is that clone.
			const folder = await this.folderFor(pr.repo);
			const text = task(kind, pr, quote, folder);
			let boss;
			try {
				boss = await this.bossAgent();
			} catch (e) {
				this.error = `could not list the running agents: ${e?.message ?? e}`;
				cx.notify();
				return;
			}
			if (!boss) {
				try {
					boss = await this.startBoss(cx);
				} catch (e) {
					this.error = `no big-boss-pi agent is running and one could not be started in ${AGENT_FOLDER}: ${e?.message ?? e}`;
					cx.notify();
					return;
				}
			}
			if (!boss) {
				this.error = `no big-boss-pi agent is running and none appeared in ${AGENT_FOLDER}`;
				cx.notify();
				return;
			}
			let sent;
			try {
				sent = await hc(["send", boss.address, text]);
			} catch (e) {
				sent = { code: 1, stderr: String(e?.message ?? e) };
			}
			if (sent.code !== 0) {
				this.error = `could not hand ${name} to the boss (${boss.address}): ${(sent.stderr || sent.stdout || "hc send failed").trim().split("\n")[0]}`;
				cx.notify();
				return;
			}
			this.notice = `${this.notice ? this.notice + " · " : ""}handed ${name} to the big-boss-pi agent (${boss.address}) to delegate${folder ? ` into ${folder}` : `, which clones ${pr.repo} first`}`;
			cx.notify();
		});
	}

	/**
	 * Live terminals in AGENT_FOLDER that are agents, from the core the app is talking to.
	 * `--all` matters: without it hc leaves out every field that tells the boss apart from a
	 * worker (its `--name` and when it started).
	 */
	async liveAgents() {
		const result = await hc(["ls", "--all", "--json"]);
		if (result.code !== 0) throw new Error((result.stderr || result.stdout || "hc ls failed").trim().split("\n")[0]);
		let terminals;
		try {
			terminals = JSON.parse(result.stdout).terminals ?? [];
		} catch (e) {
			throw new Error(`could not read hc ls output: ${e}`);
		}
		const isAgent = (t) => t.agent === "pi" || (t.foreground?.argv ?? []).some((a) => /(^|\/)pi$/.test(a));
		return terminals.filter((t) => t.state === "live" && !t.rm && isAgent(t) && t.cwd === AGENT_FOLDER);
	}

	/**
	 * The boss: the agent in AGENT_FOLDER that was not started as a worker. A worker
	 * comes from `hc run --name` and carries that name; a sub-agent has a parent. The
	 * oldest of the rest is the one this workspace belongs to, so a leftover agent in
	 * the same folder is never picked ahead of it.
	 */
	async bossAgent() {
		const found = (await this.liveAgents()).filter((t) => !t.name && !t.parent);
		return found.sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0))[0] ?? null;
	}

	/**
	 * No boss running: make the big-boss-pi space with plain pi and no baked-in task,
	 * then wait until that agent's banner is up — a send to a booting pi is dropped.
	 */
	async startBoss(cx) {
		const before = new Set((await this.liveAgents()).map((t) => t.address));
		run("space.new", { name: "big-boss-pi", folder: AGENT_FOLDER, argv: [await this.piPath()] });
		const sleep = (ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
		for (let i = 0; i < 60; i++) {
			await sleep(500);
			let fresh;
			try {
				fresh = (await this.liveAgents()).find((t) => !before.has(t.address));
			} catch {
				continue;
			}
			if (!fresh) continue;
			for (let j = 0; j < 60; j++) {
				const screen = await hc(["read", fresh.address]).catch(() => null);
				if (screen?.code === 0 && /escape interrupt|\/commands/i.test(screen.stdout)) return fresh;
				await sleep(500);
			}
			return fresh;
		}
		return null;
	}

	/** The changed line under the cursor, if any — only real lines take a note. */
	pickLine(row, cx) {
		if (!row || !row.path || row.number === undefined) return;
		this.line = row;
		this.error = "";
		cx.notify();
		// The box only exists after this render, so focus arrives a tick later.
		cx.timer.after(30, (cx) => {
			this.lineNote.focus();
			cx.notify();
		});
	}

	moveLine(delta, cx) {
		const rows = this.diff.rows;
		const usable = (row) => Boolean(row.path) && row.number !== undefined;
		if (!rows.length) return;
		const from = this.line ? rows.findIndex((row) => row.at === this.line.at) : -1;
		let index = from;
		if (from < 0) index = delta > 0 ? rows.findIndex(usable) : rows.length - 1 - [...rows].reverse().findIndex(usable);
		else for (index = from + delta; index >= 0 && index < rows.length && !usable(rows[index]); index += delta);
		if (index < 0 || index >= rows.length || !usable(rows[index])) return;
		this.pickLine(rows[index], cx);
	}

	key(event, cx) {
		const k = event.key;
		if ((k === "down" || k === "j") && !this.reviewAction) this.move(1, cx);
		else if ((k === "up" || k === "k") && !this.reviewAction) this.move(-1, cx);
		else if (k === "r") this.refresh(cx);
		else if (k === "escape") {
			this.pending = "";
			this.reviewAction = "";
			this.line = null;
			this.handle.focus();
			cx.notify();
		} else if (k === "]") this.moveLine(1, cx);
		else if (k === "[") this.moveLine(-1, cx);
		else if (k === "a") this.startReview("approve", cx);
		else if (k === "x") this.startReview("changes", cx);
		else if (k === "c") this.startReview("comment", cx);
		else if (k === "o" && this.current) exec("xdg-open", [this.current.url]);
		else if (k === "m" && this.current) {
			if (this.pending === this.current.key) {
				this.pending = "";
				this.merge(cx);
			} else this.arm(this.current, cx);
		} else if (/^[1-4]$/.test(k)) {
			const action = ACTIONS[Number(k) - 1];
			if (action) this.startAgent(action.key, cx);
		} else return;
		cx.stop_propagation();
	}

	textButton(id, label, on, primary, t) {
		return div()
			.id(id)
			.px(9)
			.py(3)
			.rounded(6)
			.text_size(11.5)
			.bg(primary ? t.solid : t.raised)
			.text_color(primary ? t.solid_foreground : t.foreground)
			.hover((s) => s.opacity(0.85))
			.on_click(on)
			.child(label);
	}

	checksBadge(pr, t) {
		const color = pr.checks === "SUCCESS" ? t.done : pr.checks === "PENDING" || pr.checks === "" ? t.muted : t.blocked;
		const text = pr.checks === "SUCCESS" ? "checks ✓" : pr.checks === "" ? "no checks" : `checks ${pr.checks.toLowerCase()}`;
		return div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(color).child(text);
	}

	listRow(pr, t, cx) {
		const index = this.prs.indexOf(pr);
		const selected = index === this.selected;
		return h_flex()
			.id(`pr-${pr.key}`)
			.gap(6)
			.px(8)
			.py(4)
			.items_center()
			.rounded(6)
			.when(selected, (el) => el.bg(t.selection))
			.when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
			.on_click((_e, cx) => this.select(pr.key, cx))
			.child(div().w(34).flex_none().text_color(t.muted).text_size(11.5).child(`#${pr.number}`))
			.child(
				v_flex()
					.flex_1()
					.min_w(0)
					.justify_start()
					.items_start()
					.child(div().truncate().text_size(12).text_color(pr.draft ? t.dim : t.foreground).child(pr.title))
					.child(
						h_flex()
							.gap(6)
							.text_size(10.5)
							.text_color(t.dim)
							.child(`${pr.author} · ${pr.updated}`)
							.when(pr.review, (el) => el.child(div().text_color(t.accent).child("review asked"))),
					),
			)
			.when(pr.checks === "SUCCESS", (el) => el.child(div().text_size(10).text_color(t.done).child("✓")))
			.when(pr.checks !== "SUCCESS" && pr.checks !== "", (el) => el.child(div().text_size(10).text_color(t.blocked).child("!")))
			.when(pr.mergeable === "CONFLICTING", (el) => el.child(div().text_size(10).text_color(t.blocked).child("≠")));
	}

	diffRow({ kind, number, text, add, del, at, path }, t, cx) {
		if (kind === "file")
			return h_flex()
				.w_full()
				.px(12)
				.h(22)
				.flex_none()
				.gap(8)
				.items_center()
				.bg(t.background)
				.child(div().flex_1().min_w(0).truncate().text_color(t.accent).child(text))
				.when(add > 0, (e) => e.child(div().text_size(10).text_color(t.ansi2).child(`+${add}`)))
				.when(del > 0, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(`−${del}`)));
		if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
		const mine = this.line && this.line.at === at && Boolean(path) && number !== undefined;
		return h_flex()
			.w_full()
			.h(20)
			.flex_none()
			.when(kind === "+", (e) => e.bg(t.ansi2 + ADD_TINT))
			.when(kind === "-", (e) => e.bg(t.ansi1 + DEL_TINT))
			.when(mine, (e) => e.bg(t.selection))
			.when(Boolean(path) && number !== undefined, (e) => e.id(`prs-diff-row-${at}`).cursor_pointer().on_mouse_down("left", (_ev, cx) => this.pickLine({ kind, number, path, at }, cx)))
			.child(
				h_flex()
					.w(16)
					.flex_none()
					.items_center()
					.justify_center()
					.when(mine, (e) => e.bg(t.solid).child(div().text_color(t.solid_foreground).child("#")))
					.when(!mine && kind === "+", (e) => e.bg(t.ansi2).child(div().text_color(t.background).child("+")))
					.when(!mine && kind === "-", (e) => e.bg(t.ansi1).child(div().text_color(t.background).child("−")))
					.when(!mine && kind !== "+" && kind !== "-", (e) => e.child(div().text_color(t.dim).child(" "))),
			)
			.child(div().w(38).flex_none().text_right().pr(6).text_color(t.dim).child(number === undefined ? "" : String(number)))
			.child(div().pl(8).flex_1().min_w(0).truncate().child(text));
	}

	/** Under the picked line: a four-row box that keeps Enter for itself, and a post button. */
	lineEditor(row, t, cx) {
		return v_flex()
			.id("prs-line-editor")
			.w_full()
			.gap(6)
			.px(10)
			.py(8)
			.flex_none()
			.bg(t.raised)
			.border_t_1()
			.border_b_1()
			.border_color(t.border)
			.child(
				div()
					.text_size(10.5)
					.text_color(t.dim)
					.child(`comment on ${row.path}:${row.number} — Enter starts a new line, the button posts it`),
			)
			.child(
				div()
					.w(760)
					.max_w_full()
					.max_h(LINE_ROWS * 20 + 12)
					.overflow_y_scrollbar()
					.rounded(6)
					.border_1()
					.border_color(t.input)
					.bg(t.background)
					.child(Textarea.new(this.lineNote).id("prs-line-note-input").w_full()),
			)
			.child(
				h_flex()
					.gap(6)
					.items_center()
					.child(this.textButton("prs-line-post", "post comment", (_e, cx) => this.postLineNote(cx), true, t))
					.child(this.textButton("prs-line-cancel", "cancel", (_e, cx) => {
						this.line = null;
						this.handle.focus();
						cx.notify();
					}, false, t))
					.child(div().text_size(10.5).text_color(t.dim).child("the line stays picked after posting")),
			);
	}

	groupHeader(group, t, cx) {
		const collapsed = this.collapsed.has(group.repo);
		return h_flex()
			.id(`repo-${group.repo}`)
			.px(8)
			.pt(8)
			.pb(3)
			.gap(6)
			.items_center()
			.rounded(6)
			.hover((s) => s.bg(t.hover))
			.on_click((_e, cx) => {
				if (collapsed) this.collapsed.delete(group.repo);
				else this.collapsed.add(group.repo);
				cx.notify();
			})
			.child(div().w(10).flex_none().text_size(9).text_color(t.dim).child(collapsed ? "▸" : "▾"))
			.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(group.asked ? t.accent : t.dim).child(group.repo))
			.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(String(group.count)));
	}

	list(t, cx) {
		return v_flex()
			.id("prs-list")
			.w(360)
			.flex_none()
			.h_full()
			.min_h(0)
			.border_r_1()
			.border_color(t.border)
			.child(
				h_flex()
					.px(10)
					.py(8)
					.items_center()
					.justify_between()
					.border_b_1()
					.border_color(t.border)
					.child(div().text_size(12).font_semibold().child("Pull requests"))
					.child(div().text_size(10.5).text_color(t.dim).child(`${this.prs.length} open`)),
			)
			.when(this.loading, (el) => el.child(div().p(10).text_color(t.muted).child("loading…")))
			.when(!this.loading && !this.prs.length && !this.error, (el) =>
				el.child(div().p(10).text_color(t.muted).child("nothing open, nothing waiting for your review")),
			)
			.child(
				v_flex()
					.id("prs-list-scroll")
					.flex_1()
					.min_h(0)
					.p(4)
					.overflow_y_scrollbar()
					.track_scroll(this.listScroll)
					.children(
						this.listRows.map((row) =>
							row.type === "group" ? this.groupHeader(row, t, cx) : this.listRow(row.pr, t, cx),
						),
					),
			);
	}

	detail(t, cx) {
		const pr = this.current;
		if (!pr) return v_flex().flex_1().min_h(0).h_full().items_center().justify_center().child(div().text_color(t.dim).child("pick a pull request"));
		return v_flex()
			.flex_1()
			.min_w(0)
			.min_h(0)
			.h_full()
			.justify_start()
			.child(
				v_flex()
					.px(12)
					.py(8)
					.gap(4)
					.border_b_1()
					.border_color(t.border)
					.child(
						h_flex()
							.gap(8)
							.items_center()
							.child(div().text_size(12).text_color(t.muted).child(pr.key))
							.child(div().flex_1().min_w(0).truncate().font_semibold().child(pr.title))
							.child(this.checksBadge(pr, t))
							.when(pr.decision === "APPROVED", (el) => el.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.done).child("approved")))
							.when(pr.decision === "CHANGES_REQUESTED", (el) =>
								el.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.blocked).child("changes asked")),
							)
							.when(pr.mergeable === "CONFLICTING", (el) =>
								el.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.blocked).child("conflict")),
							)
							.when(this.pending === pr.key, (el) =>
								el.child(div().px(6).py(1).rounded(4).bg(t.working).text_size(11).text_color(t.background).child("press m again to merge")),
							),
					)
					.child(
						h_flex()
							.gap(10)
							.items_center()
							.text_size(11)
							.text_color(t.dim)
							.child(`${pr.author} · ${pr.updated}`)
							.child("·")
							.child(this.textButton("prs-open", "open in browser", () => exec("xdg-open", [pr.url]), false, t))
							.child(this.textButton("prs-merge", this.pending === pr.key ? "confirm merge" : "merge", (_e, cx) => {
								if (this.pending === pr.key) {
									this.pending = "";
									this.merge(cx);
								} else this.arm(pr, cx);
								cx.notify();
							}, false, t)),
					),
			)
			.child(
				div()
					.flex_1()
					.min_h(0)
					.relative()
					.font_family(settings().font_family ?? "JetBrains Mono")
					.text_size(11.5)
					.child(
						this.diff.loading || !this.diff.rows.length
							? v_flex().p(12).child(div().text_color(t.muted).child(this.diff.loading ? "loading diff…" : "no diff"))
							: div()
									.id("prs-diff-x2")
									.size_full()
									.overflow_x_scrollbar()
									.child(
										div()
											.w_full()
											.min_w(this.diff.width)
											.h_full()
											.child(
												v_flex()
													.id("prs-diff-y")
													.absolute()
													.inset_0()
													.overflow_y_scroll()
													.children(
														this.diff.rows.slice(0, SHOWN_LINES).flatMap((row) => {
															const out = [this.diffRow(row, t)];
															if (this.line && this.line.at === row.at) out.push(this.lineEditor(row, t, cx));
															return out;
														}),
													),
											),
									),
					)
					.child(Scrollbar.vertical("prs-diff-y").viewport_from_layout().absolute().inset_0()),
			)
			.child(
				v_flex()
					.gap(6)
					.px(12)
					.py(8)
					.border_t_1()
					.border_color(t.border)
					.child(div().text_size(10.5).text_color(t.dim).child("review note for the whole PR — Enter starts a new line, the buttons post it"))
					.child(
						div()
							.w_full()
							.max_h(REVIEW_ROWS * 20 + 12)
							.overflow_y_scrollbar()
							.rounded(6)
							.border_1()
							.border_color(t.input)
							.bg(t.background)
							.child(Textarea.new(this.note).id("prs-review-note-input").w_full()),
					)
					.child(
						h_flex()
							.gap(6)
							.items_center()
							.child(this.textButton("prs-approve", "approve", (_e, cx) => this.startReview("approve", cx), false, t))
							.child(this.textButton("prs-changes", "request changes", (_e, cx) => this.startReview("changes", cx), false, t))
							.child(this.textButton("prs-comment", "post comment", (_e, cx) => this.startReview("comment", cx), true, t)),
					)
					.child(
						h_flex()
							.gap(6)
							.items_center()
							.child(div().text_size(10.5).text_color(t.dim).w(74).child("hand to the boss:"))
							.children(
								ACTIONS.map((action, i) =>
									this.textButton(`prs-agent-${action.key}`, `${i + 1} ${action.label}`, (_e, cx) => this.startAgent(action.key, cx), false, t),
								),
							),
					),
			);
	}

	render(cx) {
		const t = theme();
		return v_flex()
			.id("prs-root")
			.size_full()
			.min_h(0)
			.bg(t.surface)
			.text_size(12.5)
			.text_color(t.foreground)
			.track_focus(this.handle)
			.on_key_down((e, cx) => this.key(e, cx))
			.when(Boolean(this.error || this.notice), (el) =>
				el.child(
					div()
						.px(10)
						.py(3)
						.text_size(11)
						.text_color(this.error ? t.blocked : t.done)
						.child(this.error || this.notice),
				),
			)
			.child(h_flex().flex_1().min_h(0).items_stretch().child(this.list(t, cx)).child(this.detail(t, cx)));
	}
}
