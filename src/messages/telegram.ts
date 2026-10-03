import type { Net } from "./net";
import { redact } from "./net";

/** Parse a stored Telegram update into the one thing the plugin cares about: a message from you. */

export type MessageKind = "text" | "link" | "photo" | "voice" | "audio" | "document" | "video" | "location" | "contact" | "other";

export interface MessageFile {
  /** The role in the message, which decides how it's handled. */
  role: "photo" | "voice" | "audio" | "document" | "video";
  fileId: string;
  uniqueId?: string;
  mime?: string;
  name?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
}

export interface IncomingMessage {
  relayId: number;
  updateId: number;
  chatId: string;
  messageId: number;
  edited: boolean;
  /** ISO 8601, UTC. */
  receivedAt: string;
  kind: MessageKind;
  /** The text, or the caption of a photo/voice message. */
  text: string;
  urls: string[];
  files: MessageFile[];
  forwardedFrom?: string;
  mediaGroupId?: string;
  /** A short description for kinds with no text (a location, a contact). */
  detail?: string;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Telegram's bot API limit for getFile

export function findUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

const forwardOrigin = (m: Raw): string | undefined => {
  const o = m.forward_origin;
  if (o) return o.sender_user?.first_name ?? o.sender_user_name ?? o.chat?.title ?? o.sender_chat?.title ?? "someone";
  return m.forward_from?.first_name ?? m.forward_sender_name ?? m.forward_from_chat?.title;
};

/** Returns null for updates that aren't a message (and for ones we can't make sense of). */
export function parseUpdate(item: { relay_id: number; update_id: number; update: Raw }): IncomingMessage | null {
  const u = item.update;
  const m: Raw | undefined = u.message ?? u.edited_message;
  if (!m || typeof m !== "object") return null;
  const chatId = m.chat?.id;
  if (chatId === undefined || chatId === null || typeof m.message_id !== "number") return null;

  const files: MessageFile[] = [];
  if (Array.isArray(m.photo) && m.photo.length) {
    // Telegram sends several sizes; the last is the largest.
    const p = m.photo[m.photo.length - 1];
    files.push({ role: "photo", fileId: p.file_id, uniqueId: p.file_unique_id, mime: "image/jpeg", size: p.file_size, width: p.width, height: p.height });
  }
  const add = (role: MessageFile["role"], f: Raw | undefined, defaultMime?: string) => {
    if (f?.file_id) files.push({ role, fileId: f.file_id, uniqueId: f.file_unique_id, mime: f.mime_type ?? defaultMime, name: f.file_name, size: f.file_size, duration: f.duration });
  };
  add("voice", m.voice, "audio/ogg");
  add("audio", m.audio);
  add("video", m.video, "video/mp4");
  add("video", m.video_note, "video/mp4");
  add("video", m.animation, "video/mp4");
  add("document", m.document);

  const text: string = String(m.text ?? m.caption ?? "").trim();
  const urls = findUrls(text);

  let kind: MessageKind = "text";
  let detail: string | undefined;
  const doc = files.find((f) => f.role === "document");
  if (files.some((f) => f.role === "photo") || (doc && doc.mime?.startsWith("image/"))) kind = "photo";
  else if (files.some((f) => f.role === "voice")) kind = "voice";
  else if (files.some((f) => f.role === "audio")) kind = "audio";
  else if (files.some((f) => f.role === "video")) kind = "video";
  else if (doc) kind = "document";
  else if (m.location) {
    kind = "location";
    detail = `${m.location.latitude}, ${m.location.longitude}`;
  } else if (m.venue) {
    kind = "location";
    detail = [m.venue.title, m.venue.address].filter(Boolean).join(", ");
  } else if (m.contact) {
    kind = "contact";
    detail = [m.contact.first_name, m.contact.last_name, m.contact.phone_number].filter(Boolean).join(" ");
  } else if (text) {
    const rest = text.replace(URL_RE, "").replace(/[\s\-–—:,.]+/g, "");
    kind = urls.length && rest.length === 0 ? "link" : "text";
  } else kind = "other";

  return {
    relayId: item.relay_id,
    updateId: item.update_id,
    chatId: String(chatId),
    messageId: m.message_id,
    edited: !!u.edited_message && !u.message,
    receivedAt: typeof m.date === "number" ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
    kind,
    text,
    urls,
    files,
    forwardedFrom: forwardOrigin(m),
    mediaGroupId: m.media_group_id ? String(m.media_group_id) : undefined,
    detail,
  };
}

// ── Files ───────────────────────────────────────────────────────────────────

export class TelegramError extends Error {
  constructor(message: string, public kind: "auth" | "gone" | "too-large" | "network" | "other") {
    super(redact(message));
  }
}

const API = "https://api.telegram.org";

/** Resolve a file id to bytes. The token only ever appears in the URL we call, never in errors. */
export async function downloadFile(net: Net, token: string, file: { fileId: string; size?: number }): Promise<{ bytes: ArrayBuffer; path: string }> {
  if (file.size && file.size > MAX_DOWNLOAD_BYTES) throw new TelegramError("The file is over Telegram's 20 MB bot limit.", "too-large");
  let meta;
  try {
    meta = await net(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(file.fileId)}`, { method: "GET" });
  } catch (e) {
    throw new TelegramError(`Couldn't reach Telegram: ${(e as Error).message}`, "network");
  }
  if (meta.status === 401 || meta.status === 404) throw new TelegramError("Telegram rejected the bot token.", "auth");
  const j = meta.json as { ok?: boolean; result?: { file_path?: string; file_size?: number }; description?: string } | undefined;
  if (meta.status === 400 || !j?.ok || !j.result?.file_path) {
    throw new TelegramError(`Telegram has no file for that message${j?.description ? ` (${j.description})` : ""}.`, "gone");
  }
  if (j.result.file_size && j.result.file_size > MAX_DOWNLOAD_BYTES) throw new TelegramError("The file is over Telegram's 20 MB bot limit.", "too-large");
  let data;
  try {
    data = await net(`${API}/file/bot${token}/${j.result.file_path}`, { method: "GET" });
  } catch (e) {
    throw new TelegramError(`Couldn't download the file: ${(e as Error).message}`, "network");
  }
  if (data.status !== 200) throw new TelegramError(`Telegram returned HTTP ${data.status} for the file.`, "other");
  return { bytes: data.bytes, path: j.result.file_path };
}

export function extensionFor(file: { mime?: string; name?: string }, tgPath?: string): string {
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(file.name ?? "")?.[1] ?? /\.([A-Za-z0-9]{1,5})$/.exec(tgPath ?? "")?.[1];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf", "video/mp4": "mp4" };
  return map[file.mime ?? ""] ?? "bin";
}
