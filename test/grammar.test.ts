import { describe, expect, it } from "vitest";
import { interpret } from "../src/intent/grammar";
import type { AnnouncementSubject, MessageSubject, RadarSubject, TaskSubject, Op } from "../src/intent/types";

const ctx = { today: "2026-10-03", courses: ["CS344", "CS345", "DS346"] }; // a Saturday
const task = (raw: string, due?: string, i = 0): TaskSubject => ({ type: "task", key: `t${i}`, label: raw, path: "n.md", line: i, raw, due });
const T1 = task("- [ ] Write the DS346 test 📅 2026-10-04", "2026-10-04");
const ops = (r: ReturnType<typeof interpret>): Op[] => (r.kind === "ops" ? r.ops : []);
const patch = (r: ReturnType<typeof interpret>) => (ops(r)[0] as Extract<Op, { k: "task.patch" }>).patch;

describe("tasks", () => {
  it("'next tues' is a date, and the subject comes from the selection", () => {
    const r = interpret("next tues", [T1], ctx);
    expect(r.kind).toBe("ops");
    expect(patch(r)).toEqual({ due: "2026-10-06" });
    expect((r as { summary: string }).summary).toBe("Move task to Tue 6 Oct");
  });
  it("accepts filler words around a date", () => {
    for (const s of ["move to friday", "push it to friday", "due friday", "make it friday", "set deadline to friday", "reschedule to friday please"]) {
      expect(patch(interpret(s, [T1], ctx)), s).toEqual({ due: "2026-10-09" });
    }
  });
  it("applies one date to every selected task", () => {
    const r = interpret("monday", [T1, task("- [ ] b", undefined, 1)], ctx);
    expect(ops(r)).toHaveLength(2);
    expect(ops(r).every((o) => (o as Extract<Op, { k: "task.patch" }>).patch.due === "2026-10-05")).toBe(true);
  });
  it("shifts each task from its own due date, or from today if it's already overdue", () => {
    const late = task("- [ ] late 📅 2026-09-20", "2026-09-20", 1);
    const r = interpret("push 3 days", [T1, late], ctx);
    const dues = ops(r).map((o) => (o as Extract<Op, { k: "task.patch" }>).patch.due);
    expect(dues).toEqual(["2026-10-07", "2026-10-06"]);
    expect(patch(interpret("+1w", [T1], ctx)).due).toBe("2026-10-11");
    expect(patch(interpret("a week", [T1], ctx)).due).toBe("2026-10-11");
    expect(patch(interpret("next week", [T1], ctx)).due).toBe("2026-10-11");
  });
  it("completes, with today's date or the real day you did it", () => {
    expect(patch(interpret("done", [T1], ctx))).toEqual({ status: "done", statusDate: "2026-10-03" });
    expect(patch(interpret("done yesterday", [T1], ctx))).toEqual({ status: "done", statusDate: "2026-10-02" });
    expect(patch(interpret("done on monday", [T1], ctx)).statusDate).toBe("2026-09-28");
    expect(interpret("done, it was easy", [T1], ctx).kind).toBe("agent"); // won't guess at the rest
  });
  it("cancels, reopens, and clears a date", () => {
    expect(patch(interpret("drop", [T1], ctx)).status).toBe("cancelled");
    expect(patch(interpret("delete this", [T1], ctx)).status).toBe("cancelled");
    expect(patch(interpret("reopen", [T1], ctx)).status).toBe("open");
    expect(patch(interpret("clear the date", [T1], ctx))).toEqual({ due: null });
    expect(patch(interpret("drop the date", [T1], ctx))).toEqual({ due: null }); // not a cancel
  });
  it("handles waiting, with a name", () => {
    expect(patch(interpret("waiting on sam", [T1], ctx))).toEqual({ addTags: ["waiting"], mention: "sam" });
    expect(patch(interpret("waiting for Sam's reply", [T1], ctx)).mention).toBe("sam");
    expect(patch(interpret("waiting", [T1], ctx))).toEqual({ addTags: ["waiting"], mention: undefined });
    expect(patch(interpret("unblocked", [T1], ctx))).toEqual({ removeTags: ["waiting"] });
  });
  it("sets priority and renames, keeping the case you typed", () => {
    expect(patch(interpret("p1", [T1], ctx)).priority).toBe("high");
    expect(patch(interpret("urgent", [T1], ctx)).priority).toBe("high");
    expect(patch(interpret("normal", [T1], ctx)).priority).toBe("none");
    expect(patch(interpret("rename to Submit the DS346 A1", [T1], ctx)).text).toBe("Submit the DS346 A1");
  });
  it("files under a course, once, and per task", () => {
    expect(patch(interpret("course CS345", [T1], ctx)).text).toBe("CS345 Write the DS346 test");
    const already = task("- [ ] CS345 already 📅 2026-10-04", "2026-10-04");
    expect(interpret("course CS345", [already], ctx).kind).toBe("agent"); // nothing to do
    expect(ops(interpret("course CS344", [T1, task("- [ ] other", undefined, 1)], ctx))).toHaveLength(2);
  });
  it("hands anything it can't read to the agent instead of guessing", () => {
    expect(interpret("split this into two and move the second one", [T1], ctx).kind).toBe("agent");
    expect(interpret("push everything non-urgent", [T1], ctx).kind).toBe("agent");
    expect(interpret("friday and tell sam", [T1], ctx).kind).toBe("agent");
  });
});

describe("messages", () => {
  const msg = (excerpt: string, i = 0): MessageSubject => ({ type: "message", key: `m${i}`, label: excerpt, path: `Inbox/messages/${i}.md`, kind: "text", excerpt });
  it("ignores and acknowledges", () => {
    expect(ops(interpret("ignore", [msg("spam")], ctx))[0]).toMatchObject({ k: "message.status", status: "ignored" });
    expect(ops(interpret("noted", [msg("x")], ctx))[0]).toMatchObject({ k: "message.status", status: "acknowledged" });
  });
  it("turns a message into a task and marks it actioned, taking the date from you or from the message", () => {
    const a = ops(interpret("task friday", [msg("email Sam about the invoice")], ctx));
    expect(a[0]).toMatchObject({ k: "task.create", text: "email Sam about the invoice", due: "2026-10-09" });
    expect(a[1]).toMatchObject({ k: "message.status", status: "actioned" });
    const b = ops(interpret("task", [msg("email Sam on monday")], ctx));
    expect(b[0]).toMatchObject({ k: "task.create", due: "2026-10-05" });
    const c = ops(interpret("task: call the dentist tomorrow", [msg("junk")], ctx));
    expect(c[0]).toMatchObject({ k: "task.create", text: "call the dentist", due: "2026-10-04" });
  });
  it("makes one task per message", () => {
    expect(ops(interpret("task monday", [msg("a", 0), msg("b", 1)], ctx)).filter((o) => o.k === "task.create")).toHaveLength(2);
  });
});

describe("announcements and radar", () => {
  const ann: AnnouncementSubject = { type: "announcement", key: "a", label: "x", id: "brief:x", level: "soon" };
  it("dismisses and snoozes", () => {
    expect(ops(interpret("dismiss", [ann], ctx))[0]).toEqual({ k: "announcement.ack", id: "brief:x" });
    expect(ops(interpret("snooze", [ann], ctx))[0]).toMatchObject({ k: "announcement.snooze", until: "2026-10-04T04:00:00.000Z" });
    expect(ops(interpret("snooze 3d", [ann], ctx))[0]).toMatchObject({ until: "2026-10-06T04:00:00.000Z" });
    expect(ops(interpret("snooze friday", [ann], ctx))[0]).toMatchObject({ until: "2026-10-09T04:00:00.000Z" });
  });
  const rad = (editable = true, due = "2026-10-05T14:00"): RadarSubject => ({ type: "radar", key: "r", label: "CS345 project", id: "proj", due, weight: 40, editable });
  it("edits a deadline's weight, date and time", () => {
    expect(ops(interpret("weight 30", [rad()], ctx))[0]).toEqual({ k: "radar.patch", id: "proj", patch: { weight: 30 } });
    expect(ops(interpret("friday", [rad()], ctx))[0]).toEqual({ k: "radar.patch", id: "proj", patch: { due: "2026-10-09T14:00" } }); // keeps the time
    expect(ops(interpret("friday 16:30", [rad()], ctx))[0]).toEqual({ k: "radar.patch", id: "proj", patch: { due: "2026-10-09T16:30" } });
    expect(ops(interpret("at 17:00", [rad()], ctx))[0]).toEqual({ k: "radar.patch", id: "proj", patch: { due: "2026-10-05T17:00" } });
    expect(ops(interpret("remove", [rad()], ctx))[0]).toEqual({ k: "radar.remove", id: "proj" });
  });
  it("says so plainly when it can't edit something", () => {
    expect(interpret("friday", [rad(false)], ctx)).toMatchObject({ kind: "blocked" });
    expect(interpret("move it", [{ type: "event", key: "e", label: "x", start: "09:00", title: "x" }], ctx)).toMatchObject({ kind: "blocked" });
  });
});

describe("no selection", () => {
  it("adds a task, with the date read from the words", () => {
    const r = interpret("cs344 hand in A2 friday", [], ctx);
    expect(ops(r)[0]).toEqual({ k: "task.create", text: "CS344 hand in A2 friday", due: "2026-10-09", course: "CS344" });
  });
  it("treats questions as questions", () => {
    expect(interpret("what's due before monday?", [], ctx)).toEqual({ kind: "question", text: "what's due before monday?" });
    expect(interpret("? why is A1 top", [], ctx)).toEqual({ kind: "question", text: "why is A1 top" });
    expect(interpret("show me my overdue tasks", [], ctx).kind).toBe("question");
  });
  it("a leading ? asks about the selection instead of changing it", () => {
    expect(interpret("? why is this late", [T1], ctx)).toEqual({ kind: "question", text: "why is this late" });
  });
  it("mixed selections go to the agent, and empty input does nothing", () => {
    const m: MessageSubject = { type: "message", key: "m", label: "x", path: "p", kind: "text", excerpt: "x" };
    expect(interpret("link them", [T1, m], ctx)).toEqual({ kind: "agent", reason: "mixed" });
    expect(interpret("  ", [T1], ctx)).toEqual({ kind: "agent", reason: "empty" });
  });
});

import { SelectionStore } from "../src/intent/selection";
import { taskSubject, taskSubjectFromLine, textSubject, messageSubject } from "../src/intent/subjects";
import { parseTasks } from "../src/engine/collectors/tasks";

describe("highlighted text", () => {
  it("'task friday' makes a task from the words and links back to the note", () => {
    const sub = textSubject("Email Sam about the invoice", "Areas/Work/CURRENT.md");
    const r = interpret("task friday", [sub], ctx);
    expect(ops(r)[0]).toEqual({ k: "task.create", text: "Email Sam about the invoice [[CURRENT]]", due: "2026-10-09", course: undefined });
    expect(interpret("task", [textSubject("buy stamps tomorrow")], ctx)).toMatchObject({ kind: "ops" });
    expect(interpret("what does this mean", [sub], ctx).kind).toBe("agent");
  });
});

describe("selection", () => {
  const a = taskSubject(parseTasks("n.md", "## Tasks\n- [ ] one 📅 2026-10-04\n- [ ] two\n")[0]);
  const b = taskSubject(parseTasks("n.md", "## Tasks\n- [ ] one 📅 2026-10-04\n- [ ] two\n")[1]);
  it("toggles one or many, in the order you picked them", () => {
    const s = new SelectionStore();
    s.toggle(a);
    s.toggle(b);
    expect(s.all.map((x) => x.label)).toEqual(["one", "two"]);
    s.toggle(a);
    expect(s.all.map((x) => x.label)).toEqual(["two"]);
    expect(s.has(b.key)).toBe(true);
  });
  it("tells listeners, and stops when they unsubscribe", () => {
    const s = new SelectionStore();
    let n = 0;
    const off = s.onChange(() => n++);
    s.toggle(a);
    s.clear();
    s.clear(); // nothing to clear: no event
    off();
    s.toggle(b);
    expect(n).toBe(2);
  });
  it("keeps the same key for the same line, so selection survives a re-render", () => {
    const again = taskSubject(parseTasks("n.md", "## Tasks\n- [ ] one 📅 2026-10-04\n- [ ] two\n")[0]);
    expect(again.key).toBe(a.key);
    const moved = taskSubject(parseTasks("n.md", "## Tasks\n- [ ] one 📅 2026-10-09\n- [ ] two\n")[0]);
    expect(moved.key).not.toBe(a.key); // the line changed, so the old selection no longer points at it
  });
  it("reads a task from an editor line", () => {
    expect(taskSubjectFromLine("n.md", 4, "  - [ ] Call Sam ⏫ 📅 2026-10-04")).toMatchObject({ label: "Call Sam", due: "2026-10-04", line: 4 });
    expect(taskSubjectFromLine("n.md", 4, "just a sentence")).toBeNull();
  });
  it("builds message subjects from the words", () => {
    expect(messageSubject({ path: "p.md", kind: "voice", excerpt: "book the car", received: "", status: "new", text: "", attachments: [], needsRetry: false, edited: false }).label).toBe("book the car");
  });
});
