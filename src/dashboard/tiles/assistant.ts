
import { TileType, empty } from "./common";
import { describeNextBrief } from "../../engine/scheduler";
import { PROVIDER_LABELS } from "../../runner/provider";
import { RunLogModal } from "../log-modal";
import { isoDate, timeOfDay } from "../../util/dates";
import type { RunRecord } from "../../state/schema";

const ICON: Record<string, string> = { ok: "✓", failed: "✕", rejected: "✕", cancelled: "–", running: "…" };

export const paStatus: TileType = {
  id: "pa-status",
  title: "Assistant",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const s = plugin.settings;
    const state = plugin.store.state;
    const runner = plugin.runner;

    if (!runner) {
      body.createDiv({
        cls: "vd-dateline vd-bad",
        text: plugin.runnerError ? `Runner unavailable: ${plugin.runnerError}` : "The runner isn't ready yet.",
      });
      const retry = body.createEl("button", { text: "Retry setup", cls: "vd-btn" });
      retry.addEventListener("click", async () => {
        await plugin.setupRunner();
        ctx.rerender();
      });
    }

    // Live run
    if (runner?.current) {
      const live = body.createDiv({ cls: "vd-live" });
      live.createSpan({ cls: "vd-pulse" });
      live.createSpan({ text: runner.progress || "Working…" });
      const cancel = live.createEl("button", { text: "Cancel", cls: "vd-btn" });
      cancel.addEventListener("click", () => runner.cancel());
    }

    // Results held by dry-run, each with the exact list of changes it would make.
    for (const pend of state.pending) {
      const card = body.createDiv({ cls: "vd-pending" });
      const name = pend.job === "brief" ? "Brief" : pend.job === "close" ? "Close" : "Result";
      card.createDiv({ cls: "vd-pending-title", text: `${name} ready for review` });
      const list = card.createEl("ul", { cls: "vd-plan" });
      list.createEl("li", { cls: "vd-faint", text: "Working out the changes…" });
      void plugin.assistant.previewPending(pend).then((lines) => {
        list.empty();
        if (!lines.length) list.createEl("li", { cls: "vd-faint", text: "No changes to the vault." });
        for (const l of lines) list.createEl("li", { cls: `vd-plan-${l.kind}`, text: l.text });
      });
      const row = card.createDiv({ cls: "vd-row" });
      row.createEl("button", { text: "Apply", cls: "mod-cta vd-btn-cta" }).addEventListener("click", async () => {
        await plugin.assistant.applyPending(pend.runId);
        ctx.rerender();
      });
      row.createEl("button", { text: "Discard", cls: "vd-btn" }).addEventListener("click", async () => {
        await plugin.assistant.discardPending(pend.runId);
        ctx.rerender();
      });
    }

    // Job summary
    const jobs = body.createDiv({ cls: "vd-jobs" });
    const today = isoDate();
    const lastBrief = state.runs.find((r) => r.job === "brief");
    const line = (label: string, value: string, cls = "") => {
      const d = jobs.createDiv({ cls: "vd-job-line" });
      d.createSpan({ cls: "vd-job-key", text: label });
      d.createSpan({ cls: cls, text: value });
    };
    for (const [job, label] of [["brief", "Brief"], ["close", "Close"], ["week", "Weekly"]] as const) {
      const last = state.runs.find((r) => r.job === job && r.status !== "running");
      if (!last) {
        line(label, "never run");
        continue;
      }
      const same = isoDate(new Date(last.startedAt)) === today;
      const when = same ? timeOfDay(new Date(last.startedAt)) : new Date(last.startedAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
      line(label, `${ICON[last.status]} ${last.status} · ${when}${last.costUsd !== undefined ? ` · $${last.costUsd.toFixed(2)}` : ""}`, last.status === "ok" || last.status === "cancelled" ? "" : "vd-bad");
    }
    line("Provider", `${PROVIDER_LABELS[s.provider]}${plugin.modelFor(s.provider) ? ` · ${plugin.modelFor(s.provider)}` : ""}`);
    line("Auto-run", describeNextBrief(new Date(), { autoRun: s.autoRun, time: s.briefTime, weekdaysOnly: s.weekdaysOnly }));
    line("Dry-run", s.dryRun ? "on: results wait for Apply" : "off: results apply immediately");
    const weekCost = state.runs
      .filter((r) => Date.now() - Date.parse(r.startedAt) < 7 * 86_400_000)
      .reduce((a, r) => a + (r.costUsd ?? 0), 0);
    line("This week", `$${weekCost.toFixed(2)}`);

    // Error block
    if (lastBrief && (lastBrief.status === "failed" || lastBrief.status === "rejected")) {
      const err = body.createDiv({ cls: "vd-error" });
      err.createDiv({ text: lastBrief.error ?? "The last run failed." });
    }

    // Buttons
    if (runner) {
      const row = body.createDiv({ cls: "vd-row" });
      const run = row.createEl("button", { text: runner.isBusy() ? "Running…" : "Run brief", cls: "vd-btn" });
      run.disabled = runner.isBusy();
      run.addEventListener("click", () => void plugin.runJob("brief", "manual"));
      const wk = row.createEl("button", { text: "Weekly review", cls: "vd-btn" });
      wk.disabled = runner.isBusy();
      wk.addEventListener("click", () => void plugin.runJob("week", "manual"));
      if (lastBrief) {
        row.createEl("button", { text: "View log", cls: "vd-btn" }).addEventListener("click", () => new RunLogModal(ctx.app, lastBrief).open());
      }
    }

    // Recent runs
    const recent = state.runs.slice(0, 5);
    if (recent.length > 1) {
      body.createDiv({ cls: "vd-dateline", text: "Recent runs" });
      const ul = body.createEl("ul", { cls: "vd-notes" });
      for (const r of recent) recentRow(ul, r, ctx.app);
    }
    if (!runner && !recent.length && !state.pending.length) empty(body, "No runs recorded.");
  },
};

function recentRow(ul: HTMLElement, r: RunRecord, app: import("obsidian").App) {
  const li = ul.createEl("li");
  const a = li.createEl("a", { cls: "vd-note-name", text: `${ICON[r.status]} ${r.job} · ${r.trigger}` });
  a.addEventListener("click", () => new RunLogModal(app, r).open());
  li.createSpan({ cls: "vd-path", text: new Date(r.startedAt).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) });
}


