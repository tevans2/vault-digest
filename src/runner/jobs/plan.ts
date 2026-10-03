import type { Task } from "../../engine/collectors/tasks";
import type { RadarItem, TriageItem, WriteOp } from "../../state/schema";
import { slug } from "../../engine/collectors/announcements";
import type { JournalSections } from "../../writers/journal";
import { contextBody } from "../../writers/journal";
import { OpResult, TaskOp, formatTaskLine, similarity, validateOps, NEAR_DUPLICATE } from "../../writers/tasks";
import { applySpellingEdits, SpellingEdit } from "../../writers/raw";
import { assertMovable } from "../../writers/writer";

/** What a model result will do to the vault, computed without touching it. Used for dry-run previews and for the real write. */

export interface ModelTaskOp {
  op: string;
  text?: string;
  due?: string;
  time?: string;
  calendar?: boolean;
  calendarAlias?: string;
  file?: string;
  line?: number;
  doneDate?: string;
  reason?: string;
}

export interface MessageDisposition {
  path: string;
  disposition: "actioned" | "acknowledged" | "ignored";
  summary: string;
}

export interface MessagePlan {
  valid: MessageDisposition[];
  rejected: string[];
}

/** Only messages that are really new, and only once each. A made-up path is rejected, not written. */
export function planMessages(raw: MessageDisposition[] | undefined, newPaths: Set<string> | undefined): MessagePlan {
  const valid: MessageDisposition[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const m of raw ?? []) {
    if (!newPaths?.has(m.path)) rejected.push(`message ${m.path.split("/").pop()}: not a new message`);
    else if (seen.has(m.path)) rejected.push(`message ${m.path.split("/").pop()}: handled twice in one result`);
    else {
      seen.add(m.path);
      valid.push(m);
    }
  }
  return { valid, rejected };
}

const msgLines = (p: MessagePlan): PlanLine[] => [
  ...p.valid.map((m): PlanLine => ({ kind: "message", text: `Message ${m.disposition}: ${m.summary || m.path.split("/").pop()}` })),
  ...p.rejected.map((r): PlanLine => ({ kind: "reject", text: `Rejected ${r}` })),
];

export interface PlanLine {
  kind: "message" | "journal" | "create" | "redate" | "complete" | "drop" | "reject" | "radar" | "spelling" | "triage";
  text: string;
}

/** Turn the model's loose op objects into validated-shape ops. The model never chooses a target path for a create. */
export function resolveOps(
  raw: ModelTaskOp[],
  tasks: Task[],
  allowed: ("create" | "redate" | "complete")[]
): { ops: TaskOp[]; rejected: string[] } {
  const ops: TaskOp[] = [];
  const rejected: string[] = [];
  const open = tasks.filter((t) => !t.done);
  const refFor = (m: ModelTaskOp): { path: string; line: number; expectedText: string } | null => {
    const file = m.file ?? "";
    const exact = open.find((t) => t.path === file && m.line !== undefined && t.line + 1 === m.line);
    const found =
      exact ?? (m.text ? open.filter((t) => t.path === file).sort((a, b) => similarity(b.text, m.text!) - similarity(a.text, m.text!)).find((t) => similarity(t.text, m.text!) >= NEAR_DUPLICATE) : undefined);
    return found ? { path: found.path, line: found.line, expectedText: found.raw } : null;
  };

  for (const m of raw) {
    const label = `${m.op} ${(m.text ?? m.file ?? "").slice(0, 50)}`;
    if (!allowed.includes(m.op as never)) {
      rejected.push(`${label}: the ${m.op} operation is not allowed in this job`);
    } else if (m.op === "create") {
      if (!m.text) rejected.push(`${label}: no task text`);
      else ops.push({ op: "create", text: m.text, due: m.due, reason: m.reason, time: m.time, calendar: m.calendar ? m.calendarAlias || true : undefined });
    } else {
      const ref = refFor(m);
      if (!ref) rejected.push(`${label}: could not find that open task (${m.file ?? "no file"}:${m.line ?? "?"})`);
      else if (m.op === "redate") {
        if (!m.due) rejected.push(`${label}: no new due date`);
        else ops.push({ op: "redate", ref, due: m.due, reason: m.reason });
      } else ops.push({ op: "complete", ref, doneDate: m.doneDate, reason: m.reason });
    }
  }
  return { ops, rejected };
}

const count = (rs: OpResult[], f: (r: OpResult) => boolean) => rs.filter(f).length;
const isCreate = (r: OpResult) => r.verdict === "apply" && !r.converted && r.op.op === "create";
const isRedate = (r: OpResult) => r.verdict === "apply" && (r.converted?.op ?? r.op.op) === "redate";
const isComplete = (r: OpResult) => r.verdict === "apply" && !r.converted && r.op.op === "complete";

function opLines(results: OpResult[], resolveRejected: string[]): PlanLine[] {
  const lines: PlanLine[] = [];
  for (const r of results) {
    const op = r.converted ?? r.op;
    if (r.verdict === "apply") {
      if (op.op === "create") lines.push({ kind: "create", text: `New task: ${op.text}${op.due ? ` 📅 ${op.due}` : ""}` });
      else if (op.op === "redate") lines.push({ kind: "redate", text: `Re-date to ${op.due}: ${op.ref.expectedText.replace(/^\s*- \[.\]\s*/, "").slice(0, 70)}${r.converted ? " (instead of a duplicate)" : ""}` });
      else lines.push({ kind: "complete", text: `Complete ✅ ${op.doneDate}: ${op.ref.expectedText.replace(/^\s*- \[.\]\s*/, "").slice(0, 70)}` });
    } else {
      const what = r.op.op === "create" ? r.op.text : r.op.ref.expectedText.replace(/^\s*- \[.\]\s*/, "");
      lines.push({ kind: r.verdict === "drop" ? "drop" : "reject", text: `${r.verdict === "drop" ? "Skipped" : "Rejected"} “${what.slice(0, 60)}”: ${r.reason}` });
    }
  }
  for (const r of resolveRejected) lines.push({ kind: "reject", text: `Rejected ${r}` });
  return lines;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "Writes:" line, so the notes always end by stating exactly what the plugin changed. */
export function writesLine(parts: { sections: string[]; created: number; redated: number; completed: number; dropped: number; rejected: number; spelling?: number; radar?: number; messages?: number }): string {
  const bits: string[] = [];
  if (parts.sections.length) bits.push(`updated ${parts.sections.join(", ")}`);
  if (parts.created) bits.push(`created ${plural(parts.created, "task")}`);
  if (parts.redated) bits.push(`re-dated ${parts.redated}`);
  if (parts.completed) bits.push(`completed ${parts.completed}`);
  if (parts.spelling) bits.push(`fixed spelling in ${plural(parts.spelling, "place")}`);
  if (parts.radar) bits.push(`refreshed the radar (${parts.radar})`);
  if (parts.messages) bits.push(`handled ${plural(parts.messages, "message")}`);
  if (parts.dropped) bits.push(`skipped ${parts.dropped} as ${parts.dropped === 1 ? "a duplicate" : "duplicates"}`);
  if (parts.rejected) bits.push(`rejected ${parts.rejected}`);
  return `**Writes:** ${bits.length ? bits.join("; ") : "nothing"}. No calendar events were created or changed.`;
}

// ── brief ───────────────────────────────────────────────────────────────────

export interface BriefResult {
  announcements: { id: string; level: string; text: string; topic?: string }[];
  priorities: string[];
  timeline: { start: string; end?: string; title: string; note?: string }[];
  notes: string;
  missing: string[];
  carriedForward: string;
  radar: { name: string; due: string; weight?: number; course?: string; note?: string }[];
  taskOps: ModelTaskOp[];
  messages?: MessageDisposition[];
}

export interface BriefPlan {
  sections: JournalSections;
  results: OpResult[];
  resolveRejected: string[];
  radar: RadarItem[];
  messages: MessagePlan;
  preview: PlanLine[];
}

export function planBrief(result: BriefResult, ctx: { today: string; tasks: Task[]; calendarChecked: boolean; newMessages?: Set<string> }): BriefPlan {
  const msgs = planMessages(result.messages, ctx.newMessages);
  const { ops, rejected } = resolveOps(result.taskOps, ctx.tasks, ["create", "redate"]);
  const results = validateOps(ops, { today: ctx.today, openTasks: ctx.tasks.filter((t) => !t.done) });

  const radar: RadarItem[] = [];
  const seen = new Set<string>();
  for (const r of result.radar) {
    const id = slug(r.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    radar.push({ id, name: r.name, due: r.due, weight: r.weight, course: r.course, note: r.note });
  }

  const sectionNames = ["Carried Forward", "Today's Priorities", "Context", "Claude's Notes"];
  const wl = writesLine({
    sections: ["Carried Forward", "Priorities", "Context", "Notes"],
    created: count(results, isCreate),
    redated: count(results, isRedate),
    completed: 0,
    dropped: count(results, (r) => r.verdict === "drop"),
    rejected: count(results, (r) => r.verdict === "reject") + rejected.length + msgs.rejected.length,
    radar: radar.length,
    messages: msgs.valid.length,
  });
  const sections: JournalSections = {
    carriedForward: result.carriedForward,
    priorities: result.priorities,
    context: contextBody(result.timeline, result.missing, ctx.calendarChecked),
    notes: `${result.notes.trim()}\n\n${wl}`,
    actionsAppend: results.filter(isCreate).map((r) => formatTaskLine((r.op as Extract<TaskOp, { op: "create" }>).text, (r.op as Extract<TaskOp, { op: "create" }>).due, false, { time: (r.op as Extract<TaskOp, { op: "create" }>).time, calendar: (r.op as Extract<TaskOp, { op: "create" }>).calendar })),
  };

  const preview: PlanLine[] = [
    { kind: "journal", text: `Today's journal: update ${sectionNames.join(", ")}` },
    ...opLines(results, rejected),
    ...msgLines(msgs),
  ];
  if (radar.length) preview.push({ kind: "radar", text: `Radar: ${plural(radar.length, "upcoming deadline")} with weights` });
  return { sections, results, resolveRejected: rejected, radar, messages: msgs, preview };
}

// ── close ───────────────────────────────────────────────────────────────────

export interface CloseResult {
  summary: string;
  notes: string;
  rawEdits: SpellingEdit[];
  taskOps: ModelTaskOp[];
  announcements: { id: string; level: string; text: string; topic?: string }[];
  messages?: MessageDisposition[];
}

export interface ClosePlan {
  sections: JournalSections;
  results: OpResult[];
  resolveRejected: string[];
  spelling: { applied: SpellingEdit[]; rejected: { edit: SpellingEdit; reason: string }[] };
  messages: MessagePlan;
  preview: PlanLine[];
}

export function planClose(result: CloseResult, ctx: { today: string; tasks: Task[]; rawText: string; newMessages?: Set<string> }): ClosePlan {
  const msgs = planMessages(result.messages, ctx.newMessages);
  const { ops, rejected } = resolveOps(result.taskOps, ctx.tasks, ["create", "redate", "complete"]);
  const results = validateOps(ops, { today: ctx.today, openTasks: ctx.tasks.filter((t) => !t.done) });
  // Dry-run the spelling edits against Raw so the preview shows exactly what would be accepted.
  const spelling = applySpellingEdits(`<!-- RAW INPUT BOUNDARY -->\n${ctx.rawText}`, result.rawEdits);

  const wl = writesLine({
    sections: ["Notes"],
    created: count(results, isCreate),
    redated: count(results, isRedate),
    completed: count(results, isComplete),
    dropped: count(results, (r) => r.verdict === "drop"),
    rejected: count(results, (r) => r.verdict === "reject") + rejected.length + spelling.rejected.length + msgs.rejected.length,
    spelling: spelling.applied.length,
    messages: msgs.valid.length,
  });
  const sections: JournalSections = {
    notes: `${result.notes.trim()}\n\n${wl}`,
    actionsAppend: results.filter(isCreate).map((r) => formatTaskLine((r.op as Extract<TaskOp, { op: "create" }>).text, (r.op as Extract<TaskOp, { op: "create" }>).due, false, { time: (r.op as Extract<TaskOp, { op: "create" }>).time, calendar: (r.op as Extract<TaskOp, { op: "create" }>).calendar })),
  };
  const preview: PlanLine[] = [{ kind: "journal", text: "Today's journal: refresh Claude's Notes" }];
  for (const e of spelling.applied) preview.push({ kind: "spelling", text: `Spelling in Raw: “${e.find}” → “${e.replace}”` });
  for (const r of spelling.rejected) preview.push({ kind: "reject", text: `Left Raw alone: “${r.edit.find.slice(0, 40)}” (${r.reason})` });
  preview.push(...opLines(results, rejected), ...msgLines(msgs));
  return { sections, results, resolveRejected: rejected, spelling, messages: msgs, preview };
}

// ── week ────────────────────────────────────────────────────────────────────

export interface WeekResult {
  triage: { path: string; action: string; destination?: string; reason: string }[];
  announcements: { id: string; level: string; text: string; topic?: string }[];
  loadForecast: string;
  ruleViolations: string[];
}

export interface TriageCtx {
  /** Inbox notes that exist right now, with sizes. */
  inbox: { path: string; size: number }[];
  /** Folders that exist (vault-relative, no trailing slash). */
  folders: Set<string>;
  /** Every existing note path, to refuse overwrites. */
  allPaths: Set<string>;
}

const base = (p: string) => p.split("/").pop() ?? p;

/** Check each proposal against the real vault. Nothing here moves a file; approval does. */
export function planTriage(items: WeekResult["triage"], ctx: TriageCtx, runId: string): TriageItem[] {
  const inbox = new Map(ctx.inbox.map((i) => [i.path, i.size]));
  const out: TriageItem[] = [];
  items.forEach((it, i) => {
    const id = `${runId}:${i}`;
    const item = (over: Partial<TriageItem>): TriageItem => ({ id, runId, path: it.path, action: "keep", reason: it.reason, status: "pending", ...over });
    if (!inbox.has(it.path)) return out.push(item({ status: "skipped", reason: `${it.reason} (not in the inbox any more)` }));
    if (it.action === "keep") return out.push(item({ status: "skipped" }));
    if (it.action === "delete-empty") {
      if (inbox.get(it.path) === 0 && /^Untitled/i.test(base(it.path))) return out.push(item({ action: "delete-empty" }));
      return out.push(item({ status: "skipped", reason: `${it.reason} (empty, but only empty Untitled* stubs are ever deleted, so review it yourself)` }));
    }
    const dest = it.action === "archive" ? "Archive" : (it.destination ?? "").replace(/\/+$/, "");
    if (!dest) return out.push(item({ status: "skipped", reason: `${it.reason} (no destination folder given)` }));
    if (!ctx.folders.has(dest)) return out.push(item({ status: "skipped", reason: `${it.reason} (folder “${dest}” doesn't exist)` }));
    const to = `${dest}/${base(it.path)}`;
    try {
      assertMovable(it.path, to);
    } catch (e) {
      return out.push(item({ status: "skipped", reason: `${it.reason} (${(e as Error).message})` }));
    }
    if (ctx.allPaths.has(to)) return out.push(item({ status: "skipped", reason: `${it.reason} (${to} already exists)` }));
    out.push(item({ action: it.action as "file" | "archive", destination: dest }));
  });
  return out;
}

export const OP_LABEL: Record<WriteOp, string> = {
  "journal-create": "Created journal",
  "journal-sections": "Updated journal",
  "actions-append": "Added task",
  "task-create": "Added task",
  "task-redate": "Re-dated",
  "task-complete": "Completed",
  "raw-append": "Your answers",
  "raw-spelling": "Spelling",
  "triage-move": "Moved note",
  "triage-delete": "Deleted stub",
  "board-radar": "Task Board",
  "message-save": "Saved message",
  "message-update": "Updated message",
  "message-status": "Handled message",
  "task-edit": "Edited task",
  "task-undo": "Undid",
};
