import { TFile, normalizePath } from "obsidian";
import { TileType, empty, findByBasename, openPath, taskList } from "./common";
import { byUrgency, dueByToday, isOpen, Task } from "../../engine/collectors/tasks";

export const today: TileType = {
  id: "today",
  title: "Today",
  render(body, ctx) {
    const list = dueByToday(ctx.plugin.data.tasks, ctx.today).slice(0, 12);
    if (!list.length) return empty(body, "Nothing due or overdue.");
    taskList(body, list, ctx, { showPath: true });
  },
};

export const work: TileType = {
  id: "work",
  title: "Work",
  render(body, ctx) {
    const folders = ctx.plugin.settings.workFolders.map((f) => normalizePath(f) + "/");
    const list = ctx.plugin.data.tasks
      .filter((t) => isOpen(t) && folders.some((f) => t.path.startsWith(f)))
      .sort(byUrgency)
      .slice(0, 8);

    // CURRENT.md age badge for each work folder that has one.
    const badges = body.createDiv({ cls: "vd-badges" });
    for (const folder of folders) {
      const cur = ctx.app.vault.getAbstractFileByPath(folder + "CURRENT.md");
      if (cur instanceof TFile) {
        const days = Math.floor((Date.now() - cur.stat.mtime) / 86_400_000);
        const b = badges.createEl("a", {
          cls: "vd-chip" + (days >= 7 ? " is-today" : ""),
          text: `${folder.split("/").filter(Boolean).pop()} · CURRENT ${days}d`,
        });
        b.addEventListener("click", () => void openPath(ctx.app, cur.path));
      }
    }
    if (!badges.childElementCount) badges.remove();

    const waiting = ctx.plugin.data.tasks.filter((t) => isOpen(t) && t.waiting);
    if (!list.length) empty(body, "No open work tasks.");
    else taskList(body, list, ctx);
    if (waiting.length) body.createDiv({ cls: "vd-dateline", text: `${waiting.length} waiting on others` });
  },
};

export const courses: TileType = {
  id: "courses",
  title: "Courses",
  render(body, ctx) {
    if (!ctx.plugin.settings.courses.length) return empty(body, "No courses yet. Add them in Settings → Vault Digest (one per line as CODE | Title).");
    const grid = body.createDiv({ cls: "vd-cards" });
    if (ctx.spec.cols) grid.style.setProperty("--vd-cols", String(ctx.spec.cols));
    for (const c of ctx.plugin.settings.courses) {
      const card = grid.createDiv({ cls: "vd-card" });
      const head = card.createDiv({ cls: "vd-card-head" });
      const hub = findByBasename(ctx.app, `${c.code} Course Hub`);
      const title = head.createEl("a", { cls: "vd-card-title", text: c.code });
      if (c.title) head.createSpan({ cls: "vd-card-sub", text: c.title });
      if (hub) title.addEventListener("click", () => void openPath(ctx.app, hub.path));
      const re = new RegExp(`^\\W*${c.code}`);
      const tasks: Task[] = ctx.plugin.data.tasks
        .filter((t) => isOpen(t) && t.due && (t.path.includes(c.code) || re.test(t.text)))
        .sort(byUrgency)
        .slice(0, 3);
      if (!tasks.length) card.createDiv({ cls: "vd-empty", text: "No dated tasks." });
      else taskList(card, tasks, ctx);
    }
  },
};
