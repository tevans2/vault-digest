import { Notice, TFile, moment, normalizePath } from "obsidian";
import type VaultDigestPlugin from "./main";
import { ObsidianFs } from "./writers/obsidian-fs";
import { VaultWriter } from "./writers/writer";
import type { JobId, PendingResult, WriteRecord } from "./state/schema";
import { MAX_WRITES } from "./state/schema";
import type { JobDef } from "./runner/runner";
import { hasCalendar, type Provider } from "./runner/provider";
import { providerNote } from "./runner/prompts";
import { BRIEF_SCHEMA, BRIEF_TOOLS, buildBriefSnapshot } from "./runner/jobs/brief";
import { INTENT_SCHEMA, INTENT_TOOLS, IntentArgs } from "./intent/agent";
import { CLOSE_SCHEMA, CLOSE_TOOLS, buildCloseSnapshot, CloseForm } from "./runner/jobs/close";
import { WEEK_SCHEMA, WEEK_TOOLS, buildWeekSnapshot } from "./runner/jobs/week";
import { ApplyError, ExecDeps, ExecReport, approveTriage, applyWeek, executeBrief, executeClose } from "./runner/jobs/execute";
import { BriefResult, CloseResult, PlanLine, TriageCtx, WeekResult, planBrief, planClose } from "./runner/jobs/plan";
import { parseCapture, Capture } from "./writers/capture";
import { setMessageStatus } from "./messages/ingest";
import type { MessageSnapshot } from "./runner/jobs/brief";
import { completeLine } from "./engine/collectors/tasks";
import type { Task } from "./engine/collectors/tasks";
import { addDays, isoDate, timeOfDay } from "./util/dates";

const weekday = (d: Date) => new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long" }).format(d);

/** Everything the plugin does to the vault, in one place: jobs, writes, capture, triage. */
export class Assistant {
  readonly fs: ObsidianFs;
  readonly writer: VaultWriter;
  private saveTimer: number | null = null;

  constructor(private p: VaultDigestPlugin) {
    this.fs = new ObsidianFs(p.app);
    this.writer = new VaultWriter(this.fs, {
      journalPath: (iso) => p.data.journalPath(iso),
      templatePath: () => p.data.journalTemplatePath(),
      format: (iso, f) => (moment as unknown as (s: string, f: string) => { format(f: string): string })(iso, "YYYY-MM-DD").format(f),
      journalName: (iso) => (p.data.journalPath(iso).split("/").pop() ?? "").replace(/\.md$/, ""),
      courseHub: (code) => this.courseHub(code),
      record: (rec) => this.record(rec),
      now: () => new Date(),
      uuid: () => crypto.randomUUID(),
    });
  }

  private get state() {
    return this.p.store.state;
  }

  /** Every write is logged with hashes; saves are batched so a busy brief writes state once. */
  recordWrite(rec: WriteRecord) {
    this.record(rec);
  }

  private record(rec: WriteRecord) {
    this.state.writes.unshift(rec);
    this.state.writes.length = Math.min(this.state.writes.length, MAX_WRITES);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.p.store.save();
      this.p.data.trigger("change");
    }, 300);
  }

  /** A course's hub note, if it has a Tasks heading to append to. */
  courseHub(code: string): string | null {
    const f = this.p.app.vault.getMarkdownFiles().find((x) => x.basename === `${code} Course Hub`);
    if (!f) return null;
    const heads = this.p.app.metadataCache.getFileCache(f)?.headings ?? [];
    return heads.some((h) => /^tasks\b/i.test(h.heading)) ? f.path : null;
  }

  private deps(): ExecDeps {
    return {
      writer: this.writer,
      state: this.state,
      tasks: () => this.p.data.tasks,
      now: () => new Date(),
      messages: {
        newPaths: () => new Set(this.p.data.newMessages().map((m) => m.path)),
        mark: (path, status, by, summary) =>
          setMessageStatus({ fs: this.fs, record: (r) => this.record(r), now: () => new Date(), uuid: () => crypto.randomUUID() }, path, status, { by, date: isoDate(), summary }),
      },
    };
  }

  /** New messages from the phone for the brief and close snapshots: the oldest first, so they clear in order. */
  messageSnapshot(): MessageSnapshot | undefined {
    if (!this.p.settings.messagesEnabled) return undefined;
    const all = this.p.data.newMessages().sort((a, b) => a.received.localeCompare(b.received));
    return {
      new: all.slice(0, 15).map((m) => ({ path: m.path, kind: m.kind, received: m.received, text: m.text, attachments: m.attachments, forwardedFrom: m.forwardedFrom })),
      moreNew: Math.max(0, all.length - 15),
    };
  }

  // ── Jobs ────────────────────────────────────────────────────────────────────

  jobs(): Record<JobId, JobDef> {
    const p = this.p;
    const common = (prompt: "brief.md" | "close.md" | "week.md" | "intent.md", withNote: boolean) => async (provider: Provider) => ({
      system: await p.readPrompt("system.md"),
      task: (await p.readPrompt(prompt)) + (withNote ? providerNote(provider, { codexCalendar: p.settings.codexCalendar }) : ""),
    });

    return {
      brief: {
        id: "brief",
        schema: BRIEF_SCHEMA,
        tools: BRIEF_TOOLS,
        writesVault: true,
        prompts: common("brief.md", true),
        snapshot: () => {
          const now = new Date();
          const today = isoDate(now);
          const st = this.state;
          return buildBriefSnapshot({
            date: today,
            weekday: weekday(now),
            time: timeOfDay(now),
            tasks: p.data.tasks,
            radar: p.data.scoredRadar(now.getTime()),
            journal: { ...p.data.journal, todayPath: p.data.journalPath(today) },
            engine: p.data.engine,
            courses: p.settings.courses,
            previous: st.brief,
            acked: Object.keys(st.interactions.acks),
            recentNotes: p.app.vault
              .getMarkdownFiles()
              .filter((f) => now.getTime() - f.stat.mtime < 7 * 86_400_000 && !f.path.startsWith("Journal/") && !/excalidraw/i.test(f.name))
              .map((f) => ({ path: f.path, mtime: f.stat.mtime })),
            nowMs: now.getTime(),
            messages: this.messageSnapshot(),
          });
        },
        apply: (result, runId) => this.applyJob("brief", result, runId),
      },

      close: {
        id: "close",
        schema: CLOSE_SCHEMA,
        tools: CLOSE_TOOLS,
        writesVault: true,
        prompts: common("close.md", true),
        snapshot: async (args) => {
          const now = new Date();
          const today = isoDate(now);
          return buildCloseSnapshot({
            date: today,
            tomorrow: addDays(today, 1),
            weekday: weekday(now),
            time: timeOfDay(now),
            rawText: await this.writer.rawText(today),
            form: (args as CloseForm | undefined) ?? { done: "", waiting: "", other: "" },
            tasks: p.data.tasks,
            radar: p.data.scoredRadar(now.getTime()),
            courses: p.settings.courses,
            messages: this.messageSnapshot(),
          });
        },
        apply: (result, runId) => this.applyJob("close", result, runId),
      },

      intent: {
        id: "intent",
        schema: INTENT_SCHEMA,
        tools: INTENT_TOOLS,
        // Quick and cheap: a few seconds and a few cents, and it applies at once (every change is undoable).
        effort: "low",
        budgetUsd: 0.2,
        timeoutMs: 120_000,
        writesVault: false,
        prompts: common("intent.md", false),
        snapshot: (args) => p.intent.snapshot(args as IntentArgs),
        apply: (result, runId, args) => p.intent.applyAgent(result, runId, args as IntentArgs),
      },

      week: {
        id: "week",
        schema: WEEK_SCHEMA,
        tools: WEEK_TOOLS,
        writesVault: false, // proposals only; files move on approval
        prompts: common("week.md", false),
        snapshot: async () => {
          const now = new Date();
          const ctx = this.triageCtx();
          const inbox = await Promise.all(
            ctx.inbox.map(async ({ path, size }) => {
              const f = p.app.vault.getAbstractFileByPath(path);
              return f instanceof TFile
                ? { path, size, ctime: f.stat.ctime, mtime: f.stat.mtime, preview: (await p.app.vault.cachedRead(f)).replace(/\s+/g, " ").slice(0, 280) }
                : { path, size, ctime: now.getTime(), mtime: now.getTime(), preview: "" };
            })
          );
          return buildWeekSnapshot({
            date: isoDate(now),
            weekday: weekday(now),
            tasks: p.data.tasks,
            radar: p.data.scoredRadar(now.getTime()),
            inbox,
            folders: [...ctx.folders].filter((f) => !f.startsWith("Journal") && !/^(Inbox\/captures)/.test(f)).sort(),
            duplicates: p.data.duplicates,
            engine: p.data.engine,
            courses: p.settings.courses,
            mtimeOf: (path) => {
              const f = p.app.vault.getAbstractFileByPath(path);
              return f instanceof TFile ? f.stat.mtime : undefined;
            },
            nowMs: now.getTime(),
          });
        },
        apply: (result, runId) => this.applyJob("week", result, runId),
      },
    };
  }

  /** Apply a validated result. Logs what happened onto the run so "View log" shows the real writes. */
  async applyJob(job: JobId, result: unknown, runId: string): Promise<void> {
    const d = this.deps();
    const today = isoDate();
    const run = this.state.runs.find((r) => r.id === runId);
    const provider = (run?.provider as Provider | undefined) ?? this.p.settings.provider;
    const note = (lines: string[]) => {
      if (!run) return;
      run.log.push(...lines.map((l) => `apply: ${l}`));
      if (run.log.length > 80) run.log.splice(0, run.log.length - 80);
    };
    try {
      let report: ExecReport;
      if (job === "brief") report = await executeBrief(d, result as BriefResult, today, runId, hasCalendar(provider, this.p.settings.codexCalendar));
      else if (job === "close") report = await executeClose(d, result as CloseResult, today, addDays(today, 1), runId);
      else report = applyWeek(d, result as WeekResult, this.triageCtx(), today, runId);
      note(report.lines);
    } catch (e) {
      if (e instanceof ApplyError) note(e.lines);
      throw e;
    } finally {
      await this.p.store.save();
      this.p.data.trigger("change");
    }
  }

  /** Apply (or preview) results that were held back by dry-run. */
  async applyPending(runId?: string): Promise<void> {
    const list = this.state.pending.filter((x) => !runId || x.runId === runId);
    for (const pend of list) {
      this.state.pending = this.state.pending.filter((x) => x.runId !== pend.runId);
      try {
        await this.applyJob(pend.job, pend.result, pend.runId);
        new Notice(`${pend.job === "brief" ? "Brief" : "Close"} applied.`);
      } catch (e) {
        new Notice(`Applied with a problem: ${(e as Error).message}`, 12_000);
      }
    }
    await this.p.store.save();
    this.p.data.trigger("change");
  }

  async discardPending(runId: string) {
    this.state.pending = this.state.pending.filter((x) => x.runId !== runId);
    await this.p.store.save();
    this.p.data.trigger("change");
  }

  /** What applying a held result would do, using the vault as it is right now. */
  async previewPending(pend: PendingResult): Promise<PlanLine[]> {
    const today = isoDate();
    const run = this.state.runs.find((r) => r.id === pend.runId);
    const provider = (run?.provider as Provider | undefined) ?? this.p.settings.provider;
    if (pend.job === "brief") return planBrief(pend.result as BriefResult, { today, tasks: this.p.data.tasks, calendarChecked: hasCalendar(provider, this.p.settings.codexCalendar), newMessages: new Set(this.p.data.newMessages().map((m) => m.path)) }).preview;
    if (pend.job === "close") return planClose(pend.result as CloseResult, { today, tasks: this.p.data.tasks, rawText: await this.writer.rawText(today), newMessages: new Set(this.p.data.newMessages().map((m) => m.path)) }).preview;
    return [];
  }

  // ── Close form ──────────────────────────────────────────────────────────────

  /** Save the user's answers into Raw (their words), then run the close job. */
  async submitClose(form: CloseForm) {
    const parts = [
      form.done.trim() && `**Done:** ${form.done.trim()}`,
      form.waiting.trim() && `**Waiting:** ${form.waiting.trim()}`,
      form.other.trim() && `**Anything else:** ${form.other.trim()}`,
    ].filter(Boolean);
    try {
      if (parts.length) await this.writer.appendRaw(isoDate(), `### Close — ${timeOfDay()}\n\n${parts.join("\n\n")}`);
    } catch (e) {
      new Notice(`Couldn't save your answers to the journal: ${(e as Error).message}`, 12_000);
      return null;
    }
    return this.p.runJob("close", "manual", form);
  }

  // ── Capture and task actions ────────────────────────────────────────────────

  parse(input: string): Capture {
    return parseCapture(input, isoDate(), this.p.settings.courses.map((c) => c.code));
  }

  /** Where a captured task would go, for the preview. */
  captureTarget(c: Capture): string {
    const hub = c.course ? this.courseHub(c.course) : null;
    return hub ?? this.p.data.journalPath(isoDate());
  }

  async capture(input: string) {
    const c = this.parse(input);
    if (!c.text) throw new Error("Nothing to add.");
    const r = await this.writer.capture(c.text, c.due, c.course, isoDate());
    new Notice(`Added to ${(r.path.split("/").pop() ?? r.path).replace(/\.md$/, "")}${c.due ? ` · due ${c.due}` : ""}`);
    return r;
  }

  /** A tick on the dashboard: stamps the real completion date and is logged like any other write. */
  async completeFromUi(t: Task) {
    try {
      await this.writer.complete({ op: "complete", ref: { path: t.path, line: t.line, expectedText: t.raw }, doneDate: isoDate() }, "user");
    } catch (e) {
      new Notice(`Couldn't complete that task: ${(e as Error).message}. Open the note to tick it.`, 8000);
    }
  }

  async replaceBoardRadar() {
    if (!this.state.radar.length) {
      new Notice("Run a brief first, so there's a live radar to show in place of the table.");
      return;
    }
    try {
      const changed = await this.writer.replaceBoardRadar(normalizePath(this.p.settings.taskBoardPath));
      new Notice(changed ? "Task Board radar table replaced with a live block." : "No radar table found to replace (already converted?).");
    } catch (e) {
      new Notice(`Couldn't update the Task Board: ${(e as Error).message}`, 8000);
    }
  }

  // ── Inbox triage ────────────────────────────────────────────────────────────

  triageCtx(): TriageCtx {
    const s = this.p.settings;
    const root = normalizePath(s.inboxFolder) + "/";
    const ignore = s.inboxIgnore ? normalizePath(s.inboxIgnore) + "/" : "\u0000";
    const messages = normalizePath(s.messagesFolder) + "/"; // the message channel has its own board
    const files = this.p.app.vault.getMarkdownFiles();
    return {
      inbox: files.filter((f) => f.path.startsWith(root) && !f.path.startsWith(ignore) && !f.path.startsWith(messages)).map((f) => ({ path: f.path, size: f.stat.size })),
      folders: new Set(this.fs.folders()),
      allPaths: new Set(files.map((f) => f.path)),
    };
  }

  async approveTriage(id: string) {
    const item = await approveTriage(this.deps(), id, this.triageCtx());
    await this.p.store.save();
    this.p.data.trigger("change");
    if (item.status === "failed") new Notice(`Couldn't do that: ${item.error}`, 8000);
  }

  async skipTriage(id: string) {
    const item = this.state.triage.find((t) => t.id === id);
    if (item && item.status === "pending") item.status = "skipped";
    await this.p.store.save();
    this.p.data.trigger("change");
  }
}
