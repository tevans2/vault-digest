/**
 * The intent model. A *subject* is something you can point at. An *op* is one reversible change.
 * An *action* is what one instruction did: its ops, who asked, how it was understood, and how to undo it.
 */

export type SubjectType = "task" | "message" | "announcement" | "radar" | "event" | "text";

export interface TaskSubject {
  type: "task";
  key: string;
  label: string;
  path: string;
  /** 0-based line hint; the writer re-finds the line by its exact text. */
  line: number;
  /** The full original line, used to find it again and to detect that it changed. */
  raw: string;
  due?: string;
  waiting?: boolean;
}
export interface MessageSubject {
  type: "message";
  key: string;
  label: string;
  path: string;
  kind: string;
  /** The words, so "task friday" can turn the message into a task. */
  excerpt: string;
}
export interface AnnouncementSubject {
  type: "announcement";
  key: string;
  label: string;
  id: string;
  level: string;
}
export interface RadarSubject {
  type: "radar";
  key: string;
  label: string;
  id: string;
  due?: string;
  weight?: number;
  /** Only radar items the brief authored can be edited; rows read from the Task Board table can't. */
  editable: boolean;
}
export interface EventSubject {
  type: "event";
  key: string;
  label: string;
  start: string;
  end?: string;
  title: string;
}
/** Text you highlighted in a note, so "task friday" can turn it into a task that links back. */
export interface TextSubject {
  type: "text";
  key: string;
  label: string;
  text: string;
  /** The note it came from, if any. */
  sourcePath?: string;
}
export type Subject = TaskSubject | MessageSubject | AnnouncementSubject | RadarSubject | EventSubject | TextSubject;

// ── Ops ─────────────────────────────────────────────────────────────────────

export type Priority = "highest" | "high" | "medium" | "low" | "lowest" | "none";

export interface TaskPatch {
  /** Set a due date, or null to clear it. */
  due?: string | null;
  status?: "done" | "cancelled" | "open";
  /** The real date it was done or cancelled. */
  statusDate?: string;
  priority?: Priority;
  addTags?: string[];
  removeTags?: string[];
  /** Adds `@name`, e.g. who you're waiting on. */
  mention?: string;
  /** Replace the description, keeping dates and markers. */
  text?: string;
  /** Time of day: "14:00" or "14:00-15:30", or null for all-day. */
  time?: string | null;
  /** Put on (true, or an alias for #cal/alias) or take off (false) the calendar. */
  calendar?: boolean | string;
  /** Set the Tasks plugin id marker. */
  id?: string;
}

export type MessageStatusTarget = "actioned" | "acknowledged" | "ignored";

export type Op =
  | { k: "task.patch"; subject: TaskSubject; patch: TaskPatch }
  | { k: "task.create"; text: string; due?: string; course?: string; time?: string; calendar?: boolean | string }
  | { k: "message.status"; path: string; status: MessageStatusTarget; summary?: string }
  | { k: "announcement.ack"; id: string }
  | { k: "announcement.snooze"; id: string; until: string }
  | { k: "radar.patch"; id: string; patch: { due?: string; weight?: number; name?: string } }
  | { k: "radar.remove"; id: string };

// ── Actions and undo ────────────────────────────────────────────────────────

export type Inverse =
  | { k: "line.restore"; path: string; before: string; after: string }
  | { k: "line.remove"; path: string; line: string }
  | { k: "message.restore"; path: string; status: "new" | "actioned" | "acknowledged" | "ignored" }
  | { k: "interaction.restore"; key: string; ack: string | null; snooze: string | null }
  | { k: "radar.restore"; id: string; before: { id: string; name: string; due: string; weight?: number; course?: string; note?: string } | null };

export interface ActionOpRecord {
  summary: string;
  ok: boolean;
  error?: string;
  inverse?: Inverse;
  undone?: boolean;
}

export type ActionSource = "bar" | "telegram" | "daily-note" | "agent" | "editor" | "calendar";

export interface ActionRecord {
  id: string;
  at: string;
  source: ActionSource;
  /** What you typed. */
  input: string;
  subjects: { type: SubjectType; label: string }[];
  /** "grammar" = understood locally for free; "agent" = the model worked it out. */
  interpreter: "grammar" | "agent";
  /** One line for the history. */
  summary: string;
  /** A short answer, when the instruction was a question. */
  reply?: string;
  status: "applied" | "undone" | "partial" | "failed" | "answered";
  ops: ActionOpRecord[];
  /** Shown on the row after an undo that left something alone because the file had changed. */
  undoNote?: string;
}

export const MAX_ACTIONS = 100;

/** What an instruction was understood as, before anything is written. */
export type Interpretation =
  | { kind: "ops"; ops: Op[]; summary: string }
  | { kind: "question"; text: string }
  | { kind: "agent"; reason: string }
  /** Understood, but not something that can be done (yet). Said plainly rather than guessed at. */
  | { kind: "blocked"; message: string };
