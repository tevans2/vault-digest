import { describe, expect, it, beforeEach } from "vitest";
import { MemFs } from "./memfs";
import { VaultWriter } from "../src/writers/writer";
import { applyPlan, CalApi, CalApplyDeps } from "../src/calendar/apply";
import { planSync } from "../src/calendar/sync";
import { CalLink, CalTask, CalendarState, GEvent, When, cleanTitle } from "../src/calendar/model";
import { parseTasks } from "../src/engine/collectors/tasks";
import type { WriteRecord } from "../src/state/schema";
import { ApiError } from "../src/calendar/api";

const NOTE = "Notes/Courses/CS344/Hub.md";
const TODAY = "2026-10-03";
let fs: MemFs;
let state: CalendarState;
let writes: WriteRecord[];
let calls: string[];
let events: Map<string, GEvent>;
let failNext: { patch?: ApiError; insert?: Error; remove?: Error };
let seq = 0;

const api: CalApi = {
  async insert(calId, body) {
    if (failNext.insert) throw failNext.insert;
    const b = body as { summary: string; extendedProperties: { private: Record<string, string> } };
    const ev: GEvent = { id: `ev${++seq}`, calendarId: calId, etag: `"v1"`, status: "confirmed", summary: b.summary, when: { date: "2026-10-21", start: "14:00", end: "15:00" }, priv: b.extendedProperties.private };
    events.set(ev.id, ev);
    calls.push(`insert ${calId} ${b.summary}`);
    return ev;
  },
  async patch(calId, evId, body, etag) {
    if (failNext.patch) throw failNext.patch;
    calls.push(`patch ${evId} ${JSON.stringify(body)} etag=${etag}`);
    return { ...events.get(evId)!, etag: `"v2"` };
  },
  async remove(calId, evId) {
    if (failNext.remove) throw failNext.remove;
    calls.push(`remove ${evId}`);
    events.delete(evId);
  },
};

const deps = (): CalApplyDeps => ({
  api,
  writer: new VaultWriter(fs, {
    journalPath: (i) => `Journal/${i}.md`, templatePath: () => null, format: (i) => i, journalName: (i) => i, courseHub: () => null,
    record: (r) => writes.push(r), now: () => new Date("2026-10-03T10:00:00Z"), uuid: () => `w${writes.length}`,
  }),
  state,
  today: () => TODAY,
  now: () => new Date("2026-10-03T10:00:00Z"),
  describe: (p) => `From your vault: ${p}`,
});

const read = () =>
  parseTasks(NOTE, fs.files.get(NOTE)!).map((t): CalTask => ({
    id: t.id, path: t.path, line: t.line, raw: t.raw, title: cleanTitle(t.text), cal: t.cal, done: t.done && !t.cancelled, cancelled: t.cancelled,
    when: t.due ? { date: t.due, start: t.time, end: t.endTime } : null,
  }));
const mkPlan = (over = {}) => planSync({ tasks: read(), links: state.links, changed: new Map(), orphans: new Map(), scanComplete: true, defaultCalendarId: "primary", calendarForAlias: () => undefined, newId: () => "abc123", ...over });

beforeEach(() => {
  fs = new MemFs({ [NOTE]: "# Hub\n\n## Tasks\n\n- [ ] CS344 Test 3 #cal 📅 2026-10-21 ⏰ 14:00-15:00\n- [ ] Read the guide 📅 2026-10-08\n" });
  state = { links: {} };
  writes = [];
  calls = [];
  events = new Map();
  failNext = {};
  seq = 0;
});

describe("applying a plan", () => {
  it("writes the id into the task first, then creates the event and records the link", async () => {
    const p = mkPlan();
    const r = await applyPlan(deps(), p);
    expect(fs.files.get(NOTE)).toContain("- [ ] CS344 Test 3 #cal 📅 2026-10-21 ⏰ 14:00-15:00 🆔 vd-abc123");
    expect(calls).toEqual(["insert primary CS344 Test 3"]);
    expect(state.links["vd-abc123"]).toMatchObject({ eventId: "ev1", calendarId: "primary", title: "CS344 Test 3", done: false, when: { date: "2026-10-21", start: "14:00", end: "15:00" } });
    expect(r.ops.every((o) => o.ok)).toBe(true);
    expect(writes.map((w) => w.source)).toEqual(["calendar"]);
  });
  it("is a no-op the second time: no duplicate event, no churn", async () => {
    await applyPlan(deps(), mkPlan());
    calls.length = 0;
    const again = mkPlan();
    expect(again.events).toEqual([]);
    expect(again.vault).toEqual([]);
    await applyPlan(deps(), again);
    expect(calls).toEqual([]);
  });
  it("won't create an event if the id couldn't be saved (that could orphan it)", async () => {
    // someone edits the task line between the scan and the write
    const p = mkPlan();
    fs.files.set(NOTE, fs.files.get(NOTE)!.replace("CS344 Test 3", "CS344 Test Three"));
    const r = await applyPlan(deps(), p);
    expect(calls).toEqual([]);
    expect(Object.keys(state.links)).toEqual([]);
    expect(r.ops.some((o) => !o.ok && /id couldn't be saved/.test(o.error ?? ""))).toBe(true);
  });
  it("a failed event creation leaves the id in the task, so the next sync retries instead of duplicating", async () => {
    failNext.insert = new Error("boom");
    await applyPlan(deps(), mkPlan());
    expect(fs.files.get(NOTE)).toContain("🆔 vd-abc123");
    expect(state.links).toEqual({});
    failNext = {};
    const retry = mkPlan();
    expect(retry.events[0]).toMatchObject({ k: "event.create", id: "vd-abc123" }); // same id, not a new one
    await applyPlan(deps(), retry);
    expect(Object.keys(state.links)).toEqual(["vd-abc123"]);
  });
});

describe("keeping the two sides aligned", () => {
  beforeEach(async () => {
    await applyPlan(deps(), mkPlan());
    calls.length = 0;
  });
  it("pushes a new date and time to the event, with the etag, and moves the snapshot forward", async () => {
    fs.files.set(NOTE, fs.files.get(NOTE)!.replace("📅 2026-10-21 ⏰ 14:00-15:00", "📅 2026-10-22 ⏰ 09:00-10:00"));
    await applyPlan(deps(), mkPlan());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("patch ev1");
    expect(calls[0]).toContain('"dateTime":"2026-10-22T09:00:00+02:00"');
    expect(calls[0]).toContain('etag="v1"');
    expect(state.links["vd-abc123"].when).toEqual({ date: "2026-10-22", start: "09:00", end: "10:00" });
    expect(state.links["vd-abc123"].etag).toBe('"v2"');
    expect(mkPlan().events).toEqual([]); // and it settles
  });
  it("pulls a calendar-side move into the task line, and then settles", async () => {
    const moved: GEvent = { ...events.get("ev1")!, when: { date: "2026-10-23", start: "11:00", end: "12:30" } };
    await applyPlan(deps(), mkPlan({ changed: new Map([["ev1", moved]]) }));
    expect(fs.files.get(NOTE)).toContain("📅 2026-10-23 ⏰ 11:00-12:30");
    expect(calls).toEqual([]);
    expect(state.links["vd-abc123"].when).toEqual({ date: "2026-10-23", start: "11:00", end: "12:30" });
    const next = mkPlan(); // the event is unchanged since, the task now matches the snapshot
    expect(next.vault).toEqual([]);
    expect(next.events).toEqual([]);
  });
  it("ticking the task marks the event done", async () => {
    fs.files.set(NOTE, fs.files.get(NOTE)!.replace("- [ ] CS344", "- [x] CS344") );
    await applyPlan(deps(), mkPlan());
    expect(calls[0]).toContain('"summary":"✓ CS344 Test 3"');
    expect(calls[0]).toContain('"transparency":"transparent"');
    expect(state.links["vd-abc123"].done).toBe(true);
  });
  it("taking it off the calendar removes the event and the link", async () => {
    fs.files.set(NOTE, fs.files.get(NOTE)!.replace(" #cal", ""));
    await applyPlan(deps(), mkPlan());
    expect(calls).toEqual(["remove ev1"]);
    expect(state.links).toEqual({});
  });
  it("an event deleted in the calendar unlinks the task but never deletes or cancels it", async () => {
    const gone: GEvent = { ...events.get("ev1")!, status: "cancelled" };
    await applyPlan(deps(), mkPlan({ changed: new Map([["ev1", gone]]) }));
    expect(state.links).toEqual({});
    const note = fs.files.get(NOTE)!;
    expect(note).toContain("- [ ] CS344 Test 3 📅 2026-10-21 ⏰ 14:00-15:00 🆔 vd-abc123"); // task intact, #cal gone
    expect(note).not.toContain("#cal");
    expect(calls).toEqual([]);
  });
});

describe("failures never lose track", () => {
  beforeEach(async () => {
    await applyPlan(deps(), mkPlan());
    calls.length = 0;
  });
  it("a calendar conflict is reported, the snapshot is not advanced, and the next sync tries again", async () => {
    fs.files.set(NOTE, fs.files.get(NOTE)!.replace("2026-10-21", "2026-10-24"));
    failNext.patch = new ApiError("changed", "conflict", 412);
    const r = await applyPlan(deps(), mkPlan());
    expect(r.issues.join(" ")).toMatch(/changed in the calendar while syncing/);
    expect(state.links["vd-abc123"].when.date).toBe("2026-10-21"); // still the old snapshot
    failNext = {};
    const retry = mkPlan();
    expect(retry.events[0]).toMatchObject({ k: "event.patch" });
  });
  it("a failed delete keeps the link so it's retried", async () => {
    fs.files.set(NOTE, fs.files.get(NOTE)!.replace(" #cal", ""));
    failNext.remove = new Error("offline");
    await applyPlan(deps(), mkPlan());
    expect(state.links["vd-abc123"]).toBeDefined();
    failNext = {};
    await applyPlan(deps(), mkPlan());
    expect(state.links).toEqual({});
    expect(calls).toEqual(["remove ev1"]);
  });
  it("does not delete events when the task scan was incomplete", async () => {
    const p = mkPlan({ tasks: [], scanComplete: false });
    await applyPlan(deps(), p);
    expect(calls).toEqual([]);
    expect(state.links["vd-abc123"]).toBeDefined();
  });
});
