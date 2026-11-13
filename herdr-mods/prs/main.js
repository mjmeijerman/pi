/**
 * prs — open GitHub pull requests, with diff and review, in a Herdr pane.
 *
 * Two sections: PRs waiting for your review, then your own. Each row carries
 * the facts that decide whether it can land: checks, review decision,
 * conflicts, draft, age.
 *
 * List:   ↑/↓ or j/k move · enter diff · m merge · a approve · x request
 *         changes · c comment · o open in browser · r refresh · esc cancel
 * Diff:   ↑/↓ scroll · m merge · a/x/c review · esc back, same as the list
 * Merge and review both need two presses when they are destructive (merge,
 * request changes): the first arms, the second acts.
 *
 * Props: `{ "open": "owner/repo#12" }` starts on that pull request's diff.
 *
 * Radar basis: #17 risk-tiered human oversight and #42 human-in-the-loop
 * theater — the human reads the change and presses the key; the pane only
 * shows what is about to land and keeps the buttons where the decision is.
 */
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, home, nextCommand, props, settings, theme } from "herdr";

const QUERY = `query($n: Int!) {
  viewer {
    login
    pullRequests(first: $n, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PR } }
  }
  search(query: "is:open is:pr review-requested:@me", type: ISSUE, first: $n) { nodes { ...PR } }
}
fragment PR on PullRequest {
  number title url isDraft reviewDecision mergeable updatedAt
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const CONFIRM_MS = 8000;
const MAX_DIFF_LINES = 4000;

/**
 * Run gh, retrying once with the usual install location. The app is started by
 * a desktop session, whose PATH is not always the shell's.
 */
async function gh(args, timeout) {
	const first = await exec("gh", args, { timeout });
	if (first.code !== 127 && !/ENOENT|no such file/i.test(first.stderr)) return first;
	return exec(`${home()}/.local/bin/gh`, args, { timeout });
}

/** "3m", "5h", "2d" — a PR list needs recency, not an ISO timestamp. */
function ago(iso) {
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	if (seconds < 90) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** Text draws a tab as nothing: pad each to the next 4-column stop. */
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

/** A unified diff as rows: hunk headers, and +/- lines numbered per side. */
function diffRows(text) {
	let old = 0;
	let next = 0;
	return text.split("\n").map((line) => {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
		if (hunk) {
			old = +hunk[1];
			next = +hunk[2];
			return { kind: "@", text: line };
		}
		if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))
			return { kind: "file", text: line };
		const kind = line[0];
		if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
		if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
		if (kind === " ") {
			old++;
			return { kind, number: next++, text: untab(line.slice(1)) || " " };
		}
		return { kind: "", text: line };
	});
}

const CHECK_ORDER = ["SUCCESS", "PENDING", "FAILURE", "ERROR"];

export default class PullRequests extends View {
	init(_props, cx) {
		this.handle = cx.focus_handle();
		this.mine = [];
		this.reviewing = [];
		this.selected = 0;
		this.view = "list";
		this.diff = { rows: [], width: 600, title: "", loading: false };
		this.error = "";
		this.notice = "";
		this.loading = true;
		this.pending = "";
		this.reviewAction = "";
		this.busy = "";
		this.note = InputState.new({ placeholder: "Review note — Enter sends, Esc cancels" });
		this.note.on("change", () => cx.notify());
		this.note.on("submit", (_e, cx) => this.sendReview(cx));
		this.refresh(cx);
		const start = props()?.open;
		if (start) cx.timer.after(1200, (cx) => this.openDiff(start, cx));
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

	get rows() {
		return [...this.reviewing, ...this.mine];
	}

	get current() {
		const list = this.rows;
		return list[Math.min(this.selected, list.length - 1)];
	}

	refresh(cx, done) {
		cx.spawn(async (cx) => {
			const result = await gh(["api", "graphql", "-f", `query=${QUERY}`, "-F", "n=40"], 60000);
			if (result.code !== 0) {
				this.error = (result.stderr || "gh api graphql failed").trim().split("\n")[0];
			} else {
				try {
					const data = JSON.parse(result.stdout).data;
					this.me = data.viewer.login;
					const shape = (n) => ({
						key: `${n.repository.nameWithOwner}#${n.number}`,
						repo: n.repository.nameWithOwner,
						number: n.number,
						title: n.title,
						url: n.url,
						author: n.author?.login ?? "",
						draft: n.isDraft,
						review: n.reviewDecision,
						mergeable: n.mergeable,
						checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "",
						updated: ago(n.updatedAt),
					});
					const searching = data.search.nodes.filter((n) => n && n.number).map(shape);
					const mine = data.viewer.pullRequests.nodes.map(shape);
					const asked = new Set(searching.map((row) => row.key));
					this.reviewing = searching;
					this.mine = mine.filter((row) => !asked.has(row.key));
					this.error = "";
				} catch (e) {
					this.error = `could not read gh output: ${e}`;
				}
			}
			this.loading = false;
			if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
			cx.notify();
			if (done) done();
		});
	}

	move(delta, cx) {
		if (this.view !== "list" || !this.rows.length) return;
		this.selected = Math.min(this.rows.length - 1, Math.max(0, this.selected + delta));
		this.pending = "";
		cx.notify();
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

	openDiff(key, cx) {
		const row = key ? this.rows.find((r) => r.key === key) : this.current;
		if (!row) return;
		this.selected = this.rows.indexOf(row);
		this.view = "diff";
		this.pending = "";
		this.diff = { rows: [], width: 600, title: `${row.repo}#${row.number} ${row.title}`, loading: true };
		cx.notify();
		cx.spawn(async (cx) => {
			const result = await gh(["pr", "diff", String(row.number), "-R", row.repo], 120000);
			if (result.code !== 0) {
				this.diff = { ...this.diff, loading: false, rows: [{ kind: "", text: (result.stderr || "no diff").trim() }] };
				cx.notify();
				return;
			}
			const lines = result.stdout.split("\n");
			const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
			if (lines.length > MAX_DIFF_LINES) shown.push(`… ${lines.length - MAX_DIFF_LINES} more lines — press o for the full diff`);
			const rows = diffRows(shown.join("\n"));
			const width = Math.max(600, ...rows.map((r) => (r.text.length + 1) * 6.6 + 80));
			this.diff = { rows, width, title: this.diff.title, loading: false };
			cx.notify();
		});
	}

	back(cx) {
		this.view = "list";
		this.reviewAction = "";
		this.handle.focus();
		cx.notify();
	}

	merge(row, cx) {
		if (this.busy) return;
		this.busy = row.key;
		this.notice = "";
		cx.notify();
		cx.spawn(async (cx) => {
			const result = await gh(
				["pr", "merge", String(row.number), "-R", row.repo, "--squash", "--delete-branch"],
				120000,
			);
			this.busy = "";
			if (result.code !== 0) {
				this.error = `merge failed: ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`;
				cx.notify();
				return;
			}
			this.notice = `merged ${row.key}`;
			this.view = "list";
			this.refresh(cx);
		});
	}

	/** Choose a review action; the note field decides whether it needs a body. */
	startReview(kind, cx) {
		const row = this.current;
		if (!row) return;
		if (row.author && row.author === this.me) {
			this.error = `${row.key} is yours — GitHub does not allow reviewing your own pull request`;
			cx.notify();
			return;
		}
		this.reviewAction = this.reviewAction === kind ? "" : kind;
		this.error = "";
		cx.notify();
		if (this.reviewAction) this.note.focus();
		else this.handle.focus();
	}

	sendReview(cx) {
		const row = this.current;
		const kind = this.reviewAction;
		if (!row || !kind) return;
		const body = this.note.value().trim();
		if (!body && kind !== "approve") {
			this.error = "this review needs a note — type one, then Enter";
			cx.notify();
			return;
		}
		const flags = { approve: "--approve", changes: "--request-changes", comment: "--comment" };
		const args = ["pr", "review", String(row.number), "-R", row.repo, flags[kind]];
		if (body) args.push("--body", body);
		this.busy = row.key;
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
			this.notice = `${verb} ${row.key}`;
			this.reviewAction = "";
			this.note.set_value("");
			this.handle.focus();
			this.refresh(cx);
		});
	}

	key(event, cx) {
		const k = event.key;
		const row = this.current;
		if (k === "down" || k === "j") this.move(1, cx);
		else if (k === "up" || k === "k") this.move(-1, cx);
		else if (k === "r" && this.view === "list") this.refresh(cx);
		else if (k === "escape") {
			if (this.view === "diff") this.back(cx);
			else {
				this.pending = "";
				this.reviewAction = "";
				cx.notify();
			}
		} else if (k === "enter") {
			if (this.reviewAction) this.sendReview(cx);
			else if (row) this.openDiff(null, cx);
		} else if (!row) return;
		else if (k === "a") this.startReview("approve", cx);
		else if (k === "x") this.startReview("changes", cx);
		else if (k === "c") this.startReview("comment", cx);
		else if (k === "o") exec("xdg-open", [row.url]);
		else if (k === "m") {
			if (this.pending === row.key) {
				this.pending = "";
				this.merge(row, cx);
			} else this.arm(row, cx);
		} else return;
		cx.stop_propagation();
	}

	badge(text, color, t) {
		return div().px(6).rounded(4).bg(t.raised).text_size(11).text_color(color).child(text);
	}

	rowLine(r, index, cx) {
		const t = theme();
		const selected = index === this.selected;
		const pending = this.pending === r.key;
		const merging = this.busy === r.key;
		const checkColor = r.checks === "SUCCESS" ? t.done : CHECK_ORDER.includes(r.checks) && r.checks !== "PENDING" ? t.blocked : t.muted;
		const checkText =
			r.checks === "SUCCESS" ? "checks ✓" : r.checks === "" ? "no checks" : `checks ${r.checks.toLowerCase()}`;
		return h_flex()
			.id(`pr-${r.key}`)
			.gap(10)
			.px(8)
			.py(4)
			.items_center()
			.rounded(6)
			.when(selected, (el) => el.bg(t.selection))
			.when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
			.on_click((_e, cx) => {
				this.selected = index;
				this.pending = "";
				cx.notify();
			})
			.child(div().w(190).flex_shrink_0().text_color(t.muted).truncate().child(`${r.repo}#${r.number}`))
			.child(
				v_flex()
					.flex_1()
					.min_w(0)
					.justify_start()
					.items_start()
					.child(div().truncate().text_color(r.draft ? t.dim : t.foreground).child(r.draft ? `draft · ${r.title}` : r.title))
					.child(div().text_size(11).text_color(t.dim).child(`${r.author} · ${r.updated}`)),
			)
			.child(this.badge(checkText, checkColor, t))
			.when(r.review === "APPROVED", (el) => el.child(this.badge("approved", t.done, t)))
			.when(r.review === "CHANGES_REQUESTED", (el) => el.child(this.badge("changes asked", t.blocked, t)))
			.when(r.mergeable === "CONFLICTING", (el) => el.child(this.badge("conflict", t.blocked, t)))
			.when(merging, (el) => el.child(this.badge("working…", t.working, t)))
			.when(pending, (el) => el.child(this.badge("press m again to merge", t.working, t)))
			.when(
				!merging,
				(el) =>
					el.child(
						div()
							.id(`merge-${r.key}`)
							.px(8)
							.py(2)
							.rounded(4)
							.text_size(11)
							.bg(pending ? t.working : t.raised)
							.text_color(pending ? t.background : t.muted)
							.hover((s) => s.bg(pending ? t.working : t.hover))
							.on_click((_e, cx) => {
								this.selected = index;
								if (this.pending === r.key) {
									this.pending = "";
									this.merge(r, cx);
								} else this.arm(r, cx);
								cx.stop_propagation();
								cx.notify();
							})
							.child(pending ? "confirm merge" : "merge"),
					),
			);
	}

	diffRow({ kind, number, text }, t) {
		if (kind === "@")
			return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
		if (kind === "file")
			return div().w_full().px(12).h(20).flex_none().truncate().text_color(t.accent).child(text);
		return h_flex()
			.w_full()
			.h(20)
			.flex_none()
			.when(kind === "+", (e) => e.bg(t.ansi2 + "26"))
			.when(kind === "-", (e) => e.bg(t.ansi1 + "26"))
			.child(
				div()
					.w(14)
					.flex_none()
					.text_center()
					.text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim)
					.child(kind === "+" ? "+" : kind === "-" ? "−" : " "),
			)
			.child(div().w(34).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
			.child(div().pl(10).flex_1().min_w(0).truncate().child(text));
	}

	header(t) {
		const row = this.current;
		const title =
			this.view === "diff" ? this.diff.title : `Pull requests · ${this.reviewing.length} to review · ${this.mine.length} yours`;
		const hint =
			this.view === "diff"
				? "↑↓ scroll · m merge · a approve · x changes · c comment · esc back"
				: "↑↓ move · enter diff · m merge · a/x/c review · o open · r refresh";
		return h_flex()
			.px(10)
			.py(6)
			.gap(8)
			.items_center()
			.justify_between()
			.border_b_1()
			.border_color(t.border)
			.child(
				h_flex()
					.gap(8)
					.items_center()
					.when(this.view === "diff", (el) =>
						el.child(div().id("prs-back").px(6).rounded(4).bg(t.raised).text_size(11).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.back(cx)).child("← back")),
					)
					.child(div().font_semibold().truncate().child(title)),
			)
			.child(div().text_size(11).text_color(t.dim).child(hint));
	}

	status(t) {
		if (this.error) return div().px(10).py(4).text_size(11).text_color(t.blocked).child(this.error);
		if (this.notice) return div().px(10).py(4).text_size(11).text_color(t.done).child(this.notice);
		return null;
	}

	reviewBar(t) {
		if (!this.reviewAction) return div();
		const label = this.reviewAction === "approve" ? "Approve" : this.reviewAction === "changes" ? "Request changes" : "Comment";
		return h_flex()
			.gap(8)
			.px(10)
			.py(6)
			.items_center()
			.border_t_1()
			.border_color(t.border)
			.child(div().text_size(11).text_color(t.accent).w(120).child(`${label}:`))
			.child(
				Input.new(this.note)
					.h(30)
					.px(8)
					.rounded(6)
					.border_1()
					.border_color(t.input)
					.bg(t.background)
					.text_size(12)
					.text_color(t.foreground),
			);
	}

	render(cx) {
		const t = theme();
		const list = this.rows;
		return v_flex()
			.id("prs-root")
			.size_full()
			.min_h(0)
			.bg(t.surface)
			.text_size(13)
			.text_color(t.foreground)
			.track_focus(this.handle)
			.on_key_down((e, cx) => this.key(e, cx))
			.child(this.header(t))
			.when(Boolean(this.status(t)), (el) => el.child(this.status(t)))
			.when(this.view === "list", (el) =>
				el
					.when(this.loading, (e) => e.child(div().p(10).text_color(t.muted).child("loading…")))
					.when(!this.loading && list.length === 0 && !this.error, (e) =>
						e.child(div().p(10).text_color(t.muted).child("nothing open, and nothing waiting for your review")),
					)
					.child(
						v_flex()
							.id("prs-list")
							.flex_1()
							.min_h(0)
							.p(6)
							.gap(2)
							.overflow_y_scrollbar()
							.when(this.reviewing.length > 0, (e) =>
								e.child(div().px(8).pt(6).pb(2).text_size(11).text_color(t.accent).child("WAITING FOR YOUR REVIEW")),
							)
							.children(this.reviewing.map((r) => this.rowLine(r, list.indexOf(r), cx)))
							.when(this.mine.length > 0, (e) =>
								e.child(
									div()
										.px(8)
										.pt(this.reviewing.length ? 10 : 6)
										.pb(2)
										.text_size(11)
										.text_color(t.dim)
										.child(this.reviewing.length ? "YOURS" : "OPEN PULL REQUESTS"),
								),
							)
							.children(this.mine.map((r) => this.rowLine(r, list.indexOf(r), cx))),
					),
			)
			.when(this.view === "diff", (el) =>
				el.child(
					div()
						.flex_1()
						.min_h(0)
						.relative()
						.font_family(settings().font_family ?? "JetBrains Mono")
						.text_size(11)
						.child(
							div()
								.id("prs-diff-x")
								.size_full()
								.overflow_x_scrollbar()
								.child(
									div()
										.w_full()
										.min_w(this.diff.width)
										.h_full()
										.child(
											this.diff.loading
												? v_flex().p(12).child(div().text_color(t.muted).child("loading diff…"))
												: v_virtual_list("prs-diff", Math.max(1, this.diff.rows.length), 20, (i) => String(i), (range) =>
														this.diff.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t)),
													).size_full(),
										),
								),
						)
						.child(Scrollbar.vertical("prs-diff").viewport_from_layout().absolute().inset_0()),
				),
			)
			.when(Boolean(this.reviewAction), (el) => el.child(this.reviewBar(t)));
	}
}
