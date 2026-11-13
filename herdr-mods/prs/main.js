/**
 * prs — open GitHub pull requests, in a Herdr pane, with merge.
 *
 * Shows every open PR authored by the viewer across all repositories, newest
 * activity first. Keys: ↑/↓ or j/k to move, Enter to merge (squash, delete
 * branch, twice — the row asks for confirmation), o to open in the browser,
 * r to refresh, Esc to cancel a pending merge.
 *
 * Radar basis: #17 risk-tiered human oversight and #42 human-in-the-loop
 * theater — the human decides and presses the key; the harness only shows
 * what is about to land, including checks and conflicts.
 */
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, nextCommand, theme } from "herdr";

const QUERY = `query($n: Int!) {
  viewer {
    pullRequests(first: $n, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        isDraft
        reviewDecision
        mergeable
        updatedAt
        repository { nameWithOwner }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`;

const CONFIRM_MS = 8000;

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

export default class PullRequests extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.rows = [];
    this.error = "";
    this.loading = true;
    this.selected = 0;
    this.pending = "";
    this.busy = "";
    this.refresh(cx);
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

  refresh(cx) {
    cx.spawn(async (cx) => {
      const result = await gh(["api", "graphql", "-f", `query=${QUERY}`, "-F", "n=40"], 60000);
      if (result.code !== 0) {
        this.error = (result.stderr || "gh api graphql failed").trim().split("\n")[0];
      } else {
        try {
          const nodes = JSON.parse(result.stdout).data.viewer.pullRequests.nodes;
          this.rows = nodes.map((n) => ({
            key: `${n.repository.nameWithOwner}#${n.number}`,
            repo: n.repository.nameWithOwner,
            number: n.number,
            title: n.title,
            url: n.url,
            draft: n.isDraft,
            review: n.reviewDecision,
            mergeable: n.mergeable,
            checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "",
            updated: ago(n.updatedAt),
          }));
          this.error = "";
        } catch (e) {
          this.error = `could not read gh output: ${e}`;
        }
      }
      this.loading = false;
      if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
      cx.notify();
    });
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

  move(delta, cx) {
    if (!this.rows.length) return;
    this.selected = Math.min(this.rows.length - 1, Math.max(0, this.selected + delta));
    this.pending = "";
    cx.notify();
  }

  key(event, cx) {
    const k = event.key;
    if (k === "down" || k === "j") this.move(1, cx);
    else if (k === "up" || k === "k") this.move(-1, cx);
    else if (k === "r") this.refresh(cx);
    else if (k === "escape") {
      this.pending = "";
      cx.notify();
    } else if (k === "o" || k === "enter") {
      const row = this.rows[this.selected];
      if (!row) return;
      if (k === "o") {
        exec("xdg-open", [row.url]);
        return;
      }
      if (this.pending !== row.key) {
        this.arm(row, cx);
        return;
      }
      this.pending = "";
      this.merge(row, cx);
    } else {
      return;
    }
    cx.stop_propagation();
  }

  merge(row, cx) {
    if (this.busy) return;
    this.busy = row.key;
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
      this.refresh(cx);
    });
  }

  badge(text, color, t) {
    return div()
      .px(6)
      .rounded(4)
      .bg(t.raised)
      .text_size(11)
      .text_color(color)
      .child(text);
  }

  row(r, index, cx) {
    const t = theme();
    const selected = index === this.selected;
    const pending = this.pending === r.key;
    const merging = this.busy === r.key;
    const checkColor =
      r.checks === "SUCCESS"
        ? t.done
        : r.checks === "FAILURE" || r.checks === "ERROR"
          ? t.blocked
          : t.muted;
    const checkText =
      r.checks === "SUCCESS" ? "checks ✓" : r.checks === "" ? "no checks" : `checks ${r.checks.toLowerCase()}`;
    const mergeColor = r.mergeable === "CONFLICTING" ? t.blocked : t.dim;

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
          .child(
            div()
              .truncate()
              .text_color(r.draft ? t.dim : t.foreground)
              .child(r.draft ? `draft · ${r.title}` : r.title),
          )
          .child(div().text_size(11).text_color(t.dim).child(r.updated)),
      )
      .child(this.badge(checkText, checkColor, t))
      .when(r.review === "APPROVED", (el) => el.child(this.badge("approved", t.done, t)))
      .when(r.review === "CHANGES_REQUESTED", (el) => el.child(this.badge("changes asked", t.blocked, t)))
      .when(r.mergeable === "CONFLICTING", (el) => el.child(this.badge("conflict", mergeColor, t)))
      .when(merging, (el) => el.child(this.badge("merging…", t.working, t)))
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
                } else {
                  this.pending = r.key;
                  this.arm(r, cx);
                }
                cx.stop_propagation();
                cx.notify();
              })
              .child(pending ? "confirm merge" : "merge"),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const visible = this.rows;
    return v_flex()
      .id("prs-root")
      .size_full()
      .min_h(0)
      .bg(t.surface)
      .text_size(13)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(
        h_flex()
          .px(10)
          .py(6)
          .gap(8)
          .items_center()
          .justify_between()
          .border_b_1()
          .border_color(t.border)
          .child(div().font_semibold().child(`Open pull requests · ${this.rows.length}`))
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child("↑↓ move · enter merge · o open · r refresh"),
          ),
      )
      .when(this.loading, (el) => el.child(div().p(10).text_color(t.muted).child("loading…")))
      .when(!this.loading && this.rows.length === 0 && !this.error, (el) =>
        el.child(div().p(10).text_color(t.muted).child("no open pull requests")),
      )
      .when(this.error !== "", (el) => el.child(div().p(10).text_color(t.blocked).child(this.error)))
      .child(
        v_flex()
          .id("prs-list")
          .flex_1()
          .min_h(0)
          .p(6)
          .gap(2)
          .overflow_y_scrollbar()
          .children(visible.map((r, i) => this.row(r, i, cx))),
      );
  }
}
