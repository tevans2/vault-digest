import { describe, expect, it } from "vitest";
import { RelayClient, RelayError, normaliseBase } from "../src/messages/relay";
import { parseUpdate, findUrls, downloadFile, extensionFor, TelegramError } from "../src/messages/telegram";
import { redact, Net } from "../src/messages/net";

const res = (status: number, json: unknown = {}, bytes = new ArrayBuffer(0)) => ({ status, json, text: JSON.stringify(json), bytes });
const base = { relay_id: 7, update_id: 100 };
const msg = (m: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...base, update: { update_id: 100, message: { message_id: 55, date: 1790000000, chat: { id: 4242 }, ...m }, ...extra } });

describe("parseUpdate", () => {
  it("reads plain text", () => {
    const p = parseUpdate(msg({ text: "remind me to email Sam on monday" }))!;
    expect(p).toMatchObject({ relayId: 7, updateId: 100, chatId: "4242", messageId: 55, kind: "text", text: "remind me to email Sam on monday", files: [], edited: false });
    expect(p.receivedAt).toBe(new Date(1790000000 * 1000).toISOString());
  });
  it("treats a bare URL as a link, and prose with a URL as text", () => {
    expect(parseUpdate(msg({ text: "https://example.com/a?b=1" }))!.kind).toBe("link");
    expect(parseUpdate(msg({ text: "check this https://example.com/a, thanks" }))!.kind).toBe("text");
    expect(parseUpdate(msg({ text: "check this https://example.com/a, thanks" }))!.urls).toEqual(["https://example.com/a"]);
  });
  it("picks the largest photo and keeps the caption", () => {
    const p = parseUpdate(msg({ caption: "receipt", photo: [{ file_id: "s", width: 90, height: 90 }, { file_id: "L", file_unique_id: "u", width: 1280, height: 960, file_size: 99000 }] }))!;
    expect(p.kind).toBe("photo");
    expect(p.text).toBe("receipt");
    expect(p.files).toEqual([{ role: "photo", fileId: "L", uniqueId: "u", mime: "image/jpeg", size: 99000, width: 1280, height: 960 }]);
  });
  it("reads a voice note", () => {
    const p = parseUpdate(msg({ voice: { file_id: "v1", duration: 23, mime_type: "audio/ogg", file_size: 41000 } }))!;
    expect(p.kind).toBe("voice");
    expect(p.files[0]).toMatchObject({ role: "voice", fileId: "v1", duration: 23, mime: "audio/ogg" });
  });
  it("treats an image sent as a file as a photo, and other files as documents", () => {
    expect(parseUpdate(msg({ document: { file_id: "d", mime_type: "image/png", file_name: "a.png" } }))!.kind).toBe("photo");
    expect(parseUpdate(msg({ document: { file_id: "d", mime_type: "application/pdf", file_name: "a.pdf" } }))!.kind).toBe("document");
  });
  it("flags video, location and contact without downloading anything for them", () => {
    expect(parseUpdate(msg({ video: { file_id: "x" } }))!.kind).toBe("video");
    expect(parseUpdate(msg({ location: { latitude: -33.9, longitude: 18.4 } }))).toMatchObject({ kind: "location", detail: "-33.9, 18.4" });
    expect(parseUpdate(msg({ contact: { first_name: "Sam", phone_number: "+27 82 000 0000" } }))).toMatchObject({ kind: "contact", detail: "Sam +27 82 000 0000" });
  });
  it("marks edits, forwards and albums", () => {
    const e = parseUpdate({ ...base, update: { update_id: 1, edited_message: { message_id: 9, date: 1, chat: { id: 1 }, text: "fixed" } } })!;
    expect(e.edited).toBe(true);
    expect(parseUpdate(msg({ text: "x", forward_origin: { type: "user", sender_user: { first_name: "Sam" } }, media_group_id: "g1" }))).toMatchObject({ forwardedFrom: "Sam", mediaGroupId: "g1" });
  });
  it("ignores updates that aren't messages", () => {
    expect(parseUpdate({ ...base, update: { update_id: 1, my_chat_member: {} } })).toBeNull();
    expect(parseUpdate({ ...base, update: { update_id: 1, message: { text: "no chat" } } })).toBeNull();
  });
  it("finds URLs without trailing punctuation", () => {
    expect(findUrls("see (https://a.com/x). and https://b.org/y!")).toEqual(["https://a.com/x", "https://b.org/y"]);
  });
});

describe("RelayClient", () => {
  const client = (net: Net, token: string | null = "tok") => new RelayClient(net, "https://relay.example.fly.dev/", () => token);
  it("lists pending items oldest-first with the bearer token", async () => {
    let seen: { url: string; auth?: string } = { url: "" };
    const c = client(async (url, req) => {
      seen = { url, auth: req.headers?.Authorization };
      return res(200, { ok: true, captures: [{ relay_id: 1, update_id: 10, update: {} }, { junk: true }] });
    });
    expect(await c.pending(500)).toHaveLength(1);
    expect(seen.url).toBe("https://relay.example.fly.dev/api/captures?status=pending&limit=100");
    expect(seen.auth).toBe("Bearer tok");
  });
  it("acks with status and a redacted error", async () => {
    let body = "";
    const c = client(async (_u, req) => ((body = String(req.body)), res(200, { ok: true })));
    await c.ack(5, "failed", "boom bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked");
    expect(JSON.parse(body).status).toBe("failed");
    expect(body).not.toContain("AAAAAAAA");
  });
  it("reads stats", async () => {
    expect(await client(async () => res(200, { ok: true, counts: { pending: 3, done: 9 } })).stats()).toEqual({ pending: 3, done: 9, failed: 0 });
  });
  it("explains each failure", async () => {
    const kind = async (net: Net, tok: string | null = "t") => client(net, tok).pending().catch((e: RelayError) => e.kind);
    expect(await kind(async () => res(401))).toBe("auth");
    expect(await kind(async () => res(502))).toBe("server");
    expect(await kind(async () => { throw new Error("socket hang up"); })).toBe("network");
    expect(await kind(async () => res(200), null)).toBe("config");
  });
  it("only allows https (or localhost)", () => {
    expect(() => normaliseBase("http://relay.example.com")).toThrow(/https/);
    expect(normaliseBase("http://localhost:8000/")).toBe("http://localhost:8000");
    expect(() => normaliseBase("")).toThrow(/No relay URL/);
  });
});

describe("Telegram files", () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  it("resolves the file path then downloads it", async () => {
    const urls: string[] = [];
    const net: Net = async (url) => {
      urls.push(url);
      return url.includes("/getFile") ? res(200, { ok: true, result: { file_path: "voice/file_1.oga", file_size: 3 } }) : res(200, {}, bytes);
    };
    const r = await downloadFile(net, "123456:SECRET", { fileId: "v1" });
    expect(r.path).toBe("voice/file_1.oga");
    expect(r.bytes.byteLength).toBe(3);
    expect(urls[0]).toBe("https://api.telegram.org/bot123456:SECRET/getFile?file_id=v1");
    expect(urls[1]).toBe("https://api.telegram.org/file/bot123456:SECRET/voice/file_1.oga");
  });
  it("refuses oversize files up front, and never puts the token in an error", async () => {
    await expect(downloadFile(async () => res(200), "t", { fileId: "x", size: 30 * 1024 * 1024 })).rejects.toThrow(TelegramError);
    const err = await downloadFile(async () => { throw new Error("failed https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/getFile"); }, "x", { fileId: "x" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("AAAAAAAA");
  });
  it("maps a bad token and a vanished file", async () => {
    expect(await downloadFile(async () => res(401), "t", { fileId: "x" }).catch((e: TelegramError) => e.kind)).toBe("auth");
    expect(await downloadFile(async () => res(400, { ok: false, description: "file is too old" }), "t", { fileId: "x" }).catch((e: TelegramError) => e.kind)).toBe("gone");
  });
  it("picks a sensible extension", () => {
    expect(extensionFor({ mime: "audio/ogg" })).toBe("ogg");
    expect(extensionFor({ name: "Scan.PDF" })).toBe("pdf");
    expect(extensionFor({ mime: "image/jpeg" }, "photos/file_3.jpg")).toBe("jpg");
    expect(extensionFor({})).toBe("bin");
  });
  it("redacts secrets", () => {
    expect(redact("Bearer abc.def-123 and sk-abcdefghijklmnopqrstuv")).toBe("Bearer <token> and sk-<key>");
  });
});
