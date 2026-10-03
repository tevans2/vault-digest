import { TileType, empty } from "./common";
import { ago } from "../../util/dates";

/** Google Calendar health, what a sync would change, and the buttons to run it. */
export const calendar: TileType = {
  id: "calendar",
  title: "Google Calendar",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const svc = plugin.calendar;
    const st = plugin.store.state.calendar;

    if (plugin.settings.calendarSync === "off") return empty(body, "Off. Turn it on in Settings → Vault Digest → Google Calendar.");
    const miss = svc.problems();
    if (miss.length) return void body.createDiv({ cls: "vd-error", text: `Set ${miss.join(" and ")} in Settings → Vault Digest → Google Calendar.` });
    if (!svc.connected) return void body.createDiv({ cls: "vd-error", text: "Not connected. Press Connect in Settings → Vault Digest → Google Calendar." });

    const linked = Object.keys(st.links).length;
    const line = body.createDiv({ cls: "vd-channel-line" });
    line.createSpan({ cls: "vd-dot" + (st.lastError ? " is-bad" : st.lastSyncAt ? " is-ok" : "") });
    line.createSpan({ text: st.lastSyncAt ? `Synced ${ago(Date.parse(st.lastSyncAt))} ago${st.lastSummary ? ` · ${st.lastSummary}` : ""}` : "Not synced yet" });
    line.createSpan({ cls: "vd-chip", text: `${linked} on the calendar` });
    line.createSpan({ cls: "vd-chip", text: plugin.settings.calendarSync === "auto" ? "automatic" : "manual" });
    if (st.lastError) body.createDiv({ cls: "vd-error", text: st.lastError });

    const pv = svc.preview;
    if (pv && (pv.lines.length || pv.issues.length)) {
      body.createDiv({ cls: "vd-dateline", text: `${pv.lines.length} change${pv.lines.length === 1 ? "" : "s"} waiting` });
      const ul = body.createEl("ul", { cls: "vd-plan" });
      for (const l of pv.lines) ul.createEl("li", { text: l });
      for (const i of pv.issues) ul.createEl("li", { cls: "vd-plan-reject", text: i });
    }

    const row = body.createDiv({ cls: "vd-row" });
    const busy = svc.isBusy;
    const preview = row.createEl("button", { text: busy ? "Working…" : "Preview", cls: "vd-btn" });
    preview.disabled = busy;
    preview.addEventListener("click", () => void svc.sync({ apply: false }));
    const apply = row.createEl("button", { text: pv?.lines.length ? `Apply ${pv.lines.length}` : "Sync now", cls: "mod-cta vd-btn-cta" });
    apply.disabled = busy;
    apply.addEventListener("click", () => void svc.sync({ apply: true }));
  },
};
