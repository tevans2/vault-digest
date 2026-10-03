import { Notice } from "obsidian";
import type VaultDigestPlugin from "../main";
import { obsidianNet } from "../messages/obsidian-net";
import { redact } from "../messages/net";
import { ApiError, CalendarInfo, GoogleCalendar } from "./api";
import { applyPlan } from "./apply";
import { CalTask, GEvent, cleanTitle } from "./model";
import { AuthError, Credentials, GoogleAuth, buildAuthUrl, exchangeCode, makePkce, randomString } from "./oauth";
import { SyncPlan, planIsEmpty, planSync } from "./sync";
import { isoDate } from "../util/dates";
import type { ActionRecord } from "../intent/types";
import { MAX_ACTIONS } from "../intent/types";

export const REFRESH_SECRET = "google-calendar-refresh-token";
const LOOKBACK_MS = 10 * 60_000; // re-read a little before the last sync so nothing slips through a clock gap

export type SyncMode = "off" | "manual" | "auto";

/** Connects to Google, keeps the vault and the calendar aligned, and reports honestly when it can't. */
export class CalendarService {
  private busy = false;
  private calCache: { at: number; list: CalendarInfo[] } | null = null;
  private lastSignature = "";
  private debounce: number | null = null;
  /** What the last preview would do, for manual mode. */
  preview: { lines: string[]; issues: string[]; at: string } | null = null;

  readonly auth: GoogleAuth;
  readonly api: GoogleCalendar;

  constructor(private p: VaultDigestPlugin) {
    this.auth = new GoogleAuth(obsidianNet, () => this.creds());
    this.api = new GoogleCalendar(obsidianNet, this.auth);
  }

  private get st() {
    return this.p.store.state.calendar;
  }
  private secret(name: string): string | null {
    return this.p.app.secretStorage?.getSecret(name) ?? null;
  }
  private creds(): Credentials | null {
    const s = this.p.settings;
    const clientId = this.secret(s.googleClientIdSecret);
    const clientSecret = this.secret(s.googleClientSecretSecret);
    return clientId && clientSecret ? { clientId, clientSecret, refreshToken: this.secret(REFRESH_SECRET) ?? "" } : null;
  }

  get mode(): SyncMode {
    return this.p.settings.calendarSync;
  }
  get connected(): boolean {
    return !!this.secret(REFRESH_SECRET);
  }
  get isBusy() {
    return this.busy;
  }

  /** What's missing, in plain words. */
  problems(): string[] {
    const out: string[] = [];
    const s = this.p.settings;
    if (!this.secret(s.googleClientIdSecret)) out.push("the Google client id");
    if (!this.secret(s.googleClientSecretSecret)) out.push("the Google client secret");
    return out;
  }

  // ── Connecting ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const miss = this.problems();
    if (miss.length) return void new Notice(`Add ${miss.join(" and ")} in settings first.`, 8000);
    if (!this.p.app.secretStorage) return void new Notice("Needs Obsidian 1.11.4 or newer for secure storage.");
    const creds = this.creds()!;
    try {
      const { startLoopback } = await import("./loopback"); // Node only exists on desktop
      const lb = await startLoopback();
      const { verifier, challenge } = await makePkce();
      const state = randomString(16);
      window.open(buildAuthUrl({ clientId: creds.clientId, redirectUri: lb.redirectUri, challenge, state }));
      new Notice("Approve access in your browser. Google may warn the app is unverified: choose Advanced, then continue.", 12_000);
      const code = await lb.wait(state);
      const t = await exchangeCode(obsidianNet, { clientId: creds.clientId, clientSecret: creds.clientSecret, code, verifier, redirectUri: lb.redirectUri });
      this.p.app.secretStorage.setSecret(REFRESH_SECRET, t.refreshToken);
      this.auth.invalidate();
      const list = await this.calendars(true);
      this.st.connectedAs = list.find((c) => c.primary)?.id ?? list[0]?.id;
      this.st.lastError = undefined;
      await this.p.store.save();
      new Notice(`Connected to Google Calendar${this.st.connectedAs ? ` as ${this.st.connectedAs}` : ""}.`, 8000);
    } catch (e) {
      new Notice(`Couldn't connect: ${redact((e as Error).message)}`, 12_000);
    }
    this.p.data.trigger("change");
  }

  async disconnect() {
    this.p.app.secretStorage?.setSecret(REFRESH_SECRET, "");
    this.auth.invalidate();
    this.st.connectedAs = undefined;
    await this.p.store.save();
    new Notice("Disconnected. Existing events stay on your calendar.");
    this.p.data.trigger("change");
  }

  async calendars(force = false): Promise<CalendarInfo[]> {
    if (!force && this.calCache && Date.now() - this.calCache.at < 10 * 60_000) return this.calCache.list;
    const list = await this.api.calendars();
    this.calCache = { at: Date.now(), list };
    return list;
  }

  /** A calendar name or an id → an id. Names match case-insensitively. */
  private resolve(nameOrId: string, list: CalendarInfo[]): string | undefined {
    const v = nameOrId.trim();
    if (!v || v.toLowerCase() === "primary") return "primary";
    return list.find((c) => c.id === v)?.id ?? list.find((c) => c.summary.toLowerCase() === v.toLowerCase())?.id;
  }

  // ── Reading the vault ─────────────────────────────────────────────────────

  /** Tasks on the calendar, plus tasks we've linked (so removing #cal is noticed). */
  private calTasks(): CalTask[] {
    const links = this.st.links;
    return this.p.data.tasks
      .filter((t) => t.cal !== undefined || (t.id !== undefined && !!links[t.id]))
      .map((t) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        raw: t.raw,
        title: cleanTitle(t.text),
        cal: t.cal,
        done: t.done && !t.cancelled,
        cancelled: t.cancelled,
        when: t.due ? { date: t.due, start: t.time, end: t.endTime } : null,
      }));
  }

  /** Changes to what's on the calendar, so a task's state can change cheaply without a full sync. */
  private signature(): string {
    return this.calTasks().map((t) => `${t.id}|${t.cal}|${t.when?.date}|${t.when?.start}|${t.when?.end}|${t.title}|${t.done}|${t.cancelled}`).sort().join("\n");
  }

  // ── Syncing ───────────────────────────────────────────────────────────────

  /** Work out what would change. Reads Google, writes nothing. */
  async plan(): Promise<{ plan: SyncPlan; list: CalendarInfo[] }> {
    const s = this.p.settings;
    const list = await this.calendars();
    const def = this.resolve(s.calendarDefault, list) ?? "primary";
    const aliases: Record<string, string | undefined> = {};
    for (const [a, v] of Object.entries(s.calendarAliases)) aliases[a] = this.resolve(v, list);
    const tasks = this.calTasks();

    const cals = new Set<string>([def, ...Object.values(aliases).filter((x): x is string => !!x), ...Object.values(this.st.links).map((l) => l.calendarId)]);
    const since = this.st.lastSyncAt ? new Date(Date.parse(this.st.lastSyncAt) - LOOKBACK_MS).toISOString() : Object.keys(this.st.links).length ? new Date(Date.now() - 30 * 86_400_000).toISOString() : undefined;
    const changed = new Map<string, GEvent>();
    if (since) {
      for (const c of cals) for (const ev of await this.api.events(c, { updatedMin: since, showDeleted: true })) changed.set(ev.id, ev);
    }
    // A task with an id but no link might be an event we lost track of: ask Google for it by our marker.
    const orphans = new Map<string, GEvent>();
    for (const t of tasks) {
      if (t.cal === undefined || !t.id || this.st.links[t.id]) continue;
      const calendarId = t.cal ? aliases[t.cal] : def;
      if (!calendarId) continue;
      const hit = (await this.api.events(calendarId, { privateProp: `vdId=${t.id}` })).find((e) => e.status !== "cancelled");
      if (hit) orphans.set(t.id, hit);
    }
    const plan = planSync({
      tasks,
      links: this.st.links,
      changed,
      orphans,
      scanComplete: this.p.data.computedAt > 0 && this.p.data.tasks.length > 0,
      defaultCalendarId: def,
      calendarForAlias: (a) => aliases[a],
      newId: () => Math.random().toString(36).slice(2, 8),
    });
    return { plan, list };
  }

  /** Sync now. `apply` false only previews. Never throws. */
  async sync(opts: { apply?: boolean; quiet?: boolean } = {}): Promise<void> {
    const apply = opts.apply ?? this.mode === "auto";
    if (this.mode === "off" && !opts.apply) return;
    if (!this.connected) return void (opts.quiet || new Notice("Connect Google Calendar in settings first."));
    if (this.busy) return;
    this.busy = true;
    this.p.data.trigger("change");
    try {
      const { plan } = await this.plan();
      if (!apply) {
        this.preview = { lines: describePlan(plan), issues: plan.issues, at: new Date().toISOString() };
        this.st.lastSummary = planIsEmpty(plan) ? "in sync" : `${plan.events.length + plan.vault.length} changes waiting for approval`;
      } else {
        const result = await applyPlan(
          {
            api: this.api,
            writer: this.p.assistant.writer,
            state: this.st,
            today: () => isoDate(),
            now: () => new Date(),
            describe: (path) => `From your vault: ${path}\nobsidian://open?vault=${encodeURIComponent(this.p.app.vault.getName())}&file=${encodeURIComponent(path)}`,
          },
          plan
        );
        this.preview = null;
        const failed = result.ops.filter((o) => !o.ok).length;
        this.st.lastSummary = !result.ops.length ? "in sync" : `${result.ops.filter((o) => o.ok).length} changes${failed ? `, ${failed} failed` : ""}`;
        if (result.ops.length) this.record(result.ops, result.issues);
        if (result.issues.length) this.st.lastError = result.issues[0];
        else if (!failed) this.st.lastError = undefined;
        if (failed) this.st.lastError = result.ops.find((o) => !o.ok)?.error;
        this.st.lastSyncAt = new Date().toISOString();
        this.lastSignature = this.signature();
      }
      if (!apply) this.st.lastError = undefined; // reading Google worked
      if (!opts.quiet) new Notice(`Calendar: ${this.st.lastSummary}.`, 6000);
    } catch (e) {
      this.st.lastError = redact(e instanceof ApiError || e instanceof AuthError ? e.message : (e as Error).message);
      if (!opts.quiet) new Notice(`Calendar: ${this.st.lastError}`, 10_000);
    } finally {
      this.busy = false;
      await this.p.store.save();
      this.p.data.trigger("change");
    }
  }

  /** One history entry per sync that changed something, so what the calendar did to your notes is never a mystery. */
  private record(ops: { ok: boolean; summary: string; error?: string }[], issues: string[]) {
    const ok = ops.filter((o) => o.ok).length;
    const rec: ActionRecord = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: "calendar",
      input: "Calendar sync",
      subjects: [],
      interpreter: "grammar",
      summary: `Calendar sync: ${ok} change${ok === 1 ? "" : "s"}${ops.length > ok ? `, ${ops.length - ok} failed` : ""}`,
      status: ops.length > ok ? (ok ? "partial" : "failed") : "applied",
      // Not undoable on purpose: undo the task edit instead and the next sync carries it to the calendar.
      ops: [...ops, ...issues.map((i) => ({ ok: false, summary: "Skipped", error: i }))],
    };
    const a = this.p.store.state.actions;
    a.unshift(rec);
    a.length = Math.min(a.length, MAX_ACTIONS);
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  start() {
    // On a timer, and shortly after you edit a task that's on the calendar.
    this.p.registerInterval(window.setInterval(() => void this.tick(), Math.max(1, this.p.settings.calendarPollMin) * 60_000));
    this.p.registerEvent(
      this.p.data.on("change", () => {
        if (this.mode !== "auto" || !this.connected || this.busy) return;
        const sig = this.signature();
        if (sig === this.lastSignature) return;
        if (this.debounce) window.clearTimeout(this.debounce);
        this.debounce = window.setTimeout(() => void this.sync({ quiet: true }), 5000);
      })
    );
    window.setTimeout(() => {
      this.lastSignature = this.signature();
      void this.tick();
    }, 20_000);
  }

  private async tick() {
    if (this.mode === "off" || !this.connected) return;
    await this.sync({ apply: this.mode === "auto", quiet: true });
  }
}

function describePlan(plan: SyncPlan): string[] {
  const lines: string[] = [];
  for (const v of plan.vault) lines.push(`Task “${v.task.title.slice(0, 50)}”: ${v.reason}`);
  for (const e of plan.events) {
    if (e.k === "event.create") lines.push(`Create “${e.task.title.slice(0, 50)}” on the calendar (${e.reason})`);
    else if (e.k === "event.patch") lines.push(`Update “${e.link.title.slice(0, 50)}” on the calendar (${e.reason})`);
    else lines.push(`Delete “${e.link.title.slice(0, 50)}” from the calendar (${e.reason})`);
  }
  return lines;
}
