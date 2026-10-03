import { Component, ItemView, Notice, WorkspaceLeaf, normalizePath, setIcon, TFile } from "obsidian";
import type VaultDigestPlugin from "../main";
import { DEFAULT_TABS, isLegacyLayout, parseLayout, TabSpec } from "./layout";
import { TILES } from "./tiles";
import { openPath, TileContext } from "./tiles/common";
import { computeBadges } from "./badges";
import { weekMissed } from "../engine/scheduler";
import { addDays, isoDate, longDate, timeOfDay } from "../util/dates";

export const VIEW_TYPE = "vault-digest-view";

export class DigestView extends ItemView {
  private tileComponents: Component[] = [];
  private ro: ResizeObserver | null = null;
  private renderToken = 0;
  private deferTimer: number | null = null;
  private focusCaptureAfter = false;
  private selbar: HTMLElement | null = null;
  private hasBar = false;
  private warnedLayout = "";
  /** Tab ids of the layout currently on screen, for keyboard shortcuts. */
  private tabIds: string[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: VaultDigestPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.plugin.settings.paperName;
  }
  getIcon() {
    return "newspaper";
  }

  async onOpen() {
    this.contentEl.addClass("vd-root");
    this.contentEl.tabIndex = -1;
    this.ro = new ResizeObserver(() => this.applyBreakpoint());
    this.ro.observe(this.contentEl);
    this.registerEvent(this.plugin.data.on("change", () => void this.render()));
    // Radar scores and countdowns are live, so repaint every minute.
    this.registerInterval(window.setInterval(() => void this.render(), 60_000));
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.onKey(e));
    // Selection is painted in place: re-rendering on every shift-click would be slow and would lose your scroll.
    this.register(this.plugin.intent.selection.onChange(() => this.paintSelection()));
    await this.render();
  }

  async onClose() {
    this.ro?.disconnect();
    if (this.deferTimer) window.clearTimeout(this.deferTimer);
    this.unloadTiles();
  }

  /** Breakpoints follow the container width, not the window. */
  private applyBreakpoint() {
    const w = this.contentEl.clientWidth;
    this.contentEl.dataset.bp = w < 600 ? "narrow" : w < 900 ? "medium" : "wide";
  }

  private unloadTiles() {
    this.tileComponents.forEach((c) => c.unload());
    this.tileComponents = [];
  }

  /** 1-9 switch tabs and c focuses capture, but never while you're typing. */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && this.plugin.intent.selection.size && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) {
      e.preventDefault();
      this.plugin.intent.selection.clear();
      return;
    }
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (/^[1-9]$/.test(e.key)) {
      const id = this.tabIds[Number(e.key) - 1];
      if (id) {
        e.preventDefault();
        this.plugin.setTab(id);
      }
    } else if (e.key === "c") {
      e.preventDefault();
      const el = this.contentEl.querySelector<HTMLInputElement>(".vd-capture-input");
      if (el) el.focus();
      else this.plugin.openCommandBar();
    }
  }

  private async loadTabs(): Promise<TabSpec[]> {
    const path = normalizePath(this.plugin.settings.layoutFile);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      const text = await this.app.vault.cachedRead(f);
      const layout = parseLayout(text);
      if (layout) return layout.tabs;
      const why = isLegacyLayout(text)
        ? `${path} uses the old single-page format, so the built-in tabs are showing. In settings, “Create from default” saves the new format (your old file is kept as a backup).`
        : `${path} couldn't be read as a tabs layout, so the built-in tabs are showing.`;
      if (this.warnedLayout !== why) {
        this.warnedLayout = why;
        new Notice(why, 12_000);
      }
    }
    return DEFAULT_TABS;
  }

  /** Is the user typing in one of our inputs? Re-rendering now would eat their text. */
  private isTyping(): boolean {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !this.contentEl.contains(a)) return false;
    return a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && (a as HTMLInputElement).type === "text");
  }

  async render() {
    if (this.isTyping()) {
      this.deferTimer ??= window.setTimeout(() => {
        this.deferTimer = null;
        void this.render();
      }, 4000);
      return;
    }
    const token = ++this.renderToken;
    const tabs = await this.loadTabs();
    if (token !== this.renderToken) return; // a newer render won the race

    this.tabIds = tabs.map((t) => t.id);
    const active = tabs.find((t) => t.id === this.plugin.activeTabId(this.tabIds)) ?? tabs[0];
    const scroll = this.contentEl.scrollTop;
    this.unloadTiles();
    this.contentEl.empty();
    this.applyBreakpoint();

    const page = this.contentEl.createDiv({ cls: "vd-page" });
    this.renderMasthead(page, tabs, active);

    const grid = page.createDiv({ cls: "vd-grid" });
    const today = isoDate();
    for (const spec of active.tiles) {
      const type = TILES[spec.tile];
      const tile = grid.createDiv({ cls: `vd-tile vd-tile-${spec.tile}` });
      tile.style.setProperty("--vd-span", String(spec.span ?? 12));
      if (!type) {
        tile.createDiv({ cls: "vd-empty", text: `Unknown tile “${spec.tile}”` });
        continue;
      }
      if (!spec.bare) {
        const head = tile.createDiv({ cls: "vd-tile-head" });
        head.createEl("h2", { cls: "vd-tile-title", text: type.title });
      } else tile.addClass("is-bare");
      const body = tile.createDiv({ cls: "vd-tile-body" });
      if (spec.height) body.style.maxHeight = `${spec.height}px`;

      const comp = new Component();
      comp.load();
      this.tileComponents.push(comp);
      let hidden = false;
      const ctx: TileContext = {
        app: this.app,
        plugin: this.plugin,
        component: comp,
        spec,
        today,
        tabId: active.id,
        tabIds: this.tabIds,
        rerender: () => void this.render(),
        hideTile: () => {
          hidden = true;
        },
        setTab: (id) => this.plugin.setTab(id),
      };
      try {
        await type.render(body, ctx);
      } catch (e) {
        console.error(`[vault-digest] tile ${spec.tile} failed`, e);
        body.empty();
        body.createDiv({ cls: "vd-empty", text: "This tile failed to render. See the console." });
      }
      if (hidden) tile.remove(); // e.g. a notices tile with nothing in it
    }
    this.hasBar = active.tiles.some((t) => t.tile === "capture");
    this.selbar = page.createDiv({ cls: "vd-selbar" });
    this.paintSelection();
    this.contentEl.scrollTop = scroll;
    if (this.focusCaptureAfter) {
      this.focusCaptureAfter = false;
      this.contentEl.querySelector<HTMLInputElement>(".vd-capture-input")?.focus();
    }
  }

  /** Highlight what's selected, and show a pill with the next step on tabs that have no command bar. */
  private paintSelection() {
    const sel = this.plugin.intent.selection;
    this.contentEl.querySelectorAll<HTMLElement>("[data-vd-key]").forEach((el) => el.toggleClass("is-selected", sel.has(el.dataset.vdKey ?? "")));
    const bar = this.selbar;
    if (!bar) return;
    bar.empty();
    if (!sel.size || this.hasBar) return void bar.removeClass("is-on");
    bar.addClass("is-on");
    bar.createSpan({ text: `${sel.size} selected` });
    bar.createEl("button", { text: "Instruct…", cls: "mod-cta vd-btn-cta" }).addEventListener("click", () => this.plugin.openCommandBar());
    bar.createEl("button", { text: "Clear", cls: "vd-btn" }).addEventListener("click", () => sel.clear());
  }

  private renderMasthead(page: HTMLElement, tabs: TabSpec[], active: TabSpec) {
    const s = this.plugin.settings;
    const data = this.plugin.data;
    const st = this.plugin.store.state;
    const mast = page.createEl("header", { cls: "vd-masthead" });

    const row = mast.createDiv({ cls: "vd-mast-row" });
    const left = row.createDiv({ cls: "vd-mast-left" });
    left.createEl("h1", { cls: "vd-title", text: s.paperName });
    left.createSpan({ cls: "vd-date", text: longDate() });

    const nav = row.createDiv({ cls: "vd-mast-nav" });
    const journal = nav.createEl("a", { text: "Today’s journal" });
    journal.addEventListener("click", () => void this.openToday());
    for (const l of s.quickLinks) {
      const a = nav.createEl("a", { text: l.label });
      a.addEventListener("click", () => void openPath(this.app, normalizePath(l.path)));
    }
    const refresh = nav.createEl("button", { cls: "vd-iconbtn clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void data.recomputeAll());

    // Status strip: what the engine currently knows.
    const today = isoDate();
    const open = data.tasks.filter((t) => !t.done);
    const overdue = open.filter((t) => t.due && t.due < today).length;
    const dueToday = open.filter((t) => t.due === today).length;
    const j = data.journal;
    const strip = mast.createDiv({ cls: "vd-status" });
    const item = (label: string, cls = "") => strip.createSpan({ cls: `vd-status-item ${cls}`.trim(), text: label });
    item(
      j.todayHasContent ? "Journal today ✓" : j.todayExists ? "Journal today: empty" : "No journal today",
      j.todayHasContent ? "is-ok" : "is-warn"
    ).addEventListener("click", () => void this.openToday());
    if (j.lastContentDate && j.gapDays) item(`Last entry ${j.gapDays}d ago`, j.gapDays >= 2 ? "is-warn" : "");
    const runner = this.plugin.runner;
    const lastRun = st.runs.find((r) => r.job === "brief");
    if (runner?.current) item("Running…", "is-warn");
    else if (lastRun && isoDate(new Date(lastRun.startedAt)) === today) {
      item(
        lastRun.status === "ok" ? `Brief ✓ ${timeOfDay(new Date(lastRun.startedAt))}` : `Brief ${lastRun.status}`,
        lastRun.status === "ok" ? "is-ok" : lastRun.status === "cancelled" ? "" : "is-late"
      );
    } else if (runner) item("Brief not run today", "is-warn").addEventListener("click", () => void this.plugin.runJob("brief", "manual"));
    if (st.pending.length) item(`${st.pending.length} awaiting review`, "is-warn").addEventListener("click", () => this.plugin.setTab("assistant"));
    const newMsgs = this.plugin.data.newMessages().length;
    if (s.messagesEnabled && newMsgs) item(`${newMsgs} new message${newMsgs === 1 ? "" : "s"}`, "is-warn").addEventListener("click", () => this.plugin.setTab("inbox"));
    item(`${open.length} open`);
    item(`${dueToday} due today`);
    item(`${overdue} overdue`, overdue ? "is-late" : "");
    item(`Updated ${timeOfDay(new Date(data.computedAt || Date.now()))}`, "is-faint");

    if (tabs.length > 1) this.renderTabs(mast, tabs, active);
  }

  private renderTabs(mast: HTMLElement, tabs: TabSpec[], active: TabSpec) {
    const s = this.plugin.settings;
    const st = this.plugin.store.state;
    const week = st.week && st.week.date >= addDays(isoDate(), -6) ? st.week : null;
    const badges = computeBadges({
      tasks: this.plugin.data.tasks,
      today: isoDate(),
      courses: s.courses.map((c) => c.code),
      workFolders: s.workFolders,
      triagePending: st.triage.filter((t) => t.status === "pending").length,
      newMessages: this.plugin.data.newMessages().length,
      ruleViolations: week?.ruleViolations.length ?? 0,
      weekMissed: weekMissed(new Date(), st.runs),
      pendingResults: st.pending.length,
      runs: st.runs,
    });

    const bar = mast.createDiv({ cls: "vd-tabs-bar", attr: { role: "tablist" } });
    tabs.forEach((t, i) => {
      const b = bar.createEl("button", {
        cls: "vd-tabbtn" + (t.id === active.id ? " is-active" : ""),
        attr: { role: "tab", "aria-selected": String(t.id === active.id), title: i < 9 ? `Press ${i + 1}` : "" },
      });
      b.createSpan({ text: t.title });
      const badge = badges[t.id];
      if (badge) b.createSpan({ cls: `vd-badge-count is-${badge.level}`, text: String(badge.count) });
      b.addEventListener("click", () => this.plugin.setTab(t.id));
    });
  }

  /** Open today's journal, creating it through the core Daily notes command if needed. */
  private async openToday() {
    const path = this.plugin.data.journalPath(isoDate());
    if (this.app.vault.getAbstractFileByPath(path)) {
      await openPath(this.app, path);
    } else {
      // Core command applies the user's template correctly.
      (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(
        "daily-notes"
      );
    }
  }
}
