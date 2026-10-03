import type { Schema } from "../validate";
import type { Task } from "../../engine/collectors/tasks";
import type { RadarRow } from "../../engine/collectors/radar";
import type { Announcement } from "../../engine/collectors/announcements";

export const WEEK_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["triage", "announcements", "loadForecast", "ruleViolations"],
  properties: {
    triage: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "action", "reason"],
        properties: {
          path: { type: "string", maxLength: 300 },
          action: { type: "string", enum: ["file", "archive", "delete-empty", "keep"] },
          destination: { type: "string", maxLength: 300 },
          reason: { type: "string", maxLength: 200 },
        },
      },
    },
    announcements: {
      type: "array",
      maxItems: 6,
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
    loadForecast: { type: "string", maxLength: 1200 },
    ruleViolations: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
  },
};

/** The week job proposes only: no write tools. */
export const WEEK_TOOLS = ["Read", "Grep", "Glob"];

export interface InboxEntry {
  path: string;
  size: number;
  ctime: number;
  mtime: number;
  preview: string;
}

export interface WeekSnapshotInput {
  date: string;
  weekday: string;
  tasks: Task[];
  radar: RadarRow[];
  inbox: InboxEntry[];
  folders: string[];
  duplicates: Task[][];
  engine: Announcement[];
  courses: { code: string; title: string }[];
  mtimeOf: (path: string) => number | undefined;
  nowMs: number;
}

const DAY = 86_400_000;

export function buildWeekSnapshot(i: WeekSnapshotInput) {
  const open = i.tasks.filter((t) => !t.done);
  const next14: Record<string, number> = {};
  for (const t of open) {
    if (!t.due || t.due < i.date) continue;
    const days = Math.round((Date.parse(t.due) - Date.parse(i.date)) / DAY);
    if (days <= 14) next14[t.due] = (next14[t.due] ?? 0) + 1;
  }
  return {
    courses: i.courses,
    inbox: [...i.inbox]
      .sort((a, b) => a.ctime - b.ctime)
      .slice(0, 40)
      .map((e) => ({
        path: e.path,
        bytes: e.size,
        capturedDaysAgo: Math.round((i.nowMs - e.ctime) / DAY),
        editedDaysAgo: Math.round((i.nowMs - e.mtime) / DAY),
        preview: e.preview.slice(0, 280),
      })),
    inboxCount: i.inbox.length,
    folders: i.folders.slice(0, 80),
    tasks: {
      counts: { open: open.length, overdue: open.filter((t) => t.due && t.due < i.date).length, waiting: open.filter((t) => t.waiting).length },
      dueByDayNext14: next14,
      waiting: open
        .filter((t) => t.waiting)
        .slice(0, 12)
        .map((t) => {
          const m = i.mtimeOf(t.path);
          return { text: t.text.slice(0, 120), file: t.path, noteEditedDaysAgo: m ? Math.round((i.nowMs - m) / DAY) : null };
        }),
      duplicateGroups: i.duplicates.slice(0, 8).map((g) => g.map((t) => `${t.path}:${t.line + 1}`)),
    },
    radar: i.radar.slice(0, 10).map((r) => ({ name: r.name, due: r.dueText, weightPercent: r.weight ?? null, hoursLeft: r.hoursLeft !== undefined ? Math.round(r.hoursLeft) : null })),
    alreadyFlaggedByEngine: i.engine.map((a) => a.text),
    now: { date: i.date, weekday: i.weekday, timezone: "Africa/Johannesburg" },
  };
}
