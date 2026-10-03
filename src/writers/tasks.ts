import { Task } from "../engine/collectors/tasks";
import { normalise } from "../engine/collectors/duplicates";

/** A task identified by where it lives and what its line said, so edits survive line drift. */
export interface TaskRef {
  path: string;
  line: number; // 0-based hint
  expectedText: string; // the full original line
}

export type TaskOp =
  | { op: "create"; text: string; due?: string; path?: string; reason?: string; time?: string; calendar?: boolean | string }
  | { op: "redate"; ref: TaskRef; due: string; reason?: string }
  | { op: "complete"; ref: TaskRef; doneDate?: string; reason?: string };

export type Verdict = "apply" | "drop" | "reject";
export interface OpResult {
  op: TaskOp;
  verdict: Verdict;
  reason?: string;
  /** A near-duplicate create can become a re-date of the existing task. */
  converted?: TaskOp;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function isValidIso(s: string | undefined): s is string {
  if (!s || !ISO.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
/** A date written in prose, which neither the Tasks plugin nor the vault CLI can see. */
const PROSE_DATE = new RegExp(
  `\\b(due|by|on|before|until)\\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(${MONTHS})[a-z]*\\b|\\b(tomorrow|tonight|next week)\\b`,
  "i"
);

const tokens = (s: string) => new Set(normalise(s).split(" ").filter((w) => w.length > 1));
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  x.forEach((t) => y.has(t) && both++);
  return both / (x.size + y.size - both);
}

export const NEAR_DUPLICATE = 0.8;

/**
 * How much of the shorter task's words appear in the other. A short title ("Group project BPE DFA")
 * is almost fully contained in a long description, which plain Jaccard similarity scores too low.
 */
export function containment(a: string, b: string): { score: number; min: number } {
  const x = tokens(a);
  const y = tokens(b);
  const min = Math.min(x.size, y.size);
  if (!min) return { score: 0, min };
  let both = 0;
  x.forEach((t) => y.has(t) && both++);
  return { score: both / min, min };
}

export interface ValidateCtx {
  today: string;
  openTasks: Task[];
}

const findOpen = (ctx: ValidateCtx, ref: TaskRef) =>
  ctx.openTasks.filter((t) => t.path === ref.path && t.raw === ref.expectedText);

/**
 * Decide what to do with each proposed operation. Pure: nothing is written here.
 * Enforces the §4.5 guarantees that don't need the file: dedupe, real dates, no prose-only deadlines.
 */
export function validateOps(ops: TaskOp[], ctx: ValidateCtx): OpResult[] {
  const out: OpResult[] = [];
  const seen: { text: string; due?: string }[] = [];

  for (const op of ops) {
    if (op.op === "create") {
      const text = op.text.trim();
      if (!text) {
        out.push({ op, verdict: "reject", reason: "empty task text" });
        continue;
      }
      if (op.due !== undefined && !isValidIso(op.due)) {
        out.push({ op, verdict: "reject", reason: `due "${op.due}" is not a valid YYYY-MM-DD date` });
        continue;
      }
      if (!op.due && PROSE_DATE.test(text)) {
        out.push({ op, verdict: "reject", reason: "the text names a date but no 📅 due date was given" });
        continue;
      }
      // Near-duplicate of an existing open task (same text, or ≥80% of the same words)?
      const near = ctx.openTasks
        .map((t) => {
          const jac = similarity(t.text, text);
          const c = containment(t.text, text);
          // Containment only counts for 3+ word titles, and only when the dates don't disagree.
          const contained = c.min >= 3 && c.score >= 0.9 && (!op.due || !t.due || op.due === t.due);
          return { t, score: Math.max(jac, contained ? c.score : 0), same: jac >= NEAR_DUPLICATE };
        })
        .filter((x) => x.score >= NEAR_DUPLICATE || x.score >= 0.9)
        .sort((a, b) => b.score - a.score)[0];
      if (near) {
        const at = `${near.t.path}:${near.t.line + 1}`;
        if (near.same && op.due && near.t.due !== op.due) {
          out.push({
            op,
            verdict: "apply",
            reason: `already exists at ${at}; re-dating it instead`,
            converted: { op: "redate", ref: { path: near.t.path, line: near.t.line, expectedText: near.t.raw }, due: op.due, reason: op.reason },
          });
        } else {
          out.push({ op, verdict: "drop", reason: `duplicate of ${at}` });
        }
        continue;
      }
      const twin = seen.find((s) => similarity(s.text, text) >= NEAR_DUPLICATE);
      if (twin) {
        out.push({ op, verdict: "drop", reason: "proposed twice in the same result" });
        continue;
      }
      seen.push({ text, due: op.due });
      out.push({ op: { ...op, text }, verdict: "apply" });
      continue;
    }

    // redate / complete both target an existing open task.
    const matches = findOpen(ctx, op.ref);
    if (!matches.length) {
      out.push({ op, verdict: "reject", reason: `no open task "${op.ref.expectedText.trim().slice(0, 60)}" in ${op.ref.path}` });
      continue;
    }
    if (op.op === "redate") {
      if (!isValidIso(op.due)) out.push({ op, verdict: "reject", reason: `due "${op.due}" is not a valid YYYY-MM-DD date` });
      else if (matches[0].due === op.due) out.push({ op, verdict: "drop", reason: "already has that due date" });
      else out.push({ op, verdict: "apply" });
      continue;
    }
    // complete: the real completion date is required. We never default to today.
    if (!isValidIso(op.doneDate)) out.push({ op, verdict: "reject", reason: "completion needs the real date (YYYY-MM-DD); none given" });
    else if (op.doneDate > ctx.today) out.push({ op, verdict: "reject", reason: `completion date ${op.doneDate} is in the future` });
    else out.push({ op, verdict: "apply" });
  }
  return out;
}

export type Located = { index: number } | { error: "not-found" | "ambiguous" };

/** Find a task's line again after the file may have changed. Aborts rather than guessing. */
export function locateLine(lines: string[], ref: TaskRef): Located {
  if (lines[ref.line] === ref.expectedText) return { index: ref.line };
  const hits = lines.flatMap((l, i) => (l === ref.expectedText ? [i] : []));
  if (hits.length === 1) return { index: hits[0] };
  if (hits.length > 1) return { error: "ambiguous" };
  return { error: "not-found" };
}

/** `- [ ] text #tag 📅 date`. Tagged #task only when the target heading wouldn't count it already. */
export function formatTaskLine(text: string, due: string | undefined, needsTag: boolean, extra: { time?: string; calendar?: boolean | string } = {}): string {
  let t = text.trim().replace(/^[-*]\s*(\[.\]\s*)?/, "");
  if (needsTag && !/(^|\s)#task\b/.test(t)) t += " #task";
  if (extra.calendar) t += ` #${typeof extra.calendar === "string" && extra.calendar ? `cal/${extra.calendar}` : "cal"}`;
  if (due) t += ` 📅 ${due}`;
  if (extra.time) t += ` ⏰ ${extra.time}`;
  return `- [ ] ${t}`;
}

/** A created task with a date must carry the machine-readable marker. */
export function hasDueMarker(line: string): boolean {
  return /📅\s*\d{4}-\d{2}-\d{2}/.test(line);
}
