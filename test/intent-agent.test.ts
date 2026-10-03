import { describe, expect, it } from "vitest";
import { INTENT_SCHEMA, buildIntentSnapshot, resolveAgentOps, AgentResult } from "../src/intent/agent";
import { validate } from "../src/runner/validate";
import { parseTasks } from "../src/engine/collectors/tasks";
import { taskSubject, textSubject } from "../src/intent/subjects";

const TODAY = "2026-10-03";
const tasks = parseTasks("Areas/Work/CURRENT.md", "## Tasks\n- [ ] Write the DS346 test 📅 2026-10-04\n- [ ] Ship the Acme fix #waiting @sam 📅 2026-10-09\n- [ ] Order a new charger cable\n");
const subs = tasks.map(taskSubject);
const ctx = (over = {}) => ({ subjects: [], tasks, today: TODAY, newMessages: new Set(["Inbox/messages/a.md"]), announcementIds: new Set(["brief:x"]), radar: [{ id: "proj", name: "Project", due: "2026-10-05T14:00" }], ...over });
const res = (ops: AgentResult["ops"], extra: Partial<AgentResult> = {}): AgentResult => ({ summary: "s", reply: "", ops, ...extra });

describe("intent schema", () => {
  it("accepts a well-formed result and rejects bad dates and unknown operations", () => {
    expect(validate(res([{ k: "task.patch", target: 0, due: "2026-10-09" }]), INTENT_SCHEMA)).toEqual([]);
    expect(validate(res([{ k: "task.patch", target: 0, due: "friday" }]), INTENT_SCHEMA).join()).toMatch(/due: does not match/);
    expect(validate(res([{ k: "rm -rf" }]), INTENT_SCHEMA).join()).toMatch(/must be one of/);
    expect(validate(res(Array.from({ length: 11 }, () => ({ k: "task.patch" }))), INTENT_SCHEMA).join()).toMatch(/at most 10/);
  });
});

describe("snapshot", () => {
  const base = { tasks, newMessages: [], announcements: [], radar: [], courses: [], today: TODAY, weekday: "Saturday", time: "09:00" };
  it("hands the model the real selected objects with their file and line", () => {
    const s = buildIntentSnapshot({ ...base, args: { input: "next tues", origin: "bar", subjects: [subs[0]] } });
    expect(s.subjects[0]).toMatchObject({ index: 0, type: "task", file: "Areas/Work/CURRENT.md", line: 2, due: "2026-10-04" });
    expect(Object.keys(s).pop()).toBe("now");
  });
  it("keeps the candidate list short when something is selected, and long when it must search", () => {
    const many = parseTasks("a.md", "## Tasks\n" + Array.from({ length: 80 }, (_, i) => `- [ ] t${i} 📅 2026-10-${String(4 + (i % 15)).padStart(2, "0")}`).join("\n"));
    expect(buildIntentSnapshot({ ...base, tasks: many, args: { input: "x", origin: "bar", subjects: [taskSubject(many[0])] } }).candidates.tasks).toHaveLength(12);
    expect(buildIntentSnapshot({ ...base, tasks: many, args: { input: "x", origin: "telegram", subjects: [] } }).candidates.tasks).toHaveLength(60);
  });
  it("describes highlighted text and an originating message", () => {
    const s = buildIntentSnapshot({ ...base, args: { input: "x", origin: "editor", subjects: [textSubject("buy milk", "n.md")], originMessage: { path: "p.md", kind: "voice", attachments: [] } } });
    expect(s.subjects[0]).toMatchObject({ type: "text", text: "buy milk", fromNote: "n.md" });
    expect(s.originMessage).toMatchObject({ kind: "voice" });
  });
});

describe("resolveAgentOps: the model can only act on what you gave it", () => {
  it("patches the selected task by index", () => {
    const { ops, rejected } = resolveAgentOps(res([{ k: "task.patch", target: 1, due: "2026-10-13", addTags: ["#waiting"], mention: "sam" }]), ctx({ subjects: subs }));
    expect(rejected).toEqual([]);
    expect(ops[0]).toMatchObject({ k: "task.patch", patch: { due: "2026-10-13", addTags: ["waiting"], mention: "sam" } });
    expect((ops[0] as { subject: { label: string } }).subject.label).toBe("Ship the Acme fix #waiting @sam");
  });
  it("finds a task by file and line when nothing was selected (a message from your phone)", () => {
    const { ops } = resolveAgentOps(res([{ k: "task.patch", ref: "Areas/Work/CURRENT.md", line: 2, due: "2026-10-13" }]), ctx());
    expect(ops).toHaveLength(1);
    const miss = resolveAgentOps(res([{ k: "task.patch", ref: "Areas/Work/CURRENT.md", line: 99, due: "2026-10-13" }]), ctx());
    expect(miss.rejected[0]).toMatch(/not one of your tasks/);
  });
  it("rejects a target index that isn't a task, or doesn't exist", () => {
    const m = textSubject("x");
    expect(resolveAgentOps(res([{ k: "task.patch", target: 0, due: "2026-10-13" }]), ctx({ subjects: [m] })).rejected[0]).toMatch(/not one of your tasks/);
    expect(resolveAgentOps(res([{ k: "task.patch", target: 5, due: "2026-10-13" }]), ctx({ subjects: subs })).rejected).toHaveLength(1);
  });
  it("won't mark a task done in the future, or with an impossible date", () => {
    expect(resolveAgentOps(res([{ k: "task.patch", target: 0, taskStatus: "done", statusDate: "2026-10-09" }]), ctx({ subjects: subs })).rejected[0]).toMatch(/past/);
    expect(resolveAgentOps(res([{ k: "task.patch", target: 0, due: "2026-02-30" }]), ctx({ subjects: subs })).rejected[0]).toMatch(/not a real date/);
    expect(resolveAgentOps(res([{ k: "task.patch", target: 0, taskStatus: "done" }]), ctx({ subjects: subs })).ops[0]).toMatchObject({ patch: { status: "done", statusDate: TODAY } });
  });
  it("creates tasks through the same duplicate and prose-date checks as everything else", () => {
    const r = resolveAgentOps(res([
      { k: "task.create", text: "Order a new charger cable" }, // duplicate
      { k: "task.create", text: "Hand in the form by Friday" }, // date only in prose
      { k: "task.create", text: "Book the car service", createDue: "2026-10-14" },
    ]), ctx());
    expect(r.ops).toEqual([{ k: "task.create", text: "Book the car service", due: "2026-10-14", course: undefined }]);
    expect(r.rejected.join(" ")).toMatch(/duplicate of/);
    expect(r.rejected.join(" ")).toMatch(/no 📅/);
  });
  it("turns a re-dated duplicate into an edit of the original task", () => {
    const r = resolveAgentOps(res([{ k: "task.create", text: "Write the DS346 test", createDue: "2026-10-12" }]), ctx());
    expect(r.ops[0]).toMatchObject({ k: "task.patch", patch: { due: "2026-10-12" } });
  });
  it("only touches messages that are really new", () => {
    const ok = resolveAgentOps(res([{ k: "message.status", ref: "Inbox/messages/a.md", messageStatus: "ignored" }]), ctx());
    expect(ok.ops).toHaveLength(1);
    const bad = resolveAgentOps(res([{ k: "message.status", ref: "Notes/Secret.md", messageStatus: "ignored" }]), ctx());
    expect(bad.ops).toEqual([]);
    expect(bad.rejected[0]).toMatch(/not a new message/);
  });
  it("records what became of the message it was working from", () => {
    const r = resolveAgentOps(res([], { messageStatus: { status: "actioned", summary: "made a task" } }), ctx({ originMessage: "Inbox/messages/a.md" }));
    expect(r.ops).toEqual([{ k: "message.status", path: "Inbox/messages/a.md", status: "actioned", summary: "made a task" }]);
    expect(resolveAgentOps(res([], { messageStatus: { status: "actioned", summary: "x" } }), ctx({ originMessage: "Inbox/messages/gone.md" })).ops).toEqual([]);
  });
  it("only edits announcements and radar items that exist", () => {
    expect(resolveAgentOps(res([{ k: "announcement.ack", ref: "brief:x" }, { k: "announcement.ack", ref: "brief:nope" }]), ctx()).ops).toHaveLength(1);
    expect(resolveAgentOps(res([{ k: "announcement.snooze", ref: "brief:x", snoozeDays: 999 }]), ctx()).ops[0]).toMatchObject({ until: "2026-11-02T04:00:00.000Z" }); // capped at 30 days
    expect(resolveAgentOps(res([{ k: "radar.patch", ref: "proj", weight: 30 }, { k: "radar.patch", ref: "ghost", weight: 1 }]), ctx()).ops).toEqual([{ k: "radar.patch", id: "proj", patch: { weight: 30 } }]);
  });
  it("caps the number of operations and rejects ones it doesn't know", () => {
    const many = Array.from({ length: 14 }, () => ({ k: "announcement.ack", ref: "brief:x" }));
    expect(resolveAgentOps(res(many), ctx()).ops).toHaveLength(10);
    expect(resolveAgentOps(res([{ k: "file.delete", ref: "x" }]), ctx()).rejected[0]).toMatch(/not an operation/);
  });
});

describe("calendar fields from the agent", () => {
  it("accepts a time and onCalendar in the schema, and rejects a malformed time", () => {
    expect(validate(res([{ k: "task.patch", target: 0, time: "14:00-15:30", onCalendar: true }]), INTENT_SCHEMA)).toEqual([]);
    expect(validate(res([{ k: "task.patch", target: 0, time: "2pm" }]), INTENT_SCHEMA).join()).toMatch(/time: does not match/);
  });
  it("puts a selected task on the calendar with a time", () => {
    const { ops } = resolveAgentOps(res([{ k: "task.patch", target: 0, due: "2026-10-21", time: "14:00-15:00", onCalendar: true }]), ctx({ subjects: subs }));
    expect(ops[0]).toMatchObject({ k: "task.patch", patch: { due: "2026-10-21", time: "14:00-15:00", calendar: true } });
  });
  it("takes a task off the calendar", () => {
    expect(resolveAgentOps(res([{ k: "task.patch", target: 0, onCalendar: false }]), ctx({ subjects: subs })).ops[0]).toMatchObject({ patch: { calendar: false } });
  });
  it("routes by alias, and creates a calendar task with a time", () => {
    const r = resolveAgentOps(res([
      { k: "task.patch", target: 0, onCalendar: true, calendarAlias: "uni" },
      { k: "task.create", text: "Dentist", createDue: "2026-10-14", time: "09:30", onCalendar: true },
      { k: "task.create", text: "Buy stamps", createDue: "2026-10-14" },
    ]), ctx({ subjects: subs }));
    expect(r.ops[0]).toMatchObject({ patch: { calendar: "uni" } });
    expect(r.ops[1]).toEqual({ k: "task.create", text: "Dentist", due: "2026-10-14", course: undefined, time: "09:30", calendar: true });
    expect(r.ops[2]).toMatchObject({ text: "Buy stamps", time: undefined, calendar: undefined }); // not everything goes on the calendar
  });
});
