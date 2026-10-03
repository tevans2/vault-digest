import { describe, expect, it } from "vitest";
import { planSync, SyncInput, planIsEmpty } from "../src/calendar/sync";
import { CalLink, CalTask, GEvent, When, cleanTitle, eventBody, sameWhen, whenFromGoogle, withDone } from "../src/calendar/model";

const when = (date: string, start?: string, end?: string): When => ({ date, start, end });
const task = (over: Partial<CalTask> = {}): CalTask => ({ id: "vd-a1", path: "n.md", line: 3, raw: "- [ ] x", title: "Write DS346 test", when: when("2026-10-05", "14:00", "15:00"), cal: "", done: false, cancelled: false, ...over });
const link = (over: Partial<CalLink> = {}): CalLink => ({ id: "vd-a1", calendarId: "primary", eventId: "e1", path: "n.md", title: "Write DS346 test", when: when("2026-10-05", "14:00", "15:00"), done: false, syncedAt: "2026-10-03T10:00:00Z", ...over });
const event = (over: Partial<GEvent> = {}): GEvent => ({ id: "e1", calendarId: "primary", status: "confirmed", summary: "Write DS346 test", when: when("2026-10-05", "14:00", "15:00"), priv: { vdId: "vd-a1" }, ...over });

let n = 0;
const input = (over: Partial<SyncInput> = {}): SyncInput => ({
  tasks: [],
  links: {},
  changed: new Map(),
  orphans: new Map(),
  scanComplete: true,
  defaultCalendarId: "primary",
  calendarForAlias: (a) => ({ uni: "uni-cal", work: "work-cal" })[a],
  newId: () => `n${++n}`,
  ...over,
});
const plan = (over: Partial<SyncInput>) => planSync(input(over));

describe("helpers", () => {
  it("compares times, treating a missing end as an hour", () => {
    expect(sameWhen(when("2026-10-05", "14:00"), when("2026-10-05", "14:00", "15:00"))).toBe(true);
    expect(sameWhen(when("2026-10-05", "14:00"), when("2026-10-05", "14:00", "15:30"))).toBe(false);
    expect(sameWhen(when("2026-10-05"), when("2026-10-05", "00:00"))).toBe(false);
    expect(sameWhen(null, null)).toBe(true);
  });
  it("cleans a task into a title", () => {
    expect(cleanTitle("CS344 hand in A2 #task #cal @sam [[CURRENT|the note]] [[Plain]]")).toBe("CS344 hand in A2 the note Plain");
    expect(withDone("x", true)).toBe("✓ x");
  });
  it("builds timed and all-day bodies in Johannesburg time, with our marker", () => {
    const timed = eventBody({ title: "T", when: when("2026-10-05", "14:00"), done: false, description: "d", vdId: "vd-1", vdPath: "n.md" });
    expect(timed.start).toEqual({ dateTime: "2026-10-05T14:00:00+02:00", timeZone: "Africa/Johannesburg" });
    expect(timed.end).toEqual({ dateTime: "2026-10-05T15:00:00+02:00", timeZone: "Africa/Johannesburg" });
    expect(timed.extendedProperties.private).toEqual({ vdId: "vd-1", vdPath: "n.md" });
    const allDay = eventBody({ title: "T", when: when("2026-10-31"), done: true, description: "d", vdId: "vd-1", vdPath: "n.md" });
    expect(allDay.start).toEqual({ date: "2026-10-31" });
    expect(allDay.end).toEqual({ date: "2026-11-01" }); // Google's all-day end is exclusive
    expect(allDay.summary).toBe("✓ T");
    expect(allDay.transparency).toBe("transparent");
  });
  it("reads Google times as Johannesburg wall-clock, and refuses multi-day events", () => {
    expect(whenFromGoogle({ dateTime: "2026-10-05T14:00:00+02:00" }, { dateTime: "2026-10-05T15:30:00+02:00" })).toEqual(when("2026-10-05", "14:00", "15:30"));
    expect(whenFromGoogle({ dateTime: "2026-10-05T12:00:00Z" }, { dateTime: "2026-10-05T13:00:00Z" })).toEqual(when("2026-10-05", "14:00", "15:00"));
    expect(whenFromGoogle({ date: "2026-10-05" }, { date: "2026-10-06" })).toEqual(when("2026-10-05"));
    expect(whenFromGoogle({ date: "2026-10-05" }, { date: "2026-10-08" })).toBeNull();
  });
});

describe("new tasks", () => {
  it("creates an event for a task on the calendar, assigning an id to the task first", () => {
    const p = plan({ tasks: [task({ id: undefined })] });
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ k: "event.create", calendarId: "primary", when: when("2026-10-05", "14:00", "15:00") });
    const id = (p.events[0] as { id: string }).id;
    expect(id).toMatch(/^vd-n/);
    expect(p.vault).toEqual([{ task: expect.anything(), patch: { id }, reason: "linked to its calendar event" }]);
  });
  it("keeps an id the task already has", () => {
    const p = plan({ tasks: [task()] });
    expect(p.vault).toEqual([]);
    expect(p.events[0]).toMatchObject({ id: "vd-a1" });
  });
  it("routes by alias, and reports an alias with no calendar", () => {
    expect((plan({ tasks: [task({ cal: "uni" })] }).events[0] as { calendarId: string }).calendarId).toBe("uni-cal");
    const p = plan({ tasks: [task({ cal: "nope" })] });
    expect(p.events).toEqual([]);
    expect(p.issues[0]).toMatch(/no calendar is set for #cal\/nope/);
  });
  it("needs a date, and skips tasks that are done or cancelled before they were ever linked", () => {
    expect(plan({ tasks: [task({ when: null })] }).issues[0]).toMatch(/has no date/);
    expect(plan({ tasks: [task({ done: true })] }).events).toEqual([]);
    expect(plan({ tasks: [task({ cancelled: true, done: true })] }).events).toEqual([]);
    expect(plan({ tasks: [task({ cal: undefined })] }).events).toEqual([]); // an id alone is not an opt-in
  });
  it("re-links a lost link instead of creating a duplicate", () => {
    const p = plan({ tasks: [task()], orphans: new Map([["vd-a1", event()]]) });
    expect(p.events).toEqual([]);
    expect(p.links).toEqual([{ k: "link.relink", id: "vd-a1", event: expect.anything(), task: expect.anything() }]);
  });
});

describe("linked tasks: nothing changed", () => {
  it("does nothing when both sides match the last sync", () => {
    expect(planIsEmpty(plan({ tasks: [task()], links: { "vd-a1": link() } }))).toBe(true);
  });
  it("does nothing when the calendar reports a change that equals the vault (our own write coming back)", () => {
    expect(planIsEmpty(plan({ tasks: [task()], links: { "vd-a1": link() }, changed: new Map([["e1", event()]]) }))).toBe(true);
  });
});

describe("when: the calendar wins", () => {
  it("pulls a time change made in the calendar into the task", () => {
    const moved = event({ when: when("2026-10-06", "09:00", "10:00") });
    const p = plan({ tasks: [task()], links: { "vd-a1": link() }, changed: new Map([["e1", moved]]) });
    expect(p.events).toEqual([]);
    expect(p.vault).toHaveLength(1);
    expect(p.vault[0].patch).toEqual({ due: "2026-10-06", time: "09:00-10:00" });
  });
  it("pulls an all-day move, clearing the time", () => {
    const p = plan({ tasks: [task()], links: { "vd-a1": link() }, changed: new Map([["e1", event({ when: when("2026-10-07") })]]) });
    expect(p.vault[0].patch).toEqual({ due: "2026-10-07", time: null });
  });
  it("when both sides moved it, the calendar's time wins and the vault is overwritten", () => {
    const p = plan({ tasks: [task({ when: when("2026-10-09", "16:00", "17:00") })], links: { "vd-a1": link() }, changed: new Map([["e1", event({ when: when("2026-10-06", "09:00", "10:00") })]]) });
    expect(p.vault[0].patch).toMatchObject({ due: "2026-10-06" });
    expect(p.events.find((e) => e.k === "event.patch" && e.when)).toBeUndefined(); // nothing pushed over the calendar's choice
  });
  it("pushes a change you made in the vault to the calendar", () => {
    const p = plan({ tasks: [task({ when: when("2026-10-09", "16:00", "17:00") })], links: { "vd-a1": link() } });
    expect(p.events).toEqual([{ k: "event.patch", link: expect.anything(), when: when("2026-10-09", "16:00", "17:00"), reason: "you moved it" }]);
    expect(p.vault).toEqual([]);
  });
  it("leaves a multi-day calendar event alone and says so", () => {
    const p = plan({ tasks: [task()], links: { "vd-a1": link() }, changed: new Map([["e1", event({ when: null })]]) });
    expect(p.issues[0]).toMatch(/spans several days/);
    expect(p.vault).toEqual([]);
  });
});

describe("title and done: the vault wins", () => {
  it("pushes a new title to the event", () => {
    const p = plan({ tasks: [task({ title: "Submit DS346 test" })], links: { "vd-a1": link() } });
    expect(p.events[0]).toMatchObject({ k: "event.patch", summary: "Submit DS346 test" });
  });
  it("reverts a title edited in the calendar", () => {
    const p = plan({ tasks: [task()], links: { "vd-a1": link() }, changed: new Map([["e1", event({ summary: "Edited in Google" })]]) });
    expect(p.events[0]).toMatchObject({ k: "event.patch", summary: "Write DS346 test", reason: "the vault's title wins" });
    expect(p.vault).toEqual([]);
  });
  it("marks the event done when the task is ticked, and un-marks it", () => {
    const done = plan({ tasks: [task({ done: true })], links: { "vd-a1": link() } });
    expect(done.events[0]).toMatchObject({ summary: "✓ Write DS346 test", done: true });
    const back = plan({ tasks: [task()], links: { "vd-a1": link({ done: true }) }, changed: new Map([["e1", event({ summary: "✓ Write DS346 test" })]]) });
    expect(back.events[0]).toMatchObject({ summary: "Write DS346 test", done: false });
  });
});

describe("removals", () => {
  it("deletes the event when the task is cancelled, taken off the calendar, or removed from the vault", () => {
    expect(plan({ tasks: [task({ cancelled: true, done: true })], links: { "vd-a1": link() } }).events[0]).toMatchObject({ k: "event.delete", reason: expect.stringMatching(/cancelled/) });
    expect(plan({ tasks: [task({ cal: undefined })], links: { "vd-a1": link() } }).events[0]).toMatchObject({ k: "event.delete", reason: expect.stringMatching(/taken off the calendar/) });
    const gone = plan({ tasks: [], links: { "vd-a1": link() } });
    expect(gone.events[0]).toMatchObject({ k: "event.delete", reason: expect.stringMatching(/no longer in the vault/) });
    expect(gone.links).toEqual([{ k: "link.drop", id: "vd-a1" }]);
  });
  it("does NOT delete an event just because a scan missed the task", () => {
    const p = plan({ tasks: [], links: { "vd-a1": link() }, scanComplete: false });
    expect(p.events).toEqual([]);
    expect(p.issues[0]).toMatch(/couldn't see every note/);
  });
  it("when the event is deleted in the calendar, the task stays and is just unlinked", () => {
    const p = plan({ tasks: [task()], links: { "vd-a1": link() }, changed: new Map([["e1", event({ status: "cancelled" })]]) });
    expect(p.events).toEqual([]);
    expect(p.links).toEqual([{ k: "link.drop", id: "vd-a1" }]);
    expect(p.vault[0].patch).toEqual({ calendar: false });
  });
  it("a finished task whose event was deleted is left completely alone", () => {
    const p = plan({ tasks: [task({ done: true })], links: { "vd-a1": link() }, changed: new Map([["e1", event({ status: "cancelled" })]]) });
    expect(p.vault).toEqual([]);
  });
});

describe("one edit per task", () => {
  it("merges an id and a calendar move into a single patch", () => {
    const p = plan({ tasks: [task({ id: undefined }), task({ id: "vd-b2", line: 7, raw: "- [ ] y" })], links: { "vd-b2": link({ id: "vd-b2", eventId: "e2" }) }, changed: new Map([["e2", event({ id: "e2", when: when("2026-10-08", "10:00", "11:00") })]]) });
    const keys = p.vault.map((v) => `${v.task.path}#${v.task.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
