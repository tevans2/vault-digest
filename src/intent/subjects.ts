import { hash } from "../writers/hash";
import type { Task } from "../engine/collectors/tasks";
import type { MessageNote } from "../messages/collect";
import type { Announcement } from "../engine/collectors/announcements";
import type { RadarRow } from "../engine/collectors/radar";
import type { AnnouncementSubject, EventSubject, MessageSubject, RadarSubject, TaskSubject, TextSubject } from "./types";

/** Turn things on the dashboard into subjects. The key is stable across re-renders. */

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function taskSubject(t: Task): TaskSubject {
  return { type: "task", key: `task:${t.path}#${t.line}#${hash(t.raw)}`, label: clip(t.text), path: t.path, line: t.line, raw: t.raw, due: t.due, waiting: t.waiting || undefined };
}

/** A task line read straight from an editor (the cursor is on it). */
export function taskSubjectFromLine(path: string, line: number, raw: string): TaskSubject | null {
  const m = /^\s*[-*+]\s+\[.\]\s+(.*)$/.exec(raw);
  if (!m) return null;
  const text = m[1].replace(/[📅⏳🛫✅❌➕🔁🔺⏫🔼🔽⏬].*$/u, "").trim();
  return { type: "task", key: `task:${path}#${line}#${hash(raw)}`, label: clip(text || m[1]), path, line, raw, due: /📅\s*(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] };
}

export function messageSubject(m: MessageNote): MessageSubject {
  return { type: "message", key: `msg:${m.path}`, label: clip(m.excerpt || `(${m.kind})`), path: m.path, kind: m.kind, excerpt: m.excerpt };
}

export function announcementSubject(a: Announcement): AnnouncementSubject {
  return { type: "announcement", key: `ann:${a.id}`, label: clip(a.text.replace(/\*\*/g, "")), id: a.id, level: a.level };
}

/** `item` is the authored radar entry, which has the exact due string (with a time) that edits need. */
export function radarSubject(r: RadarRow, item?: { due: string; weight?: number }): RadarSubject {
  return { type: "radar", key: `radar:${r.id}`, label: clip(r.name), id: r.id, due: item?.due, weight: item?.weight ?? r.weight, editable: !!item };
}

export function eventSubject(e: { start: string; end?: string; title: string }): EventSubject {
  return { type: "event", key: `ev:${e.start}:${e.title}`, label: clip(e.title), start: e.start, end: e.end, title: e.title };
}

export function textSubject(text: string, sourcePath?: string): TextSubject {
  return { type: "text", key: `text:${hash(text)}`, label: `“${clip(text.replace(/\s+/g, " "), 40)}”`, text, sourcePath };
}

export const TYPE_LABEL: Record<string, string> = { task: "Task", message: "Message", announcement: "Notice", radar: "Deadline", event: "Event", text: "Text" };
