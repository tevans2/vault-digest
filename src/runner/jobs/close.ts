import type { Schema } from "../validate";
import type { Task } from "../../engine/collectors/tasks";
import type { RadarRow } from "../../engine/collectors/radar";
import { TASK_OP, MESSAGE_DISPOSITION, MessageSnapshot } from "./brief";

const CLOSE_TASK_OP: Schema = {
  ...TASK_OP,
  properties: {
    ...TASK_OP.properties,
    op: { type: "string", enum: ["create", "redate", "complete"] },
    doneDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
};

export const CLOSE_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "notes", "rawEdits", "taskOps", "announcements", "messages"],
  properties: {
    summary: { type: "string", maxLength: 400 },
    notes: { type: "string", maxLength: 2500 },
    rawEdits: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["find", "replace"],
        properties: { find: { type: "string", maxLength: 200 }, replace: { type: "string", maxLength: 200 } },
      },
    },
    taskOps: { type: "array", maxItems: 10, items: CLOSE_TASK_OP },
    messages: { type: "array", maxItems: 20, items: MESSAGE_DISPOSITION },
    announcements: {
      type: "array",
      maxItems: 5,
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
  },
};

export const CLOSE_TOOLS = [
  "ToolSearch",
  "Read",
  "Grep",
  "Glob",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__search_events",
];

export interface CloseForm {
  done: string;
  waiting: string;
  other: string;
}

export interface CloseSnapshotInput {
  date: string;
  tomorrow: string;
  weekday: string;
  time: string;
  /** Everything below the RAW boundary, including the form answers just appended. */
  rawText: string;
  form: CloseForm;
  tasks: Task[];
  radar: RadarRow[];
  courses: { code: string; title: string }[];
  messages?: MessageSnapshot;
}

const slim = (t: Task) => ({ text: t.text.slice(0, 160), due: t.due, file: t.path, line: t.line + 1, waiting: t.waiting || undefined });

export function buildCloseSnapshot(i: CloseSnapshotInput) {
  const open = i.tasks.filter((t) => !t.done);
  return {
    courses: i.courses,
    form: i.form,
    rawToday: i.rawText.length > 6000 ? i.rawText.slice(-6000) : i.rawText,
    tasks: {
      completedToday: i.tasks.filter((t) => t.done && t.doneDate === i.date).slice(0, 25).map(slim),
      overdue: open.filter((t) => t.due && t.due < i.date).slice(0, 25).map(slim),
      dueToday: open.filter((t) => t.due === i.date).slice(0, 25).map(slim),
      dueTomorrow: open.filter((t) => t.due === i.tomorrow).slice(0, 25).map(slim),
      waiting: open.filter((t) => t.waiting).slice(0, 10).map(slim),
    },
    radar: i.radar.slice(0, 8).map((r) => ({
      name: r.name,
      due: r.dueText,
      weightPercent: r.weight ?? null,
      hoursLeft: r.hoursLeft !== undefined ? Math.round(r.hoursLeft) : null,
    })),
    ...(i.messages ? { messages: i.messages } : {}),
    now: { date: i.date, tomorrow: i.tomorrow, weekday: i.weekday, time: i.time, timezone: "Africa/Johannesburg" },
  };
}
