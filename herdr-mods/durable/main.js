/**
 * durable — the spaces that outlive their terminals, without anyone typing `bin/space`.
 *
 * Three small views, one mod, opened by `herdr-app do mod.open --name durable` (or the
 * `alt-shift-d` key in keys.json beside this file, once that section is in the person's):
 *
 *  · New     name, the project (a folder, or a URL to clone), and "not a git project".
 *            Nothing is created until Create: escape leaves no space, no record, no folder.
 *            It runs `bin/space new` and shows the command it ran and what it said when that
 *            exits non-zero — a refusal with its reason is the case worth reading. On success
 *            the form becomes one line — the space, its project, and the delegate command to
 *            copy — and a Close button.
 *  · Forget  the recorded spaces, one action: forget. Asked twice, record only: the folder
 *            stays, the space simply stops being reopened. It never deletes from disk.
 *  · List    the same rows, read only, plus the guard's last line for each space — where a
 *            person checks that it is actually being watched.
 *
 * Every call goes through `bin/space` in the pi repo, resolved from `home()`; the argv comes
 * from `argv.mjs` and nowhere else. It creates and forgets, and does nothing else: no
 * `space.close`, no `tab.close`, no deletion, no rename, no move.
 *
 * Keys: 1/2/3 or alt-shift-n/f/l switch view · r reload (list) · esc back, then close.
 */
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { checking, closeOverlay, exec, home, nextCommand, props, run, theme } from "herdr";
import { NAME_RULE, forgetArgv, nameProblem, newArgv } from "./argv.mjs";
import { initialForm } from "./prefill.mjs";

const spaceBin = () => `${home()}/.pi/bin/space`;
const guardBin = () => `${home()}/.pi/bin/guard`;
const defaultProject = (name) => `~/projects/${name}`;

/** `~/x` is the person's word for home; nothing here goes through a shell to expand it. */
function expand(text) {
	if (text === "~") return home();
	if (text.startsWith("~/")) return `${home()}/${text.slice(2)}`;
	return text;
}

/** `bin/space list` pads seven columns with spaces; the path may hold spaces, so anchor the rest.
 * `live <id>` / `not in herdr-app` / `unknown` is whether the app has the space open right now. */
function parseRows(text) {
	const rows = [];
	for (const line of text.split("\n")) {
		const m = /^(\S+)\s+(\S+)\s+(.*?)\s+(git|no-git)\s+(\d+) tabs\s+(live \S+|not in herdr-app|unknown)\s+(.*?) tab\s*$/.exec(
			line,
		);
		if (!m) continue;
		rows.push({
			name: m[1],
			kind: m[2],
			project: m[3],
			git: m[4] === "git",
			tabs: Number(m[5]),
			live: m[6].startsWith("live ") ? m[6].slice(5) : "",
			state: m[6],
			boss: m[7],
		});
	}
	return rows;
}

/** The one line a person reads about this space from a dry pass of the supervisor. */
function lastLine(text) {
	const lines = String(text ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return lines.length ? lines[lines.length - 1] : "";
}

/** Says "no such binary" as one line, never a stack trace. */
function why(result, cmd) {
	if (result?.code === 127 || /ENOENT|no such file|cannot start|not found/i.test(result?.stderr ?? "")) {
		return `no ${cmd} — is pi installed?`;
	}
	const first = String(result?.stderr || result?.stdout || "").trim().split("\n")[0];
	return first || `exited ${result?.code}`;
}

export default class Durable extends View {
	init(_props, cx) {
		this.handle = cx.focus_handle();
		// What the caller opened this copy with: `openOverlay({ mod, props })` reaches us here,
		// and a `run` command does not — the form fills in either way, even when nothing does.
		const start = initialForm(props());
		this.view = start.view;
		this.busy = false;
		this.rows = [];
		this.loading = true;
		this.error = "";
		this.notice = "";
		this.ran = null;
		this.output = "";
		this.done = null;
		this.confirm = "";
		this.watching = {};
		this.focus = "";

		// The URL field holds the URL in clone mode, the folder otherwise — one field either way.
		const given = start.clone ? start.url : start.project;
		this.name = InputState.new({ value: start.name });
		this.path = InputState.new({ value: given });
		this.next = InputState.new({ value: "" });
		this.setting = false;
		// A path the caller chose is theirs: the name's change handler must not overwrite it.
		this.pathTouched = Boolean(given);
		this.clone = start.clone;
		this.noGit = false;

		this.name.on("change", (_e, cx) => {
			// The folder follows the name until the person writes their own.
			if (!this.pathTouched && !this.clone) this.setPath(defaultProject(this.name.value().trim()));
			cx.notify();
		});
		this.name.on("focus", (_e, cx) => {
			this.focus = "name";
			cx.notify();
		});
		this.name.on("blur", (_e, cx) => {
			if (this.focus === "name") this.focus = "";
			cx.notify();
		});
		this.name.on("submit", (_e, cx) => this.submit(cx));

		this.path.on("change", (_e, cx) => {
			if (!this.setting) this.pathTouched = true;
			cx.notify();
		});
		this.path.on("focus", (_e, cx) => {
			this.focus = "path";
			cx.notify();
		});
		this.path.on("blur", (_e, cx) => {
			if (this.focus === "path") this.focus = "";
			cx.notify();
		});
		this.path.on("submit", (_e, cx) => this.submit(cx));

		cx.spawn(async (cx) => {
			for (;;) {
				const command = await nextCommand();
				if (command === "durable.new") this.show("new", cx);
				else if (command === "durable.forget") this.show("forget", cx);
				else if (command === "durable.list") this.show("list", cx);
				else if (command === "focus") {
					this.handle.focus();
					cx.notify();
				}
			}
		});

		// A check renders once, with empty state, and runs no programs: the view says so itself.
		if (checking()) {
			this.loading = false;
			cx.notify();
			return;
		}
		this.load(cx);
		// Focus the first field still empty, so a prefilled form is one Tab from Create space.
		if (this.view === "new") {
			cx.timer.after(80, () => {
				if (!start.name) this.name.focus();
				else if (!given) this.path.focus();
			});
		}
	}

	setPath(text) {
		this.setting = true;
		this.path.set_value(text);
		this.setting = false;
	}

	show(view, cx) {
		this.view = view;
		this.error = "";
		this.confirm = "";
		this.focus = "";
		// Coming back to New is a fresh form: the last space is already made.
		if (view === "new") this.done = null;
		this.load(cx);
		cx.notify();
		if (view === "new") cx.timer.after(60, () => this.name.focus());
	}

	/** The recorded spaces, from `bin/space list`. A missing binary is one line, not a throw. */
	load(cx) {
		this.loading = true;
		cx.spawn(async (cx) => {
			const result = await exec(spaceBin(), ["list"], { timeout: 20000 }).catch((e) => ({
				code: -1,
				stdout: "",
				stderr: String(e?.message ?? e),
			}));
			this.loading = false;
			if (result.code !== 0) {
				this.error = why(result, spaceBin());
				this.rows = [];
			} else {
				this.rows = parseRows(result.stdout);
				this.error = "";
			}
			cx.notify();
			if (this.view === "list") this.loadWatching(cx);
		});
	}

	/** The supervisor's own last line per space: the cheap proof that it is watched. */
	loadWatching(cx) {
		const rows = this.rows.slice(0, 20);
		if (!rows.length) return;
		cx.spawn(async (cx) => {
			for (const row of rows) {
				const result = await exec(guardBin(), ["--dry-run", "--space", row.name], { timeout: 20000 }).catch(
					(e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }),
				);
				this.watching[row.name] =
					result.code === 0 ? lastLine(result.stdout) : why(result, guardBin());
				cx.notify();
			}
		});
	}

	/** Create runs, and nothing else: the argv, its output, and the next command on success. */
	submit(cx) {
		if (this.busy) return;
		const name = this.name.value().trim();
		let argv;
		try {
			argv = newArgv({
				name,
				mode: this.clone ? "clone" : "folder",
				path: this.clone ? this.path.value().trim() : expand(this.path.value().trim()),
				noGit: this.noGit,
			});
		} catch (e) {
			this.error = String(e?.message ?? e);
			this.ran = null;
			this.output = "";
			cx.notify();
			return;
		}
		const project = this.clone ? `${home()}/projects/${name}` : expand(this.path.value().trim());
		this.busy = true;
		this.error = "";
		this.notice = "";
		this.done = null;
		this.ran = [spaceBin(), ...argv].join(" ");
		this.output = "";
		cx.notify();
		cx.spawn(async (cx) => {
			const result = await exec(spaceBin(), argv, { timeout: 600000 }).catch((e) => ({
				code: -1,
				stdout: "",
				stderr: String(e?.message ?? e),
			}));
			this.busy = false;
			if (result.code !== 0) {
				// stderr first: the refusal's reason is the thing worth reading.
				this.error = why(result, spaceBin());
				this.output = [result.stderr, result.stdout].filter((s) => String(s ?? "").trim()).join("\n").trim();
				cx.notify();
				return;
			}
			this.output = "";
			// bin/space says what it made: `space <name>: <project> (git|no-git), ...`.
			const said = /^space (\S+): (.*) \((git|no-git)\)/.exec(String(result.stdout ?? "").split("\n")[0].trim());
			const made = said ? said[2] : project;
			this.done = {
				name,
				project: made,
				git: said ? said[3] === "git" : !this.noGit,
				next: `cd ${made} && ${home()}/.pi/bin/delegate spawn ${name} --cwd ${made} "<task>"`,
			};
			this.next.set_value(this.done.next);
			this.next.set_selected_range({ start: 0, end: this.done.next.length });
			this.notice = `space ${name} created`;
			this.load(cx);
			cx.notify();
		});
	}

	/** Forget, twice: the second press is the one that runs. */
	forget(row, cx) {
		if (this.busy) return;
		if (this.confirm !== row.name) {
			this.confirm = row.name;
			this.error = "";
			this.notice = "";
			cx.notify();
			return;
		}
		this.confirm = "";
		this.busy = true;
		cx.spawn(async (cx) => {
			const result = await exec(spaceBin(), forgetArgv({ name: row.name }), { timeout: 30000 }).catch((e) => ({
				code: -1,
				stdout: "",
				stderr: String(e?.message ?? e),
			}));
			this.busy = false;
			if (result.code !== 0) {
				this.error = why(result, spaceBin());
				cx.notify();
				return;
			}
			this.notice = `forgot ${row.name} — ${row.project} is still on disk`;
			cx.notify();
			this.load(cx);
		});
	}

	/** Close this mod: the overlay it came in, or the mod.open that made it. */
	close(cx) {
		const overlay = props()?.overlay;
		if (overlay) closeOverlay(overlay);
		else run("mod.open", { name: "durable" });
		cx.notify();
	}

	toggle(which, cx) {
		if (which === "clone") {
			this.clone = !this.clone;
			if (!this.pathTouched) this.setPath(this.clone ? "" : defaultProject(this.name.value().trim()));
		} else {
			this.noGit = !this.noGit;
		}
		this.error = "";
		cx.notify();
	}

	key(e, cx) {
		const k = e.key;
		if (k === "escape") {
			if (this.done) {
				this.done = null;
				this.show("list", cx);
			} else if (this.view === "list") this.close(cx);
			else this.show("list", cx);
		} else if (this.focus) return; // typing goes to the field
		else if (k === "r") this.load(cx);
		else if (k === "1") this.show("new", cx);
		else if (k === "2") this.show("forget", cx);
		else if (k === "3") this.show("list", cx);
		else return;
		cx.stop_propagation();
	}

	textButton(id, label, on, primary, t, enabled = true) {
		return h_flex()
			.id(id)
			.h(30)
			.px(13)
			.items_center()
			.rounded(8)
			.border_1()
			.border_color(primary ? t.solid : t.input)
			.bg(primary ? t.solid : t.raised)
			.text_color(primary ? t.solid_foreground : enabled ? t.foreground : t.dim)
			.text_size(12)
			.cursor_pointer()
			.when(enabled, (el) => el.hover((s) => s.opacity(0.88)).on_click(on))
			.child(label);
	}

	field(state, focused, t) {
		return Input.new(state)
			.h(34)
			.px(10)
			.rounded(8)
			.border_1()
			.border_color(focused ? t.accent : t.input)
			.bg(t.background)
			.text_size(12.5)
			.text_color(t.foreground);
	}

	check(label, on, state, t) {
		return h_flex()
			.id(`durable-check-${label.replace(/\W+/g, "-")}`)
			.gap(8)
			.items_center()
			.py(3)
			.cursor_pointer()
			.on_click((_e, cx) => on(cx))
			.child(div().w(14).text_color(state ? t.accent : t.dim).child(state ? "▣" : "▢"))
			.child(div().text_size(12).text_color(t.foreground).child(label));
	}

	tabs(t, cx) {
		const one = (id, label, view) =>
			h_flex()
				.id(`durable-tab-${view}`)
				.h(26)
				.px(10)
				.items_center()
				.rounded(7)
				.bg(this.view === view ? t.selected : t.popover)
				.text_size(12)
				.text_color(this.view === view ? t.foreground : t.muted)
				.cursor_pointer()
				.hover((s) => s.bg(this.view === view ? t.selected : t.hover))
				.on_click((_e, cx) => this.show(view, cx))
				.child(label);
		return h_flex().gap(6).items_center().child(one("durable-tab-new", "New space", "new")).child(one("durable-tab-forget", "Forget", "forget")).child(one("durable-tab-list", "Watched", "list"));
	}

	bar(t) {
		if (this.error) return div().px(10).py(4).rounded(6).bg(t.raised).text_size(11.5).text_color(t.blocked).child(this.error);
		if (this.notice) return div().px(10).py(4).rounded(6).bg(t.raised).text_size(11.5).text_color(t.done).child(this.notice);
		return null;
	}

	ranBlock(t) {
		if (!this.ran) return null;
		return v_flex()
			.id("durable-ran")
			.gap(4)
			.p(10)
			.rounded(8)
			.bg(t.background)
			.border_1()
			.border_color(t.input)
			.child(div().text_size(10.5).text_color(t.dim).child("the command that ran"))
			.child(div().text_size(11.5).text_color(t.foreground).child(this.ran))
			.when(Boolean(this.output), (el) =>
				el.child(
					v_flex()
						.gap(2)
						.child(div().text_size(10.5).text_color(t.dim).child("what it said"))
						.children(this.output.split("\n").slice(0, 12).map((line) => div().text_size(11).text_color(t.blocked).child(line))),
				),
			);
	}

	successView(t, cx) {
		const d = this.done;
		return v_flex()
			.id("durable-done")
			.gap(10)
			.child(
				div()
					.text_size(13)
					.child(`${d.name} → ${d.project} (${d.git ? "git" : "no-git"})`),
			)
			.child(div().text_size(11).text_color(t.dim).child("next, and the folder it starts in — select it, or ctrl+c with the box focused"))
			.child(this.field(this.next, true, t))
			.child(
				h_flex()
					.gap(8)
					.items_center()
					.child(this.textButton("durable-done-close", "Close", (_e, cx) => this.close(cx), true, t))
					.child(this.textButton("durable-done-another", "New space", (_e, cx) => {
						this.done = null;
						this.show("new", cx);
					}, false, t)),
			);
	}

	newView(t, cx) {
		if (this.done) return this.successView(t, cx);
		const name = this.name.value().trim();
		const problem = nameProblem(name);
		const where = this.path.value().trim();
		const ready = !problem && Boolean(where);
		return v_flex()
			.id("durable-new")
			.gap(8)
			.child(div().text_size(11.5).text_color(t.dim).child("Name"))
			.child(this.field(this.name, this.focus === "name", t))
			.child(
				div()
					.text_size(11)
					.text_color(name && problem ? t.blocked : t.dim)
					.child(`a space name is a slug: ${NAME_RULE}`),
			)
			.child(div().pt(6).text_size(11.5).text_color(t.dim).child("The project"))
			.child(this.field(this.path, this.focus === "path", t))
			.child(
				div()
					.text_size(11)
					.text_color(t.dim)
					.child(
						this.clone
							? "the URL to clone — it lands in ~/projects/<name>, and the folder must not be there yet"
							: "a folder that already exists on disk, or turn on clone from GitHub for a URL",
					),
			)
			.child(this.check("clone from GitHub", (cx) => this.toggle("clone", cx), this.clone, t))
			.child(this.check("not a git project", (cx) => this.toggle("noGit", cx), this.noGit, t))
			.child(
				div()
					.text_size(11)
					.text_color(t.dim)
					.child(
						`it runs: ${spaceBin()} ${newArgvPreview(name, this.clone, this.clone ? where : expand(where), this.noGit)}`,
					),
			)
			.child(
				h_flex()
					.gap(8)
					.items_center()
					.child(this.textButton("durable-create", this.busy ? "creating…" : "Create space", (_e, cx) => this.submit(cx), true, t, ready && !this.busy))
					.child(this.textButton("durable-cancel", "Cancel", (_e, cx) => this.show("list", cx), false, t))
					.child(div().text_size(11).text_color(t.dim).child("escape leaves no space, no record, no folder")),
			)
			.when(Boolean(this.ran), (el) => el.child(this.ranBlock(t)));
	}

	rowLine(row, t, cx) {
		const forget = this.view === "forget";
		const pending = this.confirm === row.name;
		return v_flex()
			.id(`durable-row-${row.name}`)
			.gap(2)
			.px(10)
			.py(7)
			.rounded(7)
			.bg(pending ? t.raised : t.popover)
			.hover((s) => s.bg(pending ? t.raised : t.hover))
			.child(
				h_flex()
					.gap(10)
					.items_center()
					.child(div().w(160).text_size(12.5).child(row.name))
					.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(row.project))
					.child(div().w(48).text_size(11).text_color(t.dim).child(row.git ? "git" : "no-git"))
					.child(div().w(58).text_size(11).text_color(t.dim).child(row.state))
					.when(forget, (el) =>
						el.child(
							this.textButton(
								`durable-forget-${row.name}`,
								pending ? "forget it" : "forget",
								(_e, cx) => this.forget(row, cx),
								pending,
								t,
								!this.busy,
							),
						),
					),
			)
			.when(pending, (el) =>
				el.child(
					div()
						.text_size(11)
						.text_color(t.blocked)
						.child(`Forget ${row.name}? The folder stays; the space stops being reopened.`),
				),
			)
			.when(this.view === "list" && Boolean(this.watching[row.name]), (el) =>
				el.child(div().text_size(10.5).text_color(t.dim).child(this.watching[row.name])),
			);
	}

	rowsView(t, cx) {
		const forget = this.view === "forget";
		return v_flex()
			.id(forget ? "durable-forget" : "durable-list")
			.gap(4)
			.child(
				div()
					.text_size(11)
					.text_color(t.dim)
					.child(
						this.loading
							? "reading the recorded spaces…"
							: forget
								? "one action: forget. The folder and its work stay on disk — only the record goes."
								: `${this.rows.length} recorded · the last line is the guard's plan for it · r reloads`,
					),
			)
			.child(
				v_flex()
					.id(forget ? "durable-forget-rows" : "durable-list-rows")
					.gap(2)
					.overflow_y_scrollbar()
					.children(this.rows.map((row) => this.rowLine(row, t, cx)))
					.when(!this.loading && this.rows.length === 0 && !this.error, (el) =>
						el.child(div().p(6).text_size(12).text_color(t.muted).child("no spaces recorded yet — New space makes the first")),
					),
			);
	}

	render(cx) {
		const t = theme();
		const bar = this.bar(t);
		return v_flex()
			.id("durable-root")
			.size_full()
			.min_h(0)
			.gap(9)
			.p(14)
			.bg(t.popover)
			.text_color(t.foreground)
			.text_size(12.5)
			.track_focus(this.handle)
			.on_key_down((e, cx) => this.key(e, cx))
			.child(
				h_flex()
					.gap(10)
					.items_center()
					.child(div().flex_1().text_size(14).font_semibold().child("Durable spaces"))
					.child(div().text_size(11).text_color(t.dim).child("esc")),
			)
			.child(this.tabs(t, cx))
			.when(Boolean(bar), (el) => el.child(bar))
			.child(
				v_flex()
					.id("durable-body")
					.flex_1()
					.min_h(0)
					.child(this.view === "new" ? this.newView(t, cx) : this.rowsView(t, cx)),
			);
	}
}

/**
 * The argv as a person reads it before pressing: the same builder `submit` uses, so what is
 * shown and what runs cannot drift apart. Half-filled fields print as placeholders, never as
 * a refusal — the rule under the Name field is the rule, and it is there from the start.
 */
function newArgvPreview(name, clone, path, noGit) {
	try {
		return newArgv({ name, mode: clone ? "clone" : "folder", path, noGit }).join(" ");
	} catch {
		return [
			"new",
			"--name",
			name || "<name>",
			clone ? "--clone" : "--project",
			path || (clone ? "<url>" : defaultProject(name || "<name>")),
			...(noGit ? ["--no-git"] : []),
		].join(" ");
	}
}
