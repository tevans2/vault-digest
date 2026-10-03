import { App, Events, TFile, normalizePath } from "obsidian";
import type { DigestSettings } from "../settings/settings";
import { parseTasks, Task } from "./collectors/tasks";
import { parseAnnouncements, AnnouncementBlock } from "./collectors/announcements";
import { parseRadar, scoreRadar, rowsFromItems, RadarRow } from "./collectors/radar";
import type { RadarItem } from "../state/schema";
import { analyzeJournal, summarizeJournal, JournalEntry, JournalSummary } from "./collectors/journal";
import { findDuplicates } from "./collectors/duplicates";
import { engineAnnouncements } from "./collectors/staleness";
import { Announcement } from "./collectors/announcements";
import { dailyNameToIso, formatDaily, isoDate } from "../util/dates";
import { MessageNote, byReceivedDesc, parseMessageNote } from "../messages/collect";

/** Derived state: rebuilt from the vault, never persisted. */
export class DigestData extends Events {
  tasks: Task[] = [];
  announcements: AnnouncementBlock = { items: [] };
  radar: RadarRow[] = [];
  /** Announcements the engine generates itself (journal gap, stale items, duplicates). */
  engine: Announcement[] = [];
  journal: JournalSummary = { todayExists: false, todayHasContent: false, gapDays: null };
  duplicates: Task[][] = [];
  /** Message notes from Inbox/messages, newest first. */
  messageNotes: MessageNote[] = [];
  computedAt = 0;
  private journalCfg = { folder: "Journal", format: "YYYYMMDD", template: "" };

  private byFile = new Map<string, Task[]>();
  private timer: number | null = null;

  constructor(private app: App, private settings: () => DigestSettings, private authoredRadar: () => RadarItem[] = () => []) {
    super();
  }

  /** Full recompute. Only reads notes the metadata cache says contain tasks. */
  async recomputeAll() {
    const next = new Map<string, Task[]>();
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.hasTasks(f));
    await Promise.all(
      files.map(async (f) => {
        const content = await this.app.vault.cachedRead(f);
        const t = parseTasks(f.path, content);
        if (t.length) next.set(f.path, t);
      })
    );
    this.byFile = next;
    await this.readNotes();
    this.finish();
  }

  /** Incremental update for a single changed file. */
  async updateFile(file: TFile) {
    if (file.extension !== "md") return;
    const s = this.settings();
    if (this.hasTasks(file)) {
      const t = parseTasks(file.path, await this.app.vault.cachedRead(file));
      if (t.length) this.byFile.set(file.path, t);
      else this.byFile.delete(file.path);
    } else {
      this.byFile.delete(file.path);
    }
    if (
      file.path === normalizePath(s.announcementsPath) ||
      file.path === normalizePath(s.taskBoardPath) ||
      this.isJournalFile(file.path)
    ) {
      await this.readNotes();
    } else if (this.isMessageFile(file.path)) {
      await this.readMessages();
    }
    this.finish();
  }

  remove(path: string) {
    if (this.byFile.delete(path)) this.finish();
  }

  /** Debounced change notification (≈750ms) so bursts of edits render once. */
  schedule(file: TFile | null, fn?: () => void) {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(async () => {
      this.timer = null;
      if (file) await this.updateFile(file);
      fn?.();
    }, 750);
  }

  private hasTasks(f: TFile): boolean {
    const c = this.app.metadataCache.getFileCache(f);
    // Cache not ready yet → assume it might.
    if (!c) return true;
    return !!c.listItems?.some((li) => li.task !== undefined);
  }

  private async readNotes() {
    const s = this.settings();
    const read = async (p: string) => {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(p));
      return f instanceof TFile ? this.app.vault.cachedRead(f) : "";
    };
    this.announcements = parseAnnouncements(await read(s.announcementsPath));
    this.radar = parseRadar(await read(s.taskBoardPath));
    await this.readJournal();
    await this.readMessages();
  }

  private messagesPrefix(): string {
    return normalizePath(this.settings().messagesFolder) + "/";
  }

  isMessageFile(path: string): boolean {
    return path.startsWith(this.messagesPrefix()) && path.endsWith(".md") && !path.endsWith("/README.md");
  }

  /** Read message notes straight from the files (the metadata cache lags right after a write). */
  async readMessages() {
    if (!this.settings().messagesEnabled && !this.messageNotes.length) return;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isMessageFile(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 400);
    const notes = await Promise.all(files.map(async (f) => parseMessageNote(f.path, await this.app.vault.cachedRead(f))));
    this.messageNotes = notes.filter((n): n is MessageNote => !!n).sort(byReceivedDesc);
  }

  newMessages(): MessageNote[] {
    return this.messageNotes.filter((m) => m.status === "new");
  }

  /** Journal folder/format: settings override, else the daily-notes core plugin config. */
  private async resolveJournalConfig() {
    const s = this.settings();
    let folder = "Journal";
    let format = "YYYYMMDD";
    let template = "";
    try {
      const cfg = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/daily-notes.json`));
      if (cfg.folder) folder = cfg.folder;
      if (cfg.format) format = cfg.format;
      if (cfg.template) template = cfg.template;
    } catch {
      /* defaults */
    }
    this.journalCfg = { folder: s.journalFolder || folder, format: s.journalFormat || format, template };
  }

  journalPath(iso: string): string {
    const { folder, format } = this.journalCfg;
    return normalizePath(`${folder}/${formatDaily(format, iso)}.md`);
  }

  /** Vault path of the daily-notes template, or null if none is configured. */
  journalTemplatePath(): string | null {
    const t = this.journalCfg.template;
    return t ? normalizePath(t.endsWith(".md") ? t : `${t}.md`) : null;
  }

  isJournalFile(path: string): boolean {
    return path.startsWith(normalizePath(this.journalCfg.folder) + "/");
  }

  private async readJournal() {
    await this.resolveJournalConfig();
    const { folder, format } = this.journalCfg;
    const prefix = normalizePath(folder) + "/";
    const dated = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ f, date: dailyNameToIso(format, f.basename) }))
      .filter((x): x is { f: TFile; date: string } => !!x.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 21); // enough to find the latest entry with content
    const entries: JournalEntry[] = await Promise.all(
      dated.map(async ({ f, date }) => ({
        date,
        path: f.path,
        ...analyzeJournal(await this.app.vault.cachedRead(f)),
      }))
    );
    this.journal = summarizeJournal(entries, isoDate());
  }

  /** Radar rows with live scores. Cheap, so callers can ask at render time. */
  scoredRadar(now = Date.now()): RadarRow[] {
    // The brief's authored radar wins; the Task Board table is the fallback until one exists.
    const authored = this.authoredRadar();
    return scoreRadar(authored.length ? rowsFromItems(authored) : this.radar, isoDate(new Date(now)), now);
  }

  private finish() {
    this.tasks = Array.from(this.byFile.values()).flat();
    this.duplicates = findDuplicates(this.tasks);
    const now = Date.now();
    this.engine = engineAnnouncements({
      today: isoDate(new Date(now)),
      now,
      tasks: this.tasks,
      journal: this.journal,
      radar: this.scoredRadar(now),
      duplicates: this.duplicates,
      mtimeOf: (p) => {
        const f = this.app.vault.getAbstractFileByPath(p);
        return f instanceof TFile ? f.stat.mtime : undefined;
      },
    });
    this.computedAt = now;
    this.trigger("change");
  }
}
