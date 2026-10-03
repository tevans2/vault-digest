import { describe, expect, it } from "vitest";
import { patchTaskLine, dueOf } from "../src/intent/taskline";
import { findDate, findPastDate } from "../src/writers/capture";

const T = "2026-10-03"; // Saturday
const ok = (line: string, patch: Parameters<typeof patchTaskLine>[1]) => {
  const r = patchTaskLine(line, patch, T);
  if ("error" in r) throw new Error(r.error);
  return r.line;
};
const err = (line: string, patch: Parameters<typeof patchTaskLine>[1]) => {
  const r = patchTaskLine(line, patch, T);
  return "error" in r ? r.error : `OK: ${r.line}`;
};

describe("patchTaskLine", () => {
  const base = "- [ ] Write the DS346 test #task 📅 2026-10-04";
  it("re-dates in place, sets one if missing, and clears it", () => {
    expect(ok(base, { due: "2026-10-13" })).toBe("- [ ] Write the DS346 test #task 📅 2026-10-13");
    expect(ok("- [ ] undated", { due: "2026-10-13" })).toBe("- [ ] undated 📅 2026-10-13");
    expect(ok(base, { due: null })).toBe("- [ ] Write the DS346 test #task");
    expect(err(base, { due: "2026-10-04" })).toMatch(/wouldn't change/);
  });
  it("completes and cancels with a real date, never stamping over an existing one", () => {
    expect(ok(base, { status: "done" })).toBe("- [x] Write the DS346 test #task 📅 2026-10-04 ✅ 2026-10-03");
    expect(ok(base, { status: "done", statusDate: "2026-09-28" })).toContain("✅ 2026-09-28");
    expect(ok(base, { status: "cancelled" })).toBe("- [-] Write the DS346 test #task 📅 2026-10-04 ❌ 2026-10-03");
    expect(err("- [x] done ✅ 2026-10-01", { status: "done" })).toMatch(/already done/);
    expect(ok("- [x] done ✅ 2026-10-01", { status: "open" })).toBe("- [ ] done");
  });
  it("refuses to complete a recurring task, which only the Tasks plugin can roll forward", () => {
    expect(err("- [ ] water plants 🔁 every week 📅 2026-10-04", { status: "done" })).toMatch(/recurring/);
    expect(ok("- [ ] water plants 🔁 every week 📅 2026-10-04", { due: "2026-10-06" })).toContain("📅 2026-10-06");
  });
  it("sets and clears priority without disturbing dates", () => {
    expect(ok(base, { priority: "high" })).toBe("- [ ] Write the DS346 test #task ⏫ 📅 2026-10-04");
    expect(ok("- [ ] x ⏫ 📅 2026-10-04", { priority: "low" })).toBe("- [ ] x 🔽 📅 2026-10-04");
    expect(ok("- [ ] x ⏫ 📅 2026-10-04", { priority: "none" })).toBe("- [ ] x 📅 2026-10-04");
  });
  it("adds and removes tags and a mention, in the description, before the dates", () => {
    expect(ok(base, { addTags: ["waiting"], mention: "Sam" })).toBe("- [ ] Write the DS346 test #task #waiting @Sam 📅 2026-10-04");
    expect(err("- [ ] a #waiting @Sam", { addTags: ["waiting"], mention: "Sam" })).toMatch(/wouldn't change/);
    expect(ok("- [ ] a #waiting @Sam 📅 2026-10-04", { removeTags: ["waiting"] })).toBe("- [ ] a @Sam 📅 2026-10-04");
    expect(ok("- [ ] a", { mention: "@sam!" })).toBe("- [ ] a @sam");
  });
  it("renames while keeping every marker", () => {
    expect(ok("- [ ] Old name ⏫ 📅 2026-10-04", { text: "New name" })).toBe("- [ ] New name ⏫ 📅 2026-10-04");
    expect(err(base, { text: "ship it 📅 2026-10-09" })).toMatch(/due date/);
    expect(err(base, { text: "  " })).toMatch(/empty/);
  });
  it("combines edits and leaves indentation and bullet style alone", () => {
    expect(ok("    * [ ] nested", { due: "2026-10-09", priority: "high" })).toBe("    * [ ] nested ⏫ 📅 2026-10-09");
  });
  it("won't touch something that isn't a task", () => {
    expect(err("just text", { due: "2026-10-09" })).toMatch(/isn't a task/);
    expect(dueOf(base)).toBe("2026-10-04");
    expect(dueOf("- [ ] none")).toBeUndefined();
  });
});

describe("shared date reading", () => {
  it("reads next/short weekdays the way people say them", () => {
    expect(findDate("next tues", T)?.due).toBe("2026-10-06"); // the Tuesday in the week starting next Monday
    expect(findDate("friday", T)?.due).toBe("2026-10-09");
    expect(findDate("by wed", T)?.due).toBe("2026-10-07");
    expect(findDate("I sat the test", T)).toBeUndefined();
    expect(findDate("push to 20 oct", T)?.due).toBe("2026-10-20");
  });
  it("reads past dates for completions", () => {
    expect(findPastDate("yesterday", T)?.due).toBe("2026-10-02");
    expect(findPastDate("on monday", T)?.due).toBe("2026-09-28");
    expect(findPastDate("3 days ago", T)?.due).toBe("2026-09-30");
    expect(findPastDate("saturday", T)?.due).toBe("2026-09-26"); // a week back, not today
  });
});
