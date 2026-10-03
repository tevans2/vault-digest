import { App, Modal, setIcon } from "obsidian";
import type VaultDigestPlugin from "../main";
import type { BarContext, BarFlags, SubmitResult } from "../intent/service";
import { TYPE_LABEL } from "../intent/subjects";
import type { Subject } from "../intent/types";

const HINTS: Record<string, string> = {
  task: "next tues · done · waiting on sam · push 3 days · p1 · rename … · drop",
  message: "task friday · ignore · done",
  announcement: "snooze 3d · dismiss",
  radar: "weight 30 · friday 14:00 · remove",
  text: "task friday",
  event: "Calendar events can't be edited yet",
};
const NO_SUBJECT_HINT = "Add a task (“cs344 hand in A2 friday”) or ask a question (“? what's due this week”). Shift-click anything to act on it.";

export interface BarOptions {
  context?: BarContext;
  /** Called when something was applied, so a modal can close itself. */
  onDone?: (r: SubmitResult) => void;
  /** Keep what you've typed across dashboard re-renders. */
  persistDraft?: boolean;
  /** Dashboard tiles pass their Component so subscriptions are cleaned up when the tile re-renders. */
  owner?: { register(cb: () => void): void };
}

/** The one place you give instructions. It reads the selection (or the open note), shows how it understood you, then applies it. */
export function renderCommandBar(el: HTMLElement, plugin: VaultDigestPlugin, opts: BarOptions = {}) {
  const ctx: BarContext = opts.context ?? { cursorTasks: [] };
  const flags: BarFlags = { tasks: true, text: true, note: true };
  const intent = plugin.intent;

  const wrap = el.createDiv({ cls: "vd-cmd" });
  const chips = wrap.createDiv({ cls: "vd-cmd-chips" });
  const row = wrap.createDiv({ cls: "vd-cmd-row" });
  const input = row.createEl("input", { type: "text", cls: "vd-capture-input vd-cmd-input", attr: { placeholder: "Tell it what to do…", "aria-label": "Command bar", spellcheck: "false" } });
  const go = row.createEl("button", { text: "Go", cls: "mod-cta vd-btn-cta" });
  const preview = wrap.createDiv({ cls: "vd-cmd-preview" });
  const result = wrap.createDiv({ cls: "vd-cmd-result" });

  if (opts.persistDraft) input.value = plugin.captureDraft;
  let busy = false;
  let hist = -1;

  const current = () => intent.subjectsFor(ctx, flags);

  const chip = (parent: HTMLElement, label: string, onRemove: () => void, cls = "") => {
    const c = parent.createSpan({ cls: `vd-cmd-chip ${cls}`.trim() });
    c.createSpan({ text: label });
    const x = c.createSpan({ cls: "vd-cmd-x", attr: { "aria-label": "Remove" } });
    setIcon(x, "x");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove();
    });
  };

  const drawChips = () => {
    chips.empty();
    const { subjects } = current();
    if (!subjects.length) chips.createSpan({ cls: "vd-faint", text: "Nothing selected" });
    for (const s of subjects) {
      const fromSelection = intent.selection.has(s.key);
      chip(chips, `${TYPE_LABEL[s.type]} · ${s.label}`, () => {
        if (fromSelection) intent.selection.remove(s.key);
        else if (s.type === "task") flags.tasks = false;
        else flags.text = false;
        refresh();
      }, "is-subject");
    }
    if (ctx.activeFile && flags.note) chip(chips, `Note · ${ctx.activeFile.name}`, () => ((flags.note = false), refresh()), "is-context");
    if (intent.selection.size > 1) {
      const clear = chips.createEl("a", { cls: "vd-more", text: "Clear selection" });
      clear.addEventListener("click", () => intent.selection.clear());
    }
  };

  const drawPreview = () => {
    preview.empty();
    const text = input.value.trim();
    const { subjects, implicit } = current();
    if (busy) return void preview.createSpan({ cls: "vd-faint", text: "Working…" });
    if (!text) {
      const types = [...new Set(subjects.map((s) => s.type))];
      preview.createSpan({ cls: "vd-faint", text: types.length === 1 ? `Try: ${HINTS[types[0]]}` : types.length ? "That mixes different things, so the agent will work out what you mean." : NO_SUBJECT_HINT });
      return;
    }
    const g = intent.preview(text, subjects, implicit);
    if (g.kind === "ops") {
      preview.createSpan({ cls: "vd-cmd-arrow", text: "↳" });
      preview.createSpan({ text: g.summary });
      preview.createSpan({ cls: "vd-chip", text: "instant" });
    } else if (g.kind === "question") {
      preview.createSpan({ cls: "vd-cmd-arrow", text: "↳" });
      preview.createSpan({ text: "Ask the agent" });
      preview.createSpan({ cls: "vd-chip", text: "agent" });
    } else if (g.kind === "agent") {
      preview.createSpan({ cls: "vd-cmd-arrow", text: "↳" });
      preview.createSpan({ text: subjects.length ? "The agent will work this out, using what you've selected" : "The agent will work this out" });
      preview.createSpan({ cls: "vd-chip", text: "agent" });
    } else {
      preview.createSpan({ cls: "vd-bad", text: g.message });
    }
  };

  const refresh = () => {
    drawChips();
    drawPreview();
  };

  const showResult = (r: SubmitResult) => {
    result.empty();
    if (r.kind === "blocked" || r.kind === "error") return void result.createDiv({ cls: "vd-bad", text: r.message });
    const a = r.action;
    if (a.status === "answered" && a.reply) {
      result.createDiv({ cls: "vd-cmd-reply", text: a.reply });
      result.createDiv({ cls: "vd-faint", text: "Answered by the agent. Nothing was changed." });
      return;
    }
    const bad = a.ops.filter((o) => !o.ok);
    result.createDiv({ cls: a.status === "failed" ? "vd-bad" : "vd-cmd-ok", text: `${a.status === "failed" ? "✕" : "✓"} ${a.summary}${bad.length && a.status !== "failed" ? ` (${a.ops.length - bad.length} of ${a.ops.length} done)` : ""}` });
    for (const o of bad) result.createDiv({ cls: "vd-bad vd-cmd-small", text: `${o.summary}: ${o.error}` });
    if (a.reply) result.createDiv({ cls: "vd-cmd-reply", text: a.reply });
    const undo = result.createEl("a", { cls: "vd-more", text: "Undo is on the Assistant tab →" });
    undo.addEventListener("click", () => plugin.setTab("assistant"));
  };

  const submit = async () => {
    if (busy || !input.value.trim()) return;
    busy = true;
    go.disabled = true;
    result.empty();
    drawPreview();
    const res = await intent_submit();
    busy = false;
    go.disabled = false;
    showResult(res);
    if (res.kind === "done") {
      input.value = "";
      if (opts.persistDraft) plugin.captureDraft = "";
      hist = -1;
    }
    refresh();
    opts.onDone?.(res);
    input.focus();
  };
  const intent_submit = () => intent.submit(input.value, ctx, flags);

  input.addEventListener("input", () => {
    if (opts.persistDraft) plugin.captureDraft = input.value;
    drawPreview();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (input.value) {
        input.value = "";
        if (opts.persistDraft) plugin.captureDraft = "";
        drawPreview();
      } else if (intent.selection.size) intent.selection.clear();
      else input.blur();
    } else if (e.key === "ArrowUp" && intent.history.length) {
      e.preventDefault();
      hist = Math.min(hist + 1, intent.history.length - 1);
      input.value = intent.history[hist];
      drawPreview();
    } else if (e.key === "ArrowDown" && hist >= 0) {
      e.preventDefault();
      hist -= 1;
      input.value = hist >= 0 ? intent.history[hist] : "";
      drawPreview();
    }
  });
  go.addEventListener("click", () => void submit());

  const off = intent.selection.onChange(refresh);
  opts.owner?.register(off);
  refresh();
  return { input, dispose: off };
}

/** The same bar, from anywhere in Obsidian. Opened by the "Command bar" command. */
export class CommandModal extends Modal {
  private dispose: (() => void) | null = null;
  constructor(app: App, private plugin: VaultDigestPlugin, private context: BarContext) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText("Instruct");
    this.modalEl.addClass("vd-cmd-modal");
    this.contentEl.addClass("vd-root");
    const { input, dispose } = renderCommandBar(this.contentEl, this.plugin, {
      context: this.context,
      // Answers stay open to be read; changes close the panel.
      onDone: (r) => {
        if (r.kind === "done" && !(r.action.status === "answered" && r.action.reply)) window.setTimeout(() => this.close(), 600);
      },
    });
    this.dispose = dispose;
    window.setTimeout(() => input.focus(), 30);
  }
  onClose() {
    this.dispose?.();
    this.contentEl.empty();
  }
}

export type { Subject };
