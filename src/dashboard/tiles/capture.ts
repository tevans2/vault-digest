import { App, Modal, Notice } from "obsidian";
import type VaultDigestPlugin from "../../main";
import { TileType } from "./common";
import { renderCommandBar } from "../command-bar";
import { shortDue } from "../../util/dates";

/** One-line capture with a live preview of what will be written and where. Shared by the tile and the modal. */
export interface CaptureOpts {
  /** Start with this text (e.g. a message you are turning into a task). It isn't kept as the draft. */
  prefill?: string;
  /** Called after the task is added, before the modal closes. */
  onAdded?: () => void | Promise<void>;
}

export function renderCapture(el: HTMLElement, plugin: VaultDigestPlugin, onDone?: () => void, opts: CaptureOpts = {}) {
  const wrap = el.createDiv({ cls: "vd-capture" });
  const row = wrap.createDiv({ cls: "vd-capture-row" });
  const input = row.createEl("input", { type: "text", cls: "vd-capture-input", attr: { placeholder: "CS344 hand in A2 friday", "aria-label": "Capture a task" } });
  const add = row.createEl("button", { text: "Add", cls: "mod-cta vd-btn-cta" });
  const preview = wrap.createDiv({ cls: "vd-capture-preview" });

  input.value = opts.prefill ?? plugin.captureDraft; // the draft survives a re-render
  const draw = () => {
    if (opts.prefill === undefined) plugin.captureDraft = input.value;
    preview.empty();
    if (!input.value.trim()) {
      preview.createSpan({ cls: "vd-faint", text: "Dates like friday, tomorrow, 14 oct or in 3 days become a due date. Start with a course code to file it with the course." });
      return;
    }
    const c = plugin.assistant.parse(input.value);
    const chip = (t: string, cls = "") => preview.createSpan({ cls: `vd-chip ${cls}`.trim(), text: t });
    if (c.due) chip(`📅 ${shortDue(c.due)} (${c.due})`, "is-today");
    else chip("no date", "");
    if (c.course) chip(c.course);
    preview.createSpan({ cls: "vd-faint", text: ` → ${(plugin.assistant.captureTarget(c).split("/").pop() ?? "").replace(/\.md$/, "")}` });
  };

  let busy = false;
  const submit = async () => {
    if (busy || !input.value.trim()) return;
    busy = true;
    add.disabled = true;
    try {
      await plugin.assistant.capture(input.value);
      input.value = "";
      if (opts.prefill === undefined) plugin.captureDraft = "";
      draw();
      await opts.onAdded?.();
      onDone?.();
    } catch (e) {
      new Notice(`Couldn't add that: ${(e as Error).message}`, 8000);
    } finally {
      busy = false;
      add.disabled = false;
    }
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  add.addEventListener("click", () => void submit());
  draw();
  return input;
}

export class CaptureModal extends Modal {
  constructor(app: App, private plugin: VaultDigestPlugin, private opts: CaptureOpts = {}) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText("Capture a task");
    this.contentEl.addClass("vd-root");
    renderCapture(this.contentEl, this.plugin, () => this.close(), this.opts).focus();
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** The capture bar is now the command bar: with nothing selected it adds a task, with something selected it acts on it. */
export const capture: TileType = {
  id: "capture",
  title: "Command",
  render(body, ctx) {
    renderCommandBar(body, ctx.plugin, { persistDraft: true, owner: ctx.component });
  },
};
