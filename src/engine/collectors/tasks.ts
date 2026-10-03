import { addDays, daysBetween } from "../../util/dates";

export interface Task {
  path: string;
  line: number; // 0-based
  raw: string; // full original line
  text: string; // description without date/priority markers
  done: boolean;
  due?: string;
  scheduled?: string;
  start?: string;
  doneDate?: string;
  priority: number; // 0 highest .. 5 none
  tags: string[];
  waiting: boolean;
  /** Cancelled (`[-]`), as opposed to done. */
  cancelled: boolean;
  /** The Tasks plugin's own id marker (🆔). The calendar link is keyed on it. */
  id?: string;
  /** Start and end of day, from `⏰ 14:00-15:30`. */
  time?: string;
  endTime?: string;
  /** On the calendar: "" for #cal, or the alias for #cal/alias. Undefined if it isn't. */
  cal?: string;
}

const TASK_LINE = /^(\s*)([-*+])\s+\[([ xX\-/])\]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const ALLOWED_HEADING = /\b(tasks?|actions?)\b/i;
const DATE = (emoji: string) => new RegExp(`${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})`);
const PRIORITY: [string, number][] = [
  ["🔺", 0],
  ["⏫", 1],
  ["🔼", 2],
  ["🔽", 4],
  ["⏬", 5],
];

/**
 * Collect tasks from one note. Only tasks under a `## Tasks` / `## Actions`
 * heading, or tagged #task, count. Study checklists are ignored on purpose.
 */
export function parseTasks(path: string, content: string): Task[] {
  const out: Task[] = [];
  const lines = content.split("\n");
  let heading = "";
  let inFence = false;
  let inFrontmatter = lines[0]?.trim() === "---";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontmatter) {
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = HEADING.exec(line);
    if (h) {
      heading = h[1];
      continue;
    }
    const m = TASK_LINE.exec(line);
    if (!m) continue;

    const body = m[4];
    const tags = Array.from(body.matchAll(/(?:^|\s)(#[\w/-]+)/g)).map((t) => t[1]);
    const counted = ALLOWED_HEADING.test(heading) || tags.includes("#task");
    if (!counted) continue;

    const due = DATE("📅").exec(body)?.[1];
    const scheduled = DATE("⏳").exec(body)?.[1];
    const start = DATE("🛫").exec(body)?.[1];
    const doneDate = DATE("✅").exec(body)?.[1];
    const priority = PRIORITY.find(([e]) => body.includes(e))?.[1] ?? 3;

    const tm = /⏰\s*(\d{1,2}):(\d{2})(?:\s*[-–]\s*(\d{1,2}):(\d{2}))?/u.exec(body);
    const calTag = tags.map((x) => /^#cal(?:\/([\w-]+))?$/i.exec(x)).find(Boolean);
    const text = body
      .replace(/⏰\s*\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/gu, "")
      .replace(/🆔\s*[\w-]+/gu, "")
      .replace(/[📅⏳🛫✅❌➕]\s*\d{4}-\d{2}-\d{2}/gu, "")
      .replace(/[🔺⏫🔼🔽⏬🔁]️?/gu, "")
      .replace(/\s+/g, " ")
      .trim();

    out.push({
      path,
      line: i,
      raw: line,
      text,
      done: m[3] === "x" || m[3] === "X" || m[3] === "-",
      due,
      scheduled,
      start,
      doneDate,
      priority,
      tags,
      waiting: tags.includes("#waiting"),
      cancelled: m[3] === "-",
      id: /🆔\s*([\w-]+)/u.exec(body)?.[1],
      time: tm ? `${tm[1].padStart(2, "0")}:${tm[2]}` : undefined,
      endTime: tm?.[3] ? `${tm[3].padStart(2, "0")}:${tm[4]}` : undefined,
      cal: calTag ? (calTag[1] ?? "") : undefined,
    });
  }
  return out;
}

export function isOpen(t: Task): boolean {
  return !t.done;
}

/** Open tasks due on or before `today`. */
export function dueByToday(tasks: Task[], today: string): Task[] {
  return tasks
    .filter((t) => isOpen(t) && t.due && t.due <= today)
    .sort(byUrgency);
}

export function byUrgency(a: Task, b: Task): number {
  return (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.priority - b.priority;
}

export function overdueDays(t: Task, today: string): number {
  return t.due ? Math.max(0, daysBetween(t.due, today)) : 0;
}

/** Mark a task line done, stamping the real completion date. */
export function completeLine(line: string, doneDate: string): string {
  return line.replace(/\[\s\]/, "[x]").replace(/\s*$/, ` ✅ ${doneDate}`);
}

/** Re-date the 📅 marker on a line, appending one if missing. */
export function redateLine(line: string, due: string): string {
  return /📅\s*\d{4}-\d{2}-\d{2}/.test(line)
    ? line.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${due}`)
    : line.replace(/\s*$/, ` 📅 ${due}`);
}

export const tomorrow = (today: string) => addDays(today, 1);
