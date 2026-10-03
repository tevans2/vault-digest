import { App, Component, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import type VaultDigestPlugin from "../../main";
import type { TileSpec } from "../layout";
import type { Task } from "../../engine/collectors/tasks";
import { overdueDays } from "../../engine/collectors/tasks";
import { makeSelectable } from "../selectable";
import { taskSubject } from "../../intent/subjects";
import { shortDue } from "../../util/dates";

export interface TileContext {
  app: App;
  plugin: VaultDigestPlugin;
  component: Component;
  spec: TileSpec;
  today: string;
  /** The tab this tile is on, and every tab in the layout. */
  tabId: string;
  tabIds: string[];
  rerender(): void;
  /** Remove this tile from the page (e.g. a notices tile with nothing to show). */
  hideTile(): void;
  setTab(id: string): void;
}

export interface TileType {
  id: string;
  title: string;

  render(body: HTMLElement, ctx: TileContext): void | Promise<void>;
}

/** Render inline markdown (wikilinks, bold) into an element. */
export async function renderInline(text: string, el: HTMLElement, ctx: TileContext, sourcePath = "") {
  const tmp = createDiv();
  await MarkdownRenderer.render(ctx.app, text, tmp, sourcePath, ctx.component);
  const p = tmp.querySelector(":scope > p");
  if (p && tmp.children.length === 1) {
    while (p.firstChild) el.appendChild(p.firstChild);
  } else {
    while (tmp.firstChild) el.appendChild(tmp.firstChild);
  }
}

export function empty(el: HTMLElement, msg: string) {
  el.createDiv({ cls: "vd-empty", text: msg });
}

export async function openPath(app: App, path: string, line?: number, newTab = false) {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) {
    new Notice(`Not found: ${path}`);
    return;
  }
  const leaf = app.workspace.getLeaf(newTab);
  await leaf.openFile(f, line !== undefined ? { eState: { line } } : undefined);
}

export function findByBasename(app: App, name: string): TFile | undefined {
  return app.vault.getMarkdownFiles().find((f) => f.basename === name);
}

/** Tick a task through the writer: real completion date, audited. */
export async function completeTask(ctx: TileContext, t: Task) {
  await ctx.plugin.assistant.completeFromUi(t);
}

export function taskList(el: HTMLElement, tasks: Task[], ctx: TileContext, opts: { showPath?: boolean } = {}) {
  const ul = el.createEl("ul", { cls: "vd-tasks" });
  for (const t of tasks) {
    const li = ul.createEl("li", { cls: "vd-task" });
    makeSelectable(li, taskSubject(t), ctx.plugin);
    const cb = li.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
    cb.addEventListener("change", async () => {
      li.addClass("is-done");
      await completeTask(ctx, t);
    });
    const main = li.createDiv({ cls: "vd-task-main" });
    const txt = main.createEl("a", { cls: "vd-task-text" });
    void renderInline(t.text, txt, ctx, t.path);
    txt.addEventListener("click", (e) => {
      // let inner links handle themselves
      if ((e.target as HTMLElement).closest("a.internal-link")) return;
      e.preventDefault();
      void openPath(ctx.app, t.path, t.line);
    });
    const meta = main.createDiv({ cls: "vd-task-meta" });
    if (t.due) {
      const od = overdueDays(t, ctx.today);
      const chip = meta.createSpan({ cls: "vd-chip", text: od > 0 ? `${od}d overdue` : t.due === ctx.today ? "today" : shortDue(t.due) });
      if (od > 0) chip.addClass("is-late");
      else if (t.due === ctx.today) chip.addClass("is-today");
    }
    if (opts.showPath) {
      meta.createSpan({ cls: "vd-path", text: t.path.split("/").slice(-1)[0].replace(/\.md$/, "") });
    }
  }
}

export function iconLink(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
  const b = parent.createEl("button", { cls: "vd-iconbtn clickable-icon", attr: { "aria-label": label } });
  setIcon(b, icon);
  b.addEventListener("click", onClick);
  return b;
}
