import { addMinutes } from "../util/time";
import { addDays } from "../util/dates";

/** Everything here is Africa/Johannesburg wall-clock time, which has no daylight saving (always +02:00). */
export const TZ = "Africa/Johannesburg";
export const OFFSET = "+02:00";
export const DEFAULT_MINUTES = 60;
export const DONE_PREFIX = "✓ ";

/** When something happens. No `start` means an all-day item on `date`. */
export interface When {
  date: string;
  start?: string; // HH:MM
  end?: string; // HH:MM
}

export type EventStatus = "confirmed" | "tentative" | "cancelled";

/** A Google Calendar event, reduced to what the sync cares about. */
export interface GEvent {
  id: string;
  calendarId: string;
  etag?: string;
  status: EventStatus;
  summary: string;
  description?: string;
  location?: string;
  /** Null when it can't be represented as a single day (a multi-day event). */
  when: When | null;
  /** Our own marker properties, e.g. vdId. */
  priv: Record<string, string>;
  htmlLink?: string;
}

/** A task that is on the calendar, or carries an id because it once was. */
export interface CalTask {
  id?: string;
  path: string;
  line: number;
  raw: string;
  title: string;
  when: When | null;
  /** On the calendar: "" for #cal or the alias for #cal/alias. Undefined: not on it. */
  cal: string | undefined;
  done: boolean;
  cancelled: boolean;
}

/** What the two sides looked like at the last sync. The base for deciding who changed what. */
export interface CalLink {
  id: string;
  calendarId: string;
  eventId: string;
  etag?: string;
  path: string;
  title: string;
  when: When;
  done: boolean;
  syncedAt: string;
}

export interface CalendarState {
  links: Record<string, CalLink>;
  lastSyncAt?: string;
  lastError?: string;
  lastSummary?: string;
  /** Plan waiting for approval when sync is in manual mode. */
  connectedAs?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The end a timed item effectively has: its own, or an hour after it starts. */
export const effectiveEnd = (w: When): string | undefined => (w.start ? (w.end ?? addMinutes(w.start, DEFAULT_MINUTES)) : undefined);

export function sameWhen(a: When | null | undefined, b: When | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.date === b.date && (a.start ?? "") === (b.start ?? "") && (effectiveEnd(a) ?? "") === (effectiveEnd(b) ?? "");
}

/** A task's text as an event title: no tags, no @mentions, links reduced to their text. */
export function cleanTitle(text: string): string {
  return text
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/(^|\s)#[\w/-]+/g, " ")
    .replace(/(^|\s)@[\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const withDone = (title: string, done: boolean) => (done ? `${DONE_PREFIX}${title}` : title);
export const stripDone = (summary: string) => (summary.startsWith(DONE_PREFIX) ? summary.slice(DONE_PREFIX.length) : summary).trim();

/** The Google API body for an item. */
export function eventBody(o: { title: string; when: When; done: boolean; description: string; vdId: string; vdPath: string }) {
  const { when } = o;
  const base = {
    summary: withDone(o.title, o.done),
    description: o.description,
    transparency: o.done ? "transparent" : "opaque",
    extendedProperties: { private: { vdId: o.vdId, vdPath: o.vdPath } },
  };
  if (!when.start) return { ...base, start: { date: when.date }, end: { date: addDays(when.date, 1) } };
  const end = effectiveEnd(when)!;
  return {
    ...base,
    start: { dateTime: `${when.date}T${when.start}:00${OFFSET}`, timeZone: TZ },
    end: { dateTime: `${when.date}T${end}:00${OFFSET}`, timeZone: TZ },
  };
}

/** Read a Google event's start/end into a single-day When, in Johannesburg time. */
export function whenFromGoogle(start?: { date?: string; dateTime?: string }, end?: { date?: string; dateTime?: string }): When | null {
  if (start?.date) {
    // An all-day event spanning several days ends later than the next day.
    if (end?.date && end.date > addDays(start.date, 1)) return null;
    return { date: start.date };
  }
  if (!start?.dateTime) return null;
  const sast = (iso: string) => new Date(Date.parse(iso) + 2 * 3_600_000).toISOString();
  const s = sast(start.dateTime);
  const date = s.slice(0, 10);
  const out: When = { date, start: s.slice(11, 16) };
  if (end?.dateTime) {
    const e = sast(end.dateTime);
    if (e.slice(0, 10) === date) out.end = e.slice(11, 16);
    else if (e.slice(0, 10) > date && e.slice(11, 16) !== "00:00") return null; // runs into another day
    else out.end = "23:59";
  }
  return out;
}

export function describeWhen(w: When): string {
  return w.start ? `${w.date} ${w.start}${w.end ? `–${w.end}` : ""}` : `${w.date} (all day)`;
}
