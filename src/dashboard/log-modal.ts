import { App, Modal } from "obsidian";
import type { RunRecord } from "../state/schema";

export class RunLogModal extends Modal {
  constructor(app: App, private run: RunRecord) {
    super(app);
  }
  onOpen() {
    const r = this.run;
    this.titleEl.setText(`Run log · ${r.job} · ${r.status}`);
    const meta = this.contentEl.createDiv({ cls: "vd-log-meta" });
    const row = (k: string, v?: string | number) => {
      if (v === undefined || v === "") return;
      const d = meta.createDiv();
      d.createSpan({ cls: "vd-log-key", text: k });
      d.createSpan({ text: String(v) });
    };
    row("Started", new Date(r.startedAt).toLocaleString());
    row("Trigger", r.trigger);
    row("Provider", r.provider);
    row("Model", (r.model || "default") + (r.effort ? ` · ${r.effort}` : ""));
    row("Attempts", r.attempts);
    row("Cost", r.costUsd !== undefined ? `$${r.costUsd.toFixed(3)}` : undefined);
    row("Session", r.sessionId);
    if (r.error) this.contentEl.createDiv({ cls: "vd-log-error", text: r.error });
    this.contentEl.createEl("pre", { cls: "vd-log", text: r.log.join("\n") || "(no log lines)" });
  }
  onClose() {
    this.contentEl.empty();
  }
}
