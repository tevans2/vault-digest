import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFs } from "./memfs";
import { VaultWriter } from "../src/writers/writer";
import { executeBrief, executeClose, applyWeek, approveTriage, ApplyError, ExecDeps } from "../src/runner/jobs/execute";
import { planBrief, planTriage, BriefResult, CloseResult, resolveOps } from "../src/runner/jobs/plan";
import { BRIEF_SCHEMA } from "../src/runner/jobs/brief";
import { CLOSE_SCHEMA } from "../src/runner/jobs/close";
import { WEEK_SCHEMA } from "../src/runner/jobs/week";
import { validate } from "../src/runner/validate";
import { emptyState, WriteRecord } from "../src/state/schema";
import { parseTasks, Task } from "../src/engine/collectors/tasks";
import { BOUNDARY_RE } from "../src/writers/journal";
import { rowsFromItems, scoreRadar } from "../src/engine/collectors/radar";

const template = readFileSync(join(__dirname, "fixtures/daily-template.md"), "utf8");
const DATE = "2026-10-02";
const J = "Journal/20261002.md";
const tail = (t: string) => t.slice(t.search(BOUNDARY_RE));

let fs: MemFs;
let writes: WriteRecord[];
let state = emptyState();
let tasks: Task[];
let n = 0;

const mk = (): ExecDeps => ({
  writer: new VaultWriter(fs, {
    journalPath: (iso) => `Journal/${iso.replace(/-/g, "")}.md`,
    templatePath: () => "Templates/Daily Notes.md",
    format: (iso, f) => ({ "YYYY-MM-DD HH:mm": `${iso} 07:00`, "YYYY-MM-DD": iso, dddd: "Friday", "dddd, MMMM DD, YYYY": "Friday, October 02, 2026" }[f] ?? f),
    journalName: (iso) => iso.replace(/-/g, ""),
    courseHub: (code) => (code === "CS345" ? "Notes/Courses/CS345/CS345 Course Hub.md" : null),
    record: (r) => writes.push(r),
    now: () => new Date("2026-10-02T05:00:00Z"),
    uuid: () => `w${++n}`,
  }),
  state,
  tasks: () => tasks,
  now: () => new Date("2026-10-02T05:00:00Z"),
});

const hub = "# CS345\n\n## Tasks\n\n- [ ] **Group project — BPE DFA tokenization** 📅 2026-10-05 #task\n- [ ] Read the tokenizer guide 📅 2026-10-08 #task\n\n## Notes\nx\n";
const brief = (over: Partial<BriefResult> = {}): BriefResult => ({
  announcements: [{ id: "a1", level: "urgent", text: "A1 due today" }],
  priorities: ["Submit A1"],
  timeline: [{ start: "09:00", end: "10:00", title: "CS343 Lecture" }],
  notes: "Blunt.",
  missing: [],
  carriedForward: "Two items unverified.",
  radar: [{ name: "DS346 A1", due: "2026-10-02", weight: 40, course: "DS346" }],
  taskOps: [],
  messages: [],
  ...over,
});

beforeEach(() => {
  fs = new MemFs({ "Templates/Daily Notes.md": template, "Notes/Courses/CS345/CS345 Course Hub.md": hub });
  writes = [];
  state = emptyState();
  tasks = parseTasks("Notes/Courses/CS345/CS345 Course Hub.md", hub);
});

describe("output contracts", () => {
  it("accept a well-formed result for each job", () => {
    expect(validate(brief(), BRIEF_SCHEMA)).toEqual([]);
    expect(validate({ summary: "s", notes: "n", rawEdits: [], taskOps: [{ op: "complete", file: "a.md", line: 3, doneDate: "2026-09-28", reason: "r" }], announcements: [], messages: [] }, CLOSE_SCHEMA)).toEqual([]);
    expect(validate({ triage: [{ path: "Inbox/a.md", action: "file", destination: "Notes", reason: "r" }], announcements: [], loadForecast: "f", ruleViolations: [] }, WEEK_SCHEMA)).toEqual([]);
  });
  it("reject bad dates and unknown ops before anything is written", () => {
    expect(validate(brief({ taskOps: [{ op: "create", text: "x", due: "friday", reason: "r" }] }), BRIEF_SCHEMA).join()).toMatch(/due: does not match/);
    expect(validate(brief({ taskOps: [{ op: "complete", reason: "r" }] }), BRIEF_SCHEMA).join()).toMatch(/must be one of/);
  });
});

describe("executeBrief", () => {
  it("creates the journal, writes sections, adds the task, refreshes radar, logs every write", async () => {
    const r = await executeBrief(mk(), brief({ taskOps: [{ op: "create", text: "CS344 book demo slot", due: "2026-10-12", reason: "calendar" }] }), DATE, "run1", true);
    const j = await fs.read(J);
    expect(j).toContain("date: 2026-10-02");
    expect(j).toContain("1. Submit A1");
    expect(j).toContain("- **09:00–10:00** — CS343 Lecture");
    expect(j).toContain("- [ ] CS344 book demo slot 📅 2026-10-12");
    expect(j).toMatch(/> \*\*Writes:\*\* updated Carried Forward, Priorities, Context, Notes; created 1 task; refreshed the radar \(1\)/);
    expect(state.brief?.priorities).toEqual(["Submit A1"]);
    expect(state.radar).toHaveLength(1);
    expect(r.lines.join("\n")).toMatch(/applied: create/);
    expect(writes.map((w) => w.op)).toEqual(["journal-create", "journal-sections"]);
    expect(writes.every((w) => w.source === "run1" || w.op === "journal-create")).toBe(true);
    expect(writes[1].before).not.toBe(writes[1].after);
  });
  it("never writes below the boundary, even when Raw looks like generated sections", async () => {
    const existing = (await new MemFs({ "Templates/Daily Notes.md": template }).read("Templates/Daily Notes.md")) && "";
    void existing;
    await executeBrief(mk(), brief(), DATE, "r", true);
    const withRaw = (await fs.read(J)) + "\n## Context\nmy own words\n## Actions\n- [ ] raw task\n";
    fs.files.set(J, withRaw);
    await executeBrief(mk(), brief({ priorities: ["Different"] }), DATE, "r2", true);
    expect(tail(await fs.read(J))).toBe(tail(withRaw));
    expect(await fs.read(J)).toContain("1. Different");
  });
  it("is idempotent: a second run adds no duplicate tasks or sections", async () => {
    const b = brief({ taskOps: [{ op: "create", text: "Book demo slot for CS344", due: "2026-10-12", reason: "r" }] });
    await executeBrief(mk(), b, DATE, "r1", true);
    const once = await fs.read(J);
    tasks = [...tasks, ...parseTasks(J, once)]; // the engine now sees the new task
    const r2 = await executeBrief(mk(), b, DATE, "r2", true);
    const again = await fs.read(J);
    // The Writes line honestly changes ("skipped 1 as a duplicate"); everything else must be identical.
    const strip = (t: string) => t.replace(/^> \*\*Writes:\*\*.*$/m, "");
    expect(strip(again)).toBe(strip(once));
    expect(again.match(/Book demo slot for CS344/g)).toHaveLength(1);
    expect(again).toMatch(/Writes:\*\* .*skipped 1 as a duplicate/);
    expect(r2.lines.join("\n")).toMatch(/skipped: create .*duplicate of/);
  });
  it("turns a re-dated duplicate into an edit of the original line", async () => {
    const b = brief({ taskOps: [{ op: "create", text: "Read the tokenizer guide", due: "2026-10-15", reason: "moved" }] });
    await executeBrief(mk(), b, DATE, "r", true);
    expect(await fs.read("Notes/Courses/CS345/CS345 Course Hub.md")).toContain("- [ ] Read the tokenizer guide 📅 2026-10-15 #task");
    expect((await fs.read(J)).match(/Read the tokenizer guide/g) ?? []).toHaveLength(0);
    expect(writes.some((w) => w.op === "task-redate")).toBe(true);
  });
  it("re-dates by file and line, and survives line drift", async () => {
    const b = brief({ taskOps: [{ op: "redate", file: "Notes/Courses/CS345/CS345 Course Hub.md", line: 6, due: "2026-10-20", reason: "r" }] });
    // someone inserts a line above the task after the snapshot was taken
    fs.files.set("Notes/Courses/CS345/CS345 Course Hub.md", "# CS345\nnew line\n\n" + hub.split("\n").slice(1).join("\n"));
    await executeBrief(mk(), b, DATE, "r", true);
    const out = await fs.read("Notes/Courses/CS345/CS345 Course Hub.md");
    // Line 6 (1-based) is "Read the tokenizer guide"; it moved down a line, and was still found by its text.
    expect(out).toContain("Read the tokenizer guide 📅 2026-10-20 #task");
    expect(out).toContain("BPE DFA tokenization** 📅 2026-10-05 #task"); // the neighbour is untouched
  });
  it("rejects an op the model invented and says why", async () => {
    const r = await executeBrief(mk(), brief({ taskOps: [{ op: "redate", file: "nope.md", line: 1, due: "2026-10-20", reason: "r" }] }), DATE, "r", true);
    expect(r.lines.join("\n")).toMatch(/rejected: .*could not find that open task/);
  });
  it("refuses to write the journal when the boundary marker is gone, and fails loudly", async () => {
    fs.files.set(J, template.replace(/<!-- RAW INPUT BOUNDARY[^>]*-->/, ""));
    const before = fs.files.get(J);
    await expect(executeBrief(mk(), brief({ taskOps: [{ op: "create", text: "should not be written", due: "2026-10-12", reason: "r" }] }), DATE, "r", true)).rejects.toThrow(ApplyError);
    expect(fs.files.get(J)).toBe(before);
    expect(writes).toEqual([]);
    expect(state.brief?.priorities).toEqual(["Submit A1"]); // the dashboard still gets the plan
  });
  it("plans the same changes it makes (dry-run preview matches execution)", () => {
    const p = planBrief(brief({ taskOps: [{ op: "create", text: "Pack the lab kit", due: "2026-10-09", reason: "r" }, { op: "create", text: "Hand in by Friday" }] as never }), { today: DATE, tasks, calendarChecked: true });
    expect(p.preview.map((l) => l.kind)).toEqual(["journal", "create", "reject", "radar"]);
  });
  it("says the calendar wasn't checked when it wasn't", async () => {
    await executeBrief(mk(), brief({ timeline: [], missing: ["Calendar not available with this provider"] }), DATE, "r", false);
    expect(await fs.read(J)).toContain("*The calendar was not checked this run.*");
  });
});

describe("the brief can put a task on the calendar", () => {
  it("writes the #cal tag and the time into the new task, so the sync picks it up", async () => {
    await executeBrief(mk(), brief({ taskOps: [
      { op: "create", text: "CS344 Test 3 revision session", due: "2026-10-20", time: "14:00-16:00", calendar: true, reason: "calendar shows a tutorial" },
      { op: "create", text: "Pack the lab kit", due: "2026-10-19", reason: "r" },
    ] as never }), DATE, "run", true);
    const j = await fs.read(J);
    expect(j).toContain("- [ ] CS344 Test 3 revision session #cal 📅 2026-10-20 ⏰ 14:00-16:00");
    expect(j).toContain("- [ ] Pack the lab kit 📅 2026-10-19"); // plain tasks stay off the calendar
    expect(j).not.toMatch(/Pack the lab kit #cal/);
  });
});

describe("authored radar", () => {
  it("scores weight ÷ fractional days from the authored items", () => {
    const rows = scoreRadar(rowsFromItems([{ id: "a", name: "A1", due: "2026-10-02", weight: 40 }, { id: "b", name: "Proj", due: "2026-10-05T14:00", weight: 40, course: "CS345" }]), DATE, Date.parse("2026-10-02T00:00:00+02:00"));
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0].liveScore).toBeGreaterThan(30);
    expect(rows[1].name).toBe("CS345 · Proj");
  });
});

describe("executeClose", () => {
  const close = (over: Partial<CloseResult> = {}): CloseResult => ({ summary: "s", notes: "Closed.", rawEdits: [], taskOps: [], announcements: [{ id: "tomorrow", level: "soon", text: "Tests tomorrow" }], ...over });
  const withRaw = async (raw: string) => {
    await executeBrief(mk(), brief(), DATE, "r0", true);
    fs.files.set(J, (await fs.read(J)).replace(/\s+$/, "") + "\n\n" + raw + "\n");
    writes = [];
  };

  it("appends the form answers below the boundary and logs it", async () => {
    await withRaw("existing words");
    await mk().writer.appendRaw(DATE, "### Close\n**Done:** A1");
    expect((await fs.read(J)).endsWith("### Close\n**Done:** A1\n")).toBe(true);
    expect(await fs.read(J)).toContain("existing words");
    expect(writes.map((w) => w.op)).toEqual(["raw-append"]);
  });
  it("fixes spelling only inside Raw, completes with the stated date, and refreshes notes", async () => {
    await withRaw("I recieve the sheet and did the CS345 project work on Monday.");
    const t = parseTasks("Notes/Courses/CS345/CS345 Course Hub.md", hub);
    tasks = t;
    const r = await executeClose(
      mk(),
      close({
        rawEdits: [{ find: "recieve", replace: "receive" }, { find: "Monday", replace: "Tuesday" }],
        taskOps: [{ op: "complete", file: t[0].path, line: t[0].line + 1, doneDate: "2026-09-28", reason: "you said so" }],
      }),
      DATE,
      "2026-10-03",
      "run2"
    );
    const j = await fs.read(J);
    expect(j).toContain("I receive the sheet");
    expect(j).toContain("on Monday."); // changing a word is not spelling
    expect(j).toContain("> Closed.");
    expect(j).toMatch(/completed 1; fixed spelling in 1 place/);
    expect(await fs.read("Notes/Courses/CS345/CS345 Course Hub.md")).toContain("tokenization** 📅 2026-10-05 #task ✅ 2026-09-28");
    expect(state.close?.forDate).toBe("2026-10-03");
    expect(state.close?.announcements[0].id).toBe("close:tomorrow");
    expect(r.lines.join("\n")).toMatch(/1 fixed, 1 left alone/);
  });
  it("won't complete without the real date or with a future one", async () => {
    await withRaw("x");
    const t = parseTasks("Notes/Courses/CS345/CS345 Course Hub.md", hub);
    tasks = t;
    const r = await executeClose(mk(), close({ taskOps: [{ op: "complete", file: t[0].path, line: t[0].line + 1, reason: "r" }, { op: "complete", file: t[1].path, line: t[1].line + 1, doneDate: "2026-10-09", reason: "r" }] }), DATE, "2026-10-03", "r");
    expect(r.lines.join("\n")).toMatch(/rejected: .*needs the real date/);
    expect(r.lines.join("\n")).toMatch(/rejected: .*in the future/);
    expect(await fs.read("Notes/Courses/CS345/CS345 Course Hub.md")).not.toContain("✅");
  });
  it("close can run with nothing written in Raw", async () => {
    await mk().writer.ensureJournal(DATE, "t");
    await expect(executeClose(mk(), close(), DATE, "2026-10-03", "r")).resolves.toBeTruthy();
  });
});

describe("capture routing", () => {
  it("puts a course-led task in the course hub's Tasks without a tag, undated ones in the journal", async () => {
    const w = mk().writer;
    const a = await w.capture("CS345 email the group about the repo", "2026-10-03", "CS345", DATE);
    expect(a.path).toBe("Notes/Courses/CS345/CS345 Course Hub.md");
    expect(await fs.read(a.path)).toContain("- [ ] CS345 email the group about the repo 📅 2026-10-03\n\n## Notes");
    const b = await w.capture("buy a charger", undefined, undefined, DATE);
    expect(b.path).toBe(J);
    expect(await fs.read(J)).toContain("- [ ] buy a charger");
    const c = await w.capture("CS344 hand in A2", "2026-10-30", "CS344", DATE); // no CS344 hub → journal
    expect(c.path).toBe(J);
  });
  it("tags a task #task when it lands in a note whose heading wouldn't count it", async () => {
    fs.files.set("Notes/Loose.md", "# Loose\n\nno tasks heading here\n");
    const r = await mk().writer.createTask("buy stamps", undefined, { path: "Notes/Loose.md", iso: DATE }, "user");
    expect(r.path).toBe(J);
    expect(r.line).toBe("- [ ] buy stamps #task");
  });
});

describe("inbox triage", () => {
  const ctx = () => ({
    inbox: [
      { path: "Inbox/Adapter plan.md", size: 5000 },
      { path: "Inbox/Untitled.md", size: 0 },
      { path: "Inbox/Financial Snapshot - 2026.md", size: 0 },
    ],
    folders: new Set(["Notes", "Areas", "Archive"]),
    allPaths: new Set(["Notes/Existing.md", "Inbox/Adapter plan.md", "Inbox/Untitled.md", "Inbox/Financial Snapshot - 2026.md"]),
  });
  const result = {
    triage: [
      { path: "Inbox/Adapter plan.md", action: "file", destination: "Notes", reason: "project notes" },
      { path: "Inbox/Untitled.md", action: "delete-empty", reason: "empty stub" },
      { path: "Inbox/Financial Snapshot - 2026.md", action: "delete-empty", reason: "empty" },
      { path: "Inbox/ghost.md", action: "archive", reason: "old" },
      { path: "Inbox/Adapter plan.md", action: "file", destination: "Journal", reason: "protected" },
      { path: "Inbox/Adapter plan.md", action: "file", destination: "Nowhere", reason: "no such folder" },
    ],
    announcements: [],
    loadForecast: "heavy",
    ruleViolations: [],
  };

  it("proposes only safe moves and explains every skip", () => {
    const items = planTriage(result.triage, ctx(), "r");
    expect(items.map((i) => i.status)).toEqual(["pending", "pending", "skipped", "skipped", "skipped", "skipped"]);
    expect(items[2].reason).toMatch(/only empty Untitled\* stubs/);
    expect(items[3].reason).toMatch(/not in the inbox/);
    expect(items[4].reason).toMatch(/protected/);
    expect(items[5].reason).toMatch(/doesn't exist/);
  });
  it("applying the week job touches no files", async () => {
    fs.files.set("Inbox/Adapter plan.md", "x".repeat(10));
    const before = new Map(fs.files);
    applyWeek(mk(), result, ctx(), DATE, "r");
    expect(new Map(fs.files)).toEqual(before);
    expect(state.triage.filter((t) => t.status === "pending")).toHaveLength(2);
    expect(state.week?.loadForecast).toBe("heavy");
  });
  it("moves on approval, trashes only empty Untitled stubs, and logs both", async () => {
    fs.files.set("Inbox/Adapter plan.md", "x".repeat(10));
    fs.files.set("Inbox/Untitled.md", "");
    fs.folders.add("Notes");
    applyWeek(mk(), result, ctx(), DATE, "r");
    const [move, del] = state.triage;
    await approveTriage(mk(), move.id, ctx());
    await approveTriage(mk(), del.id, ctx());
    expect(fs.files.has("Notes/Adapter plan.md")).toBe(true);
    expect(fs.files.has("Inbox/Adapter plan.md")).toBe(false);
    expect(fs.trashed).toEqual(["Inbox/Untitled.md"]);
    expect(writes.map((w) => w.op)).toEqual(["triage-move", "triage-delete"]);
  });
  it("refuses at approval time if the note changed since the proposal", async () => {
    fs.files.set("Inbox/Untitled.md", "now has content");
    applyWeek(mk(), result, ctx(), DATE, "r");
    const del = state.triage[1];
    const c = ctx();
    c.inbox[1].size = 15; // no longer empty
    await approveTriage(mk(), del.id, c);
    expect(del.status).toBe("failed");
    expect(fs.trashed).toEqual([]);
  });
  it("never overwrites an existing note", async () => {
    fs.files.set("Inbox/Adapter plan.md", "a");
    fs.files.set("Notes/Adapter plan.md", "different");
    const c = ctx();
    c.allPaths.add("Notes/Adapter plan.md");
    const [item] = planTriage(result.triage.slice(0, 1), c, "r");
    expect(item.status).toBe("skipped");
    expect(item.reason).toMatch(/already exists/);
    await expect(mk().writer.move("Inbox/Adapter plan.md", "Notes/Adapter plan.md", "r")).rejects.toThrow(/already exists/);
    expect(fs.files.get("Notes/Adapter plan.md")).toBe("different");
  });
  it("won't move journals or dot-folders even if asked directly", async () => {
    fs.files.set("Journal/20260930.md", "x");
    await expect(mk().writer.move("Journal/20260930.md", "Notes/x.md", "r")).rejects.toThrow(/protected/);
    await expect(mk().writer.deleteEmptyStub("Inbox/Real note.md", "r")).rejects.toThrow(/Untitled/);
  });
});

describe("model refs", () => {
  it("never lets the model pick a create target", () => {
    const { ops } = resolveOps([{ op: "create", text: "x task", due: "2026-10-12", file: "Journal/20260930.md" }], [], ["create"]);
    expect(ops[0]).toEqual({ op: "create", text: "x task", due: "2026-10-12", reason: undefined });
  });
  it("blocks operations a job isn't allowed", () => {
    expect(resolveOps([{ op: "complete", file: "a.md", line: 1, doneDate: "2026-09-01" }], [], ["create", "redate"]).rejected[0]).toMatch(/not allowed in this job/);
  });
});
