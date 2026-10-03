import type { VaultWriter } from "../writers/writer";
import type { ActionOpRecord } from "../intent/types";
import { descriptionOf } from "../intent/taskline";
import { CalLink, CalendarState, GEvent, When, cleanTitle, describeWhen, eventBody } from "./model";
import type { SyncPlan } from "./sync";

/** Carry out a sync plan against Google and the vault. Obsidian-free, so every failure path can be tested. */

export interface CalApi {
  insert(calendarId: string, body: unknown): Promise<GEvent>;
  patch(calendarId: string, eventId: string, body: unknown, etag?: string): Promise<GEvent>;
  remove(calendarId: string, eventId: string): Promise<void>;
}

export interface CalApplyDeps {
  api: CalApi;
  writer: VaultWriter;
  state: CalendarState;
  today: () => string;
  now: () => Date;
  /** The text on an event that points back at the note. */
  describe: (path: string) => string;
}

export interface CalApplyResult {
  ops: ActionOpRecord[];
  issues: string[];
  changed: boolean;
}

const key = (path: string, line: number) => `${path}#${line}`;
const short = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isConflict = (e: unknown) => (e as { kind?: string })?.kind === "conflict";

export async function applyPlan(d: CalApplyDeps, plan: SyncPlan): Promise<CalApplyResult> {
  const ops: ActionOpRecord[] = [];
  const issues = [...plan.issues];
  const links = d.state.links;
  const failedVault = new Set<string>(); // task keys whose line edit failed
  const failedLinks = new Set<string>(); // link ids that must keep their old snapshot
  const failedDeletes = new Set<string>();
  const ok = (summary: string) => void ops.push({ ok: true, summary });
  const bad = (summary: string, error: string) => void ops.push({ ok: false, summary, error });

  // 1. The vault first. A new task needs its id written before an event is created, so a failure
  //    here can never leave an event we can't find again.
  for (const v of plan.vault) {
    const k = key(v.task.path, v.task.line);
    try {
      await d.writer.editTaskLine({ path: v.task.path, line: v.task.line, expectedText: v.task.raw }, v.patch, d.today(), "calendar");
      ok(`“${short(v.task.title)}”: ${v.reason}`);
    } catch (e) {
      failedVault.add(k);
      if (v.task.id) failedLinks.add(v.task.id);
      bad(`“${short(v.task.title)}”: couldn't update the task`, errText(e));
    }
  }

  // 2. Re-link events we'd lost track of.
  for (const l of plan.links) {
    if (l.k !== "link.relink") continue;
    const w = l.task.when!;
    links[l.id] = { id: l.id, calendarId: l.event.calendarId, eventId: l.event.id, etag: l.event.etag, path: l.task.path, title: l.task.title, when: w, done: l.task.done, syncedAt: d.now().toISOString() };
    ok(`“${short(l.task.title)}”: found its calendar event again`);
  }

  // 3. The calendar.
  for (const e of plan.events) {
    try {
      if (e.k === "event.create") {
        if (failedVault.has(key(e.task.path, e.task.line))) {
          bad(`“${short(e.task.title)}”: not put on the calendar`, "its id couldn't be saved first");
          continue;
        }
        const body = eventBody({ title: cleanTitle(e.task.title), when: e.when, done: e.task.done, description: d.describe(e.task.path), vdId: e.id, vdPath: e.task.path });
        const ev = await d.api.insert(e.calendarId, body);
        links[e.id] = { id: e.id, calendarId: e.calendarId, eventId: ev.id, etag: ev.etag, path: e.task.path, title: e.task.title, when: e.when, done: e.task.done, syncedAt: d.now().toISOString() };
        ok(`Put “${short(e.task.title)}” on the calendar: ${describeWhen(e.when)}`);
      } else if (e.k === "event.patch") {
        const body: Record<string, unknown> = {};
        if (e.summary !== undefined) {
          body.summary = e.summary;
          body.transparency = e.done ? "transparent" : "opaque";
        }
        if (e.when) Object.assign(body, whenBody(e.when));
        const ev = await d.api.patch(e.link.calendarId, e.link.eventId, body, e.link.etag);
        links[e.link.id] = { ...links[e.link.id], etag: ev.etag, syncedAt: d.now().toISOString() };
        ok(`Updated “${short(e.link.title)}” on the calendar: ${e.reason}`);
      } else {
        await d.api.remove(e.link.calendarId, e.link.eventId);
        ok(`Removed “${short(e.link.title)}” from the calendar: ${e.reason}`);
      }
    } catch (err) {
      const t = e.k === "event.create" ? e.task.title : e.link.title;
      if (e.k === "event.patch") failedLinks.add(e.link.id);
      if (e.k === "event.delete") failedDeletes.add(e.link.id);
      if (isConflict(err)) issues.push(`“${short(t)}” changed in the calendar while syncing. It will be reconciled on the next sync.`);
      else bad(`“${short(t)}”: calendar update failed`, errText(err));
    }
  }

  // 4. Drop links whose event is gone, and move every live link's snapshot forward.
  for (const l of plan.links) {
    if (l.k === "link.drop" && !failedDeletes.has(l.id)) delete links[l.id];
  }
  for (const [id, snap] of Object.entries(plan.snaps)) {
    if (!links[id] || failedLinks.has(id)) continue;
    links[id] = { ...links[id], title: snap.title, done: snap.done, when: snap.when as When, path: links[id].path };
  }
  return { ops, issues, changed: ops.some((o) => o.ok) };
}

const whenBody = (w: When) =>
  w.start
    ? { start: { dateTime: `${w.date}T${w.start}:00+02:00`, timeZone: "Africa/Johannesburg" }, end: { dateTime: `${w.date}T${w.end ?? addHour(w.start)}:00+02:00`, timeZone: "Africa/Johannesburg" } }
    : { start: { date: w.date }, end: { date: nextDay(w.date) } };

const addHour = (t: string) => `${String(Math.min(23, Number(t.slice(0, 2)) + 1)).padStart(2, "0")}${t.slice(2)}`;
const nextDay = (iso: string) => new Date(Date.parse(iso + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);

export type { CalLink };
export { descriptionOf };
