import type { DigestStateV1, RadarItem, WriteRecord } from "../state/schema";
import type { VaultFs } from "../writers/fs";
import type { VaultWriter } from "../writers/writer";
import { readFrontmatter, restoreStatus } from "../messages/note";
import { setMessageStatus } from "../messages/ingest";
import { dayLabel } from "./grammar";
import { descriptionOf } from "./taskline";
import { ActionOpRecord, ActionRecord, ActionSource, Inverse, MAX_ACTIONS, Op, Subject, TaskPatch } from "./types";

export interface ApplyDeps {
  writer: VaultWriter;
  fs: VaultFs;
  state: DigestStateV1;
  today: () => string;
  now: () => Date;
  uuid: () => string;
  record: (w: WriteRecord) => void;
}

export interface ActionMeta {
  source: ActionSource;
  input: string;
  subjects: Subject[];
  interpreter: "grammar" | "agent";
  summary: string;
  reply?: string;
}

const by = (s: ActionSource) => (s === "bar" || s === "editor" ? "you" : "agent");
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const name = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/, "");

/** A readable account of a task patch, for the history. */
function patchWords(p: TaskPatch): string {
  const bits: string[] = [];
  if (p.due === null) bits.push("cleared the date");
  else if (p.due) bits.push(`due ${dayLabel(p.due)}`);
  if (p.status === "done") bits.push(`done ${p.statusDate ? dayLabel(p.statusDate) : ""}`.trim());
  if (p.status === "cancelled") bits.push("cancelled");
  if (p.status === "open") bits.push("reopened");
  if (p.priority) bits.push(p.priority === "none" ? "cleared priority" : `priority ${p.priority}`);
  if (p.addTags?.length) bits.push(`#${p.addTags.join(" #")}`);
  if (p.removeTags?.length) bits.push(`removed #${p.removeTags.join(" #")}`);
  if (p.mention) bits.push(`@${p.mention.replace(/^@/, "")}`);
  if (p.time === null) bits.push("all day");
  else if (p.time) bits.push(`at ${p.time}`);
  if (p.calendar === false) bits.push("off the calendar");
  else if (p.calendar) bits.push("on the calendar");
  if (p.text) bits.push(`renamed`);
  return bits.join(", ") || "edited";
}

async function applyOne(d: ApplyDeps, op: Op, source: ActionSource): Promise<ActionOpRecord> {
  const src = by(source);
  const today = d.today();
  try {
    if (op.k === "task.patch") {
      const { before, after } = await d.writer.editTaskLine({ path: op.subject.path, line: op.subject.line, expectedText: op.subject.raw }, op.patch, today, src);
      return { ok: true, summary: `“${short(descriptionOf(after))}”: ${patchWords(op.patch)}`, inverse: { k: "line.restore", path: op.subject.path, before, after } };
    }
    if (op.k === "task.create") {
      const r = await d.writer.capture(op.text, op.due, op.course, today, src, { time: op.time, calendar: op.calendar });
      return { ok: true, summary: `Added “${short(op.text)}”${op.due ? ` due ${dayLabel(op.due)}` : ""} to ${name(r.path)}`, inverse: { k: "line.remove", path: r.path, line: r.line } };
    }
    if (op.k === "message.status") {
      if (!(await d.fs.exists(op.path))) throw new Error("that message no longer exists");
      const fm = readFrontmatter(await d.fs.read(op.path));
      if (fm.type !== "message") throw new Error("that isn't a message note");
      const prev = (["new", "actioned", "acknowledged", "ignored"].includes(fm.status) ? fm.status : "new") as "new" | "actioned" | "acknowledged" | "ignored";
      await setMessageStatus({ fs: d.fs, record: d.record, now: d.now, uuid: d.uuid }, op.path, op.status, { by: src, date: today, summary: op.summary ?? "" });
      return { ok: true, summary: `Message ${op.status}: ${name(op.path)}`, inverse: { k: "message.restore", path: op.path, status: prev } };
    }
    if (op.k === "announcement.ack" || op.k === "announcement.snooze") {
      const it = d.state.interactions;
      const inverse: Inverse = { k: "interaction.restore", key: op.id, ack: it.acks[op.id] ?? null, snooze: it.snoozes[op.id] ?? null };
      if (op.k === "announcement.ack") it.acks[op.id] = d.now().toISOString();
      else it.snoozes[op.id] = op.until;
      return { ok: true, summary: op.k === "announcement.ack" ? "Dismissed an announcement" : `Snoozed an announcement until ${dayLabel(op.until.slice(0, 10))}`, inverse };
    }
    if (op.k === "radar.patch" || op.k === "radar.remove") {
      const i = d.state.radar.findIndex((r) => r.id === op.id);
      if (i < 0) throw new Error("that deadline isn't on the editable radar");
      const before: RadarItem = { ...d.state.radar[i] };
      if (op.k === "radar.remove") d.state.radar.splice(i, 1);
      else d.state.radar[i] = { ...before, ...(op.patch.due ? { due: op.patch.due } : {}), ...(op.patch.weight !== undefined ? { weight: op.patch.weight } : {}), ...(op.patch.name ? { name: op.patch.name } : {}) };
      return { ok: true, summary: op.k === "radar.remove" ? `Removed “${short(before.name)}” from the radar` : `${short(before.name)}: ${Object.entries(op.patch).map(([k, v]) => `${k} ${v}`).join(", ")}`, inverse: { k: "radar.restore", id: op.id, before } };
    }
    return { ok: false, summary: "Unknown operation", error: "unsupported operation" };
  } catch (e) {
    return { ok: false, summary: describeFailed(op), error: (e as Error).message };
  }
}

function describeFailed(op: Op): string {
  if (op.k === "task.patch") return `“${short(descriptionOf(op.subject.raw))}” not changed`;
  if (op.k === "task.create") return `“${short(op.text)}” not added`;
  if (op.k === "message.status") return `Message ${name(op.path)} not updated`;
  return "Not applied";
}

/** Apply every op, independently, and record what happened with a way back. */
export async function applyOps(d: ApplyDeps, ops: Op[], meta: ActionMeta): Promise<ActionRecord> {
  const results: ActionOpRecord[] = [];
  for (const op of ops) results.push(await applyOne(d, op, meta.source));
  const ok = results.filter((r) => r.ok).length;
  const rec: ActionRecord = {
    id: d.uuid(),
    at: d.now().toISOString(),
    source: meta.source,
    input: meta.input,
    subjects: meta.subjects.map((s) => ({ type: s.type, label: s.label })),
    interpreter: meta.interpreter,
    summary: meta.summary,
    reply: meta.reply,
    status: ops.length === 0 ? "answered" : ok === 0 ? "failed" : ok < results.length ? "partial" : "applied",
    ops: results,
  };
  d.state.actions.unshift(rec);
  d.state.actions.length = Math.min(d.state.actions.length, MAX_ACTIONS);
  return rec;
}

/** An answer with nothing changed, e.g. a question. */
export function recordAnswer(d: ApplyDeps, meta: ActionMeta): ActionRecord {
  const rec: ActionRecord = { id: d.uuid(), at: d.now().toISOString(), source: meta.source, input: meta.input, subjects: meta.subjects.map((s) => ({ type: s.type, label: s.label })), interpreter: meta.interpreter, summary: meta.summary, reply: meta.reply, status: "answered", ops: [] };
  d.state.actions.unshift(rec);
  d.state.actions.length = Math.min(d.state.actions.length, MAX_ACTIONS);
  return rec;
}

async function undoOne(d: ApplyDeps, inv: Inverse): Promise<void> {
  if (inv.k === "line.restore") return d.writer.replaceLine(inv.path, inv.after, inv.before, "you");
  if (inv.k === "line.remove") return d.writer.removeLine(inv.path, inv.line, "you");
  if (inv.k === "message.restore") {
    if (!(await d.fs.exists(inv.path))) throw new Error("that message no longer exists");
    await d.fs.modify(inv.path, (t) => restoreStatus(t, inv.status));
    return;
  }
  if (inv.k === "interaction.restore") {
    const it = d.state.interactions;
    if (inv.ack === null) delete it.acks[inv.key];
    else it.acks[inv.key] = inv.ack;
    if (inv.snooze === null) delete it.snoozes[inv.key];
    else it.snoozes[inv.key] = inv.snooze;
    return;
  }
  if (inv.k === "radar.restore") {
    const i = d.state.radar.findIndex((r) => r.id === inv.id);
    if (inv.before === null) {
      if (i >= 0) d.state.radar.splice(i, 1);
    } else if (i >= 0) d.state.radar[i] = inv.before;
    else d.state.radar.push(inv.before);
  }
}

/** Reverse an action, newest change first. Anything that has since been edited is left alone and reported. */
export async function undoAction(d: ApplyDeps, action: ActionRecord): Promise<{ undone: number; skipped: string[] }> {
  let undone = 0;
  const skipped: string[] = [];
  for (const op of [...action.ops].reverse()) {
    if (!op.ok || !op.inverse || op.undone) continue;
    try {
      await undoOne(d, op.inverse);
      op.undone = true;
      undone++;
    } catch (e) {
      skipped.push(`${op.summary}: ${(e as Error).message}`);
    }
  }
  const live = action.ops.filter((o) => o.ok && o.inverse);
  action.status = live.length > 0 && live.every((o) => o.undone) ? "undone" : undone ? "partial" : action.status;
  return { undone, skipped };
}
