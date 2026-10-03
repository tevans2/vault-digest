import type { VaultFs } from "../writers/fs";
import { hash } from "../writers/hash";
import type { WriteOp, WriteRecord } from "../state/schema";
import type { RelayClient } from "./relay";
import { RelayError } from "./relay";
import type { Net } from "./net";
import { redact } from "./net";
import { IncomingMessage, MessageFile, TelegramError, downloadFile, extensionFor, parseUpdate } from "./telegram";
import { AiError, describeImage, transcribe } from "./openai";
import { Handling, MessageStatus, NoteParts, PartStatus, README_TEXT, blockText, bodyTextFor, buildNote, jsonList, markHandled, noteBaseName, readFrontmatter, replaceBlock, setBodyText, setFields } from "./note";

export interface IngestCfg {
  /** e.g. "Inbox/messages" */
  folder: string;
  /** Only accept messages from this chat. Empty = trust whatever the relay forwarded. */
  allowedChatId: string;
  /** YYYY-MM-DD: older messages are acknowledged on the relay but not imported. Empty = import all. */
  since: string;
  transcribe: boolean;
  transcribeModel: string;
  transcribeLanguage: string;
  describePhotos: boolean;
  visionModel: string;
  maxPerRun: number;
  maxAttempts: number;
}

/** Small persisted lookups kept in plugin state. */
export interface MsgIndex {
  path(key: string): string | undefined;
  set(key: string, path: string): void;
  attempts(relayId: number): number;
  bump(relayId: number): number;
  clear(relayId: number): void;
}

export interface IngestDeps {
  fs: VaultFs;
  relay: Pick<RelayClient, "pending" | "ack">;
  net: Net;
  bot: () => string | null;
  openai: () => string | null;
  cfg: IngestCfg;
  index: MsgIndex;
  now: () => Date;
  uuid: () => string;
  record: (rec: WriteRecord) => void;
}

export interface IngestReport {
  saved: { path: string; kind: string }[];
  skipped: string[];
  failed: string[];
  /** Things that didn't stop a message being saved but need attention (missing key, ack failed…). */
  problems: string[];
}

const base = (p: string) => p.split("/").pop() ?? p;
const sastDate = (iso: string) => new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().slice(0, 10);

function log(d: IngestDeps, op: WriteOp, path: string, summary: string, source = "relay") {
  d.record({ id: d.uuid(), at: d.now().toISOString(), source, op, path, summary });
}

async function ensureHome(d: IngestDeps) {
  await d.fs.mkdirp(`${d.cfg.folder}/attachments`);
  const readme = `${d.cfg.folder}/README.md`;
  if (!(await d.fs.exists(readme))) await d.fs.create(readme, README_TEXT);
}

async function existingFor(d: IngestDeps, updateId: number): Promise<string | undefined> {
  const names = await d.fs.list(d.cfg.folder);
  return names.find((p) => base(p).includes(`-${updateId}-`) && p.endsWith(".md"));
}

async function uniquePath(d: IngestDeps, dir: string, name: string, ext: string): Promise<string> {
  let p = `${dir}/${name}.${ext}`;
  for (let i = 2; await d.fs.exists(p); i++) p = `${dir}/${name}-${i}.${ext}`;
  return p;
}

const isAudio = (f: MessageFile) => f.role === "voice" || f.role === "audio";

/** Download what we can, then transcribe or describe it. Anything that fails is recorded for a later retry, never dropped. */
async function buildParts(d: IngestDeps, msg: IncomingMessage, name: string): Promise<{ parts: NoteParts; problems: string[] }> {
  const problems: string[] = [];
  const wanted = msg.files.filter((f) => f.role !== "video");
  const attachments: NoteParts["attachments"] = [];
  const fileIds: string[] = [];
  const bytes = new Map<number, { buf: ArrayBuffer; file: MessageFile }>();
  let attachmentStatus: PartStatus = wanted.length ? "done" : "none";

  for (const [i, file] of wanted.entries()) {
    const token = d.bot();
    if (!token) {
      attachmentStatus = "pending";
      fileIds.push(file.fileId);
      if (!problems.includes("No Telegram bot token is set, so attachments weren't downloaded.")) problems.push("No Telegram bot token is set, so attachments weren't downloaded.");
      continue;
    }
    try {
      const got = await downloadFile(d.net, token, file);
      const path = await uniquePath(d, `${d.cfg.folder}/attachments`, wanted.length > 1 ? `${name}-${i + 1}` : name, extensionFor(file, got.path));
      await d.fs.writeBinary(path, got.bytes);
      attachments.push({ path, embed: base(path) });
      bytes.set(i, { buf: got.bytes, file });
      log(d, "message-save", path, `Saved ${file.role} from Telegram`);
    } catch (e) {
      const kind = e instanceof TelegramError ? e.kind : "other";
      // Network and token problems are worth retrying; a vanished or oversize file is not.
      if (kind === "gone" || kind === "too-large") attachmentStatus = attachmentStatus === "pending" ? "pending" : "failed";
      else {
        attachmentStatus = "pending";
        fileIds.push(file.fileId);
      }
      problems.push(`Couldn't download a ${file.role}: ${redact((e as Error).message)}`);
    }
  }

  let transcript: string | undefined;
  let transcriptStatus: PartStatus = "none";
  let transcriptError: string | undefined;
  const audio = [...bytes.values()].find((b) => isAudio(b.file));
  if ((msg.kind === "voice" || msg.kind === "audio") && d.cfg.transcribe) {
    const key = d.openai();
    if (!key) {
      transcriptStatus = "pending";
      transcriptError = "no OpenAI key is set";
      problems.push("No OpenAI key is set, so voice notes weren't transcribed.");
    } else if (!audio) {
      transcriptStatus = "pending";
    } else {
      try {
        transcript = await transcribe(d.net, key, { model: d.cfg.transcribeModel, language: d.cfg.transcribeLanguage }, { name: base(attachments[0]?.path ?? "voice.ogg"), mime: audio.file.mime ?? "audio/ogg", bytes: audio.buf });
        transcriptStatus = "done";
      } catch (e) {
        transcriptError = redact((e as Error).message);
        transcriptStatus = e instanceof AiError && e.kind === "bad-input" ? "failed" : "pending";
        problems.push(`Transcription: ${transcriptError}`);
      }
    }
  }

  let description: string | undefined;
  let descriptionStatus: PartStatus = "none";
  const photo = [...bytes.values()].find((b) => b.file.role === "photo" || b.file.mime?.startsWith("image/"));
  if (msg.kind === "photo" && d.cfg.describePhotos) {
    const key = d.openai();
    if (!key) descriptionStatus = "pending";
    else if (!photo) descriptionStatus = "pending";
    else {
      try {
        description = await describeImage(d.net, key, d.cfg.visionModel, { mime: photo.file.mime ?? "image/jpeg", bytes: photo.buf });
        descriptionStatus = "done";
      } catch (e) {
        descriptionStatus = "pending";
        problems.push(`Photo description: ${redact((e as Error).message)}`);
      }
    }
  }

  return {
    parts: { attachments, attachmentStatus, transcript, transcriptStatus, transcriptError, description, descriptionStatus, fileIds, model: transcriptStatus === "done" ? d.cfg.transcribeModel : undefined },
    problems,
  };
}

async function ack(d: IngestDeps, id: number, status: "done" | "failed", rep: IngestReport, error?: string): Promise<boolean> {
  try {
    await d.relay.ack(id, status, error);
    return true;
  } catch (e) {
    // The note is already safe. The relay will offer this update again, and we'll just ack it then.
    rep.problems.push(`Couldn't acknowledge #${id} on the relay: ${redact((e as Error).message)}`);
    return false;
  }
}

async function handleItem(d: IngestDeps, item: Awaited<ReturnType<RelayClient["pending"]>>[number], rep: IngestReport): Promise<boolean> {
  const msg = parseUpdate(item as never);
  if (!msg) {
    rep.skipped.push(`#${item.relay_id}: not a message`);
    return ack(d, item.relay_id, "done", rep);
  }
  if (d.cfg.allowedChatId && msg.chatId !== d.cfg.allowedChatId) {
    rep.skipped.push(`#${item.relay_id}: from a chat that isn't yours`);
    return ack(d, item.relay_id, "failed", rep, "not from the allowed chat");
  }
  if (d.cfg.since && sastDate(msg.receivedAt) < d.cfg.since) {
    rep.skipped.push(`#${item.relay_id}: older than ${d.cfg.since}`);
    return ack(d, item.relay_id, "done", rep);
  }
  const have = await existingFor(d, msg.updateId);
  if (have) {
    d.index.set(`${msg.chatId}:${msg.messageId}`, have);
    d.index.clear(item.relay_id);
    rep.skipped.push(`#${item.relay_id}: already saved`);
    return ack(d, item.relay_id, "done", rep);
  }

  try {
    // An edit of a message nobody has acted on yet just corrects the words in place.
    const key = `${msg.chatId}:${msg.messageId}`;
    const prev = d.index.path(key);
    if (msg.edited && prev && (await d.fs.exists(prev))) {
      const cur = await d.fs.read(prev);
      if (readFrontmatter(cur).status === "new") {
        const { before, after } = await d.fs.modify(prev, (t) => setBodyText(setFields(t, { edited: "true" }), bodyTextFor(msg)));
        d.record({ id: d.uuid(), at: d.now().toISOString(), source: "relay", op: "message-update", path: prev, summary: "Updated the text after you edited the message", before: hash(before), after: hash(after) });
        rep.saved.push({ path: prev, kind: msg.kind });
        d.index.clear(item.relay_id);
        return ack(d, item.relay_id, "done", rep);
      }
    }

    await ensureHome(d);
    const name = noteBaseName(msg, msg.detail ?? "");
    const { parts, problems } = await buildParts(d, msg, name);
    rep.problems.push(...problems);
    const path = await uniquePath(d, d.cfg.folder, name, "md");
    await d.fs.create(path, buildNote(msg, parts));
    log(d, "message-save", path, `Saved ${msg.kind} message from ${new Date(msg.receivedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    d.index.set(key, path);
    d.index.clear(item.relay_id);
    rep.saved.push({ path, kind: msg.kind });
    return ack(d, item.relay_id, "done", rep);
  } catch (e) {
    const n = d.index.bump(item.relay_id);
    const why = redact((e as Error).message);
    rep.failed.push(`#${item.relay_id}: ${why}`);
    // Give up loudly after a few tries rather than retrying a poison message forever.
    if (n >= d.cfg.maxAttempts) return ack(d, item.relay_id, "failed", rep, why);
    return false;
  }
}

/** Pull new messages from the relay into the vault. Throws RelayError if the relay itself can't be used. */
export async function fetchAndIngest(d: IngestDeps): Promise<IngestReport> {
  const rep: IngestReport = { saved: [], skipped: [], failed: [], problems: [] };
  let handled = 0;
  while (handled < d.cfg.maxPerRun) {
    const items = await d.relay.pending(50);
    if (!items.length) break;
    let progressed = false;
    for (const item of items) {
      if (await handleItem(d, item, rep)) progressed = true;
      handled++;
    }
    // If nothing could be acknowledged, asking again would return the same items: stop.
    if (!progressed || items.length < 50) break;
  }
  return rep;
}

// ── Retry what was left pending ─────────────────────────────────────────────

export interface RetryReport {
  fixed: string[];
  stillPending: string[];
}

/** Fill in downloads, transcripts and descriptions that failed earlier (missing key, offline, bad token). */
export async function retryPending(d: IngestDeps): Promise<RetryReport> {
  const rep: RetryReport = { fixed: [], stillPending: [] };
  const notes = (await d.fs.list(d.cfg.folder)).filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"));
  for (const path of notes) {
    const text = await d.fs.read(path);
    const fm = readFrontmatter(text);
    if (fm.type !== "message") continue;
    const needsFile = fm.attachment === "pending";
    const needsTranscript = fm.transcript === "pending" || fm.transcript === "failed";
    const needsDescription = fm.description === "pending";
    if (!needsFile && !needsTranscript && !needsDescription) continue;

    let attachments = jsonList(fm.attachments);
    const edits: { block?: [string, string]; fields: Record<string, string | null> }[] = [];
    try {
      const fileIds = jsonList(fm.file_ids);
      const token = d.bot();
      if (needsFile && token && fileIds.length) {
        const name = base(path).replace(/\.md$/, "");
        for (const [i, id] of fileIds.entries()) {
          const got = await downloadFile(d.net, token, { fileId: id });
          const p = await uniquePath(d, `${d.cfg.folder}/attachments`, fileIds.length > 1 ? `${name}-${i + 1}` : name, extensionFor({ mime: fm.kind === "photo" ? "image/jpeg" : "audio/ogg" }, got.path));
          await d.fs.writeBinary(p, got.bytes);
          attachments = [...attachments, p];
        }
        edits.push({ block: ["attachment", attachments.map((a) => `![[${base(a)}]]`).join("\n")], fields: { attachment: "done", attachments: JSON.stringify(attachments), file_ids: null } });
      }
      const key = d.openai();
      const first = attachments[0];
      if (key && first && needsTranscript && (fm.kind === "voice" || fm.kind === "audio")) {
        const buf = await d.fs.readBinary(first);
        const t = await transcribe(d.net, key, { model: d.cfg.transcribeModel, language: d.cfg.transcribeLanguage }, { name: base(first), mime: "audio/ogg", bytes: buf });
        edits.push({ block: ["transcript", `**Transcript:**\n${t.split("\n").map((l) => `> ${l}`).join("\n")}`], fields: { transcript: "done", transcript_model: d.cfg.transcribeModel } });
      }
      if (key && first && needsDescription && fm.kind === "photo") {
        const buf = await d.fs.readBinary(first);
        const desc = await describeImage(d.net, key, d.cfg.visionModel, { mime: "image/jpeg", bytes: buf });
        edits.push({ block: ["description", `**What it shows:**\n${desc.split("\n").map((l) => `> ${l}`).join("\n")}`], fields: { description: "done" } });
      }
    } catch (e) {
      rep.stillPending.push(`${base(path)}: ${redact((e as Error).message)}`);
    }
    if (!edits.length) {
      if (!rep.stillPending.some((s) => s.startsWith(base(path)))) rep.stillPending.push(`${base(path)}: waiting on a key or token`);
      continue;
    }
    await d.fs.modify(path, (t) => {
      let out = t;
      for (const e of edits) {
        if (e.block) out = replaceBlock(out, e.block[0], e.block[1]);
        out = setFields(out, e.fields);
      }
      return out;
    });
    log(d, "message-update", path, "Filled in a missing download, transcript or description", "retry");
    rep.fixed.push(base(path));
  }
  return rep;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Mark a message handled. Used by the dashboard (by "you") and by the brief/close jobs. */
export async function setMessageStatus(
  d: Pick<IngestDeps, "fs" | "record" | "now" | "uuid">,
  path: string,
  status: Exclude<MessageStatus, "new">,
  h: Handling
): Promise<void> {
  const { before, after } = await d.fs.modify(path, (t) => {
    if (readFrontmatter(t).type !== "message") throw new Error("that isn't a message note");
    return markHandled(t, status, h);
  });
  d.record({ id: d.uuid(), at: d.now().toISOString(), source: h.by, op: "message-status", path, summary: `Marked ${status}${h.summary ? `: ${h.summary.slice(0, 80)}` : ""}`, before: hash(before), after: hash(after) });
}

export { RelayError, blockText };
