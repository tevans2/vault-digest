import type { Net, NetResponse } from "../messages/net";
import { redact } from "../messages/net";
import { GEvent, whenFromGoogle } from "./model";
import { AuthError, GoogleAuth } from "./oauth";

const BASE = "https://www.googleapis.com/calendar/v3";

export type ApiErrorKind = "auth" | "forbidden" | "not-found" | "gone" | "conflict" | "rate" | "server" | "network" | "bad-request";

export class ApiError extends Error {
  constructor(message: string, public kind: ApiErrorKind, public status?: number) {
    super(redact(message));
  }
}

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  /** owner / writer can be written to; reader / freeBusyReader can't. */
  role: string;
}

interface RawEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export function toEvent(calendarId: string, r: RawEvent): GEvent {
  return {
    id: r.id ?? "",
    calendarId,
    etag: r.etag,
    status: r.status === "cancelled" ? "cancelled" : r.status === "tentative" ? "tentative" : "confirmed",
    summary: r.summary ?? "",
    description: r.description,
    location: r.location,
    // A cancelled event has no start, so its time is unknown (and irrelevant).
    when: whenFromGoogle(r.start, r.end),
    priv: r.extendedProperties?.private ?? {},
    htmlLink: r.htmlLink,
  };
}

const RETRY_MS = [500, 1500, 4000];

export class GoogleCalendar {
  constructor(private net: Net, private auth: GoogleAuth, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  /** One request, with a token, one refresh if Google says the token is stale, and a few retries for 429/5xx. */
  private async call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: { body?: unknown; etag?: string } = {}): Promise<NetResponse> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: NetResponse;
      try {
        const token = await this.auth.accessToken();
        res = await this.net(`${BASE}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(opts.etag ? { "If-Match": opts.etag } : {}) },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), contentType: "application/json" } : {}),
        });
      } catch (e) {
        if (e instanceof AuthError) throw new ApiError(e.message, "auth");
        if (attempt < RETRY_MS.length) {
          await this.sleep(RETRY_MS[attempt]);
          continue;
        }
        throw new ApiError(`Couldn't reach Google Calendar: ${(e as Error).message}`, "network");
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.auth.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < RETRY_MS.length) {
        await this.sleep(RETRY_MS[attempt]);
        continue;
      }
      return res;
    }
  }

  private fail(res: NetResponse, what: string): never {
    const msg = (res.json as { error?: { message?: string } } | undefined)?.error?.message;
    const s = res.status;
    const kind: ApiErrorKind = s === 401 ? "auth" : s === 403 ? "forbidden" : s === 404 ? "not-found" : s === 410 ? "gone" : s === 409 || s === 412 ? "conflict" : s === 429 ? "rate" : s === 400 ? "bad-request" : "server";
    throw new ApiError(`${what}: ${msg ?? `HTTP ${s}`}`, kind, s);
  }

  async calendars(): Promise<CalendarInfo[]> {
    const res = await this.call("GET", "/users/me/calendarList?minAccessRole=reader&maxResults=250");
    if (res.status !== 200) this.fail(res, "Couldn't list your calendars");
    const items = ((res.json as { items?: { id: string; summary?: string; primary?: boolean; accessRole?: string }[] })?.items ?? []);
    return items.map((c) => ({ id: c.id, summary: c.summary ?? c.id, primary: !!c.primary, role: c.accessRole ?? "reader" }));
  }

  async events(calendarId: string, o: { timeMin?: string; timeMax?: string; updatedMin?: string; showDeleted?: boolean; privateProp?: string } = {}): Promise<GEvent[]> {
    const out: GEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 8; page++) {
      const q = new URLSearchParams({ maxResults: "250", singleEvents: "true" });
      if (o.timeMin) q.set("timeMin", o.timeMin);
      if (o.timeMax) q.set("timeMax", o.timeMax);
      if (o.updatedMin) q.set("updatedMin", o.updatedMin);
      if (o.showDeleted) q.set("showDeleted", "true");
      if (o.privateProp) q.set("privateExtendedProperty", o.privateProp);
      if (pageToken) q.set("pageToken", pageToken);
      const res = await this.call("GET", `/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`);
      if (res.status !== 200) this.fail(res, `Couldn't read events from ${calendarId}`);
      const j = res.json as { items?: RawEvent[]; nextPageToken?: string };
      out.push(...(j.items ?? []).map((r) => toEvent(calendarId, r)));
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async insert(calendarId: string, body: unknown): Promise<GEvent> {
    const res = await this.call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body });
    if (res.status !== 200) this.fail(res, "Couldn't create the event");
    return toEvent(calendarId, res.json as RawEvent);
  }

  /** `etag` makes it a compare-and-set: if someone changed the event meanwhile we get a conflict, not an overwrite. */
  async patch(calendarId: string, eventId: string, body: unknown, etag?: string): Promise<GEvent> {
    const res = await this.call("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { body, etag });
    if (res.status !== 200) this.fail(res, "Couldn't update the event");
    return toEvent(calendarId, res.json as RawEvent);
  }

  /** Deleting something already gone is a success. */
  async remove(calendarId: string, eventId: string): Promise<void> {
    const res = await this.call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    if (res.status === 200 || res.status === 204 || res.status === 404 || res.status === 410) return;
    this.fail(res, "Couldn't delete the event");
  }
}
