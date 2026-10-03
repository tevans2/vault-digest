import { Notice } from "obsidian";
import { TileType, empty, openPath } from "./common";
import { OP_LABEL } from "../../runner/jobs/plan";
import { ago, minutesOfDay, isoDate, timeOfDay } from "../../util/dates";
import type { TriageItem } from "../../state/schema";

const base = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/, "");

/** Done / Waiting / Anything else, then the close job. Opens from the configured time. */
export const closeForm: TileType = {
  id: "close-form",
  title: "Close the day",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const st = plugin.store.state;
    const today = isoDate();
    const [h, m] = plugin.settings.closeTime.split(":").map(Number);
    const open = minutesOfDay() >= h * 60 + (m || 0);
    const closed = st.close?.date === today ? st.close : null;
    const running = !!plugin.runner?.current && plugin.runner.current.run.job === "close";

    if (closed && !plugin.closeReopen) {
      body.createDiv({ cls: "vd-dateline", text: `Closed at ${timeOfDay(new Date(closed.generatedAt))}` });
      body.createDiv({ text: closed.summary });
      const b = body.createEl("button", { text: "Close again", cls: "vd-btn" });
      b.addEventListener("click", () => {
        plugin.closeReopen = true;
        ctx.rerender();
      });
      return;
    }
    // Before the close time the tile isn't shown at all, so the front page stays slim. The
    // "Close the day" command (or `c` then the command palette) opens it early.
    if (!open && !plugin.closeReopen) return ctx.hideTile();

    const field = (key: "done" | "waiting" | "other", label: string, placeholder: string) => {
      const wrap = body.createDiv({ cls: "vd-field" });
      wrap.createEl("label", { text: label });
      const t = wrap.createEl("textarea", { cls: "vd-textarea", attr: { rows: "2", placeholder } });
      t.value = plugin.closeDraft[key];
      t.addEventListener("input", () => (plugin.closeDraft[key] = t.value));
      return t;
    };
    field("done", "Done", "What got finished today, and on which day if it wasn't today.");
    field("waiting", "Waiting", "Anything blocked on someone else, and who.");
    field("other", "Anything else", "Moods, surprises, things that moved. Your own words.");

    const row = body.createDiv({ cls: "vd-row" });
    const go = row.createEl("button", { text: running ? "Closing…" : "Close the day", cls: "mod-cta vd-btn-cta" });
    go.disabled = running || !plugin.runner;
    go.addEventListener("click", async () => {
      go.disabled = true;
      const draft = { ...plugin.closeDraft };
      const run = await plugin.assistant.submitClose(draft);
      if (run && run.status !== "failed" && run.status !== "rejected") {
        plugin.closeDraft = { done: "", waiting: "", other: "" };
        plugin.closeReopen = false;
      }
      ctx.rerender();
    });
    body.createDiv({ cls: "vd-dateline", text: "Your answers are saved under Raw in today's journal, in your words. Leave them all empty to close from the calendar and tasks." });
  },
};

/** Weekly review: the forecast and rule violations. Inbox proposals live in the triage tile. */
export const weekReview: TileType = {
  id: "week-review",
  title: "Weekly review",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const week = plugin.store.state.week;
    const run = () => void plugin.runJob("week", "manual");
    if (!week) {
      empty(body, "No weekly review yet.");
      body.createEl("button", { text: "Run weekly review", cls: "vd-btn" }).addEventListener("click", run);
      return;
    }
    body.createDiv({ cls: "vd-dateline", text: `Reviewed ${week.date}` });
    if (week.loadForecast) body.createDiv({ cls: "vd-forecast", text: week.loadForecast });
    if (week.ruleViolations.length) {
      body.createDiv({ cls: "vd-dateline", text: "Needs tidying" });
      const ul = body.createEl("ul", { cls: "vd-missing" });
      week.ruleViolations.forEach((v) => ul.createEl("li", { text: v }));
    }
    const pending = plugin.store.state.triage.filter((t) => t.status === "pending").length;
    if (pending) body.createEl("a", { cls: "vd-more", text: `${pending} inbox proposals waiting` }).addEventListener("click", () => ctx.setTab("inbox"));
    body.createEl("button", { text: "Run weekly review", cls: "vd-btn" }).addEventListener("click", run);
  },
};

/** Inbox triage proposals awaiting a click. Nothing moves until you apply. */
export const triage: TileType = {
  id: "triage",
  title: "Inbox triage",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const st = plugin.store.state;
    const pending = st.triage.filter((t) => t.status === "pending");
    const rest = st.triage.filter((t) => t.status !== "pending");
    if (!st.triage.length) {
      empty(body, st.week ? "No inbox proposals from the last review." : "No weekly review yet, so no proposals.");
      body.createEl("button", { text: "Run weekly review", cls: "vd-btn" }).addEventListener("click", () => void plugin.runJob("week", "manual"));
      return;
    }
    if (pending.length) {
      body.createDiv({ cls: "vd-dateline", text: `${pending.length} proposals. Nothing moves until you apply.` });
      const picked = new Set(pending.map((p) => p.id));
      const apply = body.createEl("button", { cls: "mod-cta vd-btn-cta" });
      const label = () => (apply.textContent = `Apply selected (${picked.size})`);
      label();
      const ul = body.createEl("ul", { cls: "vd-triage" });
      for (const it of pending) {
        const li = ul.createEl("li", { cls: "vd-triage-item" });
        const cb = li.createEl("input", { type: "checkbox" });
        cb.checked = true;
        cb.addEventListener("change", () => {
          cb.checked ? picked.add(it.id) : picked.delete(it.id);
          apply.disabled = picked.size === 0;
          label();
        });
        const main = li.createDiv({ cls: "vd-triage-main" });
        const name = main.createEl("a", { cls: "vd-note-name", text: base(it.path) });
        name.addEventListener("click", () => void openPath(ctx.app, it.path));
        main.createDiv({ cls: "vd-path", text: describe(it) });
        main.createDiv({ cls: "vd-path", text: it.reason });
        li.createEl("button", { text: "Skip", cls: "vd-btn" }).addEventListener("click", () => void plugin.assistant.skipTriage(it.id));
      }
      apply.addEventListener("click", async () => {
        apply.disabled = true;
        for (const it of pending) if (picked.has(it.id)) await plugin.assistant.approveTriage(it.id);
        new Notice("Done. See “What changed” on the Assistant tab.");
      });
    } else {
      body.createDiv({ cls: "vd-dateline", text: "No proposals waiting." });
    }
    if (rest.length) {
      const done = rest.filter((r) => r.status === "done").length;
      const failed = rest.filter((r) => r.status === "failed");
      body.createDiv({ cls: "vd-dateline", text: `${done} done · ${rest.filter((r) => r.status === "skipped").length} skipped${failed.length ? ` · ${failed.length} failed` : ""}` });
      failed.forEach((f) => body.createDiv({ cls: "vd-error", text: `${base(f.path)}: ${f.error}` }));
    }
  },
};

function describe(it: TriageItem): string {
  if (it.action === "delete-empty") return "→ move empty stub to trash";
  if (it.action === "archive") return "→ Archive/";
  return `→ ${it.destination}/`;
}

/** An audit trail of everything the plugin wrote, newest first. */
export const changes: TileType = {
  id: "changes",
  title: "What changed",
  render(body, ctx) {
    const list = ctx.plugin.store.state.writes.slice(0, 15);
    if (!list.length) return empty(body, "The plugin hasn't written anything yet.");
    const ul = body.createEl("ul", { cls: "vd-notes" });
    for (const w of list) {
      const li = ul.createEl("li");
      const main = li.createDiv({ cls: "vd-change" });
      const a = main.createEl("a", { cls: "vd-note-name", text: `${OP_LABEL[w.op] ?? w.op} · ${base(w.path)}` });
      a.addEventListener("click", () => void openPath(ctx.app, w.path));
      main.createDiv({ cls: "vd-path", text: w.summary });
      li.createSpan({ cls: "vd-path", text: `${ago(Date.parse(w.at))} ago${w.source === "user" ? " · you" : ""}` });
    }
  },
};
