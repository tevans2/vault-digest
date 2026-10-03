import { Notice } from "obsidian";
import type VaultDigestPlugin from "../main";
import { RelayClient, RelayError } from "./relay";
import { fetchAndIngest, retryPending, setMessageStatus, IngestCfg, IngestDeps, IngestReport } from "./ingest";
import { obsidianNet } from "./obsidian-net";
import { redact } from "./net";
import { MAX_MESSAGE_INDEX } from "../state/schema";
import { shouldFetch } from "./service-rules";
import type { MessageStatus } from "./note";

const FOCUS_MIN_GAP_MS = 30_000;

/** Owns fetching, polling and retrying for the message channel. The ingest logic itself is pure and tested. */
export class MessageService {
  private busy = false;

  constructor(private p: VaultDigestPlugin) {}

  private get st() {
    return this.p.store.state.messages;
  }
  private secret(name: string): string | null {
    return this.p.app.secretStorage?.getSecret(name) ?? null;
  }

  /** What's missing, in plain words. Empty means ready. */
  problems(): string[] {
    const s = this.p.settings;
    const out: string[] = [];
    if (!s.relayUrl.trim()) out.push("the relay URL");
    if (!this.secret(s.relaySecret)) out.push("the relay API token");
    return out;
  }

  get isBusy() {
    return this.busy;
  }

  /** Non-blocking notes about things that will degrade messages (photos, voice) without stopping them. */
  warnings(): string[] {
    const s = this.p.settings;
    const w: string[] = [];
    if (!this.secret(s.botSecret)) w.push("No Telegram bot token: photos and voice notes won't be downloaded.");
    if ((s.transcribeVoice || s.describePhotos) && !this.secret(s.openaiSecret)) w.push("No OpenAI key: voice notes won't be transcribed and photos won't be described.");
    return w;
  }

  get enabled() {
    return this.p.settings.messagesEnabled;
  }
  get ready() {
    return this.enabled && this.problems().length === 0;
  }

  private cfg(): IngestCfg {
    const s = this.p.settings;
    return {
      folder: s.messagesFolder.replace(/\/+$/, ""),
      allowedChatId: s.messagesChatId.trim(),
      since: s.messagesSince.trim(),
      transcribe: s.transcribeVoice,
      transcribeModel: s.transcribeModel,
      transcribeLanguage: s.transcribeLanguage.trim(),
      describePhotos: s.describePhotos,
      visionModel: s.visionModel,
      maxPerRun: 200,
      maxAttempts: 3,
    };
  }

  private deps(): IngestDeps {
    const s = this.p.settings;
    const st = this.st;
    return {
      fs: this.p.assistant.fs,
      relay: new RelayClient(obsidianNet, s.relayUrl, () => this.secret(s.relaySecret)),
      net: obsidianNet,
      bot: () => this.secret(s.botSecret),
      openai: () => this.secret(s.openaiSecret),
      cfg: this.cfg(),
      index: {
        path: (k) => st.index[k],
        set: (k, path) => {
          st.index[k] = path;
          const keys = Object.keys(st.index);
          if (keys.length > MAX_MESSAGE_INDEX) for (const old of keys.slice(0, keys.length - MAX_MESSAGE_INDEX)) delete st.index[old];
        },
        attempts: (id) => st.attempts[String(id)] ?? 0,
        bump: (id) => (st.attempts[String(id)] = (st.attempts[String(id)] ?? 0) + 1),
        clear: (id) => void delete st.attempts[String(id)],
      },
      now: () => new Date(),
      uuid: () => crypto.randomUUID(),
      record: (rec) => this.p.assistant.recordWrite(rec),
    };
  }

  /** Pull from the relay now. `quiet` suppresses the notice (polling). Never throws. */
  async fetchNow(quiet = false): Promise<IngestReport | null> {
    if (!this.enabled) {
      if (!quiet) new Notice("The message channel is off. Turn it on in settings.");
      return null;
    }
    const missing = this.problems();
    if (missing.length) {
      this.st.lastError = `Set ${missing.join(" and ")} in settings.`;
      if (!quiet) new Notice(this.st.lastError, 8000);
      this.p.data.trigger("change");
      return null;
    }
    if (this.busy) return null;
    this.busy = true;
    this.st.lastAttemptAt = new Date().toISOString();
    let rep: IngestReport | null = null;
    try {
      const d = this.deps();
      rep = await fetchAndIngest(d);
      this.st.lastOkAt = new Date().toISOString();
      this.st.lastError = undefined;
      const bits = [rep.saved.length && `${rep.saved.length} saved`, rep.skipped.length && `${rep.skipped.length} skipped`, rep.failed.length && `${rep.failed.length} failed`].filter(Boolean);
      this.st.lastSummary = bits.length ? bits.join(", ") : "nothing new";
      try {
        this.st.relayPending = (await d.relay.pending(100)).length;
      } catch {
        /* the count is a nicety */
      }
      if (rep.problems.length) this.st.lastError = rep.problems[0];
      await this.p.data.readMessages();
      if (this.p.data.messageNotes.some((m) => m.needsRetry)) await this.retry(true);
      if (!quiet || rep.saved.length) new Notice(rep.saved.length ? `${rep.saved.length} new message${rep.saved.length === 1 ? "" : "s"}.` : `Messages: ${this.st.lastSummary}.`);
      if (rep.failed.length) new Notice(`Couldn't save: ${rep.failed[0]}`, 10_000);
    } catch (e) {
      const kind = e instanceof RelayError ? e.kind : "network";
      this.st.lastError = redact((e as Error).message);
      if (!quiet) new Notice(`Messages: ${this.st.lastError}`, 10_000);
      void kind;
    } finally {
      this.busy = false;
      await this.p.store.save();
      this.p.data.trigger("change");
    }
    // The same pipeline as the command bar reads each new message. Not awaited: it can take a while.
    if (rep?.saved.length || this.p.data.newMessages().length) void this.p.intent.processMessages();
    return rep;
  }

  /** Fill in downloads, transcripts and descriptions that were missing when the message arrived. */
  async retry(quiet = false) {
    try {
      const rep = await retryPending(this.deps());
      await this.p.data.readMessages();
      if (!quiet) new Notice(rep.fixed.length ? `Filled in ${rep.fixed.length} message${rep.fixed.length === 1 ? "" : "s"}.` : rep.stillPending.length ? `Still waiting: ${rep.stillPending[0]}` : "Nothing to retry.", 8000);
    } catch (e) {
      if (!quiet) new Notice(`Retry failed: ${redact((e as Error).message)}`, 8000);
    }
    this.p.data.trigger("change");
  }

  /** The dashboard's own "done / ignore" buttons. */
  async mark(path: string, status: Exclude<MessageStatus, "new">, summary = "") {
    try {
      await setMessageStatus(this.deps(), path, status, { by: "you", date: new Date().toISOString().slice(0, 10), summary });
    } catch (e) {
      new Notice(`Couldn't update that message: ${(e as Error).message}`, 8000);
    }
    await this.p.data.readMessages();
    this.p.data.trigger("change");
  }

  /**
   * Fetch when Obsidian opens, when you switch back to it (at most every 30 seconds), and on a timer
   * (the "Check every" setting, read fresh each time so changing it needs no reload).
   */
  startPolling() {
    const due = (gapMs: number) => this.ready && !this.busy && shouldFetch(this.st.lastAttemptAt, Date.now(), gapMs);
    const timer = () => {
      if (due(Math.max(1, this.p.settings.messagesPollMin) * 60_000)) void this.fetchNow(true);
    };
    const focus = () => {
      if (due(FOCUS_MIN_GAP_MS)) void this.fetchNow(true);
    };
    this.p.registerInterval(window.setInterval(timer, 30_000));
    this.p.registerDomEvent(window, "focus", focus);
    window.setTimeout(focus, 15_000);
  }
}

export interface TestLine {
  ok: boolean;
  text: string;
}

/** Cheap checks of each connection, so a wrong URL or token shows up before a real message needs it. */
export async function testConnections(p: VaultDigestPlugin): Promise<TestLine[]> {
  const s = p.settings;
  const secret = (n: string) => p.app.secretStorage?.getSecret(n) ?? null;
  const out: TestLine[] = [];

  try {
    const stats = await new RelayClient(obsidianNet, s.relayUrl, () => secret(s.relaySecret)).stats();
    out.push({ ok: true, text: `Relay: connected. ${stats.pending} waiting, ${stats.done} done${stats.failed ? `, ${stats.failed} failed` : ""}.` });
  } catch (e) {
    out.push({ ok: false, text: `Relay: ${redact((e as Error).message)}` });
  }

  const bot = secret(s.botSecret);
  if (!bot) out.push({ ok: false, text: "Telegram bot token: not set, so photos and voice notes can't be downloaded." });
  else {
    try {
      const r = await obsidianNet(`https://api.telegram.org/bot${bot}/getMe`, { method: "GET" });
      const j = r.json as { ok?: boolean; result?: { username?: string } } | undefined;
      out.push(r.status === 200 && j?.ok ? { ok: true, text: `Telegram bot: @${j.result?.username ?? "ok"}.` } : { ok: false, text: "Telegram bot: the token was rejected." });
    } catch (e) {
      out.push({ ok: false, text: `Telegram bot: ${redact((e as Error).message)}` });
    }
  }

  const key = secret(s.openaiSecret);
  if (!s.transcribeVoice && !s.describePhotos) out.push({ ok: true, text: "OpenAI: not needed (transcription and descriptions are off)." });
  else if (!key) out.push({ ok: false, text: "OpenAI key: not set, so voice notes won't be transcribed." });
  else {
    try {
      const r = await obsidianNet("https://api.openai.com/v1/models", { method: "GET", headers: { Authorization: `Bearer ${key}` } });
      out.push(r.status === 200 ? { ok: true, text: "OpenAI: key accepted." } : { ok: false, text: r.status === 401 ? "OpenAI: the key was rejected." : `OpenAI: HTTP ${r.status}.` });
    } catch (e) {
      out.push({ ok: false, text: `OpenAI: ${redact((e as Error).message)}` });
    }
  }
  return out;
}
