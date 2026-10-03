import { TileContext, TileType, empty, openPath, renderInline } from "./common";
import type { Announcement } from "../../engine/collectors/announcements";
import { forFront, forTab } from "../../engine/routing";
import { makeSelectable } from "../selectable";
import { announcementSubject } from "../../intent/subjects";
import { RunLogModal } from "../log-modal";
import type { JobId } from "../../state/schema";
import { addDays, isoDate } from "../../util/dates";

const BADGE: Record<string, string> = {
  urgent: "Urgent",
  soon: "Soon",
  info: "Note",
  stale: "Stale",
  error: "Error",
};

/** Shared by the front-page tile and the per-tab notices. */
async function renderRows(body: HTMLElement, visible: Announcement[], ctx: TileContext, infoDivider: boolean) {
  const store = ctx.plugin.store;
  let dividerDrawn = false;
  for (const a of visible) {
    if (infoDivider && a.level === "info" && !dividerDrawn) {
      dividerDrawn = true;
      if (visible.some((x) => x.level !== "info")) body.createDiv({ cls: "vd-dateline", text: "Info" });
    }
    const row = body.createDiv({ cls: `vd-announce is-${a.level}` });
    makeSelectable(row, announcementSubject(a), ctx.plugin);
    row.createSpan({ cls: "vd-badge", text: a.source === "engine" && a.level !== "error" ? `${BADGE[a.level]} · auto` : a.source === "brief" ? `${BADGE[a.level]} · brief` : BADGE[a.level] });
    const text = row.createDiv({ cls: "vd-announce-text" });
    await renderInline(a.text, text, ctx, ctx.plugin.settings.announcementsPath);
    const actions = row.createDiv({ cls: "vd-announce-actions" });
    for (const act of a.actions ?? []) {
      const b = actions.createEl("button", { text: act.label, cls: "vd-btn vd-btn-act" });
      b.addEventListener("click", () => {
        if (act.kind === "run") void ctx.plugin.runJob(act.job as JobId, "manual");
        else if (act.kind === "open") void openPath(ctx.app, act.path);
        else if (act.kind === "fetch-messages") void ctx.plugin.messages.fetchNow();
        else if (act.kind === "log") {
          const run = ctx.plugin.store.state.runs.find((r) => r.id === act.runId);
          if (run) new RunLogModal(ctx.app, run).open();
        }
      });
    }
    if (a.level === "error") row.addClass("is-sticky");
    const ack = actions.createEl("button", { text: "Ack", cls: "vd-btn" });
    ack.addEventListener("click", async () => {
      await store.ack(a.id);
      ctx.rerender();
    });
    const snooze = actions.createEl("button", { text: "Snooze 1d", cls: "vd-btn" });
    snooze.addEventListener("click", async () => {
      const until = new Date(Date.parse(addDays(isoDate(), 1) + "T06:00:00+02:00"));
      await store.snooze(a.id, until);
      ctx.rerender();
    });
  }
}

const routeCtx = (ctx: TileContext) => ({
  tabs: ctx.tabIds,
  courses: ctx.plugin.settings.courses.map((c) => c.code),
  workTerms: ctx.plugin.settings.workFolders.map((f) => f.replace(/\/+$/, "").split("/").pop() ?? ""),
});
const ORDER = ["error", "urgent", "soon", "stale", "info"];
const sorted = (xs: Announcement[]) => [...xs].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));

/** Front page: everything that needs you, with info that has no other home at the bottom. */
export const announcements: TileType = {
  id: "announcements",
  title: "Announcements",
  async render(body, ctx) {
    const stamp = ctx.plugin.announcementStamp();
    const all = ctx.plugin.allAnnouncements();
    const scope = ctx.spec.scope ?? "front";
    const mine = scope === "front" ? forFront(all, routeCtx(ctx)) : forTab(all, scope, routeCtx(ctx));
    const visible = mine.filter((a) => !ctx.plugin.store.isHidden(a.id));
    if (!visible.length) {
      empty(body, mine.length ? "All caught up. Everything is acknowledged or snoozed." : "Nothing needs you right now.");
      return;
    }
    if (stamp && scope === "front") body.createDiv({ cls: "vd-dateline", text: stamp });
    await renderRows(body, sorted(visible), ctx, scope === "front");
  },
};

/** Info-level notices for one tab. Disappears entirely when there are none. */
export const notices: TileType = {
  id: "notices",
  title: "Notes",
  async render(body, ctx) {
    const scope = ctx.spec.scope ?? ctx.tabId;
    const mine = forTab(ctx.plugin.allAnnouncements(), scope, routeCtx(ctx)).filter((a) => !ctx.plugin.store.isHidden(a.id));
    if (!mine.length) return ctx.hideTile();
    await renderRows(body, sorted(mine), ctx, false);
  },
};
