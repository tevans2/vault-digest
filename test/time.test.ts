import { describe, expect, it } from "vitest";
import { findTime, addMinutes, minutesBetween } from "../src/util/time";
import { parseTasks } from "../src/engine/collectors/tasks";
import { patchTaskLine } from "../src/intent/taskline";
import { interpret } from "../src/intent/grammar";
import type { Op, TaskSubject } from "../src/intent/types";

describe("findTime", () => {
  it("reads single times", () => {
    expect(findTime("at 2pm")).toMatchObject({ start: "14:00" });
    expect(findTime("2:30pm")).toMatchObject({ start: "14:30" });
    expect(findTime("12am")).toMatchObject({ start: "00:00" });
    expect(findTime("12pm")).toMatchObject({ start: "12:00" });
    expect(findTime("14:05")).toMatchObject({ start: "14:05" });
    expect(findTime("9h30")).toMatchObject({ start: "09:30" });
    expect(findTime("noon")).toMatchObject({ start: "12:00" });
  });
  it("reads ranges, inheriting am/pm the way people write them", () => {
    expect(findTime("2-3pm")).toMatchObject({ start: "14:00", end: "15:00" });
    expect(findTime("2pm-3:30pm")).toMatchObject({ start: "14:00", end: "15:30" });
    expect(findTime("11-1pm")).toMatchObject({ start: "11:00", end: "13:00" });
    expect(findTime("14:00-15:30")).toMatchObject({ start: "14:00", end: "15:30" });
    expect(findTime("from 9 to 10am")).toMatchObject({ start: "09:00", end: "10:00" });
  });
  it("ignores things that aren't times", () => {
    expect(findTime("5 oct")).toBeUndefined();
    expect(findTime("2026-10-05")).toBeUndefined();
    expect(findTime("25:00")).toBeUndefined();
    expect(findTime("13pm")).toBeUndefined();
    expect(findTime("push 3 days")).toBeUndefined();
  });
  it("does time arithmetic within a day", () => {
    expect(addMinutes("14:00", 90)).toBe("15:30");
    expect(addMinutes("23:30", 90)).toBe("23:59");
    expect(minutesBetween("14:00", "15:30")).toBe(90);
  });
});

describe("task markers for the calendar", () => {
  const [a, b, c] = parseTasks("n.md", "## Tasks\n- [ ] CS344 Test 3 #cal ⏰ 14:00-15:00 🆔 vd-a1b2 📅 2026-10-21\n- [ ] Call Sam #cal/work 📅 2026-10-05\n- [-] Old thing #cal 🆔 vd-zz 📅 2026-10-06 ❌ 2026-10-02\n");
  it("reads the id, time, end and calendar alias without polluting the title", () => {
    expect(a).toMatchObject({ text: "CS344 Test 3 #cal", id: "vd-a1b2", time: "14:00", endTime: "15:00", cal: "", due: "2026-10-21", cancelled: false });
    expect(b).toMatchObject({ cal: "work", time: undefined, id: undefined });
    expect(c).toMatchObject({ cancelled: true, done: true, cal: "" });
  });
  it("a plain task isn't on the calendar", () => {
    expect(parseTasks("n.md", "## Tasks\n- [ ] x 📅 2026-10-05\n")[0].cal).toBeUndefined();
  });
});

describe("patching time, calendar and id", () => {
  const T = "2026-10-03";
  const ok = (line: string, p: Parameters<typeof patchTaskLine>[1]) => {
    const r = patchTaskLine(line, p, T);
    if ("error" in r) throw new Error(r.error);
    return r.line;
  };
  it("sets and replaces a time next to the date, and clears it", () => {
    expect(ok("- [ ] x 📅 2026-10-05", { time: "14:00-15:00" })).toBe("- [ ] x 📅 2026-10-05 ⏰ 14:00-15:00");
    expect(ok("- [ ] x 📅 2026-10-05 ⏰ 14:00", { time: "09:30" })).toBe("- [ ] x 📅 2026-10-05 ⏰ 09:30");
    expect(ok("- [ ] x 📅 2026-10-05 ⏰ 14:00", { time: null })).toBe("- [ ] x 📅 2026-10-05");
  });
  it("puts a task on the calendar, with an alias, and takes it off", () => {
    expect(ok("- [ ] x 📅 2026-10-05", { calendar: true })).toBe("- [ ] x #cal 📅 2026-10-05");
    expect(ok("- [ ] x #cal 📅 2026-10-05", { calendar: "uni" })).toBe("- [ ] x #cal/uni 📅 2026-10-05");
    expect(ok("- [ ] x #cal/uni 📅 2026-10-05", { calendar: false })).toBe("- [ ] x 📅 2026-10-05");
  });
  it("adds an id once", () => {
    expect(ok("- [ ] x 📅 2026-10-05", { id: "vd-abc" })).toBe("- [ ] x 📅 2026-10-05 🆔 vd-abc");
    expect(patchTaskLine("- [ ] x 🆔 vd-abc", { id: "vd-new" }, T)).toEqual({ error: "that wouldn't change anything" });
  });
  it("keeps the id and time when renaming, and when completing", () => {
    expect(ok("- [ ] Old #cal ⏰ 14:00 🆔 vd-1 📅 2026-10-05", { text: "New" })).toBe("- [ ] New ⏰ 14:00 🆔 vd-1 📅 2026-10-05");
    expect(ok("- [ ] x #cal 🆔 vd-1 📅 2026-10-05", { status: "done" })).toBe("- [x] x #cal 🆔 vd-1 📅 2026-10-05 ✅ 2026-10-03");
  });
});

describe("instructions about time and the calendar", () => {
  const ctx = { today: "2026-10-03", courses: ["CS344"], calAliases: ["uni", "work"] };
  const sub = (raw: string): TaskSubject => ({ type: "task", key: "k", label: "x", path: "n.md", line: 1, raw });
  const patch = (s: string) => {
    const r = interpret(s, [sub("- [ ] Write test 📅 2026-10-05")], ctx);
    return r.kind === "ops" ? (r.ops[0] as Extract<Op, { k: "task.patch" }>).patch : r.kind;
  };
  it("sets a time, a date and a time, and a range", () => {
    expect(patch("at 2pm")).toEqual({ time: "14:00" });
    expect(patch("friday 2pm")).toEqual({ due: "2026-10-09", time: "14:00" });
    expect(patch("tomorrow 14:00-15:30")).toEqual({ due: "2026-10-04", time: "14:00-15:30" });
  });
  it("puts it on the calendar, with the date and time it was given", () => {
    expect(patch("calendar")).toEqual({ calendar: true });
    expect(patch("put on the calendar")).toEqual({ calendar: true });
    expect(patch("calendar friday 2pm")).toEqual({ due: "2026-10-09", time: "14:00", calendar: true });
    expect(patch("cal 9-10am")).toEqual({ time: "09:00-10:00", calendar: true });
    expect(patch("calendar uni")).toEqual({ calendar: "uni" });
  });
  it("takes it off, and makes it all-day", () => {
    expect(patch("no calendar")).toEqual({ calendar: false });
    expect(patch("remove from calendar")).toEqual({ calendar: false });
    expect(patch("all day")).toEqual({ time: null });
  });
  it("leaves a bare date as a re-date, and unknown words to the agent", () => {
    expect(patch("friday")).toEqual({ due: "2026-10-09" });
    expect(patch("calendar fancy")).toBe("agent"); // not a known alias
  });
});
