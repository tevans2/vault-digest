import { addDays } from "../util/dates";

/** `cs344 hand in A2 friday` → a dated task. Pure, so the preview and the write always agree. */

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT: Record<string, number> = { mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const dow = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();

/** The next given weekday strictly after `today` ("friday" on a Friday means next Friday). */
export function nextWeekday(today: string, target: number): string {
  let d = (target - dow(today) + 7) % 7;
  if (d === 0) d = 7;
  return addDays(today, d);
}

/** "next friday" means that weekday in the week starting next Monday. */
export function weekdayNextWeek(today: string, target: number): string {
  let toMon = (1 - dow(today) + 7) % 7;
  if (toMon === 0) toMon = 7;
  return addDays(today, toMon + ((target - 1 + 7) % 7));
}

export interface Capture {
  text: string;
  due?: string;
  /** What was understood, for the preview chip. */
  dateLabel?: string;
  course?: string;
}

export interface FoundDate {
  due: string;
  /** The exact words that were read as a date. */
  label: string;
}

/** Find a date written in words: friday, tomorrow, next tues, 14 oct, in 3 days, 2026-11-01. */
export function findDate(input: string, today: string): FoundDate | undefined {
  const t = input.toLowerCase();
  let m: RegExpExecArray | null;
  const hit = (due: string, label: string): FoundDate => ({ due, label });
  if ((m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t))) return hit(m[1], m[1]);
  if ((m = /\b(today|tonight|eod)\b/.exec(t))) return hit(today, m[0]);
  if ((m = /\b(tomorrow|tmrw)\b/.exec(t))) return hit(addDays(today, 1), m[0]);
  if ((m = /\bin (\d{1,2}) (day|days|week|weeks)\b/.exec(t))) return hit(addDays(today, Number(m[1]) * (m[2].startsWith("week") ? 7 : 1)), m[0]);
  // "next friday" / "next tues" mean that weekday in the week starting next Monday.
  if ((m = new RegExp(`\\bnext (${DAYS.join("|")})\\b`).exec(t))) return hit(weekdayNextWeek(today, DAYS.indexOf(m[1])), m[0]);
  if ((m = /\bnext (mon|tues?|wed|thur?s?|fri)\b/.exec(t))) return hit(weekdayNextWeek(today, SHORT[m[1]]), m[0]);
  if ((m = new RegExp(`\\b(${DAYS.join("|")})\\b`).exec(t))) return hit(nextWeekday(today, DAYS.indexOf(m[1])), m[1]);
  if ((m = /\b(?:by|on|due|this) (mon|tues?|wed|thur?s?|fri)\b/.exec(t))) return hit(nextWeekday(today, SHORT[m[1]]), m[0]);
  if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS.join("|")})[a-z]*\\b`).exec(t))) return hit(monthDay(today, MONTHS.indexOf(m[2]), Number(m[1])), m[0]);
  if ((m = new RegExp(`\\b(${MONTHS.join("|")})[a-z]* (\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t))) return hit(monthDay(today, MONTHS.indexOf(m[1]), Number(m[2])), m[0]);
  return undefined;
}

/** A date in the past, for "done yesterday" / "done monday": the most recent such day. */
export function findPastDate(input: string, today: string): FoundDate | undefined {
  const t = input.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t))) return { due: m[1], label: m[1] };
  if ((m = /\btoday\b/.exec(t))) return { due: today, label: m[0] };
  if ((m = /\byesterday\b/.exec(t))) return { due: addDays(today, -1), label: m[0] };
  if ((m = /\b(\d{1,2}) days? ago\b/.exec(t))) return { due: addDays(today, -Number(m[1])), label: m[0] };
  const back = (target: number) => {
    let d = (dow(today) - target + 7) % 7;
    if (d === 0) d = 7;
    return addDays(today, -d);
  };
  if ((m = new RegExp(`\\b(?:on |last )?(${DAYS.join("|")})\\b`).exec(t))) return { due: back(DAYS.indexOf(m[1])), label: m[0] };
  if ((m = /\b(?:on |last )(mon|tues?|wed|thur?s?|fri)\b/.exec(t))) return { due: back(SHORT[m[1]]), label: m[0] };
  return undefined;
}

export function parseCapture(input: string, today: string, courses: string[]): Capture {
  let text = input.trim().replace(/\s+/g, " ");
  const result: Capture = { text };

  const lead = new RegExp(`^\\W*(${courses.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "$^"})\\b`, "i").exec(text);
  if (lead) {
    result.course = lead[1].toUpperCase();
    text = result.course + text.slice(lead[0].length);
    result.text = text;
  }

  const found = findDate(text, today);
  if (found) {
    result.due = found.due;
    result.dateLabel = found.label;
  }
  return result;
}

function monthDay(today: string, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  let y = Number(today.slice(0, 4));
  let iso = `${y}-${pad(month + 1)}-${pad(day)}`;
  if (iso < today) iso = `${++y}-${pad(month + 1)}-${pad(day)}`;
  return iso;
}
