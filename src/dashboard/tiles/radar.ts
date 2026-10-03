import { TileType, empty } from "./common";
import type VaultDigestPlugin from "../../main";
import { makeSelectable } from "../selectable";
import { radarSubject } from "../../intent/subjects";
import { countdown, RadarRow } from "../../engine/collectors/radar";

export const radar: TileType = {
  id: "radar",
  title: "Deadline radar",
  render(body, ctx) {
    const rows = ctx.plugin.data.scoredRadar();
    renderRadar(body, ctx.spec.limit ? rows.slice(0, ctx.spec.limit) : rows, ctx.plugin);
    if (ctx.spec.limit && rows.length > ctx.spec.limit) {
      const more = body.createEl("a", { cls: "vd-more", text: `${rows.length - ctx.spec.limit} more on the Study tab` });
      more.addEventListener("click", () => ctx.setTab("study"));
    }
  },
};

/** Shared by the tile and the ```pa-radar code block. */
export function renderRadar(body: HTMLElement, rows: RadarRow[], plugin?: VaultDigestPlugin) {
  {
    if (!rows.length) return empty(body, "No upcoming deadlines yet. Run a brief to fill the radar.");
    const max = Math.max(1, ...rows.map((r) => r.liveScore ?? 0));
    const ul = body.createEl("ul", { cls: "vd-radar" });
    for (const r of rows) {
      const li = ul.createEl("li", { cls: "vd-radar-row" });
      if (plugin) makeSelectable(li, radarSubject(r, plugin.store.state.radar.find((x) => x.id === r.id)), plugin);
      const head = li.createDiv({ cls: "vd-radar-head" });
      const chip = head.createSpan({
        cls: "vd-chip",
        text: r.hoursLeft !== undefined ? countdown(r.hoursLeft) : r.days !== undefined ? `${r.days}d` : "—",
      });
      if (r.hoursLeft !== undefined) {
        if (r.hoursLeft < 24) chip.addClass("is-late");
        else if (r.hoursLeft < 48) chip.addClass("is-today");
      }
      head.createSpan({ cls: "vd-radar-name", text: r.name });
      if (r.liveScore !== undefined) head.createSpan({ cls: "vd-score", text: r.liveScore.toFixed(1) });
      const sub = li.createDiv({ cls: "vd-radar-sub" });
      sub.createSpan({ text: r.dueText });
      if (r.weightText) sub.createSpan({ text: `· ${r.weightText}${/%/.test(r.weightText) ? "" : "%"}` });
      if (r.liveScore !== undefined) {
        const bar = li.createDiv({ cls: "vd-bar" });
        bar.createDiv({ cls: "vd-bar-fill" }).style.width = `${Math.round((r.liveScore / max) * 100)}%`;
      }
    }
  }
}
