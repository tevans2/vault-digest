import { TileType, empty } from "./common";
import { ago } from "../../util/dates";
import type { ActionRecord } from "../../intent/types";

const ICON: Record<ActionRecord["status"], string> = { applied: "✓", undone: "↶", partial: "◐", failed: "✕", answered: "?" };
const SOURCE: Record<string, string> = { bar: "you", editor: "you", telegram: "phone", "daily-note": "daily note", agent: "agent" };

/** Everything the command bar and your phone did, newest first. Each reversible action has its own Undo. */
export const actions: TileType = {
  id: "actions",
  title: "Actions",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const list = plugin.store.state.actions.slice(0, ctx.spec.limit ?? 30);
    if (!list.length) return empty(body, "Nothing yet. Shift-click something and give an instruction, or message the bot.");
    const ul = body.createEl("ul", { cls: "vd-actions" });

    for (const a of list) {
      const li = ul.createEl("li", { cls: `vd-action is-${a.status}` });
      const head = li.createDiv({ cls: "vd-action-head" });
      head.createSpan({ cls: "vd-action-icon", text: ICON[a.status] });
      head.createSpan({ cls: "vd-action-summary", text: a.summary });
      head.createSpan({ cls: "vd-faint", text: `${ago(Date.parse(a.at))} ago` });

      const meta = li.createDiv({ cls: "vd-action-meta" });
      meta.createSpan({ cls: "vd-chip", text: SOURCE[a.source] ?? a.source });
      meta.createSpan({ cls: "vd-chip", text: a.interpreter === "grammar" ? "instant" : "agent" });
      meta.createSpan({ cls: "vd-faint", text: `“${a.input.length > 70 ? `${a.input.slice(0, 69)}…` : a.input}”` });
      if (a.subjects.length) meta.createSpan({ cls: "vd-faint", text: `on ${a.subjects.map((s) => s.label).slice(0, 2).join(", ")}${a.subjects.length > 2 ? ` +${a.subjects.length - 2}` : ""}` });

      if (a.reply) li.createDiv({ cls: "vd-cmd-reply", text: a.reply });
      if (a.ops.length) {
        const det = li.createEl("details", { cls: "vd-action-ops" });
        det.createEl("summary", { text: `${a.ops.filter((o) => o.ok).length} of ${a.ops.length} changes` });
        for (const o of a.ops) det.createDiv({ cls: o.ok ? (o.undone ? "vd-faint" : "") : "vd-bad", text: `${o.ok ? (o.undone ? "↶" : "✓") : "✕"} ${o.summary}${o.error ? `: ${o.error}` : ""}` });
      }
      if (a.undoNote) li.createDiv({ cls: "vd-bad vd-cmd-small", text: a.undoNote });

      const reversible = a.ops.some((o) => o.ok && o.inverse && !o.undone);
      if (reversible) {
        const b = li.createEl("button", { text: "Undo", cls: "vd-btn vd-action-undo" });
        b.addEventListener("click", async () => {
          b.disabled = true;
          b.setText("Undoing…");
          await plugin.intent.undo(a.id);
          ctx.rerender();
        });
      }
    }
  },
};
