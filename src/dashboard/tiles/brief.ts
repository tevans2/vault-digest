import { MarkdownRenderer } from "obsidian";
import { TileType, empty } from "./common";
import { minutesOfDay, shortDue } from "../../util/dates";
import { makeSelectable } from "../selectable";
import { eventSubject } from "../../intent/subjects";

const toMin = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

export const plan: TileType = {
  id: "plan",
  title: "Today’s plan",
  async render(body, ctx) {
    const b = ctx.plugin.store.state.brief;
    if (!b) return empty(body, "No brief yet. Run it from the Assistant tile.");
    if (b.date !== ctx.today) {
      body.createDiv({ cls: "vd-dateline vd-bad", text: `From ${shortDue(b.date)}. Today’s brief hasn’t run.` });
    }
    if (b.priorities.length) {
      const ol = body.createEl("ol", { cls: "vd-prio" });
      b.priorities.forEach((p) => ol.createEl("li", { text: p }));
    }
    if (b.notes) {
      body.createDiv({ cls: "vd-dateline", text: "Claude’s notes" });
      const notes = body.createDiv({ cls: "vd-notes-md" });
      await MarkdownRenderer.render(ctx.app, b.notes, notes, "", ctx.component);
    }
    if (b.missing.length) {
      body.createDiv({ cls: "vd-dateline", text: "Couldn’t check" });
      const ul = body.createEl("ul", { cls: "vd-missing" });
      b.missing.forEach((m) => ul.createEl("li", { text: m }));
    }
  },
};

export const timeline: TileType = {
  id: "timeline",
  title: "Timeline",
  render(body, ctx) {
    const b = ctx.plugin.store.state.brief;
    if (!b) return empty(body, "No brief yet.");
    if (b.date !== ctx.today) return empty(body, `Last brief was for ${shortDue(b.date)}.`);
    if (!b.timeline.length) return empty(body, "Nothing on the calendar today.");

    const now = minutesOfDay();
    const ul = body.createEl("ul", { cls: "vd-timeline" });
    let marked = false;
    for (const e of b.timeline) {
      const allDay = e.start === "all-day";
      const start = allDay ? -1 : toMin(e.start);
      const end = e.end ? toMin(e.end) : start + 60;
      const past = !allDay && end <= now;
      const current = !allDay && start <= now && now < end;
      const li = ul.createEl("li", { cls: "vd-event" + (past ? " is-past" : "") + (current ? " is-now" : "") });
      makeSelectable(li, eventSubject(e), ctx.plugin);
      if (!allDay && !past && !current && !marked && start > now) {
        marked = true;
        li.addClass("is-next");
      }
      li.createSpan({ cls: "vd-event-time", text: allDay ? "All day" : e.end ? `${e.start}–${e.end}` : e.start });
      const main = li.createDiv({ cls: "vd-event-main" });
      main.createDiv({ text: e.title });
      if (e.note) main.createDiv({ cls: "vd-path", text: e.note });
    }
  },
};
