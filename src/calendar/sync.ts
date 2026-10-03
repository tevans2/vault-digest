import type { TaskPatch } from "../intent/types";
import { CalLink, CalTask, GEvent, When, cleanTitle, describeWhen, sameWhen, stripDone, withDone } from "./model";

/**
 * Decide what to change so the vault and Google Calendar agree. Pure: no network, no files.
 *
 * The rules (yours): the calendar wins on when (date and time); the vault wins on the title and on done.
 * Linking is by the Tasks plugin's 🆔 marker on the task and a private `vdId` property on the event.
 * Anything uncertain is left alone and reported in `issues`, never guessed.
 */

export interface SyncInput {
  /** Tasks on the calendar (#cal), or carrying an id. */
  tasks: CalTask[];
  links: Record<string, CalLink>;
  /** Events changed in Google since the last sync, by event id. An absent link event is assumed unchanged. */
  changed: Map<string, GEvent>;
  /** Events carrying one of our ids that we hold no link for (a lost link). */
  orphans: Map<string, GEvent>;
  /** Did the task scan see the whole vault? Without that, a missing task can't be taken as deleted. */
  scanComplete: boolean;
  defaultCalendarId: string;
  calendarForAlias: (alias: string) => string | undefined;
  newId: () => string;
}

export type EventOp =
  | { k: "event.create"; id: string; calendarId: string; task: CalTask; when: When; reason: string }
  | { k: "event.patch"; link: CalLink; summary?: string; when?: When; done?: boolean; reason: string }
  | { k: "event.delete"; link: CalLink; reason: string };

export interface VaultOp {
  task: CalTask;
  patch: TaskPatch;
  reason: string;
}

export type LinkOp =
  | { k: "link.relink"; id: string; event: GEvent; task: CalTask }
  | { k: "link.drop"; id: string };

export interface SyncPlan {
  /** What each live link should look like once the plan has been applied: the base for the next sync. */
  snaps: Record<string, { title: string; done: boolean; when: When }>;
  events: EventOp[];
  /** Edits to task lines. At most one per task, so line references stay valid. */
  vault: VaultOp[];
  links: LinkOp[];
  issues: string[];
}

const whenPatch = (w: When): TaskPatch => ({ due: w.date, time: w.start ? `${w.start}${w.end ? `-${w.end}` : ""}` : null });

export function planSync(i: SyncInput): SyncPlan {
  const plan: SyncPlan = { snaps: {}, events: [], vault: [], links: [], issues: [] };
  const byId = new Map(i.tasks.filter((t) => t.id).map((t) => [t.id!, t]));
  // One vault edit per task, merged as we go.
  const vaultOf = new Map<string, VaultOp>();
  const vault = (t: CalTask, patch: TaskPatch, reason: string) => {
    const key = `${t.path}#${t.line}`;
    const cur = vaultOf.get(key);
    if (cur) {
      Object.assign(cur.patch, patch);
      cur.reason = `${cur.reason}; ${reason}`;
    } else {
      const op = { task: t, patch: { ...patch }, reason };
      vaultOf.set(key, op);
      plan.vault.push(op);
    }
  };

  // ── Tasks that already have a link ────────────────────────────────────────
  for (const link of Object.values(i.links)) {
    const t = byId.get(link.id);
    const ev = i.changed.get(link.eventId);
    const label = link.title;

    if (!t) {
      if (i.scanComplete) {
        plan.events.push({ k: "event.delete", link, reason: `“${label}” is no longer in the vault` });
        plan.links.push({ k: "link.drop", id: link.id });
      } else plan.issues.push(`“${label}”: couldn't see every note, so it was left as it is`);
      continue;
    }
    if (t.cancelled) {
      plan.events.push({ k: "event.delete", link, reason: `“${label}” was cancelled` });
      plan.links.push({ k: "link.drop", id: link.id });
      continue;
    }
    if (t.cal === undefined) {
      plan.events.push({ k: "event.delete", link, reason: `“${label}” was taken off the calendar` });
      plan.links.push({ k: "link.drop", id: link.id });
      continue;
    }
    if (ev?.status === "cancelled") {
      // Deleted in Google Calendar: stop syncing this task, but never touch the task itself beyond that.
      plan.links.push({ k: "link.drop", id: link.id });
      if (!t.done) vault(t, { calendar: false }, "the event was deleted in the calendar");
      continue;
    }

    // When: the calendar wins. Otherwise a change in the vault is pushed.
    let when = link.when;
    const calMoved = !!ev?.when && !sameWhen(ev.when, link.when);
    const vaultMoved = !!t.when && !sameWhen(t.when, link.when);
    if (ev && ev.when === null && !sameWhen(null, link.when)) plan.issues.push(`“${label}”: the calendar event spans several days, so its time was left alone`);
    if (calMoved) {
      when = ev!.when!;
      if (!sameWhen(t.when, when)) vault(t, whenPatch(when), `the calendar moved it to ${describeWhen(when)}`);
    } else if (vaultMoved) when = t.when!;
    else if (!t.when) plan.issues.push(`“${label}” has no date, so the calendar keeps its last time (${describeWhen(link.when)})`);

    plan.snaps[link.id] = { title: t.title, done: t.done, when };

    // Title and done: the vault wins.
    const wantSummary = withDone(t.title, t.done);
    const haveSummary = ev ? ev.summary : withDone(link.title, link.done);
    const summaryDiffers = ev ? haveSummary !== wantSummary : t.title !== link.title || t.done !== link.done;
    const whenPush = !calMoved && vaultMoved;
    if (summaryDiffers || whenPush) {
      plan.events.push({
        k: "event.patch",
        link,
        ...(summaryDiffers ? { summary: wantSummary, done: t.done } : {}),
        ...(whenPush ? { when } : {}),
        reason: [summaryDiffers && (ev && stripDone(ev.summary) !== t.title ? "the vault's title wins" : "done state changed"), whenPush && "you moved it"].filter(Boolean).join("; "),
      });
    }
  }

  // ── Tasks on the calendar with no link yet ────────────────────────────────
  const linkedIds = new Set(Object.keys(i.links));
  for (const t of i.tasks) {
    if (t.cal === undefined || t.cancelled) continue;
    if (t.id && linkedIds.has(t.id)) continue;
    if (t.done) continue; // finished before it was ever put on the calendar
    if (!t.when) {
      plan.issues.push(`“${t.title}” is on the calendar but has no date`);
      continue;
    }
    const calendarId = t.cal ? i.calendarForAlias(t.cal) : i.defaultCalendarId;
    if (!calendarId) {
      plan.issues.push(`“${t.title}”: no calendar is set for #cal/${t.cal}`);
      continue;
    }
    const orphan = t.id ? i.orphans.get(t.id) : undefined;
    if (orphan && orphan.status !== "cancelled") {
      plan.links.push({ k: "link.relink", id: t.id!, event: orphan, task: t });
      continue;
    }
    const id = t.id ?? `vd-${i.newId()}`;
    if (!t.id) vault(t, { id }, "linked to its calendar event");
    plan.events.push({ k: "event.create", id, calendarId, task: t, when: t.when, reason: `new on the calendar: ${describeWhen(t.when)}` });
  }
  return plan;
}

/** The summary the sync would put on an event, for a task. */
export const summaryFor = (t: CalTask) => withDone(cleanTitle(t.title), t.done);

export const planIsEmpty = (p: SyncPlan) => !p.events.length && !p.vault.length && !p.links.length;
