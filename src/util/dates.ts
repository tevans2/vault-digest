export const TZ = "Africa/Johannesburg";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(d: Date) {
  const o: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** YYYY-MM-DD in Africa/Johannesburg. */
export function isoDate(d: Date = new Date()): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes since local midnight in Africa/Johannesburg. */
export function minutesOfDay(d: Date = new Date()): number {
  const p = parts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Whole days from a to b (both YYYY-MM-DD). Positive when b is later. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Moment-style YYYYMMDD style formatting for the daily-notes setting (YYYY, MM, DD only). */
export function formatDaily(format: string, iso: string): string {
  const [y, m, d] = iso.split("-");
  return format.replace(/YYYY/g, y).replace(/MM/g, m).replace(/DD/g, d);
}

export function longDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

export function shortDue(iso: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso + "T00:00:00Z"));
}

export function timeOfDay(d: Date = new Date()): string {
  const p = parts(d);
  return `${p.hour}:${p.minute}`;
}

/** Relative age like "3d", "5h", "12m". */
export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parse loose due text like "Fri 2 Oct", "Mon 5 Oct, 14:00" or "~16 Oct" into an
 * epoch (SAST). Year is inferred from `today`; no time means end of day.
 */
export function parseDueText(text: string, today: string): number | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*(?:[,\s]+(\d{1,2}):(\d{2}))?/.exec(text);
  if (!m) return undefined;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return undefined;
  const pad = (n: number | string) => String(n).padStart(2, "0");
  let year = Number(today.slice(0, 4));
  const build = (y: number) =>
    Date.parse(`${y}-${pad(mi + 1)}-${pad(m[1])}T${m[3] ? `${pad(m[3])}:${m[4]}` : "23:59"}:00+02:00`);
  let t = build(year);
  // A date far in the past means next year (e.g. "15 Jan" read in December).
  if (t < Date.parse(today + "T00:00:00+02:00") - 180 * 86_400_000) t = build(++year);
  return Number.isNaN(t) ? undefined : t;
}

/** Build a regex that matches a daily-note basename for a YYYY/MM/DD style format. */
export function dailyNameToIso(format: string, basename: string): string | undefined {
  const esc = format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const order: string[] = [];
  const re = new RegExp(
    "^" + esc.replace(/YYYY|MM|DD/g, (t) => (order.push(t), t === "YYYY" ? "(\\d{4})" : "(\\d{2})")) + "$"
  );
  const m = re.exec(basename);
  if (!m) return undefined;
  const get = (t: string) => m[order.indexOf(t) + 1];
  if (!get("YYYY") || !get("MM") || !get("DD")) return undefined;
  return `${get("YYYY")}-${get("MM")}-${get("DD")}`;
}
