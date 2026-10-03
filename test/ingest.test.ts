import { describe, expect, it, beforeEach } from "vitest";
import { MemFs } from "./memfs";
import { fetchAndIngest, retryPending, setMessageStatus, IngestDeps, IngestCfg } from "../src/messages/ingest";
import { readFrontmatter, blockText, jsonList, messageBody } from "../src/messages/note";
import type { RelayItem } from "../src/messages/relay";
import type { Net } from "../src/messages/net";
import type { WriteRecord } from "../src/state/schema";

const FOLDER = "Inbox/messages";
const upd = (n: number, m: Record<string, unknown>, extra: Record<string, unknown> = {}): RelayItem => ({
  relay_id: n,
  update_id: 1000 + n,
  chat_id: "42",
  message_id: n,
  received_at: "x",
  status: "pending",
  update: { update_id: 1000 + n, message: { message_id: 500 + n, date: 1790000000 + n * 60, chat: { id: 42 }, ...m }, ...extra },
});
const edit = (n: number, msgId: number, text: string): RelayItem => ({ ...upd(n, {}), update: { update_id: 1000 + n, edited_message: { message_id: msgId, date: 1790000000, chat: { id: 42 }, text } } });

let fs: MemFs;
let queue: RelayItem[];
let acks: { id: number; status: string; error?: string }[];
let ackFails: boolean;
let calls: string[];
let records: WriteRecord[];
let attempts: Map<number, number>;
let idx: Map<string, string>;
let tokens: { bot: string | null; openai: string | null };
let netFail: { transcribe?: number; getFile?: boolean };

const bytes = (n: number) => new Uint8Array(n).fill(7).buffer;
const net: Net = async (url, req) => {
  calls.push(url.replace(/bot[^/]+/, "bot<t>"));
  const ok = (json: unknown, b = new ArrayBuffer(0)) => ({ status: 200, json, text: "", bytes: b });
  if (url.includes("/getFile")) return netFail.getFile ? { status: 400, json: { ok: false, description: "gone" }, text: "", bytes: new ArrayBuffer(0) } : ok({ ok: true, result: { file_path: url.includes("photo") ? "photos/f.jpg" : "voice/f.oga", file_size: 10 } });
  if (url.includes("/file/bot")) return ok({}, bytes(10));
  if (url.includes("audio/transcriptions")) return netFail.transcribe ? { status: netFail.transcribe, json: { error: { message: "no" } }, text: "", bytes: new ArrayBuffer(0) } : ok({ text: "book the car service and email Sam" });
  if (url.includes("chat/completions")) return ok({ choices: [{ message: { content: "A Spar receipt for R245.50." } }] });
  throw new Error(`unexpected ${url}`);
};

const cfg = (over: Partial<IngestCfg> = {}): IngestCfg => ({ folder: FOLDER, allowedChatId: "42", since: "", transcribe: true, transcribeModel: "gpt-4o-mini-transcribe", transcribeLanguage: "en", describePhotos: true, visionModel: "gpt-4o-mini", maxPerRun: 200, maxAttempts: 3, ...over });
const deps = (over: Partial<IngestCfg> = {}): IngestDeps => ({
  fs,
  relay: {
    pending: async (limit = 50) => queue.filter((q) => q.status === "pending").slice(0, limit),
    ack: async (id, status, error) => {
      acks.push({ id, status, error });
      if (ackFails) throw new Error("relay down");
      const it = queue.find((q) => q.relay_id === id);
      if (it) it.status = status;
    },
  },
  net,
  bot: () => tokens.bot,
  openai: () => tokens.openai,
  cfg: cfg(over),
  index: {
    path: (k) => idx.get(k),
    set: (k, p) => void idx.set(k, p),
    attempts: (id) => attempts.get(id) ?? 0,
    bump: (id) => (attempts.set(id, (attempts.get(id) ?? 0) + 1), attempts.get(id)!),
    clear: (id) => void attempts.delete(id),
  },
  now: () => new Date("2026-10-03T12:00:00Z"),
  uuid: () => `u${records.length + 1}`,
  record: (r) => records.push(r),
});
const notes = () => [...fs.files.keys()].filter((k) => k.startsWith(FOLDER + "/") && k.endsWith(".md") && !k.endsWith("README.md"));

beforeEach(() => {
  fs = new MemFs();
  queue = [];
  acks = [];
  ackFails = false;
  calls = [];
  records = [];
  attempts = new Map();
  idx = new Map();
  tokens = { bot: "123456:SECRETTOKEN", openai: "sk-test-abcdefghijklmnop" };
  netFail = {};
});

describe("fetchAndIngest", () => {
  it("saves a text message as a note, creates the README, then acknowledges on the relay", async () => {
    queue = [upd(1, { text: "remind me to email Sam on monday" })];
    const rep = await fetchAndIngest(deps());
    expect(rep.saved).toHaveLength(1);
    const [path] = notes();
    const text = await fs.read(path);
    expect(readFrontmatter(text)).toMatchObject({ type: "message", kind: "text", status: "new" });
    expect(messageBody(text)).toBe("remind me to email Sam on monday");
    expect(fs.files.has(`${FOLDER}/README.md`)).toBe(true);
    expect(acks).toEqual([{ id: 1, status: "done", error: undefined }]);
    expect(records.map((r) => r.op)).toEqual(["message-save"]);
  });
  it("downloads, saves and transcribes a voice note", async () => {
    queue = [upd(2, { voice: { file_id: "AgV", duration: 12, mime_type: "audio/ogg" } })];
    await fetchAndIngest(deps());
    const [path] = notes();
    const text = await fs.read(path);
    const fm = readFrontmatter(text);
    expect(fm).toMatchObject({ kind: "voice", attachment: "done", transcript: "done" });
    expect(blockText(text, "transcript")).toBe("**Transcript (0:12):**\n> book the car service and email Sam");
    const [att] = jsonList(fm.attachments);
    expect(att).toMatch(/^Inbox\/messages\/attachments\/.*\.oga$/);
    expect(fs.binaries.get(att)?.byteLength).toBe(10);
    expect(blockText(text, "attachment")).toMatch(/^!\[\[.*\.oga\]\]$/);
  });
  it("saves a photo with its caption and a description", async () => {
    queue = [upd(3, { caption: "receipt", photo: [{ file_id: "s", width: 10, height: 10 }, { file_id: "photo-L", width: 900, height: 700 }] })];
    await fetchAndIngest(deps());
    const text = await fs.read(notes()[0]);
    expect(readFrontmatter(text)).toMatchObject({ kind: "photo", attachment: "done", description: "done" });
    expect(messageBody(text)).toBe("**Caption:** receipt");
    expect(blockText(text, "description")).toContain("A Spar receipt");
    expect([...fs.binaries.keys()][0]).toMatch(/\.jpg$/);
  });
  it("never puts a token in a note, the write log or a relay ack", async () => {
    netFail.getFile = true;
    queue = [upd(4, { voice: { file_id: "x", duration: 1 } })];
    await fetchAndIngest(deps());
    const everything = JSON.stringify([...fs.files.values(), records, acks]);
    expect(everything).not.toContain("SECRETTOKEN");
    expect(everything).not.toContain("sk-test");
  });

  it("still saves the message when there is no bot token, and says what's missing", async () => {
    tokens.bot = null;
    queue = [upd(5, { voice: { file_id: "AgV", duration: 4 } })];
    const rep = await fetchAndIngest(deps());
    const text = await fs.read(notes()[0]);
    expect(readFrontmatter(text)).toMatchObject({ attachment: "pending", transcript: "pending" });
    expect(jsonList(readFrontmatter(text).file_ids)).toEqual(["AgV"]);
    expect(rep.problems.join(" ")).toMatch(/No Telegram bot token/);
    expect(acks[0].status).toBe("done"); // the message is safe in the vault, so the relay can let it go
    expect(fs.binaries.size).toBe(0);
  });
  it("retries later: with the token and key set, the audio and transcript are filled in", async () => {
    tokens = { bot: null, openai: null };
    queue = [upd(6, { voice: { file_id: "AgV", duration: 4 } })];
    await fetchAndIngest(deps());
    const still = await retryPending(deps());
    expect(still.fixed).toEqual([]);
    tokens = { bot: "123456:SECRETTOKEN", openai: "sk-test-abcdefghijklmnop" };
    const rep = await retryPending(deps());
    expect(rep.fixed).toHaveLength(1);
    const text = await fs.read(notes()[0]);
    expect(readFrontmatter(text)).toMatchObject({ attachment: "done", transcript: "done" });
    expect(readFrontmatter(text).file_ids).toBeUndefined();
    expect(blockText(text, "transcript")).toContain("book the car service");
    expect((await retryPending(deps())).fixed).toEqual([]); // nothing left to do
  });
  it("keeps the audio and records why when transcription fails, so it can be retried", async () => {
    netFail.transcribe = 401;
    queue = [upd(7, { voice: { file_id: "AgV", duration: 4 } })];
    const rep = await fetchAndIngest(deps());
    const text = await fs.read(notes()[0]);
    expect(readFrontmatter(text)).toMatchObject({ attachment: "done", transcript: "pending" });
    expect(blockText(text, "transcript")).toMatch(/Not transcribed yet: OpenAI rejected the API key/);
    expect(rep.problems.join(" ")).toMatch(/Transcription/);
    netFail.transcribe = undefined;
    expect((await retryPending(deps())).fixed).toHaveLength(1);
    expect(readFrontmatter(await fs.read(notes()[0])).transcript).toBe("done");
  });
  it("treats an audio file OpenAI can't read as a permanent failure, not something to retry forever", async () => {
    netFail.transcribe = 400;
    queue = [upd(8, { voice: { file_id: "AgV", duration: 4 } })];
    await fetchAndIngest(deps());
    expect(readFrontmatter(await fs.read(notes()[0])).transcript).toBe("failed");
  });
  it("skips transcription entirely when turned off", async () => {
    queue = [upd(9, { voice: { file_id: "AgV", duration: 4 } })];
    await fetchAndIngest(deps({ transcribe: false }));
    expect(calls.some((c) => c.includes("transcriptions"))).toBe(false);
    expect(readFrontmatter(await fs.read(notes()[0])).transcript).toBe("none");
  });

  it("is idempotent: if the ack was lost, the next fetch acks without saving a duplicate", async () => {
    queue = [upd(10, { text: "buy stamps" })];
    ackFails = true;
    const first = await fetchAndIngest(deps());
    expect(first.saved).toHaveLength(1);
    expect(first.problems.join(" ")).toMatch(/Couldn't acknowledge #10/);
    ackFails = false;
    const second = await fetchAndIngest(deps());
    expect(second.saved).toHaveLength(0);
    expect(second.skipped[0]).toMatch(/already saved/);
    expect(notes()).toHaveLength(1);
    expect(queue[0].status).toBe("done");
  });
  it("stops asking when nothing can be acknowledged, instead of looping", async () => {
    queue = [upd(11, { text: "a" }), upd(12, { text: "b" })];
    ackFails = true;
    let pendingCalls = 0;
    const d = deps();
    const orig = d.relay.pending;
    d.relay.pending = async (l) => (pendingCalls++, orig(l));
    await fetchAndIngest(d);
    expect(pendingCalls).toBe(1);
  });
  it("rejects messages from another chat and leaves them out of the vault", async () => {
    queue = [{ ...upd(13, { text: "hi" }), update: { update_id: 1, message: { message_id: 1, date: 1790000000, chat: { id: 999 }, text: "hi" } } }];
    const rep = await fetchAndIngest(deps());
    expect(notes()).toHaveLength(0);
    expect(rep.skipped[0]).toMatch(/isn't yours/);
    expect(acks[0]).toMatchObject({ status: "failed", error: "not from the allowed chat" });
  });
  it("acknowledges but doesn't import messages older than the import date", async () => {
    queue = [upd(14, { text: "old" })]; // 21 Sep 2026
    const rep = await fetchAndIngest(deps({ since: "2026-10-01" }));
    expect(notes()).toHaveLength(0);
    expect(rep.skipped[0]).toMatch(/older than 2026-10-01/);
    expect(acks[0].status).toBe("done");
  });
  it("acknowledges updates that aren't messages", async () => {
    queue = [{ ...upd(15, {}), update: { update_id: 1, my_chat_member: {} } }];
    await fetchAndIngest(deps());
    expect(acks[0].status).toBe("done");
    expect(notes()).toHaveLength(0);
  });
  it("records video without downloading it", async () => {
    queue = [upd(16, { video: { file_id: "vid", file_size: 5_000_000 }, caption: "look" })];
    await fetchAndIngest(deps());
    expect(calls.filter((c) => c.includes("getFile"))).toHaveLength(0);
    expect(blockText(await fs.read(notes()[0]), "attachment")).toMatch(/capture tool for video/);
  });
  it("gives up on a message that keeps failing, after the attempt limit, and says so on the relay", async () => {
    queue = [upd(17, { text: "x" })];
    const real = fs.create.bind(fs);
    fs.create = async (p: string, t: string) => {
      if (p.endsWith(".md") && !p.endsWith("README.md")) throw new Error("disk full");
      return real(p, t);
    };
    for (let i = 0; i < 3; i++) await fetchAndIngest(deps());
    expect(acks.at(-1)).toMatchObject({ id: 17, status: "failed", error: "disk full" });
    expect(queue[0].status).toBe("failed");
  });

  it("corrects an unhandled message in place when you edit it, but not one already handled", async () => {
    queue = [upd(18, { text: "email Sam on monday" })];
    await fetchAndIngest(deps());
    const path = notes()[0];
    queue.push(edit(19, 518, "email Sam on tuesday"));
    await fetchAndIngest(deps());
    expect(notes()).toHaveLength(1);
    expect(messageBody(await fs.read(path))).toBe("email Sam on tuesday");
    expect(readFrontmatter(await fs.read(path)).edited).toBe("true");

    await setMessageStatus(deps(), path, "actioned", { by: "brief", date: "2026-10-03", summary: "created a task" });
    queue.push(edit(20, 518, "email Sam on friday"));
    await fetchAndIngest(deps());
    expect(notes()).toHaveLength(2); // a new note, so the handled one keeps its history
    expect(messageBody(await fs.read(path))).toBe("email Sam on tuesday");
  });
});

describe("setMessageStatus", () => {
  it("moves a message along its lifecycle and logs it", async () => {
    queue = [upd(21, { text: "pay the water bill" })];
    await fetchAndIngest(deps());
    const path = notes()[0];
    await setMessageStatus(deps(), path, "acknowledged", { by: "you", date: "2026-10-03", summary: "" });
    expect(readFrontmatter(await fs.read(path)).status).toBe("acknowledged");
    expect(records.at(-1)).toMatchObject({ op: "message-status", source: "you" });
  });
  it("refuses to touch a note that isn't a message", async () => {
    fs.files.set("Notes/x.md", "---\ntype: concept\n---\nhi");
    await expect(setMessageStatus(deps(), "Notes/x.md", "ignored", { by: "you", date: "2026-10-03", summary: "" })).rejects.toThrow(/isn't a message/);
  });
});

import { shouldFetch } from "../src/messages/service-rules";
describe("polling rules", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("always fetches the first time", () => {
    expect(shouldFetch(undefined, now, 60_000)).toBe(true);
    expect(shouldFetch("garbage", now, 60_000)).toBe(true);
  });
  it("waits out the minimum gap, so alt-tabbing can't hammer the relay", () => {
    expect(shouldFetch(ago(10_000), now, 30_000)).toBe(false);
    expect(shouldFetch(ago(31_000), now, 30_000)).toBe(true);
  });
  it("uses the configured interval for the timer", () => {
    expect(shouldFetch(ago(4 * 60_000), now, 5 * 60_000)).toBe(false);
    expect(shouldFetch(ago(5 * 60_000), now, 5 * 60_000)).toBe(true);
  });
});
