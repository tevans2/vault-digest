import { TileType, empty, openPath } from "./common";
import { RunLogModal } from "../log-modal";
import { addDays, shortDue, isoDate, timeOfDay, ago } from "../../util/dates";
import { isOpen } from "../../engine/collectors/tasks";
import { makeSelectable } from "../selectable";
import { taskSubject } from "../../intent/subjects";

/** Front-page control: run the brief, see its state, jump to anything waiting for review. */
export const runBar: TileType = {
  id: "run-bar",
  title: "Run",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const runner = plugin.runner;
    const st = plugin.store.state;
    const wrap = body.createDiv({ cls: "vd-runbar" });

    if (runner?.current) {
      const live = wrap.createDiv({ cls: "vd-live" });
      live.createSpan({ cls: "vd-pulse" });
      live.createSpan({ text: runner.progress || "Working…" });
      live.createEl("button", { text: "Cancel", cls: "vd-btn" }).addEventListener("click", () => runner.cancel());
      return;
    }

    const last = st.runs.find((r) => r.job === "brief" && r.status !== "running");
    const doneToday = !!last && last.status === "ok" && isoDate(new Date(last.startedAt)) === ctx.today;
    const go = wrap.createEl("button", { text: doneToday ? "Re-run brief" : "Run brief", cls: doneToday ? "vd-btn" : "mod-cta vd-btn-cta" });
    go.disabled = !runner;
    go.addEventListener("click", () => void plugin.runJob("brief", "manual"));

    const info = wrap.createDiv({ cls: "vd-runbar-info" });
    if (st.pending.length) {
      info.createEl("a", { cls: "vd-bad", text: `${st.pending.length} to review` }).addEventListener("click", () => ctx.setTab("assistant"));
    } else if (last && (last.status === "failed" || last.status === "rejected")) {
      info.createEl("a", { cls: "vd-bad", text: "Last run failed" }).addEventListener("click", () => new RunLogModal(ctx.app, last).open());
    } else if (last) {
      info.createSpan({ cls: "vd-faint", text: doneToday ? `✓ ${timeOfDay(new Date(last.startedAt))}${last.costUsd !== undefined ? ` · $${last.costUsd.toFixed(2)}` : ""}` : `last ${ago(Date.parse(last.startedAt))} ago` });
    } else info.createSpan({ cls: "vd-faint", text: "not run yet" });
  },
};

/** The next 14 days at a glance: how many tasks fall due each day, and where the graded deadlines sit. */
export const load: TileType = {
  id: "load",
  title: "Next 14 days",
  render(body, ctx) {
    const open = ctx.plugin.data.tasks.filter(isOpen);
    const radar = ctx.plugin.data.scoredRadar();
    const today = ctx.today;
    const overdue = open.filter((t) => t.due && t.due < today).length;

    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
    const counts = days.map((d) => open.filter((t) => t.due === d).length);
    const max = Math.max(1, ...counts);

    if (overdue) body.createDiv({ cls: "vd-load-over", text: `${overdue} overdue before today` });
    const grid = body.createDiv({ cls: "vd-load" });
    days.forEach((d, i) => {
      const dow = new Date(d + "T12:00:00Z").getUTCDay();
      const graded = radar.filter((r) => r.dueAt !== undefined && new Date(r.dueAt).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }) === d);
      const cell = grid.createDiv({ cls: "vd-load-cell" + (i === 0 ? " is-today" : "") + (dow === 0 || dow === 6 ? " is-weekend" : "") + (graded.length ? " has-graded" : "") });
      cell.createDiv({ cls: "vd-load-day", text: shortDue(d) });
      const bar = cell.createDiv({ cls: "vd-load-bar" });
      bar.createDiv({ cls: "vd-load-fill" }).style.height = `${Math.round((counts[i] / max) * 100)}%`;
      cell.createDiv({ cls: "vd-load-n", text: counts[i] ? String(counts[i]) : "·" });
      if (graded.length) {
        const g = cell.createDiv({ cls: "vd-load-graded", text: graded.map((r) => r.weight ? `${r.weight}%` : "★").join(" ") });
        g.setAttr("title", graded.map((r) => r.name).join("\n"));
      }
    });
    if (!radar.length && !counts.some(Boolean)) empty(body, "Nothing dated in the next two weeks.");
  },
};

/** Things you're waiting on others for, quietest first. */
export const waiting: TileType = {
  id: "waiting",
  title: "Waiting on others",
  render(body, ctx) {
    const items = ctx.plugin.data.tasks
      .filter((t) => isOpen(t) && t.waiting)
      .map((t) => {
        const f = ctx.app.vault.getAbstractFileByPath(t.path);
        const m = f && "stat" in f ? (f as { stat: { mtime: number } }).stat.mtime : Date.now();
        return { t, days: Math.floor((Date.now() - m) / 86_400_000) };
      })
      .sort((a, b) => b.days - a.days)
      .slice(0, 12);
    if (!items.length) return empty(body, "Nothing waiting on anyone.");
    const ul = body.createEl("ul", { cls: "vd-notes" });
    for (const { t, days } of items) {
      const li = ul.createEl("li");
      makeSelectable(li, taskSubject(t), ctx.plugin);
      const a = li.createEl("a", { cls: "vd-note-name", text: t.text });
      a.addEventListener("click", () => void openPath(ctx.app, t.path, t.line));
      li.createSpan({ cls: "vd-chip" + (days >= 14 ? " is-today" : ""), text: `quiet ${days}d` });
    }
  },
};
