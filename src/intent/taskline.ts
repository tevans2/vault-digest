import type { Priority, TaskPatch } from "./types";

/** Edit one task line. Pure: returns the new line, or why it can't. */

const LINE = /^(\s*[-*+]\s+\[)(.)(\]\s+)(.*)$/;
const PRIORITY_EMOJI: Record<Exclude<Priority, "none">, string> = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" };
const PRIORITY_RE = /\s?[🔺⏫🔼🔽⏬]️?/gu;
/** Where the description ends and the markers (dates, priority, recurrence) begin. */
const MARKER_START = /[📅⏳🛫✅❌➕🔁🔺⏫🔼🔽⏬⏰🆔]/u;

export type PatchResult = { line: string } | { error: string };

const tagRe = (t: string) => new RegExp(`(^|\\s)#${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

/** The description part of a task body (before any marker), and the rest. */
function split(body: string): { desc: string; rest: string } {
  const i = body.search(MARKER_START);
  return i < 0 ? { desc: body.trimEnd(), rest: "" } : { desc: body.slice(0, i).trimEnd(), rest: body.slice(i) };
}

export function patchTaskLine(line: string, p: TaskPatch, today: string): PatchResult {
  const m = LINE.exec(line);
  if (!m) return { error: "that isn't a task line" };
  const [, pre, mark, mid] = m;
  let body = m[4];
  let marker = mark;
  const recurring = body.includes("🔁");

  if (p.text !== undefined) {
    const t = p.text.trim().replace(/\s+/g, " ");
    if (!t) return { error: "the new text is empty" };
    if (MARKER_START.test(t)) return { error: "put dates in the due date, not the text" };
    const { rest } = split(body);
    body = rest ? `${t} ${rest}` : t;
  }

  if (p.due !== undefined) {
    if (p.due === null) body = body.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/, "");
    else if (/📅\s*\d{4}-\d{2}-\d{2}/.test(body)) body = body.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${p.due}`);
    else body = `${body.trimEnd()} 📅 ${p.due}`;
  }

  if (p.time !== undefined) {
    const TIME = /\s*⏰\s*\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/u;
    if (p.time === null) body = body.replace(TIME, "");
    else if (TIME.test(body)) body = body.replace(TIME, ` ⏰ ${p.time}`);
    else if (/📅\s*\d{4}-\d{2}-\d{2}/.test(body)) body = body.replace(/(📅\s*\d{4}-\d{2}-\d{2})/, `$1 ⏰ ${p.time}`);
    else body = `${body.trimEnd()} ⏰ ${p.time}`;
  }

  if (p.priority !== undefined) {
    body = body.replace(PRIORITY_RE, "");
    if (p.priority !== "none") {
      const { desc, rest } = split(body);
      body = rest ? `${desc} ${PRIORITY_EMOJI[p.priority]} ${rest}` : `${desc} ${PRIORITY_EMOJI[p.priority]}`;
    }
  }

  if (p.calendar !== undefined) {
    body = body.replace(/\s*#cal(?:\/[\w-]+)?\b/gi, "");
    if (p.calendar !== false) {
      const tag = typeof p.calendar === "string" && p.calendar ? `cal/${p.calendar}` : "cal";
      const { desc, rest } = split(body);
      body = rest ? `${desc} #${tag} ${rest}` : `${desc} #${tag}`;
    }
  }
  if (p.id && !/🆔\s*[\w-]+/u.test(body)) body = `${body.trimEnd()} 🆔 ${p.id}`;

  for (const t of p.removeTags ?? []) body = body.replace(new RegExp(`\\s*#${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "");
  for (const t of p.addTags ?? []) {
    if (tagRe(t).test(body)) continue;
    const { desc, rest } = split(body);
    body = rest ? `${desc} #${t} ${rest}` : `${desc} #${t}`;
  }
  if (p.mention) {
    const name = p.mention.replace(/^@/, "").replace(/[^\p{L}\p{N}_-]/gu, "");
    if (name && !new RegExp(`(^|\\s)@${name}\\b`, "i").test(body)) {
      const { desc, rest } = split(body);
      body = rest ? `${desc} @${name} ${rest}` : `${desc} @${name}`;
    }
  }

  if (p.status) {
    if (recurring && p.status !== "open") return { error: "this is a recurring task. Tick it in Obsidian so the next one is created" };
    const date = p.statusDate ?? today;
    body = body.replace(/\s*[✅❌]\s*\d{4}-\d{2}-\d{2}/gu, "");
    if (p.status === "done") {
      if (mark === "x" || mark === "X") return { error: "it's already done" };
      marker = "x";
      body = `${body.trimEnd()} ✅ ${date}`;
    } else if (p.status === "cancelled") {
      if (mark === "-") return { error: "it's already cancelled" };
      marker = "-";
      body = `${body.trimEnd()} ❌ ${date}`;
    } else {
      if (mark === " ") return { error: "it's already open" };
      marker = " ";
    }
  }

  const out = `${pre}${marker}${mid}${body.replace(/\s{2,}/g, " ").trimEnd()}`;
  return out === line ? { error: "that wouldn't change anything" } : { line: out };
}

/** The due date on a task line, if any. */
export const dueOf = (line: string) => /📅\s*(\d{4}-\d{2}-\d{2})/.exec(line)?.[1];

/** The description of a task line (no checkbox, no dates or markers). */
export function descriptionOf(line: string): string {
  const m = LINE.exec(line);
  return m ? split(m[4]).desc : line;
}
