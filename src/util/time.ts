/** Times of day written in words: 2pm, 2:30pm, 14:00, 14h30, 2-3pm, 14:00-15:30, noon. */

export interface TimeRange {
  /** "HH:MM", 24-hour. */
  start: string;
  end?: string;
  /** The exact words that were read as a time. */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;
const ok = (h: number, m: number) => Number.isInteger(h) && h >= 0 && h <= 23 && m >= 0 && m <= 59;

function to24(h: number, ampm?: string): number {
  if (!ampm) return h;
  if (h < 1 || h > 12) return -1;
  return (h % 12) + (ampm === "pm" ? 12 : 0);
}

export function findTime(input: string): TimeRange | undefined {
  const t = input.toLowerCase();
  let m: RegExpExecArray | null;

  // 14:00-15:30, 14h00 to 15h30
  if ((m = /\b(\d{1,2})[:h](\d{2})\s*(?:-|–|to|until|till)\s*(\d{1,2})[:h](\d{2})\b/.exec(t))) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
    if (ok(a, b) && ok(c, d)) return { start: hm(a, b), end: hm(c, d), label: m[0] };
  }
  // 2-3pm, 2pm-3:30pm, 11-1pm
  if ((m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t))) {
    const endAp = m[6];
    const startAp = m[3] ?? endAp;
    let sh = to24(Number(m[1]), startAp);
    const eh = to24(Number(m[4]), endAp);
    const sm = Number(m[2] ?? 0);
    const em = Number(m[5] ?? 0);
    // "11-1pm" means 11am: if inheriting pm puts the start after the end, the start was am.
    if (!m[3] && sh > eh && startAp === "pm") sh = to24(Number(m[1]), "am");
    if (sh >= 0 && eh >= 0 && ok(sh, sm) && ok(eh, em)) return { start: hm(sh, sm), end: hm(eh, em), label: m[0] };
  }
  // 2pm, 2:30pm
  if ((m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t))) {
    const h = to24(Number(m[1]), m[3]);
    const min = Number(m[2] ?? 0);
    if (h >= 0 && ok(h, min)) return { start: hm(h, min), label: m[0] };
  }
  // 14:00, 14h30
  if ((m = /\b(\d{1,2})[:h](\d{2})\b/.exec(t))) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (ok(h, min)) return { start: hm(h, min), label: m[0] };
  }
  if ((m = /\b(noon|midday)\b/.exec(t))) return { start: "12:00", label: m[0] };
  return undefined;
}

/** Minutes between two HH:MM times on the same day. */
export function minutesBetween(a: string, b: string): number {
  const f = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return f(b) - f(a);
}

/** Add minutes to an HH:MM time, staying within the day. */
export function addMinutes(t: string, mins: number): string {
  const total = Math.min(23 * 60 + 59, Math.max(0, Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + mins));
  return hm(Math.floor(total / 60), total % 60);
}
