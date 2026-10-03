import { describe, expect, it } from "vitest";
import { buildMultipart, transcribe, describeImage, uploadName, AiError, toBase64 } from "../src/messages/openai";
import { buildNote, noteBaseName, readFrontmatter, jsonList, messageBody, blockText, replaceBlock, setFields, markHandled, sastIso, noteTitle, NoteParts } from "../src/messages/note";
import { parseUpdate } from "../src/messages/telegram";
import type { Net } from "../src/messages/net";

const mk = (m: Record<string, unknown>) => parseUpdate({ relay_id: 7, update_id: 100, update: { update_id: 100, message: { message_id: 55, date: 1790000000, chat: { id: 1 }, ...m } } })!;
const res = (status: number, json: unknown = {}) => ({ status, json, text: "", bytes: new ArrayBuffer(0) });
const parts = (over: Partial<NoteParts> = {}): NoteParts => ({ attachments: [], attachmentStatus: "none", transcriptStatus: "none", descriptionStatus: "none", fileIds: [], ...over });

describe("multipart and OpenAI", () => {
  it("builds a well-formed multipart body with raw audio bytes intact", () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 7]).buffer;
    const { body, contentType } = buildMultipart({ model: "m" }, { field: "file", name: 'a"b.ogg', mime: "audio/ogg", bytes }, "BOUND");
    const s = new TextDecoder("latin1").decode(body);
    expect(contentType).toBe("multipart/form-data; boundary=BOUND");
    expect(s).toContain('name="model"\r\n\r\nm\r\n');
    expect(s).toContain('filename="a_b.ogg"');
    expect(s).toContain("Content-Type: audio/ogg\r\n\r\n");
    expect(s.endsWith("\r\n--BOUND--\r\n")).toBe(true);
    const raw = new Uint8Array(body);
    const at = s.indexOf("\r\n\r\n", s.indexOf('name="file"')) + 4;
    expect([...raw.slice(at, at + 5)]).toEqual([0, 255, 13, 10, 7]);
  });
  it("renames .oga to .ogg for the upload", () => {
    expect(uploadName("voice.oga")).toBe("voice.ogg");
    expect(uploadName("a.mp3")).toBe("a.mp3");
  });
  it("transcribes and sends the key, model and language", async () => {
    let seen: { url: string; auth?: string; type?: string; body: string } = { url: "", body: "" };
    const net: Net = async (url, req) => {
      seen = { url, auth: req.headers?.Authorization, type: req.contentType, body: new TextDecoder("latin1").decode(req.body as ArrayBuffer) };
      return res(200, { text: "  email Sam on monday  " });
    };
    const t = await transcribe(net, "sk-test", { model: "gpt-4o-mini-transcribe", language: "en" }, { name: "v.oga", mime: "audio/ogg", bytes: new ArrayBuffer(4) });
    expect(t).toBe("email Sam on monday");
    expect(seen.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen.auth).toBe("Bearer sk-test");
    expect(seen.body).toContain("gpt-4o-mini-transcribe");
    expect(seen.body).toContain('name="language"\r\n\r\nen');
    expect(seen.body).toContain('filename="v.ogg"');
  });
  it("classifies OpenAI failures", async () => {
    const kind = (status: number, body: unknown = {}) => transcribe(async () => res(status, body), "k", { model: "m" }, { name: "a.ogg", mime: "audio/ogg", bytes: new ArrayBuffer(1) }).catch((e: AiError) => e.kind);
    expect(await kind(401)).toBe("auth");
    expect(await kind(429, { error: { code: "insufficient_quota" } })).toBe("quota");
    expect(await kind(429)).toBe("rate");
    expect(await kind(400, { error: { message: "bad format" } })).toBe("bad-input");
    expect(await kind(503)).toBe("server");
  });
  it("describes an image with a data URL", async () => {
    let body: any;
    const d = await describeImage(async (_u, req) => ((body = JSON.parse(String(req.body))), res(200, { choices: [{ message: { content: "A receipt from Spar, R245.50." } }] })), "k", "gpt-4o-mini", { mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]).buffer });
    expect(d).toBe("A receipt from Spar, R245.50.");
    expect(body.messages[0].content[1].image_url.url).toBe(`data:image/jpeg;base64,${toBase64(new Uint8Array([1, 2, 3]).buffer)}`);
  });
});

describe("message notes", () => {
  it("names notes by time, update id and a readable slug", () => {
    expect(noteBaseName(mk({ text: "Remind me to email Sam about the invoice on Monday please" }))).toBe("20260921-1613-100-remind-me-to-email-sam-about");
    expect(noteBaseName(mk({ voice: { file_id: "v" } }), "")).toBe("20260921-1613-100-voice");
    expect(noteBaseName(mk({ text: "https://example.com/x" }))).toBe("20260921-1613-100-link");
    expect(sastIso("2026-10-03T16:42:11.000Z")).toBe("2026-10-03T18:42:11+02:00");
  });
  it("writes a text message the agent can grep: type, status, and the words", () => {
    const n = buildNote(mk({ text: "remind me to email Sam on monday" }), parts());
    const fm = readFrontmatter(n);
    expect(fm).toMatchObject({ type: "message", source: "telegram", kind: "text", status: "new", update_id: "100", relay_id: "7", chat_message_id: "55" });
    expect(fm.received).toMatch(/^2026-09-21T16:13:20\+02:00$/);
    expect(messageBody(n)).toBe("remind me to email Sam on monday");
    expect(n).toContain(`# ${noteTitle(mk({ text: "x" }))}`);
  });
  it("writes a transcribed voice note with the audio embedded", () => {
    const m = mk({ voice: { file_id: "v1", duration: 83 } });
    const n = buildNote(m, parts({ attachments: [{ path: "Inbox/messages/attachments/a.ogg", embed: "a.ogg" }], attachmentStatus: "done", transcript: "book the car service\nand email Sam", transcriptStatus: "done", model: "gpt-4o-mini-transcribe" }));
    expect(blockText(n, "attachment")).toBe("![[a.ogg]]");
    expect(blockText(n, "transcript")).toBe("**Transcript (1:23):**\n> book the car service\n> and email Sam");
    const fm = readFrontmatter(n);
    expect(jsonList(fm.attachments)).toEqual(["Inbox/messages/attachments/a.ogg"]);
    expect(fm.transcript).toBe("done");
  });
  it("keeps what's needed to retry when the download or transcript failed", () => {
    const m = mk({ voice: { file_id: "AgAD-1", duration: 5 } });
    const n = buildNote(m, parts({ attachmentStatus: "pending", transcriptStatus: "pending", fileIds: ["AgAD-1"] }));
    expect(jsonList(readFrontmatter(n).file_ids)).toEqual(["AgAD-1"]);
    expect(blockText(n, "transcript")).toBe("*Not transcribed yet.*");
    expect(blockText(buildNote(m, parts({ transcriptStatus: "pending", transcriptError: "no OpenAI key is set" })), "transcript")).toBe("*Not transcribed yet: no OpenAI key is set.*");
    expect(blockText(n, "attachment")).toBe("*Attachment not downloaded yet.*");
  });
  it("describes photos and notes unsupported video", () => {
    const n = buildNote(mk({ caption: "receipt", photo: [{ file_id: "p" }] }), parts({ attachments: [{ path: "p.jpg", embed: "p.jpg" }], attachmentStatus: "done", description: "A Spar receipt", descriptionStatus: "done" }));
    expect(messageBody(n)).toBe("**Caption:** receipt");
    expect(blockText(n, "description")).toBe("**What it shows:**\n> A Spar receipt");
    expect(blockText(buildNote(mk({ video: { file_id: "x" } }), parts()), "attachment")).toMatch(/capture tool for video/);
  });
  it("round-trips forwarded, edited and url fields safely", () => {
    const n = buildNote(mk({ text: 'see https://a.com "quoted"', forward_from: { first_name: 'Sam "S" O' } }), parts());
    const fm = readFrontmatter(n);
    expect(JSON.parse(fm.forwarded_from)).toBe('Sam "S" O');
    expect(jsonList(fm.urls)).toEqual(["https://a.com"]);
  });
  it("replaces a block and sets fields without touching the rest", () => {
    let n = buildNote(mk({ voice: { file_id: "v", duration: 3 } }), parts({ transcriptStatus: "pending" }));
    n = replaceBlock(n, "transcript", "**Transcript:**\n> done");
    n = setFields(n, { transcript: "done", transcript_model: "m" });
    expect(readFrontmatter(n)).toMatchObject({ transcript: "done", transcript_model: "m", status: "new" });
    expect(blockText(n, "transcript")).toContain("> done");
    expect(replaceBlock("no blocks", "transcript", "x")).toBe("no blocks");
  });
  it("records handling as a status change plus a visible trail, and appends on repeat", () => {
    const n0 = buildNote(mk({ text: "email Sam" }), parts());
    const n1 = markHandled(n0, "actioned", { by: "brief", date: "2026-10-03", summary: "created task “Email Sam” 📅 2026-10-05" });
    expect(readFrontmatter(n1)).toMatchObject({ status: "actioned", handled: "2026-10-03" });
    expect(n1).toMatch(/## Handled\n- 2026-10-03 · actioned · brief — created task/);
    const n2 = markHandled(n1, "acknowledged", { by: "you", date: "2026-10-04", summary: "" });
    expect(n2.match(/^- 2026/gm)).toHaveLength(2);
    expect(readFrontmatter(n2).status).toBe("acknowledged");
    expect(messageBody(n2)).toBe("email Sam"); // the words are never altered
  });
});
