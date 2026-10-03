import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFs } from "./memfs";
import { VaultWriter } from "../src/writers/writer";
import { applyOps, undoAction, recordAnswer, ApplyDeps } from "../src/intent/apply";
import { interpret } from "../src/intent/grammar";
import { emptyState, WriteRecord, coerceState } from "../src/state/schema";
import { parseTasks } from "../src/engine/collectors/tasks";
import { buildNote, readFrontmatter, restoreStatus, markHandled } from "../src/messages/note";
import { parseUpdate } from "../src/messages/telegram";
import type { Op, Subject, TaskSubject, MessageSubject, ActionRecord } from "../src/intent/types";
import { MAX_ACTIONS } from "../src/intent/types";

const template = readFileSync(join(__dirname, "fixtures/daily-template.md"), "utf8");
const TODAY = "2026-10-03";
const HUB = "Notes/Courses/CS345/CS345 Course Hub.md";
const hub = "# CS345\n\n## Tasks\n\n- [ ] Write the DS346 test #task 📅 2026-10-04\n- [ ] Read the tokenizer guide 📅 2026-10-08 #task\n- [ ] Email Sam #waiting\n\n## Notes\nx\n";
const MSG = "Inbox/messages/20260921-1613-1001-email-sam.md";

let fs: MemFs;
let writes: WriteRecord[];
let state = emptyState();
let n = 0;

const deps = (): ApplyDeps => ({
  writer: new VaultWriter(fs, {
    journalPath: (iso) => `Journal/${iso.replace(/-/g, "")}.md`,
    templatePath: () => "Templates/Daily Notes.md",
    format: (iso, f) => ({ "YYYY-MM-DD HH:mm": `${iso} 07:00`, "YYYY-MM-DD": iso, dddd: "Saturday", "dddd, MMMM DD, YYYY": "Saturday, October 03, 2026" }[f] ?? f),
    journalName: (iso) => iso.replace(/-/g, ""),
    courseHub: (code) => (code === "CS345" ? HUB : null),
    record: (r) => writes.push(r),
    now: () => new Date("2026-10-03T10:00:00Z"),
    uuid: () => `w${++n}`,
  }),
  fs,
  state,
  today: () => TODAY,
  now: () => new Date("2026-10-03T10:00:00Z"),
  uuid: () => `a${++n}`,
  record: (r) => writes.push(r),
});

const subjectsFor = (): TaskSubject[] =>
  parseTasks(HUB, fs.files.get(HUB)!).map((t, i) => ({ type: "task", key: `t${i}`, label: t.text, path: t.path, line: t.line, raw: t.raw, due: t.due, waiting: t.waiting }));
const run = (input: string, subs: Subject[], source: "bar" | "telegram" = "bar") => {
  const r = interpret(input, subs, { today: TODAY, courses: ["CS345", "CS344"] });
  if (r.kind !== "ops") throw new Error(`not ops: ${r.kind}`);
  return applyOps(deps(), r.ops, { source, input, subjects: subs, interpreter: "grammar", summary: r.summary });
};

beforeEach(() => {
  fs = new MemFs({ "Templates/Daily Notes.md": template, [HUB]: hub });
  writes = [];
  state = emptyState();
  n = 0;
});

describe("apply and undo: tasks", () => {
  it("'next tues' re-dates the selected task, and undo puts it back exactly", async () => {
    const [t] = subjectsFor();
    const a = await run("next tues", [t]);
    expect(a).toMatchObject({ status: "applied", interpreter: "grammar", summary: "Move task to Tue 6 Oct" });
    expect(a.ops[0].summary).toBe("“Write the DS346 test #task”: due Tue 6 Oct");
    expect(fs.files.get(HUB)).toContain("- [ ] Write the DS346 test #task 📅 2026-10-06");
    expect(state.actions[0]).toBe(a);

    const r = await undoAction(deps(), a);
    expect(r).toEqual({ undone: 1, skipped: [] });
    expect(fs.files.get(HUB)).toBe(hub); // byte-identical
    expect(a.status).toBe("undone");
    expect((await undoAction(deps(), a)).undone).toBe(0); // a second undo does nothing
  });
  it("multi-select: one instruction edits every selected task, in one action", async () => {
    const subs = subjectsFor().slice(0, 2);
    const a = await run("done", subs);
    expect(a.ops).toHaveLength(2);
    expect(fs.files.get(HUB)).toContain("- [x] Write the DS346 test #task 📅 2026-10-04 ✅ 2026-10-03");
    expect(fs.files.get(HUB)).toContain("- [x] Read the tokenizer guide 📅 2026-10-08 #task ✅ 2026-10-03");
    await undoAction(deps(), a);
    expect(fs.files.get(HUB)).toBe(hub);
  });
  it("a task that changed since you selected it is skipped and reported, not guessed at", async () => {
    const subs = subjectsFor().slice(0, 2);
    fs.files.set(HUB, hub.replace("Write the DS346 test #task 📅 2026-10-04", "Write the DS346 test v2 📅 2026-10-04"));
    const a = await run("friday", subs);
    expect(a.status).toBe("partial");
    expect(a.ops[0]).toMatchObject({ ok: false });
    expect(a.ops[0].error).toMatch(/has changed since you selected it/);
    expect(a.ops[1].ok).toBe(true);
    expect(fs.files.get(HUB)).toContain("Write the DS346 test v2 📅 2026-10-04"); // untouched
  });
  it("undo won't overwrite an edit you made afterwards", async () => {
    const [t] = subjectsFor();
    const a = await run("friday", [t]);
    fs.files.set(HUB, fs.files.get(HUB)!.replace("📅 2026-10-09", "📅 2026-10-09 ⏫")); // you tweaked it by hand
    const r = await undoAction(deps(), a);
    expect(r.undone).toBe(0);
    expect(r.skipped[0]).toMatch(/has changed since/);
    expect(fs.files.get(HUB)).toContain("⏫"); // your edit survives
    expect(a.status).toBe("applied");
  });
  it("waiting on someone, then undo", async () => {
    const t = subjectsFor()[1];
    const a = await run("waiting on sam", [t]);
    expect(fs.files.get(HUB)).toContain("- [ ] Read the tokenizer guide #waiting @sam 📅 2026-10-08 #task");
    await undoAction(deps(), a);
    expect(fs.files.get(HUB)).toBe(hub);
  });
  it("cancelling is a mark, not a delete, so nothing is lost", async () => {
    const [t] = subjectsFor();
    await run("drop", [t]);
    expect(fs.files.get(HUB)).toContain("- [-] Write the DS346 test #task 📅 2026-10-04 ❌ 2026-10-03");
  });
  it("every edit is also in the low-level write log, with hashes", async () => {
    await run("friday", [subjectsFor()[0]]);
    expect(writes.map((w) => w.op)).toEqual(["task-edit"]);
    expect(writes[0].before).not.toBe(writes[0].after);
    expect(writes[0].source).toBe("you");
  });
});

describe("apply and undo: creating tasks", () => {
  it("adds a task with the date read from your words, and undo removes exactly that line", async () => {
    const a = await run("cs345 email the group about the repo friday", []);
    expect(a.summary).toBe("New task due Fri 9 Oct");
    expect(fs.files.get(HUB)).toContain("- [ ] CS345 email the group about the repo friday 📅 2026-10-09");
    await undoAction(deps(), a);
    expect(fs.files.get(HUB)!.replace(/\n{3,}/g, "\n\n")).toContain("- [ ] Email Sam #waiting\n\n## Notes");
    expect(fs.files.get(HUB)).not.toContain("email the group");
  });
  it("a task for no particular course goes to today's journal, and undo removes it from there", async () => {
    const a = await run("buy a charger tomorrow", []);
    expect(await fs.read("Journal/20261003.md")).toContain("- [ ] buy a charger tomorrow 📅 2026-10-04");
    await undoAction(deps(), a);
    expect(await fs.read("Journal/20261003.md")).not.toContain("buy a charger");
  });
});

describe("apply and undo: messages", () => {
  const msgSubject = (): MessageSubject => ({ type: "message", key: "m", label: "email Sam", path: MSG, kind: "text", excerpt: "email Sam about the invoice on monday" });
  beforeEach(() => {
    fs.files.set(MSG, buildNote(parseUpdate({ relay_id: 1, update_id: 1001, update: { update_id: 1001, message: { message_id: 1, date: 1790000000, chat: { id: 1 }, text: "email Sam about the invoice on monday" } } })!, { attachments: [], attachmentStatus: "none", transcriptStatus: "none", descriptionStatus: "none", fileIds: [] }));
  });
  it("'task' makes a dated task and marks the message actioned; undo reverses both", async () => {
    const original = fs.files.get(MSG)!;
    const a = await run("task", [msgSubject()]);
    expect(a.ops.map((o) => o.ok)).toEqual([true, true]);
    expect(fs.files.get("Journal/20261003.md")).toContain("- [ ] email Sam about the invoice on monday 📅 2026-10-05");
    expect(readFrontmatter(fs.files.get(MSG)!)).toMatchObject({ status: "actioned", handled: TODAY, handled_by: '"you"' });
    await undoAction(deps(), a);
    expect(readFrontmatter(fs.files.get(MSG)!).status).toBe("new");
    expect(fs.files.get(MSG)).toBe(original);
    expect(fs.files.get("Journal/20261003.md")).not.toContain("email Sam about the invoice");
  });
  it("an agent-made change is attributed to the agent, a typed one to you", async () => {
    await run("noted", [msgSubject()], "telegram");
    expect(readFrontmatter(fs.files.get(MSG)!).handled_by).toBe('"agent"');
  });
  it("restoreStatus keeps earlier handling lines when stepping back one status", () => {
    const base = fs.files.get(MSG)!;
    const once = markHandled(base, "acknowledged", { by: "you", date: "2026-10-02", summary: "" });
    const twice = markHandled(once, "actioned", { by: "agent", date: "2026-10-03", summary: "task" });
    const back = restoreStatus(twice, "acknowledged");
    expect(readFrontmatter(back).status).toBe("acknowledged");
    expect(back.match(/^- 2026/gm)).toHaveLength(1);
  });
});

describe("apply and undo: announcements and radar", () => {
  it("snooze and dismiss are restored exactly, including a previous snooze", async () => {
    state.interactions.snoozes["x"] = "2026-10-05T04:00:00.000Z";
    const a = await run("dismiss", [{ type: "announcement", key: "k", label: "x", id: "x", level: "soon" }]);
    expect(state.interactions.acks["x"]).toBeTruthy();
    await undoAction(deps(), a);
    expect(state.interactions.acks["x"]).toBeUndefined();
    expect(state.interactions.snoozes["x"]).toBe("2026-10-05T04:00:00.000Z");
  });
  it("radar edits and removal are reversible", async () => {
    state.radar = [{ id: "proj", name: "BPE project", due: "2026-10-05T14:00", weight: 40, course: "CS345" }];
    const sub = { type: "radar" as const, key: "r", label: "BPE project", id: "proj", due: "2026-10-05T14:00", weight: 40, editable: true };
    const a = await run("weight 30", [sub]);
    expect(state.radar[0].weight).toBe(30);
    const b = await run("remove", [sub]);
    expect(state.radar).toHaveLength(0);
    await undoAction(deps(), b);
    expect(state.radar[0].weight).toBe(30);
    await undoAction(deps(), a);
    expect(state.radar[0]).toEqual({ id: "proj", name: "BPE project", due: "2026-10-05T14:00", weight: 40, course: "CS345" });
  });
  it("reports a deadline that isn't on the editable radar", async () => {
    const a = await run("weight 30", [{ type: "radar", key: "r", label: "x", id: "ghost", editable: true }]);
    expect(a.status).toBe("failed");
    expect(a.ops[0].error).toMatch(/isn't on the editable radar/);
  });
});

describe("history", () => {
  it("is newest first, capped, and survives a round trip through saved state", async () => {
    for (let i = 0; i < MAX_ACTIONS + 5; i++) await applyOps(deps(), [{ k: "announcement.ack", id: `a${i}` }], { source: "bar", input: "ack", subjects: [], interpreter: "grammar", summary: `s${i}` });
    expect(state.actions).toHaveLength(MAX_ACTIONS);
    expect(state.actions[0].summary).toBe(`s${MAX_ACTIONS + 4}`);
    const back = coerceState(JSON.parse(JSON.stringify(state)));
    expect(back.actions).toHaveLength(MAX_ACTIONS);
    expect(back.actions[0].ops[0].inverse).toMatchObject({ k: "interaction.restore" });
  });
  it("records an answer with nothing to undo", () => {
    const a: ActionRecord = recordAnswer(deps(), { source: "bar", input: "? why", subjects: [], interpreter: "agent", summary: "Answered", reply: "Because it is 40%." });
    expect(a).toMatchObject({ status: "answered", reply: "Because it is 40%.", ops: [] });
  });
});
