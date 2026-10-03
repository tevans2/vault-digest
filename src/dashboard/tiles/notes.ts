import { TFile } from "obsidian";
import { TileType, empty, openPath } from "./common";
import { ago } from "../../util/dates";

function noteList(body: HTMLElement, items: { file: TFile; meta: string }[], ctx: Parameters<TileType["render"]>[1]) {
  const ul = body.createEl("ul", { cls: "vd-notes" });
  for (const { file, meta } of items) {
    const li = ul.createEl("li");
    const a = li.createEl("a", { text: file.basename, cls: "vd-note-name" });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void openPath(ctx.app, file.path, undefined, e.metaKey || e.ctrlKey);
    });
    li.createSpan({ cls: "vd-path", text: meta });
  }
}

export const weakSpots: TileType = {
  id: "weak-spots",
  title: "Weak spots",
  render(body, ctx) {
    const codes = ctx.plugin.settings.courses.map((c) => c.code);
    const hits: { file: TFile; conf: number; course: string }[] = [];
    for (const f of ctx.app.vault.getMarkdownFiles()) {
      const fm = ctx.app.metadataCache.getFileCache(f)?.frontmatter;
      const conf = Number(fm?.confidence);
      if (!fm || !Number.isFinite(conf) || conf > 2) continue;
      const course = String(fm.course ?? "");
      if (!codes.includes(course)) continue;
      hits.push({ file: f, conf, course });
    }
    hits.sort((a, b) => a.conf - b.conf || b.file.stat.mtime - a.file.stat.mtime);
    if (!hits.length) return empty(body, "No notes with confidence ≤ 2.");
    noteList(
      body,
      hits.slice(0, 12).map((h) => ({
        file: h.file,
        meta: `${"●".repeat(h.conf)}${"○".repeat(5 - h.conf)} ${h.course}`,
      })),
      ctx
    );
  },
};

export const recentInbox: TileType = {
  id: "recent-inbox",
  title: "Recent · Inbox",
  render(body, ctx) {
    const s = ctx.plugin.settings;
    const tabs = body.createDiv({ cls: "vd-tabs" });
    const content = body.createDiv();
    const files = ctx.app.vault.getMarkdownFiles();

    const views: Record<string, () => { file: TFile; meta: string }[]> = {
      Recent: () =>
        files
          .filter(
            (f) =>
              !/excalidraw/i.test(f.name) &&
              (!s.announcementsPath || !f.path.startsWith(s.announcementsPath.replace(/[^/]*$/, ""))) &&
              (!s.recentFolders.length || s.recentFolders.some((d) => f.path.startsWith(d + "/")))
          )
          .sort((a, b) => b.stat.mtime - a.stat.mtime)
          .slice(0, 10)
          .map((file) => ({ file, meta: `${ago(file.stat.mtime)} ago` })),
      Inbox: () =>
        files
          .filter(
            (f) =>
              f.path.startsWith(s.inboxFolder + "/") &&
              !f.path.startsWith(s.messagesFolder.replace(/\/+$/, "") + "/") &&
              !(s.inboxIgnore && f.path.startsWith(s.inboxIgnore + "/"))
          )
          .sort((a, b) => a.stat.ctime - b.stat.ctime)
          .slice(0, 10)
          .map((file) => ({ file, meta: `${ago(file.stat.ctime)} old` })),
    };

    let active = "Recent";
    const draw = () => {
      content.empty();
      tabs.empty();
      for (const name of Object.keys(views)) {
        const t = tabs.createEl("button", { text: name, cls: "vd-tab" + (name === active ? " is-active" : "") });
        t.addEventListener("click", () => {
          active = name;
          draw();
        });
      }
      const items = views[active]();
      if (!items.length) empty(content, "Nothing here.");
      else noteList(content, items, ctx);
    };
    draw();
  },
};
