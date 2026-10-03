import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFs } from "./memfs";
import { VaultWriter } from "../src/writers/writer";
import { executeBrief, executeClose, ExecDeps } from "../src/runner/jobs/execute";
import { planBrief, planMessages, BriefResult, CloseResult } from "../src/runner/jobs/plan";
import { buildBriefSnapshot } from "../src/runner/jobs/brief";
import { buildCloseSnapshot } from "../src/runner/jobs/close";
import { setMessageStatus } from "../src/messages/ingest";
import { parseMessageNote } from "../src/messages/collect";
import { buildNote, readFrontmatter } from "../src/messages/note";
import { parseUpdate } from "../src/messages/telegram";
import { emptyState, WriteRecord } from "../src/state/schema";
import { parseTasks } from "../src/engine/collectors/tasks";

const template = readFileSync(join(__dirname, "fixtures/daily-template.md"), "utf8");
const DATE = "2026-10-03";
const noteFor = (n: number, m: Record<string, unknown>, parts: Partial<Parameters<typeof buildNote>[1]> = {}) =>
  buildNote(parseUpdate({ relay_id: n, update_id: 1000 + n, update: { update_id: 1000 + n, message: { message_id: n, date: 1790000000 + n, chat: { id: 1 }, ...m } } })!, { attachments: [], attachmentStatus: "none", transcriptStatus: "none", descriptionStatus: "none", fileIds: [], ...parts });

let fs: MemFs;
let writes: WriteRecord[];
let state = emptyState();
const A = "Inbox/messages/20260921-1613-1001-email-sam.md";
const B = "Inbox/messages/20260921-1614-1002-voice.md";
const C = "Inbox/messages/20260921-1615-1003-spam.md";

const deps = (): ExecDeps => ({
  writer: new VaultWriter(fs, {
    journalPath: (iso) => `Journal/${iso.replace(/-/g, "")}.md`,
    templatePath: () => "Templates/Daily Notes.md",
    format: (iso, f) => ({ "YYYY-MM-DD HH:mm": `${iso} 07:00`, "YYYY-MM-DD": iso, dddd: "Saturday", "dddd, MMMM DD, YYYY": "Saturday, October 03, 2026" }[f] ?? f),
    journalName: (iso) => iso.replace(/-/g, ""),
    courseHub: () => null,
    record: (r) => writes.push(r),
    now: () => new Date("2026-10-03T10:00:00Z"),
    uuid: () => `w${writes.length + 1}`,
  }),
  state,
  tasks: () => parseTasks("x.md", ""),
  now: () => new Date("2026-10-03T10:00:00Z"),
  messages: {
    newPaths: () => new Set([...fs.files.keys()].filter((k) => k.startsWith("Inbox/messages/") && k.endsWith(".md") && readFrontmatter(fs.files.get(k)!).status === "new")),
    mark: (path, status, by, summary) => setMessageStatus({ fs, record: (r) => writes.push(r), now: () => new Date("2026-10-03T10:00:00Z"), uuid: () => `m${writes.length + 1}` }, path, status, { by, date: DATE, summary }),
  },
});

const brief = (over: Partial<BriefResult> = {}): BriefResult => ({ announcements: [], priorities: [], timeline: [], notes: "n", missing: [], carriedForward: "", radar: [], taskOps: [], messages: [], ...over });
const close = (over: Partial<CloseResult> = {}): CloseResult => ({ summary: "s", notes: "n", rawEdits: [], taskOps: [], announcements: [], messages: [], ...over });

beforeEach(() => {
  writes = [];
  state = emptyState();
  fs = new MemFs({
    "Templates/Daily Notes.md": template,
    [A]: noteFor(1, { text: "email Sam about the invoice on monday" }),
    [B]: noteFor(2, { voice: { file_id: "v", duration: 9 } }, { transcript: "book the car service", transcriptStatus: "done" }),
    [C]: noteFor(3, { text: "WIN A FREE PHONE click here" }),
  });
});

describe("message collector", () => {
  it("reads words, transcripts and attachments from real message notes", () => {
    const a = parseMessageNote(A, fs.files.get(A)!)!;
    expect(a).toMatchObject({ kind: "text", status: "new", excerpt: "email Sam about the invoice on monday", needsRetry: false });
    const b = parseMessageNote(B, fs.files.get(B)!)!;
    expect(b.kind).toBe("voice");
    expect(b.transcript).toBe("book the car service");
    expect(b.excerpt).toBe("book the car service");
    expect(parseMessageNote("Notes/x.md", "---\ntype: concept\n---\nhi")).toBeNull();
  });
  it("flags notes that are waiting on a download or transcript", () => {
    const n = noteFor(4, { voice: { file_id: "v", duration: 3 } }, { attachmentStatus: "pending", transcriptStatus: "pending", fileIds: ["v"] });
    expect(parseMessageNote("p.md", n)!.needsRetry).toBe(true);
  });
  it("reports a handled message with its new status and keeps the words", async () => {
    await setMessageStatus({ fs, record: (r) => writes.push(r), now: () => new Date(), uuid: () => "u" }, A, "actioned", { by: "brief", date: DATE, summary: "made a task" });
    const a = parseMessageNote(A, fs.files.get(A)!)!;
    expect(a.status).toBe("actioned");
    expect(a.excerpt).toBe("email Sam about the invoice on monday");
  });
});

describe("planMessages", () => {
  const paths = new Set([A, B]);
  it("accepts new messages, and rejects invented, repeated or already-handled paths", () => {
    const p = planMessages(
      [
        { path: A, disposition: "actioned", summary: "task" },
        { path: A, disposition: "ignored", summary: "again" },
        { path: "Inbox/messages/made-up.md", disposition: "actioned", summary: "x" },
        { path: "Notes/Concept.md", disposition: "ignored", summary: "y" },
      ],
      paths
    );
    expect(p.valid.map((m) => m.path)).toEqual([A]);
    expect(p.rejected).toHaveLength(3);
    expect(p.rejected.join(" ")).toMatch(/handled twice/);
  });
  it("treats everything as rejected when the channel isn't in use", () => {
    expect(planMessages([{ path: A, disposition: "ignored", summary: "" }], undefined).valid).toEqual([]);
  });
});

describe("brief and close handle messages", () => {
  it("brief: marks each message with the model's disposition, logs it, and the Writes line says so", async () => {
    const result = brief({
      messages: [
        { path: A, disposition: "actioned", summary: "created a task to email Sam" },
        { path: B, disposition: "acknowledged", summary: "car service noted" },
        { path: C, disposition: "ignored", summary: "spam" },
      ],
      taskOps: [{ op: "create", text: "Email Sam about the invoice", due: "2026-10-05", reason: "from a message" }],
    });
    const r = await executeBrief(deps(), result, DATE, "run1", true);
    expect(readFrontmatter(fs.files.get(A)!)).toMatchObject({ status: "actioned", handled: DATE, handled_by: '"brief"' });
    expect(readFrontmatter(fs.files.get(B)!).status).toBe("acknowledged");
    expect(readFrontmatter(fs.files.get(C)!).status).toBe("ignored");
    expect(fs.files.get(A)).toMatch(/## Handled\n- 2026-10-03 · actioned · brief — created a task to email Sam/);
    expect(await fs.read("Journal/20261003.md")).toMatch(/Writes:\*\* .*created 1 task; .*handled 3 messages/);
    expect(await fs.read("Journal/20261003.md")).toContain("- [ ] Email Sam about the invoice 📅 2026-10-05");
    expect(r.lines.join("\n")).toMatch(/message actioned: 20260921-1613-1001-email-sam\.md/);
    expect(writes.filter((w) => w.op === "message-status").map((w) => w.source)).toEqual(["brief", "brief", "brief"]);
  });
  it("brief: a message the model didn't mention stays new, and an invented path touches nothing", async () => {
    const before = new Map(fs.files);
    const r = await executeBrief(deps(), brief({ messages: [{ path: "Inbox/messages/ghost.md", disposition: "actioned", summary: "x" }] }), DATE, "r", true);
    expect(r.lines.join("\n")).toMatch(/rejected: message ghost\.md: not a new message/);
    for (const p of [A, B, C]) expect(fs.files.get(p)).toBe(before.get(p));
    expect(fs.files.has("Inbox/messages/ghost.md")).toBe(false);
  });
  it("brief: the dry-run preview lists what would happen to each message", () => {
    const p = planBrief(brief({ messages: [{ path: A, disposition: "actioned", summary: "task" }, { path: "x.md", disposition: "ignored", summary: "" }] }), { today: DATE, tasks: [], calendarChecked: true, newMessages: new Set([A]) });
    expect(p.preview.filter((l) => l.kind === "message").map((l) => l.text)).toEqual(["Message actioned: task"]);
    expect(p.preview.some((l) => l.kind === "reject" && /not a new message/.test(l.text))).toBe(true);
  });
  it("close: marks messages by 'close' and never alters the words", async () => {
    await mkJournal();
    await executeClose(deps(), close({ messages: [{ path: A, disposition: "acknowledged", summary: "noted" }] }), DATE, "2026-10-04", "run2");
    const t = fs.files.get(A)!;
    expect(readFrontmatter(t)).toMatchObject({ status: "acknowledged", handled_by: '"close"' });
    expect(parseMessageNote(A, t)!.excerpt).toBe("email Sam about the invoice on monday");
  });
});
async function mkJournal() {
  await deps().writer.ensureJournal(DATE, "t");
}

describe("snapshots", () => {
  const base = { date: DATE, weekday: "Saturday", time: "09:00", tasks: [], radar: [], courses: [] };
  const messages = { new: [{ path: A, kind: "text", received: "2026-09-21T16:13:00+02:00", text: "email Sam", attachments: [] }], moreNew: 4 };
  it("include messages when the channel is in use, and omit the field otherwise", () => {
    const withMsgs = buildBriefSnapshot({ ...base, journal: { todayExists: false, todayHasContent: false, gapDays: 0, todayPath: "J.md" }, engine: [], previous: null, acked: [], recentNotes: [], messages });
    expect(withMsgs.messages).toEqual(messages);
    expect(Object.keys(withMsgs).pop()).toBe("now"); // the date still comes last
    const without = buildBriefSnapshot({ ...base, journal: { todayExists: false, todayHasContent: false, gapDays: 0, todayPath: "J.md" }, engine: [], previous: null, acked: [], recentNotes: [] });
    expect("messages" in without).toBe(false);
    const c = buildCloseSnapshot({ ...base, tomorrow: "2026-10-04", rawText: "", form: { done: "", waiting: "", other: "" }, messages });
    expect(c.messages).toEqual(messages);
  });
});
