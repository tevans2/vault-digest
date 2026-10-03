import { addDays } from "../util/dates";
import { findDate, findPastDate, parseCapture } from "../writers/capture";
import { findTime } from "../util/time";
import { descriptionOf } from "./taskline";
import type { AnnouncementSubject, Interpretation, MessageSubject, Op, Priority, RadarSubject, Subject, TaskPatch, TaskSubject, TextSubject } from "./types";

/**
 * The predictable 80%: short instructions about a thing you've pointed at. Understood locally, instantly and
 * for free. Anything it can't read confidently goes to the agent, which is given the same subjects.
 */

export interface GrammarCtx {
  today: string;
  courses: string[];
  /** Calendar aliases from settings, so "calendar uni" can mean #cal/uni. */
  calAliases?: string[];
}

const FILLER = /\b(move|push|set|make|change|reschedule|re-?date|postpone|delay|bump|shift|to|until|till|by|on|for|due|it|this|that|the|date|deadline|these|them|all|now|please|pls)\b/g;
const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

const clean = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
const noun = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "Tue 6 Oct" */
export function dayLabel(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-ZA", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).formatToParts(new Date(iso + "T00:00:00Z")).map((x) => [x.type, x.value]));
  return `${p.weekday} ${Number(p.day)} ${p.month}`.replace(/\.$/, "");
}

/** A due date in words → one ISO date, if the text is *only* a date (no other instruction mixed in). */
function pureDate(s: string, today: string): { due: string; label: string } | null {
  const found = findDate(s, today);
  if (!found) return null;
  const rest = s.toLowerCase().replace(found.label, " ").replace(FILLER, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return rest ? null : { due: found.due, label: found.label };
}

/** "3 days", "a week", "+2w", "next week": a shift, in days, from the later of the due date and today. */
function shiftDays(s: string): number | null {
  const l = s.toLowerCase().replace(FILLER, " ").replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  if (l === "next week" || l === "a week" || l === "week") return 7;
  if ((m = /^\+?\s*(\d+|a|an|one|two|three|four|five)\s*(d|day|days|w|wk|wks|week|weeks)$/.exec(l))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : (WORD_NUM[m[1]] ?? 1);
    return n * (m[2].startsWith("w") ? 7 : 1);
  }
  return null;
}

function priorityOf(s: string): Priority | null {
  const l = s.toLowerCase().replace(/^(set |make it |mark |priority |prio )+/, "").trim();
  if (/^(p0|highest|critical|asap)$/.test(l)) return "highest";
  if (/^(p1|urgent|high|important)$/.test(l)) return "high";
  if (/^(p2|medium|med)$/.test(l)) return "medium";
  if (/^(p3|low)$/.test(l)) return "low";
  if (/^(p4|lowest)$/.test(l)) return "lowest";
  if (/^(normal|none|no priority|clear priority|unprioriti[sz]e)$/.test(l)) return "none";
  return null;
}

function taskPatch(s: string, ctx: GrammarCtx, subject?: TaskSubject): { patch: TaskPatch; says: string } | null {
  const l = s.toLowerCase();
  let m: RegExpExecArray | null;

  if (/^(clear|remove|no|drop)\s+(the\s+)?(date|due|deadline)(\s+date)?$/.test(l)) return { patch: { due: null }, says: "clear the date" };

  if ((m = /^(done|finished|complete|completed|tick|ticked|did it|finish)(?:\s+(.*))?$/.exec(l))) {
    const rest = (m[2] ?? "").trim();
    if (!rest) return { patch: { status: "done", statusDate: ctx.today }, says: "mark done" };
    const d = findPastDate(rest, ctx.today);
    return d && !rest.replace(d.label, "").replace(/\b(on|last|at|was)\b/g, "").trim() ? { patch: { status: "done", statusDate: d.due }, says: `mark done on ${dayLabel(d.due)}` } : null;
  }
  if (/^(drop|cancel|cancelled|delete|remove|trash|scrap|abandon)(\s+(it|this|these|them))?$/.test(l)) return { patch: { status: "cancelled", statusDate: ctx.today }, says: "cancel" };
  if (/^(reopen|re-open|not done|open)$/.test(l)) return { patch: { status: "open" }, says: "reopen" };
  if (/^(not waiting|unwait|unblocked|no longer waiting|stop waiting)$/.test(l)) return { patch: { removeTags: ["waiting"] }, says: "no longer waiting" };
  if ((m = /^(?:waiting|blocked)(?:\s+(?:on|for))?\s*(.*)$/.exec(l))) {
    const who = m[1].replace(/['’]s\b.*$/, "").trim().split(/\s+/)[0];
    return { patch: { addTags: ["waiting"], mention: who && /^[\p{L}][\p{L}\p{N}_-]*$/u.test(who) ? who : undefined }, says: `waiting${who ? ` on ${who}` : ""}` };
  }
  const pr = priorityOf(l);
  if (pr) return { patch: { priority: pr }, says: pr === "none" ? "clear priority" : `priority ${pr}` };

  if ((m = /^(rename|retitle|call it|text|title)(?:\s+to)?\s*:?\s+(.+)$/i.exec(s))) return { patch: { text: m[2].trim() }, says: `rename to “${m[2].trim()}”` };
  if ((m = /^(?:course|for)\s+([a-z]{2}\d{3})$/i.exec(l)) && subject) {
    const code = m[1].toUpperCase();
    const desc = descriptionOf(subject.raw.replace(/^\s*[-*+]\s+\[.\]\s+/, "- [ ] "));
    if (new RegExp(`^\\W*${code}\\b`).test(desc)) return null;
    return { patch: { text: `${code} ${desc}` }, says: `file under ${code}` };
  }
  return null;
}

const CAL_WORDS = /\b(put|add|on|onto|to|in|into|the|my|calendar|cal|schedule|book|block|it|this|these|them)\b/g;

/** "calendar friday 2pm", "at 14:00-15:30", "tomorrow 9am", "put on the calendar", "no calendar", "all day". */
function whenAndCalendar(s: string, subjects: TaskSubject[], ctx: GrammarCtx): Interpretation | null {
  const l = s.toLowerCase();
  const them = subjects.length === 1 ? "task" : `${subjects.length} tasks`;
  const make = (patch: TaskPatch, says: string): Interpretation => ({ kind: "ops", ops: subjects.map((subject): Op => ({ k: "task.patch", subject, patch })), summary: `${says}: ${them}` });

  if (/^(no|off|remove from|take off|not on|un-?)\s*(the\s+)?(calendar|cal)$|^uncal(endar)?$/.test(l)) return make({ calendar: false }, "Take off the calendar");
  if (/^(all[- ]day|no time|clear (the )?time)$/.test(l)) return make({ time: null }, "Make all-day");

  const hasCal = /\b(calendar|cal|schedule|book|block)\b/.test(l);
  const time = findTime(l);
  const date = findDate(l, ctx.today);
  // What's left once the date, the time and the calendar words are removed must be empty or a known alias.
  let rest = l;
  if (time) rest = rest.replace(time.label, " ");
  if (date) rest = rest.replace(date.label, " ");
  rest = rest.replace(CAL_WORDS, " ").replace(FILLER, " ").replace(/\b(at|from|until|till|-|–)\b/g, " ").replace(/[^a-z0-9/-]+/g, " ").trim();
  const alias = rest && ctx.calAliases?.includes(rest) ? rest : undefined;
  if (rest && !alias) return null;
  if (!hasCal && !time && !date) return null;
  if (!hasCal && !time) return null; // a bare date is handled as a re-date by the caller

  const patch: TaskPatch = {};
  const bits: string[] = [];
  if (date) {
    patch.due = date.due;
    bits.push(dayLabel(date.due));
  }
  if (time) {
    patch.time = time.end ? `${time.start}-${time.end}` : time.start;
    bits.push(time.end ? `${time.start}–${time.end}` : time.start);
  }
  if (hasCal) {
    patch.calendar = alias ?? true;
    bits.push("on the calendar");
  }
  return make(patch, bits.join(", ").replace(/^./, (c) => c.toUpperCase()));
}

function tasks(s: string, subjects: TaskSubject[], ctx: GrammarCtx): Interpretation | null {
  const n = subjects.length;
  const them = n === 1 ? "task" : `${n} tasks`;

  // Times and the calendar come first: "friday 2pm" is a time, not a bare re-date.
  const wc = whenAndCalendar(s, subjects, ctx);
  if (wc) return wc;

  // A date: absolute ("next tues") or a shift ("push 3 days").
  const abs = pureDate(s, ctx.today);
  if (abs) {
    return { kind: "ops", ops: subjects.map((subject): Op => ({ k: "task.patch", subject, patch: { due: abs.due } })), summary: `Move ${them} to ${dayLabel(abs.due)}` };
  }
  const days = shiftDays(s);
  if (days !== null) {
    const ops: Op[] = subjects.map((subject) => {
      const from = subject.due && subject.due > ctx.today ? subject.due : ctx.today;
      return { k: "task.patch", subject, patch: { due: addDays(from, days) } };
    });
    return { kind: "ops", ops, summary: `Push ${them} by ${noun(days, "day")}` };
  }

  // "course X" rewrites each task's text, so it is worked out per subject.
  if (/^(?:course|for)\s+[a-z]{2}\d{3}$/i.test(s)) {
    let says = "";
    const ops = subjects.flatMap((subject): Op[] => {
      const one = taskPatch(s, ctx, subject);
      if (!one) return [];
      says = one.says;
      return [{ k: "task.patch", subject, patch: one.patch }];
    });
    return ops.length ? { kind: "ops", ops, summary: `${says[0].toUpperCase()}${says.slice(1)}: ${noun(ops.length, "task")}` } : null;
  }

  const r = taskPatch(s, ctx, n === 1 ? subjects[0] : undefined);
  if (!r) return null;
  return { kind: "ops", ops: subjects.map((subject): Op => ({ k: "task.patch", subject, patch: r.patch })), summary: `${r.says[0].toUpperCase()}${r.says.slice(1)}: ${them}` };
}

function messages(s: string, subjects: MessageSubject[], ctx: GrammarCtx): Interpretation | null {
  const l = s.toLowerCase();
  if (/^(ignore|skip|junk|spam|not relevant)$/.test(l)) {
    return { kind: "ops", ops: subjects.map((m): Op => ({ k: "message.status", path: m.path, status: "ignored", summary: "ignored" })), summary: `Ignore ${subjects.length === 1 ? "message" : `${subjects.length} messages`}` };
  }
  if (/^(done|ack|acknowledge|acknowledged|noted|ok|seen|read|got it)$/.test(l)) {
    return { kind: "ops", ops: subjects.map((m): Op => ({ k: "message.status", path: m.path, status: "acknowledged", summary: "noted" })), summary: `Mark ${subjects.length === 1 ? "message" : `${subjects.length} messages`} noted` };
  }
  const m = /^(?:add\s+)?(?:task|todo|to-do|remind me(?: to)?)\b[:\s-]*(.*)$/i.exec(s);
  if (m) {
    const rest = m[1].trim();
    const ops: Op[] = [];
    for (const msg of subjects) {
      const found = findDate(rest, ctx.today) ?? findDate(msg.excerpt, ctx.today);
      let text = rest;
      if (found && text) text = text.replace(new RegExp(found.label, "i"), " ");
      text = text.replace(/\b(by|on|for|due|before)\s*$/i, "").replace(/\s+/g, " ").trim() || msg.excerpt.replace(/\s+/g, " ").trim();
      const c = parseCapture(text, ctx.today, ctx.courses);
      ops.push({ k: "task.create", text: c.text, due: found?.due ?? c.due, course: c.course }, { k: "message.status", path: msg.path, status: "actioned", summary: "made a task" });
    }
    return { kind: "ops", ops, summary: `Make ${subjects.length === 1 ? "a task" : `${subjects.length} tasks`} from ${subjects.length === 1 ? "the message" : "the messages"}` };
  }
  return null;
}

function announcements(s: string, subjects: AnnouncementSubject[], ctx: GrammarCtx): Interpretation | null {
  const l = s.toLowerCase();
  if (/^(ack|acknowledge|dismiss|done|ok|hide|got it|seen|clear)$/.test(l)) {
    return { kind: "ops", ops: subjects.map((a): Op => ({ k: "announcement.ack", id: a.id })), summary: `Dismiss ${subjects.length === 1 ? "announcement" : `${subjects.length} announcements`}` };
  }
  const m = /^snooze(?:\s+(.*))?$/.exec(l);
  if (m) {
    const rest = (m[1] ?? "").trim();
    const days = !rest ? 1 : shiftDays(rest);
    const date = days !== null ? addDays(ctx.today, days) : (pureDate(rest, ctx.today)?.due ?? null);
    if (!date) return null;
    const until = new Date(Date.parse(`${date}T06:00:00+02:00`)).toISOString();
    return { kind: "ops", ops: subjects.map((a): Op => ({ k: "announcement.snooze", id: a.id, until })), summary: `Snooze until ${dayLabel(date)}` };
  }
  return null;
}

function radar(s: string, subjects: RadarSubject[], ctx: GrammarCtx): Interpretation | null {
  const l = s.toLowerCase();
  let m: RegExpExecArray | null;
  if (/^(drop|remove|delete)$/.test(l)) return { kind: "ops", ops: subjects.map((r): Op => ({ k: "radar.remove", id: r.id })), summary: "Remove from the radar" };
  if (subjects.length !== 1) return null;
  const r = subjects[0];
  if ((m = /^(?:weight|worth)\s+(\d+(?:\.\d+)?)\s*%?$/.exec(l))) return { kind: "ops", ops: [{ k: "radar.patch", id: r.id, patch: { weight: Number(m[1]) } }], summary: `Set the weight to ${m[1]}%` };
  if ((m = /^rename\s+(.+)$/i.exec(s))) return { kind: "ops", ops: [{ k: "radar.patch", id: r.id, patch: { name: m[1].trim() } }], summary: `Rename to “${m[1].trim()}”` };

  const time = /\b(?:at\s+)?(\d{1,2}):(\d{2})\b/.exec(l);
  const withoutTime = time ? l.replace(time[0], " ") : l;
  const dated = pureDate(withoutTime, ctx.today) ?? (time ? (withoutTime.replace(FILLER, " ").trim() === "" ? { due: (r.due ?? ctx.today).slice(0, 10), label: "" } : null) : null);
  if (!dated) return null;
  const hh = time ? `${time[1].padStart(2, "0")}:${time[2]}` : r.due?.includes("T") ? r.due.slice(11, 16) : "";
  const due = hh ? `${dated.due}T${hh}` : dated.due;
  return { kind: "ops", ops: [{ k: "radar.patch", id: r.id, patch: { due } }], summary: `Move to ${dayLabel(dated.due)}${hh ? ` ${hh}` : ""}` };
}

/** Highlighted text plus "task friday": a task from those words, linked back to the note they came from. */
function text(s: string, subjects: TextSubject[], ctx: GrammarCtx): Interpretation | null {
  const m = /^(?:add\s+)?(?:task|todo|to-do|remind me(?: to)?)\b[:\s-]*(.*)$/i.exec(s);
  if (!m || subjects.length !== 1) return null;
  const sub = subjects[0];
  const rest = m[1].trim();
  const found = findDate(rest, ctx.today) ?? findDate(sub.text, ctx.today);
  let body = rest;
  if (found && body) body = body.replace(new RegExp(found.label, "i"), " ");
  body = body.replace(/\b(by|on|for|due|before)\s*$/i, "").replace(/\s+/g, " ").trim() || sub.text.replace(/\s+/g, " ").trim();
  const link = sub.sourcePath ? ` [[${(sub.sourcePath.split("/").pop() ?? "").replace(/\.md$/, "")}]]` : "";
  const c = parseCapture(`${body}${link}`, ctx.today, ctx.courses);
  return { kind: "ops", ops: [{ k: "task.create", text: c.text, due: found?.due ?? c.due, course: c.course }], summary: `New task from the selected text${found ? ` due ${dayLabel(found.due)}` : ""}` };
}

const QUESTION = /^(what|when|why|how|which|who|where|show|list|tell me|am i|is there|do i|are there)\b/i;

export function interpret(input: string, subjects: Subject[], ctx: GrammarCtx): Interpretation {
  const s = clean(input.replace(/^(please|pls|can you|could you|just)\s+/i, ""));
  if (!s) return { kind: "agent", reason: "empty" };

  if (!subjects.length) {
    if (/^\?/.test(s) || /\?$/.test(s) || QUESTION.test(s)) return { kind: "question", text: s.replace(/^\?\s*/, "") };
    const c = parseCapture(s, ctx.today, ctx.courses);
    return { kind: "ops", ops: [{ k: "task.create", text: c.text, due: c.due, course: c.course }], summary: `New task${c.due ? ` due ${dayLabel(c.due)}` : ""}` };
  }

  // A leading question mark means "answer me", even with something selected.
  if (/^\?/.test(s)) return { kind: "question", text: s.replace(/^\?\s*/, "") };

  const types = new Set(subjects.map((x) => x.type));
  if (types.size > 1) return { kind: "agent", reason: "mixed" };
  const type = subjects[0].type;
  let r: Interpretation | null = null;
  if (type === "task") r = tasks(s, subjects as TaskSubject[], ctx);
  else if (type === "message") r = messages(s, subjects as MessageSubject[], ctx);
  else if (type === "announcement") r = announcements(s, subjects as AnnouncementSubject[], ctx);
  else if (type === "radar") {
    const rs = subjects as RadarSubject[];
    if (rs.some((x) => !x.editable)) return { kind: "blocked", message: "That deadline is read from the Task Board table. Run a brief to make the radar editable, then try again." };
    r = radar(s, rs, ctx);
  } else if (type === "text") r = text(s, subjects as TextSubject[], ctx);
  else if (type === "event") return { kind: "blocked", message: "Calendar events can't be edited yet." };
  return r ?? { kind: "agent", reason: "unrecognised" };
}
