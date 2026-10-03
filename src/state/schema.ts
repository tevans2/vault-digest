import type { Announcement } from "../engine/collectors/announcements";
import { MAX_ACTIONS, type ActionRecord } from "../intent/types";
import type { CalendarState, CalLink } from "../calendar/model";

export type JobId = "brief" | "close" | "week" | "intent";
export type RunStatus = "running" | "ok" | "failed" | "cancelled" | "rejected";
export type RunTrigger = "schedule" | "catch-up" | "manual" | "launchd";

export interface RunRecord {
  id: string;
  job: JobId;
  trigger: RunTrigger;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  provider?: string;
  model: string;
  effort?: string;
  costUsd?: number;
  sessionId?: string;
  attempts: number;
  error?: string;
  /** Progress lines and notable events, newest last. Capped. */
  log: string[];
  /** True when the result went to `pending` for approval instead of being applied. */
  dryRun?: boolean;
}

export interface TimelineEvent {
  start: string; // "HH:MM" or "all-day"
  end?: string;
  title: string;
  note?: string;
}

/** What the brief last produced. Authored by the model, owned by the plugin. */
export interface BriefState {
  date: string; // YYYY-MM-DD the brief was for
  generatedAt: string;
  announcements: Announcement[];
  priorities: string[];
  timeline: TimelineEvent[];
  notes: string;
  missing: string[];
}

export interface PendingResult {
  runId: string;
  job: JobId;
  at: string;
  result: unknown;
}

/** One authored radar item. Scores are derived live from weight and due. */
export interface RadarItem {
  id: string;
  name: string;
  /** YYYY-MM-DD or YYYY-MM-DDTHH:MM, Africa/Johannesburg. */
  due: string;
  weight?: number;
  course?: string;
  note?: string;
}

export type WriteOp =
  | "journal-create"
  | "journal-sections"
  | "actions-append"
  | "task-create"
  | "task-redate"
  | "task-complete"
  | "raw-append"
  | "raw-spelling"
  | "triage-move"
  | "triage-delete"
  | "board-radar"
  | "message-save"
  | "message-update"
  | "message-status"
  | "task-edit"
  | "task-undo";

/** Every vault edit the plugin makes, with content hashes so changes are auditable. */
export interface WriteRecord {
  id: string;
  at: string;
  /** Run id, or "user" for edits made straight from the dashboard. */
  source: string;
  op: WriteOp;
  path: string;
  summary: string;
  before?: string;
  after?: string;
}

export interface CloseState {
  date: string;
  generatedAt: string;
  summary: string;
  notes: string;
  /** Announcements for tomorrow's dashboard. */
  announcements: Announcement[];
  forDate: string;
}

export interface WeekState {
  date: string;
  generatedAt: string;
  announcements: Announcement[];
  loadForecast: string;
  ruleViolations: string[];
}

export interface TriageItem {
  id: string;
  runId: string;
  path: string;
  action: "file" | "archive" | "delete-empty" | "keep";
  destination?: string;
  reason: string;
  status: "pending" | "done" | "skipped" | "failed";
  error?: string;
}

/** The Telegram message channel: connection health and the small lookups ingest needs. */
export interface MessagesState {
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
  /** What the last fetch did, e.g. "3 saved, 1 skipped". */
  lastSummary?: string;
  /** Messages still waiting on the relay after the last fetch. */
  relayPending?: number;
  /** "chat:message" → note path, so an edit can find the note it corrects. */
  index: Record<string, string>;
  /** relay_id → failed attempts, so a poison message is given up on. */
  attempts: Record<string, number>;
}

export const MAX_MESSAGE_INDEX = 800;

/** One store, split by who owns each part. */
export interface DigestStateV1 {
  schemaVersion: 1;
  updatedAt: string;
  interactions: {
    acks: Record<string, string>;
    snoozes: Record<string, string>;
  };
  brief: BriefState | null;
  close: CloseState | null;
  week: WeekState | null;
  /** Authored radar (from the brief). Empty = fall back to the Task Board table. */
  radar: RadarItem[];
  triage: TriageItem[];
  /** Dry-run results waiting for approval. */
  pending: PendingResult[];
  writes: WriteRecord[]; // newest first, capped
  messages: MessagesState;
  /** What each instruction did, newest first, each with a way to undo it. */
  actions: ActionRecord[];
  /** Google Calendar links and sync health. */
  calendar: CalendarState;
  runs: RunRecord[]; // newest first, capped
}

export const MAX_RUNS = 60;
export const MAX_WRITES = 300;

export function emptyState(): DigestStateV1 {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    interactions: { acks: {}, snoozes: {} },
    brief: null,
    close: null,
    week: null,
    radar: [],
    triage: [],
    pending: [],
    writes: [],
    messages: { index: {}, attempts: {} },
    actions: [],
    calendar: { links: {} },
    runs: [],
  };
}

const rec = (v: unknown): Record<string, string> =>
  v && typeof v === "object"
    ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>)
    : {};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate/repair whatever was on disk. Unknown versions fall back to empty. */
export function coerceState(raw: unknown): DigestStateV1 {
  const base = emptyState();
  if (!isObj(raw) || raw.schemaVersion !== 1) return base;
  const r = raw as Partial<DigestStateV1> & Record<string, unknown>;
  const inter: Record<string, unknown> = isObj(r.interactions) ? r.interactions : {};

  const runs = (Array.isArray(r.runs) ? r.runs : [])
    .filter((x): x is RunRecord => isObj(x) && typeof x.id === "string" && typeof x.job === "string" && typeof x.startedAt === "string")
    .slice(0, MAX_RUNS)
    .map((x) => ({ ...x, attempts: Number(x.attempts) || 1, log: Array.isArray(x.log) ? x.log.map(String) : [] }));

  const brief = isObj(r.brief) && typeof r.brief.date === "string" ? (r.brief as unknown as BriefState) : null;
  const close = isObj(r.close) && typeof r.close.date === "string" ? (r.close as unknown as CloseState) : null;
  const week = isObj(r.week) && typeof r.week.date === "string" ? (r.week as unknown as WeekState) : null;
  // `pending` used to be a single object; it is now a list.
  const rawPending = Array.isArray(r.pending) ? r.pending : isObj(r.pending) ? [r.pending] : [];
  const pending = rawPending.filter((x): x is PendingResult => isObj(x) && typeof x.runId === "string");
  const list = <T,>(v: unknown, ok: (x: Record<string, unknown>) => boolean, cap: number): T[] =>
    (Array.isArray(v) ? v : []).filter((x) => isObj(x) && ok(x)).slice(0, cap) as T[];
  const radar = list<RadarItem>(r.radar, (x) => typeof x.id === "string" && typeof x.name === "string" && typeof x.due === "string", 50);
  const triage = list<TriageItem>(r.triage, (x) => typeof x.id === "string" && typeof x.path === "string", 200);
  const writes = list<WriteRecord>(r.writes, (x) => typeof x.id === "string" && typeof x.path === "string", MAX_WRITES);

  const m: Record<string, unknown> = isObj(r.messages) ? r.messages : {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const nums = (v: unknown): Record<string, string> => rec(v);
  const attempts = isObj(m.attempts) ? Object.fromEntries(Object.entries(m.attempts).filter(([, x]) => typeof x === "number")) : {};
  const actions = list<ActionRecord>(r.actions, (x) => typeof x.id === "string" && typeof x.input === "string" && Array.isArray(x.ops), MAX_ACTIONS);
  const cal: Record<string, unknown> = isObj(r.calendar) ? r.calendar : {};
  const links: Record<string, CalLink> = {};
  if (isObj(cal.links)) {
    for (const [k, v] of Object.entries(cal.links)) {
      if (isObj(v) && typeof v.eventId === "string" && typeof v.calendarId === "string" && isObj(v.when) && typeof v.when.date === "string") links[k] = v as unknown as CalLink;
    }
  }
  const calendar: CalendarState = { links, lastSyncAt: str(cal.lastSyncAt), lastError: str(cal.lastError), lastSummary: str(cal.lastSummary), connectedAs: str(cal.connectedAs) };
  const messages: MessagesState = {
    lastAttemptAt: str(m.lastAttemptAt),
    lastOkAt: str(m.lastOkAt),
    lastError: str(m.lastError),
    lastSummary: str(m.lastSummary),
    relayPending: typeof m.relayPending === "number" ? m.relayPending : undefined,
    index: Object.fromEntries(Object.entries(nums(m.index)).slice(-MAX_MESSAGE_INDEX)),
    attempts: attempts as Record<string, number>,
  };

  return {
    schemaVersion: 1,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : base.updatedAt,
    interactions: { acks: rec(inter.acks), snoozes: rec(inter.snoozes) },
    brief,
    close,
    week,
    radar,
    triage,
    pending,
    writes,
    messages,
    actions,
    calendar,
    runs,
  };
}

/** Any run still marked running at load time was interrupted (Obsidian closed mid-run). */
export function reapStaleRuns(state: DigestStateV1, now = new Date()): number {
  let n = 0;
  for (const run of state.runs) {
    if (run.status === "running") {
      run.status = "failed";
      run.endedAt = now.toISOString();
      run.error = "Interrupted: Obsidian closed or reloaded during the run.";
      n++;
    }
  }
  return n;
}
