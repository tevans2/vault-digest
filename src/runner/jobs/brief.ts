import type { Schema } from "../validate";
import type { Task } from "../../engine/collectors/tasks";
import type { RadarRow } from "../../engine/collectors/radar";
import type { JournalSummary } from "../../engine/collectors/journal";
import type { Announcement } from "../../engine/collectors/announcements";
import type { BriefState } from "../../state/schema";
import { slug } from "../../engine/collectors/announcements";

const MESSAGE_DISPOSITION: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "disposition", "summary"],
  properties: {
    path: { type: "string", maxLength: 300 },
    disposition: { type: "string", enum: ["actioned", "acknowledged", "ignored"] },
    summary: { type: "string", maxLength: 200 },
  },
};

const RADAR_ITEM: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "due"],
  properties: {
    name: { type: "string", maxLength: 100 },
    due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$" },
    weight: { type: "number" },
    course: { type: "string", maxLength: 12 },
    note: { type: "string", maxLength: 160 },
  },
};

/** Flat on purpose: the plugin checks the semantics (a re-date needs file+line, a create needs text). */
export const TASK_OP: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["op", "reason"],
  properties: {
    op: { type: "string", enum: ["create", "redate"] },
    text: { type: "string", maxLength: 200 },
    due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    time: { type: "string", pattern: "^\\d{2}:\\d{2}(-\\d{2}:\\d{2})?$" },
    calendar: { type: "boolean" },
    calendarAlias: { type: "string", maxLength: 24 },
    file: { type: "string", maxLength: 300 },
    line: { type: "integer" },
    reason: { type: "string", maxLength: 200 },
  },
};

export { MESSAGE_DISPOSITION };

export const BRIEF_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["announcements", "priorities", "timeline", "notes", "missing", "carriedForward", "radar", "taskOps", "messages"],
  properties: {
    carriedForward: { type: "string", maxLength: 1500 },
    radar: { type: "array", maxItems: 12, items: RADAR_ITEM },
    taskOps: { type: "array", maxItems: 8, items: TASK_OP },
    messages: { type: "array", maxItems: 20, items: MESSAGE_DISPOSITION },
    announcements: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "level", "text"],
        properties: {
          id: { type: "string", maxLength: 60 },
          level: { type: "string", enum: ["urgent", "soon", "info", "stale"] },
          text: { type: "string", maxLength: 400 },
          topic: { type: "string", enum: ["study", "work", "week", "inbox", "assistant", "general"] },
        },
      },
    },
    priorities: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
    timeline: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "title"],
        properties: {
          start: { type: "string", pattern: "^(\\d{2}:\\d{2}|all-day)$" },
          end: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
          title: { type: "string", maxLength: 120 },
          note: { type: "string", maxLength: 200 },
        },
      },
    },
    notes: { type: "string", maxLength: 2500 },
    missing: { type: "array", maxItems: 8, items: { type: "string", maxLength: 200 } },
  },
};

/** Read-only tools only. The plugin writes; the model proposes. */
export const BRIEF_TOOLS = [
  "ToolSearch",
  "Read",
  "Grep",
  "Glob",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__search_events",
];

export interface SnapshotInput {
  date: string;
  weekday: string;
  time: string;
  tasks: Task[];
  radar: RadarRow[];
  journal: JournalSummary & { todayPath: string };
  engine: Announcement[];
  courses: { code: string; title: string }[];
  previous: BriefState | null;
  acked: string[];
  /** Notes edited recently, outside Journal/. Lets the model check "is it written down?" without a shell. */
  recentNotes: { path: string; mtime: number }[];
  nowMs?: number;
  messages?: MessageSnapshot;
}

/** New messages from the phone, oldest first. The model sees the words, not the files. */
export interface MessageSnapshot {
  new: { path: string; kind: string; received: string; text: string; attachments: string[]; forwardedFrom?: string }[];
  moreNew: number;
}

const ageLabel = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h ago` : `${Math.round(ms / 86_400_000)}d ago`);
const slim = (t: Task) => ({ text: t.text.slice(0, 160), due: t.due, file: t.path, line: t.line + 1, waiting: t.waiting || undefined });
const byDue = (a: Task, b: Task) => (a.due ?? "9").localeCompare(b.due ?? "9");

/** State → job input. Stable ordering, size-capped, date last so the prefix stays cacheable. */
export function buildBriefSnapshot(i: SnapshotInput) {
  const open = i.tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due && t.due < i.date).sort(byDue);
  const dueToday = open.filter((t) => t.due === i.date);
  const horizon = new Date(Date.parse(i.date + "T00:00:00Z") + 14 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = open.filter((t) => t.due && t.due > i.date && t.due <= horizon).sort(byDue);
  const waiting = open.filter((t) => t.waiting);

  return {
    courses: i.courses,
    journal: {
      todayPath: i.journal.todayPath,
      todayExists: i.journal.todayExists,
      lastEntryWithContent: i.journal.lastContentDate ?? null,
      gapDays: i.journal.gapDays,
      note:
        (i.journal.gapDays ?? 0) >= 2
          ? "There is a journal gap. Open and overdue items are UNVERIFIED, not proof of slippage."
          : undefined,
    },
    tasks: {
      counts: { open: open.length, overdue: overdue.length, dueToday: dueToday.length, waiting: waiting.length },
      overdue: overdue.slice(0, 25).map(slim),
      dueToday: dueToday.slice(0, 25).map(slim),
      upcoming14Days: upcoming.slice(0, 25).map(slim),
      waiting: waiting.slice(0, 10).map(slim),
    },
    radar: i.radar.slice(0, 10).map((r) => ({
      name: r.name,
      due: r.dueText,
      weightPercent: r.weight ?? null,
      hoursLeft: r.hoursLeft !== undefined ? Math.round(r.hoursLeft) : null,
      score: r.liveScore !== undefined ? Math.round(r.liveScore * 10) / 10 : null,
    })),
    recentlyEditedNotes: i.recentNotes
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40)
      .map((n) => ({ path: n.path, edited: ageLabel((i.nowMs ?? Date.now()) - n.mtime) })),
    ...(i.messages ? { messages: i.messages } : {}),
    alreadyFlaggedByEngine: i.engine.map((a) => a.text),
    previousBrief: i.previous
      ? { date: i.previous.date, announcementIds: i.previous.announcements.map((a) => a.id), acknowledged: i.acked }
      : null,
    now: { date: i.date, weekday: i.weekday, time: i.time, timezone: "Africa/Johannesburg" },
  };
}

/** Turn a validated result into the authored state. Pure, so it can be tested without a vault. */
export function applyBrief(result: unknown, date: string, now: Date = new Date()): BriefState {
  const r = result as {
    announcements: { id: string; level: Announcement["level"]; text: string; topic?: Announcement["topic"] }[];
    priorities: string[];
    timeline: BriefState["timeline"];
    notes: string;
    missing: string[];
  };
  const seen = new Set<string>();
  const announcements: Announcement[] = [];
  for (const a of r.announcements) {
    // Stable ids across runs so acks stick; dedupe within the run.
    const id = `brief:${slug(a.id) || slug(a.text)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    announcements.push({ id, level: a.level, text: a.text, source: "brief", topic: a.topic });
  }
  const timeline = [...r.timeline].sort((a, b) =>
    a.start === b.start ? 0 : a.start === "all-day" ? -1 : b.start === "all-day" ? 1 : a.start.localeCompare(b.start)
  );
  return {
    date,
    generatedAt: now.toISOString(),
    announcements,
    priorities: r.priorities,
    timeline,
    notes: r.notes.trim(),
    missing: r.missing,
  };
}
