import { MarkdownView, Notice } from "obsidian";
import type VaultDigestPlugin from "../main";
import { applyOps, recordAnswer, undoAction, ApplyDeps } from "./apply";
import { interpret } from "./grammar";
import { SelectionStore } from "./selection";
import { taskSubjectFromLine, textSubject } from "./subjects";
import { AgentResult, IntentArgs, buildIntentSnapshot, resolveAgentOps } from "./agent";
import type { ActionRecord, ActionSource, Interpretation, Op, Subject, TaskSubject } from "./types";
import type { MessageNote } from "../messages/collect";
import { isoDate, timeOfDay } from "../util/dates";

/** What was open in Obsidian when the command bar was invoked. Captured first, because opening the bar moves focus. */
export interface BarContext {
  activeFile?: { path: string; name: string };
  selectedText?: string;
  /** Task lines under the cursor or in the selection. */
  cursorTasks: TaskSubject[];
}

export interface BarFlags {
  tasks?: boolean;
  text?: boolean;
  note?: boolean;
}

export type SubmitResult = { kind: "done"; action: ActionRecord } | { kind: "blocked"; message: string } | { kind: "error"; message: string };

const MAX_AUTO_ATTEMPTS = 2;
const MAX_AUTO_PER_FETCH = 5;

export class IntentService {
  readonly selection = new SelectionStore();
  /** Recent instructions, newest first, for the up arrow. */
  readonly history: string[] = [];
  private agentActions = new Map<string, ActionRecord>();
  private processing = false;

  constructor(private p: VaultDigestPlugin) {}

  private get state() {
    return this.p.store.state;
  }

  private deps(): ApplyDeps {
    return {
      writer: this.p.assistant.writer,
      fs: this.p.assistant.fs,
      state: this.state,
      today: () => isoDate(),
      now: () => new Date(),
      uuid: () => crypto.randomUUID(),
      record: (w) => this.p.assistant.recordWrite(w),
    };
  }

  private grammarCtx() {
    return { today: isoDate(), courses: this.p.settings.courses.map((c) => c.code), calAliases: Object.keys(this.p.settings.calendarAliases ?? {}) };
  }

  // ── Context ───────────────────────────────────────────────────────────────

  captureContext(): BarContext {
    const view = this.p.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || !file) return { cursorTasks: [] };
    const ed = view.editor;
    const from = ed.getCursor("from").line;
    const to = ed.getCursor("to").line;
    const cursorTasks: TaskSubject[] = [];
    for (let l = from; l <= to && l - from < 20; l++) {
      const s = taskSubjectFromLine(file.path, l, ed.getLine(l));
      if (s) cursorTasks.push(s);
    }
    const sel = ed.getSelection().trim();
    return { activeFile: { path: file.path, name: file.basename }, selectedText: sel && !cursorTasks.length ? sel : undefined, cursorTasks };
  }

  /** What the instruction is about: the dashboard selection, else tasks under the editor cursor, else highlighted text. */
  subjectsFor(ctx: BarContext, flags: BarFlags = {}): { subjects: Subject[]; implicit: boolean } {
    if (this.selection.size) return { subjects: [...this.selection.all], implicit: false };
    if (flags.tasks !== false && ctx.cursorTasks.length) return { subjects: ctx.cursorTasks, implicit: true };
    if (flags.text !== false && ctx.selectedText) return { subjects: [textSubject(ctx.selectedText, ctx.activeFile?.path)], implicit: true };
    return { subjects: [], implicit: false };
  }

  /** The grammar's reading, for the live preview. Free and instant. */
  preview(input: string, subjects: Subject[], implicit = false): Interpretation {
    const g = interpret(input, subjects, this.grammarCtx());
    return this.retryWithout(g, input, subjects, implicit);
  }

  /**
   * Tasks under the editor cursor are only a guess at what you mean. If the words make no sense about them
   * ("buy milk"), read them as a new task instead of asking the agent.
   */
  private retryWithout(g: Interpretation, input: string, subjects: Subject[], implicit: boolean): Interpretation {
    if (g.kind === "agent" && g.reason === "unrecognised" && implicit && subjects[0]?.type === "task") {
      const bare = interpret(input, [], this.grammarCtx());
      if (bare.kind === "ops") return bare;
    }
    return g;
  }

  // ── Running an instruction ────────────────────────────────────────────────

  async submit(input: string, ctx: BarContext, flags: BarFlags = {}): Promise<SubmitResult> {
    const text = input.trim();
    if (!text) return { kind: "error", message: "Type an instruction first." };
    const { subjects, implicit } = this.subjectsFor(ctx, flags);
    const source: ActionSource = implicit ? "editor" : "bar";
    const g = this.preview(text, subjects, implicit);
    this.remember(text);

    try {
      if (g.kind === "blocked") return { kind: "blocked", message: g.message };
      if (g.kind === "ops") {
        // If the grammar fell back to "no subjects", the action is about nothing in particular.
        const used = g.ops.some((o) => o.k === "task.patch" || o.k === "message.status") ? subjects : [];
        const action = await applyOps(this.deps(), g.ops, { source, input: text, subjects: used, interpreter: "grammar", summary: g.summary });
        await this.afterWrite(subjects);
        return { kind: "done", action };
      }
      const args: IntentArgs = { input: g.kind === "question" ? g.text : text, origin: source === "editor" ? "editor" : "bar", subjects, activeNote: flags.note === false ? undefined : ctx.activeFile };
      const action = await this.askAgent(args, source);
      await this.afterWrite(subjects);
      return { kind: "done", action };
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    }
  }

  private remember(text: string) {
    const i = this.history.indexOf(text);
    if (i >= 0) this.history.splice(i, 1);
    this.history.unshift(text);
    this.history.length = Math.min(this.history.length, 30);
  }

  private async afterWrite(subjects: Subject[]) {
    if (subjects.length && this.selection.size) this.selection.clear();
    await this.p.store.save();
    this.p.data.trigger("change");
  }

  /** The model works out what the grammar couldn't, given your subjects. Its operations are validated before anything is written. */
  private async askAgent(args: IntentArgs, source: ActionSource): Promise<ActionRecord> {
    if (!this.p.runner) await this.p.setupRunner();
    const runner = this.p.runner;
    if (!runner) throw new Error(`The agent isn't available: ${this.p.runnerError || "the runner didn't start."}`);
    const run = await runner.run("intent", "manual", { ...args, _source: source });
    this.p.data.trigger("change");
    if (run.status !== "ok") throw new Error(run.status === "cancelled" ? "Cancelled." : (run.error ?? "The agent didn't finish."));
    const action = this.agentActions.get(run.id);
    this.agentActions.delete(run.id);
    if (!action) throw new Error("The agent returned nothing to apply.");
    return action;
  }

  /** The intent job's apply step: validate the model's operations against your subjects, then write them. */
  async applyAgent(result: unknown, runId: string, args: (IntentArgs & { _source?: ActionSource }) | undefined): Promise<void> {
    if (!args) throw new Error("missing instruction");
    const r = result as AgentResult;
    const p = this.p;
    const source: ActionSource = args._source ?? (args.origin === "telegram" ? "telegram" : "bar");
    const { ops, rejected } = resolveAgentOps(r, {
      subjects: args.subjects,
      tasks: p.data.tasks,
      today: isoDate(),
      newMessages: new Set(p.data.newMessages().map((m) => m.path)),
      announcementIds: new Set(p.allAnnouncements().map((a) => a.id)),
      radar: this.state.radar,
      originMessage: args.originMessage?.path,
    });
    const meta = { source, input: args.input, subjects: args.subjects, interpreter: "agent" as const, summary: r.summary || (ops.length ? "Done" : "Answered"), reply: r.reply || undefined };
    const action = ops.length ? await applyOps(this.deps(), ops, meta) : recordAnswer(this.deps(), meta);
    for (const why of rejected) action.ops.push({ ok: false, summary: "Not applied", error: why });
    if (rejected.length && action.status === "answered") action.status = "failed";
    this.agentActions.set(runId, action);
  }

  /** What the intent job is given. */
  snapshot(args: IntentArgs) {
    const now = new Date();
    return buildIntentSnapshot({
      args,
      tasks: this.p.data.tasks,
      newMessages: this.p.data.newMessages(),
      announcements: this.p.allAnnouncements(),
      radar: this.state.radar,
      courses: this.p.settings.courses,
      today: isoDate(now),
      weekday: new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long" }).format(now),
      time: timeOfDay(now),
    });
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  async undo(id: string): Promise<{ undone: number; skipped: string[] }> {
    const action = this.state.actions.find((a) => a.id === id);
    if (!action) return { undone: 0, skipped: ["that action is no longer in the history"] };
    const r = await undoAction(this.deps(), action);
    action.undoNote = r.skipped.length ? `Left ${r.skipped.length} change${r.skipped.length === 1 ? "" : "s"} alone because the file had changed: ${r.skipped.join("; ")}` : undefined;
    await this.p.store.save();
    this.p.data.trigger("change");
    return r;
  }

  // ── Messages from your phone go through the same pipeline ──────────────────

  /** Process new messages one at a time, oldest first. Anything that fails stays "new" for the brief and close to pick up. */
  async processMessages(): Promise<void> {
    if (!this.p.settings.messagesAutoProcess || this.processing) return;
    this.processing = true;
    try {
      const fresh = this.p.data
        .newMessages()
        .sort((a, b) => a.received.localeCompare(b.received))
        .filter((m) => (this.state.messages.attempts[`intent:${m.path}`] ?? 0) < MAX_AUTO_ATTEMPTS)
        .slice(0, MAX_AUTO_PER_FETCH);
      for (const m of fresh) await this.processOne(m);
    } finally {
      this.processing = false;
      await this.p.store.save();
      this.p.data.trigger("change");
    }
  }

  private async processOne(m: MessageNote) {
    const key = `intent:${m.path}`;
    const text = m.text.trim();
    if (!text) return;
    try {
      // "task buy milk friday" needs no model.
      const prefix = /^(?:task|todo|to-do|remind me(?: to)?)\b[:\s-]*(.+)$/is.exec(m.excerpt);
      if (prefix) {
        const g = interpret(prefix[1], [], this.grammarCtx());
        if (g.kind === "ops") {
          await applyOps(this.deps(), [...g.ops, { k: "message.status", path: m.path, status: "actioned", summary: "made a task" } as Op], { source: "telegram", input: m.excerpt, subjects: [], interpreter: "grammar", summary: g.summary });
          return;
        }
      }
      const args: IntentArgs = { input: text, origin: "telegram", subjects: [], originMessage: { path: m.path, kind: m.kind, attachments: m.attachments } };
      await this.askAgent(args, "telegram");
    } catch (e) {
      this.state.messages.attempts[key] = (this.state.messages.attempts[key] ?? 0) + 1;
      console.warn("[vault-digest] couldn't process a message automatically", (e as Error).message);
    }
  }

  notice(msg: string) {
    new Notice(msg, 6000);
  }
}
