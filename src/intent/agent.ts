import type { Schema } from "../runner/validate";
import type { Task } from "../engine/collectors/tasks";
import type { MessageNote } from "../messages/collect";
import type { Announcement } from "../engine/collectors/announcements";
import type { RadarItem } from "../state/schema";
import { isValidIso, validateOps } from "../writers/tasks";
import { taskSubject } from "./subjects";
import type { Op, Priority, Subject, TaskPatch, TaskSubject } from "./types";

/**
 * The agent fallback for instructions the grammar can't read. The model is handed the *subjects you pointed
 * at*, with their real fields, and returns operations. The plugin validates every one: the model cannot
 * choose a target you didn't give it, touch a message that isn't new, or create a duplicate task.
 */

export const INTENT_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "reply", "ops"],
  properties: {
    summary: { type: "string", maxLength: 160 },
    reply: { type: "string", maxLength: 900 },
    messageStatus: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary"],
      properties: { status: { type: "string", enum: ["actioned", "acknowledged", "ignored"] }, summary: { type: "string", maxLength: 160 } },
    },
    ops: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["k"],
        properties: {
          k: { type: "string", enum: ["task.patch", "task.create", "message.status", "announcement.ack", "announcement.snooze", "radar.patch", "radar.remove"] },
          /** Index into the subjects you were given. Preferred whenever there is one. */
          target: { type: "integer" },
          /** Otherwise: a path (tasks, messages) or an id (announcements, radar) from the candidates. */
          ref: { type: "string", maxLength: 300 },
          line: { type: "integer" },
          due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          clearDue: { type: "boolean" },
          taskStatus: { type: "string", enum: ["done", "cancelled", "open"] },
          statusDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          priority: { type: "string", enum: ["highest", "high", "medium", "low", "lowest", "none"] },
          addTags: { type: "array", maxItems: 4, items: { type: "string", maxLength: 24 } },
          removeTags: { type: "array", maxItems: 4, items: { type: "string", maxLength: 24 } },
          mention: { type: "string", maxLength: 40 },
          text: { type: "string", maxLength: 200 },
          createDue: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          /** HH:MM or HH:MM-HH:MM (24 hour), for a task that happens at a particular time. */
          time: { type: "string", pattern: "^\\d{2}:\\d{2}(-\\d{2}:\\d{2})?$" },
          /** true puts the task on Google Calendar, false takes it off. Only for things with a fixed time or a hard commitment. */
          onCalendar: { type: "boolean" },
          calendarAlias: { type: "string", maxLength: 24 },
          course: { type: "string", maxLength: 12 },
          messageStatus: { type: "string", enum: ["actioned", "acknowledged", "ignored"] },
          summary: { type: "string", maxLength: 160 },
          snoozeDays: { type: "integer" },
          weight: { type: "number" },
          radarDue: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$" },
          name: { type: "string", maxLength: 100 },
        },
      },
    },
  },
};

/** Read-only: it may look things up in the vault, nothing more. */
export const INTENT_TOOLS = ["Read", "Grep", "Glob"];

export type IntentOrigin = "bar" | "telegram" | "editor";

export interface IntentArgs {
  input: string;
  origin: IntentOrigin;
  subjects: Subject[];
  activeNote?: { path: string; name: string };
  /** For a Telegram message: the note it arrived as, so the model can say what became of it. */
  originMessage?: { path: string; kind: string; attachments: string[] };
}

export interface IntentSnapshotInput {
  args: IntentArgs;
  tasks: Task[];
  newMessages: MessageNote[];
  announcements: Announcement[];
  radar: RadarItem[];
  courses: { code: string; title: string }[];
  today: string;
  weekday: string;
  time: string;
}

const slimTask = (t: Task) => ({ file: t.path, line: t.line + 1, text: t.text.slice(0, 140), due: t.due, waiting: t.waiting || undefined });

export function buildIntentSnapshot(i: IntentSnapshotInput) {
  const { args } = i;
  const pointed = args.subjects.length > 0;
  const open = i.tasks.filter((t) => !t.done);
  const soon = (t: Task) => !t.due || t.due <= new Date(Date.parse(i.today + "T00:00:00Z") + 21 * 86_400_000).toISOString().slice(0, 10);
  // With a selection the model should use it, so the candidate list is short. Without one it must find the target itself.
  const candidates = open.filter(soon).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9")).slice(0, pointed ? 12 : 60);
  return {
    instruction: args.input,
    origin: args.origin,
    subjects: args.subjects.map((s, index) => ({ index, ...describeSubject(s) })),
    activeNote: args.activeNote,
    originMessage: args.originMessage,
    candidates: {
      tasks: candidates.map(slimTask),
      newMessages: i.newMessages.slice(0, 10).map((m) => ({ path: m.path, kind: m.kind, text: m.excerpt })),
      announcements: i.announcements.slice(0, 10).map((a) => ({ id: a.id, level: a.level, text: a.text.slice(0, 160) })),
      radar: i.radar.slice(0, 10).map((r) => ({ id: r.id, name: r.name, due: r.due, weight: r.weight })),
    },
    courses: i.courses,
    now: { date: i.today, weekday: i.weekday, time: i.time, timezone: "Africa/Johannesburg" },
  };
}

function describeSubject(s: Subject): Record<string, unknown> {
  if (s.type === "task") return { type: "task", file: s.path, line: s.line + 1, text: s.raw.trim(), due: s.due, waiting: s.waiting };
  if (s.type === "message") return { type: "message", path: s.path, kind: s.kind, text: s.excerpt };
  if (s.type === "announcement") return { type: "announcement", id: s.id, level: s.level, text: s.label };
  if (s.type === "radar") return { type: "radar", id: s.id, name: s.label, due: s.due, weight: s.weight, editable: s.editable };
  if (s.type === "event") return { type: "event", title: s.title, start: s.start, end: s.end, editable: false };
  return { type: "text", text: s.text, fromNote: s.sourcePath };
}

// ── Result → validated ops ──────────────────────────────────────────────────

export interface AgentOp {
  k: string;
  target?: number;
  ref?: string;
  line?: number;
  due?: string;
  clearDue?: boolean;
  taskStatus?: "done" | "cancelled" | "open";
  statusDate?: string;
  priority?: Priority;
  addTags?: string[];
  removeTags?: string[];
  mention?: string;
  text?: string;
  createDue?: string;
  time?: string;
  onCalendar?: boolean;
  calendarAlias?: string;
  course?: string;
  messageStatus?: "actioned" | "acknowledged" | "ignored";
  summary?: string;
  snoozeDays?: number;
  weight?: number;
  radarDue?: string;
  name?: string;
}

export interface AgentResult {
  summary: string;
  reply: string;
  ops: AgentOp[];
  messageStatus?: { status: "actioned" | "acknowledged" | "ignored"; summary: string };
}

export interface ResolveCtx {
  subjects: Subject[];
  tasks: Task[];
  today: string;
  /** Paths of messages that are really new. */
  newMessages: Set<string>;
  announcementIds: Set<string>;
  /** Authored radar ids only. */
  radar: RadarItem[];
  originMessage?: string;
}

export const MAX_AGENT_OPS = 10;

export function resolveAgentOps(r: AgentResult, c: ResolveCtx): { ops: Op[]; rejected: string[] } {
  const ops: Op[] = [];
  const rejected: string[] = [];
  const creates: Extract<Op, { k: "task.create" }>[] = [];
  const open = c.tasks.filter((t) => !t.done);
  const bad = (m: string) => void rejected.push(m);

  const taskFor = (o: AgentOp): TaskSubject | null => {
    if (o.target !== undefined) {
      const s = c.subjects[o.target];
      return s?.type === "task" ? s : null;
    }
    const t = open.find((x) => x.path === o.ref && o.line !== undefined && x.line + 1 === o.line);
    return t ? taskSubject(t) : null;
  };

  for (const o of r.ops.slice(0, MAX_AGENT_OPS)) {
    const where = o.ref ?? (o.target !== undefined ? `selection #${o.target + 1}` : "");
    if (o.k === "task.patch") {
      const subject = taskFor(o);
      if (!subject) {
        bad(`${o.k} ${where}: not one of your tasks`);
        continue;
      }
      const patch: TaskPatch = {};
      if (o.clearDue) patch.due = null;
      else if (o.due !== undefined) {
        if (!isValidIso(o.due)) {
          bad(`${o.k}: “${o.due}” is not a real date`);
          continue;
        }
        patch.due = o.due;
      }
      if (o.taskStatus) {
        patch.status = o.taskStatus;
        const date = o.statusDate ?? c.today;
        if (!isValidIso(date) || date > c.today) {
          bad(`${o.k}: ${date} isn't a real date in the past`);
          continue;
        }
        patch.statusDate = date;
      }
      if (o.priority) patch.priority = o.priority;
      if (o.addTags?.length) patch.addTags = o.addTags.map((t) => t.replace(/^#/, "").replace(/[^\p{L}\p{N}_/-]/gu, "")).filter(Boolean);
      if (o.removeTags?.length) patch.removeTags = o.removeTags.map((t) => t.replace(/^#/, "")).filter(Boolean);
      if (o.mention) patch.mention = o.mention;
      if (o.text) patch.text = o.text;
      if (o.time) patch.time = o.time;
      if (o.onCalendar !== undefined) patch.calendar = o.onCalendar ? o.calendarAlias || true : false;
      if (!Object.keys(patch).length) bad(`${o.k} ${where}: nothing to change`);
      else ops.push({ k: "task.patch", subject, patch });
    } else if (o.k === "task.create") {
      if (!o.text?.trim()) bad("task.create: no text");
      else if (o.createDue !== undefined && !isValidIso(o.createDue)) bad(`task.create: “${o.createDue}” is not a real date`);
      else creates.push({ k: "task.create", text: o.text.trim(), due: o.createDue, course: o.course, time: o.time, calendar: o.onCalendar ? o.calendarAlias || true : undefined });
    } else if (o.k === "message.status") {
      const path = o.target !== undefined ? (c.subjects[o.target]?.type === "message" ? (c.subjects[o.target] as { path: string }).path : undefined) : o.ref;
      if (!path || !c.newMessages.has(path)) bad(`message.status ${where}: not a new message`);
      else if (!o.messageStatus) bad("message.status: no status");
      else ops.push({ k: "message.status", path, status: o.messageStatus, summary: o.summary });
    } else if (o.k === "announcement.ack" || o.k === "announcement.snooze") {
      const sub = o.target !== undefined ? c.subjects[o.target] : undefined;
      const id = sub?.type === "announcement" ? sub.id : o.ref;
      if (!id || !c.announcementIds.has(id)) bad(`${o.k} ${where}: not a current announcement`);
      else if (o.k === "announcement.ack") ops.push({ k: "announcement.ack", id });
      else {
        const days = Math.min(Math.max(o.snoozeDays ?? 1, 1), 30);
        const until = new Date(Date.parse(`${c.today}T06:00:00+02:00`) + days * 86_400_000).toISOString();
        ops.push({ k: "announcement.snooze", id, until });
      }
    } else if (o.k === "radar.patch" || o.k === "radar.remove") {
      const sub = o.target !== undefined ? c.subjects[o.target] : undefined;
      const id = sub?.type === "radar" ? sub.id : o.ref;
      if (!id || !c.radar.some((x) => x.id === id)) bad(`${o.k} ${where}: not an editable deadline`);
      else if (o.k === "radar.remove") ops.push({ k: "radar.remove", id });
      else {
        const patch: { due?: string; weight?: number; name?: string } = {};
        if (o.radarDue) patch.due = o.radarDue;
        if (o.weight !== undefined) patch.weight = o.weight;
        if (o.name) patch.name = o.name;
        if (Object.keys(patch).length) ops.push({ k: "radar.patch", id, patch });
        else bad(`radar.patch ${where}: nothing to change`);
      }
    } else bad(`${o.k}: not an operation this can do`);
  }

  // New tasks go through the same duplicate and prose-date checks as every other write.
  const checked = validateOps(creates.map((x) => ({ op: "create" as const, text: x.text, due: x.due })), { today: c.today, openTasks: open });
  checked.forEach((v, i) => {
    if (v.verdict === "reject") bad(`task.create “${creates[i].text.slice(0, 40)}”: ${v.reason}`);
    else if (v.verdict === "drop") bad(`task.create “${creates[i].text.slice(0, 40)}”: ${v.reason}`);
    else if (v.converted?.op === "redate") {
      const cv = v.converted;
      const t = open.find((x) => x.path === cv.ref.path && x.raw === cv.ref.expectedText);
      if (t) ops.push({ k: "task.patch", subject: taskSubject(t), patch: { due: cv.due } });
    } else ops.push(creates[i]);
  });

  if (c.originMessage && r.messageStatus && c.newMessages.has(c.originMessage)) {
    ops.push({ k: "message.status", path: c.originMessage, status: r.messageStatus.status, summary: r.messageStatus.summary });
  }
  return { ops, rejected };
}
