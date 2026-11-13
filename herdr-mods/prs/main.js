/**
 * prs — pull requests on the left, the diff on the right, and the actions you
 * take on one: review it, or hand it to an agent in a new space.
 *
 * Left: open pull requests grouped by repository, review requests first. Click
 * one and the right side shows its diff — file headers with +/− counts, hunk
 * headers, line numbers, a green/red sign gutter.
 *
 * Right, below the diff: a note field with Approve / Request changes / Comment,
 * and four buttons that open a new space with a pi agent already told what to
 * do — review the PR, fix the pipeline, fix the merge conflicts, fix the review
 * comments.
 *
 * Keys: ↑/↓ move · a/x/c review · m merge (twice) · o browser · r refresh ·
 * esc cancel · 1..4 the four agent actions.
 *
 * Props: `{ "open": "owner/repo#12" }` starts on that pull request.
 *
 * Radar basis: #17 risk-tiered human oversight and #42 human-in-the-loop
 * theater — the human reads the change and presses the key, and the agent that
 * acts on it is visible in its own space instead of behind a button.
 */
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, home, nextCommand, props, run, settings, theme } from "herdr";

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
/** Alpha suffixes on the theme's green and red: readable, not faded. */
const ADD_TINT = "52";
const DEL_TINT = "52";

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
			file.rows.push({ kind: "@", text: line });
			continue;
		}
		const kind = line[0];
		if (kind === "+") {
			file.add++;
			file.rows.push({ kind, number: newLine++, text: untab(line.slice(1)) || " " });
		} else if (kind === "-") {
			file.del++;
			file.rows.push({ kind, number: oldLine++, text: untab(line.slice(1)) || " " });
		} else if (kind === " ") {
			oldLine++;
			file.rows.push({ kind, number: newLine++, text: untab(line.slice(1)) || " " });
		} else file.rows.push({ kind: "", text: line });
	}
	const rows = [];
	for (const entry of files) {
		rows.push({ kind: "file", text: entry.path, add: entry.add, del: entry.del });
		rows.push(...entry.rows);
	}
	return rows;
}

/** What each of the four agent actions is asked to do. */
function task(kind, pr) {
	const head = `Pull request ${pr.repo}#${pr.number} — ${pr.title}`;
	const repo = pr.repo;
	const n = pr.number;
	const common = `\n\nWork in this folder. Never merge, never push to the trunk branch, and leave a one-line summary when you stop.`;
	if (kind === "review")
		return `${head}\n\nReview it. Read \`gh pr view ${n} -R ${repo}\` and \`gh pr diff ${n} -R ${repo}\`, and read the code around the change before judging it. Then post one review: \`gh pr review ${n} -R ${repo} --comment --body-file -\` (use --request-changes if something must change before it lands), naming the files and lines you are unsure about. Do not touch the code.${common}`;
	if (kind === "checks")
		return `${head}\n\nIts checks are failing. List them with \`gh pr checks ${n} -R ${repo}\`, read the failing job with \`gh run view <run-id> --log-failed\`, then \`gh pr checkout ${n} -R ${repo}\` and reproduce it here. Fix the cause, not the assertion, unless the test is wrong — say which in the commit message. Run what CI runs, then push to the PR branch.${common}`;
	if (kind === "conflicts")
		return `${head}\n\nIt conflicts with its base branch. \`gh pr view ${n} -R ${repo} --json baseRefName,headRefName\`, then \`gh pr checkout ${n} -R ${repo}\` and merge the base branch in. Resolve each conflict by keeping both intents — the PR's and the base branch's — not by picking a side. Run the tests, then push to the PR branch.${common}`;
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
		this.note = InputState.new({ placeholder: "Note — Enter sends it with the review" });
		this.note.on("change", () => cx.notify());
		this.note.on("submit", (_e, cx) => this.sendReview(cx));
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

	/** The row's position in the flat list, counting repository headers. */
	flatIndex(key) {
		let index = 0;
		for (const group of this.groups) {
			index++;
			for (const pr of group.list) {
				if (pr.key === key) return index;
				index++;
			}
		}
		return 0;
	}

	select(key, cx) {
		const index = this.prs.findIndex((pr) => pr.key === key);
		if (index < 0) return;
		this.selected = index;
		this.pending = "";
		this.reviewAction = "";
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
		this.listScroll?.scroll_to_item(this.flatIndex(this.current.key));
		this.loadDiff(this.current, cx);
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
			const local = await this.syncLocal(pr);
			this.busy = "";
			this.notice = `merged ${pr.key} · ${local}`;
			this.diff = { rows: [], width: 600, key: "", loading: false };
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
		const dirty = (await git("status", "--porcelain")).stdout.trim();
		const current = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
		await git("fetch", "--prune", "origin");
		let onBase = current === base;
		if (current === branch && !dirty) onBase = (await git("checkout", base)).code === 0;
		if (onBase) {
			const pulled = await git("merge", "--ff-only", `origin/${base}`);
			said.push(pulled.code === 0 ? `${base} updated` : `${base} not fast-forwarded`);
		} else if (current !== branch) {
			const behind = await git("merge-base", "--is-ancestor", base, `origin/${base}`);
			if (behind.code !== 0) said.push(`${base} not a fast-forward, left alone`);
			else if ((await git("branch", "-f", base, `origin/${base}`)).code === 0) said.push(`${base} updated (not checked out)`);
			else said.push(`${base} could not be moved`);
		} else said.push(`${base} not updated (still on ${branch})`);
		if (!branch) return said.join(" · ");
		if (branch === base) {
			said.push(`${branch} is the trunk branch, nothing to delete`);
			return said.join(" · ");
		}
		if (!localTip) {
			said.push(`${branch} was not in the clone`);
			return said.join(" · ");
		}
		if (current === branch && !onBase) {
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
			this.error = "this review needs a note — type one, then Enter";
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
			this.note.set_value("");
			this.handle.focus();
			this.refresh(cx);
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
		this.error = "";
		this.notice = "";
		cx.notify();
		cx.spawn(async (cx) => {
			const folder = await this.folderFor(pr.repo);
			const argv = [await this.piPath()];
			const name = `${pr.repo.split("/")[1]}#${pr.number} ${kind}`;
			const where = folder ?? home();
			const text = task(kind, pr) + (folder ? "" : `\n\nThere is no local clone of ${pr.repo} yet: \`gh repo clone ${pr.repo} ${home()}/code/${pr.repo.split("/")[1]}\`, then work there.`);
			try {
				run("space.new", { name, folder: where, argv, task: text });
				this.notice = `started ${name} in a new space${folder ? ` (${folder})` : ""}`;
			} catch (e) {
				this.error = `could not start the agent: ${e}`;
			}
			cx.notify();
		});
	}

	key(event, cx) {
		const k = event.key;
		if ((k === "down" || k === "j") && !this.reviewAction) this.move(1, cx);
		else if ((k === "up" || k === "k") && !this.reviewAction) this.move(-1, cx);
		else if (k === "r") this.refresh(cx);
		else if (k === "escape") {
			this.pending = "";
			this.reviewAction = "";
			this.handle.focus();
			cx.notify();
		} else if (k === "enter" && this.reviewAction) this.sendReview(cx);
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

	diffRow({ kind, number, text, add, del }, t) {
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
		return h_flex()
			.w_full()
			.h(20)
			.flex_none()
			.when(kind === "+", (e) => e.bg(t.ansi2 + ADD_TINT))
			.when(kind === "-", (e) => e.bg(t.ansi1 + DEL_TINT))
			.child(
				h_flex()
					.w(16)
					.flex_none()
					.items_center()
					.justify_center()
					.when(kind === "+", (e) => e.bg(t.ansi2).child(div().text_color(t.background).child("+")))
					.when(kind === "-", (e) => e.bg(t.ansi1).child(div().text_color(t.background).child("−")))
					.when(kind !== "+" && kind !== "-", (e) => e.child(div().text_color(t.dim).child(" "))),
			)
			.child(div().w(38).flex_none().text_right().pr(6).text_color(t.dim).child(number === undefined ? "" : String(number)))
			.child(div().pl(8).flex_1().min_w(0).truncate().child(text));
	}

	list(t) {
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
						this.groups.flatMap((group) => [
							div().px(8).pt(8).pb(2).text_size(10.5).text_color(t.dim).child(group.repo),
							...group.list.map((pr) => this.listRow(pr, t, undefined)),
						]),
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
									.id("prs-diff-x")
									.size_full()
									.overflow_x_scrollbar()
									.child(
										div()
											.w_full()
											.min_w(this.diff.width)
											.h_full()
											.child(
												v_virtual_list("prs-diff", this.diff.rows.length, 20, (i) => String(i), (range) =>
													this.diff.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t)),
												).size_full(),
											),
									),
					)
					.child(Scrollbar.vertical("prs-diff").viewport_from_layout().absolute().inset_0()),
			)
			.child(
				v_flex()
					.gap(6)
					.px(12)
					.py(8)
					.border_t_1()
					.border_color(t.border)
					.child(
						h_flex()
							.gap(6)
							.items_center()
							.child(
								Input.new(this.note)
									.h(28)
									.px(8)
									.rounded(6)
									.border_1()
									.border_color(t.input)
									.bg(t.background)
									.text_size(12)
									.text_color(t.foreground),
							)
							.child(this.textButton("prs-approve", "approve", (_e, cx) => this.startReview("approve", cx), false, t))
							.child(this.textButton("prs-changes", "request changes", (_e, cx) => this.startReview("changes", cx), false, t))
							.child(this.textButton("prs-comment", "comment", (_e, cx) => this.startReview("comment", cx), false, t)),
					)
					.child(
						h_flex()
							.gap(6)
							.items_center()
							.child(div().text_size(10.5).text_color(t.dim).w(74).child("new space:"))
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
			.child(h_flex().flex_1().min_h(0).items_stretch().child(this.list(t)).child(this.detail(t, cx)));
	}
}
