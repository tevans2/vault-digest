import { FileSystemAdapter, Notice, Platform, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, DigestSettings, DigestSettingTab } from "./settings/settings";
import { StateStore } from "./state/store";
import { reapStaleRuns, JobId, RunRecord, RunTrigger } from "./state/schema";
import { DigestData } from "./engine/data";
import { DigestView, VIEW_TYPE } from "./dashboard/view";
import { DEFAULT_LAYOUT_YAML } from "./dashboard/layout";
import { Announcement } from "./engine/collectors/announcements";
import { decideBrief, decideWeek, weekMissed } from "./engine/scheduler";
import { JobRunner, RunnerConfig } from "./runner/runner";
import { DEFAULT_MODELS, PROVIDER_LABELS, needsDesktop, type AgentBackend, type AgentOutcome, type AgentRequest, type Provider } from "./runner/provider";
import { openRouterBackend } from "./runner/backends/openrouter";
import { obsidianHttp } from "./runner/http";
import { classifyFailure } from "./runner/errors";
import { structuredFrom } from "./runner/stream";
import { PROMPT_FILES, PROMPT_MARKER } from "./runner/prompts";
import { Assistant } from "./assistant";
import { MessageService } from "./messages/service";
import { IntentService } from "./intent/service";
import { CalendarService } from "./calendar/service";
import { CaptureModal } from "./dashboard/tiles/capture";
import { CommandModal } from "./dashboard/command-bar";
import { renderRadar } from "./dashboard/tiles/radar";
import { MarkdownRenderChild } from "obsidian";
import { addDays, isoDate, minutesOfDay, timeOfDay } from "./util/dates";
import { RunLogModal } from "./dashboard/log-modal";
import { dedupeAnnouncements, stampDate } from "./engine/dedupe";

export default class VaultDigestPlugin extends Plugin {
  settings!: DigestSettings;
  store!: StateStore;
  data!: DigestData;
  assistant!: Assistant;
  messages!: MessageService;
  intent!: IntentService;
  calendar!: CalendarService;
  showHandledMessages = false;
  /** Typed-but-unsent text survives the dashboard re-rendering. */
  captureDraft = "";
  closeDraft = { done: "", waiting: "", other: "" };
  closeReopen = false;
  runner: JobRunner | null = null;
  agent: AgentBackend = async () => ({ kind: "spawn-error", message: "The runner isn't ready yet.", stderr: "" });
  /** Why the runner isn't available, if setup failed. Shown instead of a guess. */
  runnerError = "";

  /** Public API for other plugins, Claude Code and launchd: app.plugins.plugins['vault-digest'].api */
  api = {
    getState: () => this.store.state,
    run: (job: JobId = "brief", trigger: RunTrigger = "manual") => this.runJob(job, trigger),
    capture: (text: string) => this.assistant.capture(text),
    isBusy: () => this.runner?.isBusy() ?? false,
  };

  async onload() {
    await this.loadSettings();
    this.store = new StateStore(this.app, () => this.settings.stateFolder);
    this.data = new DigestData(this.app, () => this.settings, () => this.store.state.radar);
    this.assistant = new Assistant(this);
    this.messages = new MessageService(this);
    this.intent = new IntentService(this);
    this.calendar = new CalendarService(this);

    this.registerView(VIEW_TYPE, (leaf) => new DigestView(leaf, this));
    this.addSettingTab(new DigestSettingTab(this.app, this));

    this.addRibbonIcon("newspaper", "Open Vault Digest", () => void this.activateView());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.activateView() });
    this.addCommand({ id: "refresh", name: "Refresh dashboard data", callback: () => void this.data.recomputeAll() });
    this.addCommand({ id: "run-brief", name: "Run morning brief", callback: () => void this.runJob("brief", "manual") });
    this.addCommand({ id: "run-week", name: "Run weekly review", callback: () => void this.runJob("week", "manual") });
    this.addCommand({ id: "sync-calendar", name: "Sync Google Calendar now", callback: () => void this.calendar.sync({ apply: true }) });
    this.addCommand({ id: "preview-calendar", name: "Preview Google Calendar sync", callback: () => void this.calendar.sync({ apply: false }) });
    this.addCommand({ id: "fetch-messages", name: "Fetch messages now", callback: () => void this.messages.fetchNow() });
    this.addCommand({ id: "retry-messages", name: "Retry incomplete messages (downloads and transcripts)", callback: () => void this.messages.retry() });
    this.addCommand({
      id: "command-bar",
      name: "Command bar: instruct on the selection, note or cursor",
      // Bind a hotkey to this in Settings → Hotkeys. It works from any note, or from the dashboard.
      callback: () => this.openCommandBar(),
    });
    this.addCommand({ id: "capture", name: "Capture a task (opens the command bar)", callback: () => this.openCommandBar() });
    this.addCommand({
      id: "undo-last-action",
      name: "Undo the last action",
      callback: async () => {
        const a = this.store.state.actions.find((x) => x.ops.some((o) => o.ok && o.inverse && !o.undone));
        if (!a) return void new Notice("Nothing to undo.");
        const r = await this.intent.undo(a.id);
        new Notice(r.skipped.length ? `Undid ${r.undone}, left ${r.skipped.length} alone: ${r.skipped[0]}` : `Undid: ${a.summary}`, 6000);
      },
    });
    this.addCommand({
      id: "close-day",
      name: "Close the day",
      callback: async () => {
        this.closeReopen = true; // opens the form even before the close time
        await this.activateView();
        this.setTab("today");
      },
    });
    this.addCommand({ id: "radar-block", name: "Replace Task Board radar table with live block", callback: () => void this.assistant.replaceBoardRadar() });
    this.addCommand({ id: "cancel-run", name: "Cancel running job", callback: () => this.runner?.cancel() });
    this.addCommand({
      id: "apply-pending",
      name: "Apply pending results",
      checkCallback: (checking) => {
        if (!this.store.state.pending.length) return false;
        if (!checking) void this.assistant.applyPending();
        return true;
      },
    });
    this.addCommand({
      id: "view-last-log",
      name: "View last run log",
      checkCallback: (checking) => {
        const r = this.store.state.runs[0];
        if (!r) return false;
        if (!checking) new RunLogModal(this.app, r).open();
        return true;
      },
    });
    this.addCommand({
      id: "reset-acks",
      name: "Reset acknowledged and snoozed announcements",
      callback: async () => {
        await this.store.clearInteractions();
        this.data.trigger("change");
        new Notice("Announcements reset.");
      },
    });

    // ```pa-radar blocks render the live, scored radar anywhere (e.g. the Task Board).
    this.registerMarkdownCodeBlockProcessor("pa-radar", (_src, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      const draw = () => {
        el.empty();
        renderRadar(el.createDiv({ cls: "vd-root vd-embed" }), this.data.scoredRadar());
      };
      draw();
      child.registerEvent(this.data.on("change", draw));
    });

    this.app.workspace.onLayoutReady(async () => {
      await this.store.load();
      if (reapStaleRuns(this.store.state)) await this.store.save();
      await this.setupRunner();
      await this.data.recomputeAll();
      this.registerVaultEvents();
      if (this.settings.openOnStartup && !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) {
        await this.activateView();
      }
      // Scheduler: every minute, on window focus, and shortly after startup.
      this.registerInterval(window.setInterval(() => this.checkSchedule(), 60_000));
      this.registerDomEvent(window, "focus", () => this.checkSchedule());
      window.setTimeout(() => this.checkSchedule(), 10_000);
      this.messages.startPolling();
      this.calendar.start();
    });

    // Replace empty new tabs with the dashboard.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.settings.replaceNewTab || !leaf) return;
        if (leaf.view.getViewType() !== "empty") return;
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return;
        void leaf.setViewState({ type: VIEW_TYPE, active: true });
      })
    );
  }

  onunload() {
    this.runner?.cancel();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  // ── Runner ────────────────────────────────────────────────────────────────

  async setupRunner() {
    this.runnerError = "";
    try {
      this.buildRunner();
    } catch (e) {
      this.runner = null;
      this.runnerError = (e as Error).message || String(e);
      console.error("[vault-digest] runner setup failed", e);
    }
  }

  /** The configured model for a provider, falling back to its default. */
  modelFor(p: Provider): string {
    const m = (this.settings.models[p] ?? "").trim();
    return m || DEFAULT_MODELS[p];
  }

  private spawnError = (message: string): AgentOutcome => ({ kind: "spawn-error", message, stderr: "" });

  /** CLI backends are loaded on first use, so the plugin still starts on mobile where Node doesn't exist. */
  private async runCli(req: AgentRequest): Promise<AgentOutcome> {
    const label = PROVIDER_LABELS[req.provider];
    if (!Platform.isDesktopApp) return this.spawnError(`${label} needs the desktop app. Choose OpenRouter on mobile.`);
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    if (typeof adapter.getBasePath !== "function") {
      return this.spawnError("This vault isn't backed by a local folder, so there's no working directory for the CLI.");
    }
    const [{ findBinary, loginPath }, { buildEnv }, { claudeBackend }, { codexBackend }] = await Promise.all([
      import("./runner/binaries"),
      import("./runner/claude"),
      import("./runner/backends/claude"),
      import("./runner/backends/codex"),
    ]);
    const isClaude = req.provider === "claude-code";
    const found = await findBinary(isClaude ? "claude" : "codex", isClaude ? this.settings.claudeBinary : this.settings.codexBinary);
    if (!found) return this.spawnError(`${label} was not found. Install it, or set its path in settings.`);
    const node = { cwd: adapter.getBasePath(), binary: async () => found, env: async () => buildEnv(await loginPath()) };
    return (isClaude ? claudeBackend(node) : codexBackend(node))(req);
  }

  private buildRunner() {
    const vaultReader = {
      paths: () => this.app.vault.getMarkdownFiles().map((f) => f.path),
      read: (p: string) => {
        const f = this.app.vault.getAbstractFileByPath(p);
        return f instanceof TFile ? this.app.vault.cachedRead(f) : Promise.resolve("");
      },
    };
    const openrouter = openRouterBackend({
      vault: vaultReader,
      apiKey: () => this.app.secretStorage?.getSecret(this.settings.openrouterSecret) ?? null,
      http: obsidianHttp,
    });
    this.agent = (req) => (req.provider === "openrouter" ? openrouter(req) : this.runCli(req));

    this.runner = new JobRunner(
      {
        state: () => this.store.state,
        save: () => this.store.save(),
        config: (): RunnerConfig => ({
          provider: this.settings.provider,
          model: this.modelFor(this.settings.provider),
          effort: this.settings.effort,
          fallbackModel: this.settings.fallbackModel,
          budgetUsd: this.settings.budgetUsd,
          timeoutMs: Math.round(this.settings.timeoutMin * 60_000),
          dryRun: this.settings.dryRun,
          backoffMs: [30_000, 120_000],
        }),
        agent: (req) => this.agent(req),
        sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
        now: () => new Date(),
        uuid: () => crypto.randomUUID(),
      },
      this.assistant.jobs()
    );

    let last = 0;
    this.runner.onChange(() => {
      // Progress lines arrive in bursts; repaint at most twice a second.
      const t = Date.now();
      if (t - last < 500) return;
      last = t;
      this.data.trigger("change");
    });
    void this.seedPrompts();
  }

  /** For the settings status line. */
  async detectBinary(p: Provider): Promise<string | undefined> {
    if (!Platform.isDesktopApp || p === "openrouter") return undefined;
    const { findBinary } = await import("./runner/binaries");
    return findBinary(p === "claude-code" ? "claude" : "codex", p === "claude-code" ? this.settings.claudeBinary : this.settings.codexBinary);
  }

  /** A tiny request through the chosen provider, so setup problems show up before the first real run. */
  async testConnection() {
    const p = this.settings.provider;
    const label = PROVIDER_LABELS[p];
    const model = this.modelFor(p);
    new Notice(`Testing ${label}${model ? ` · ${model}` : ""}…`);
    const started = Date.now();
    const out = await this.agent({
      provider: p,
      model,
      effort: "",
      fallbackModel: "",
      budgetUsd: 0.25,
      system: "You are a connectivity test.",
      prompt: "Set ok to true.",
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
      claudeTools: ["Read"],
      sessionId: crypto.randomUUID(),
      timeoutMs: 90_000,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (out.kind === "result" && out.result.ok && structuredFrom(out.result) !== undefined) {
      const cost = out.result.costUsd !== undefined ? ` · $${out.result.costUsd.toFixed(3)}` : "";
      new Notice(`${label} works: ${model || "default model"} replied in ${secs}s${cost}.`, 8000);
      return;
    }
    const msg =
      out.kind === "timeout"
        ? "timed out after 90s"
        : out.kind === "cancelled"
          ? "cancelled"
          : classifyFailure({
              result: out.kind === "result" ? out.result : undefined,
              exitCode: out.kind === "exit" ? out.exitCode : undefined,
              stderr: out.stderr,
              spawnError: out.kind === "spawn-error" ? out.message : undefined,
            }).message;
    new Notice(`${label} failed: ${msg.slice(0, 220)}`, 12_000);
  }

  async runJob(job: JobId, trigger: RunTrigger, args?: unknown): Promise<RunRecord | null> {
    const label = { brief: "Brief", close: "Close", week: "Weekly review", intent: "Instruction" }[job];
    if (!this.runner) await this.setupRunner(); // retry: setup may have failed at startup
    if (!this.runner) {
      new Notice(`Can't run the ${label.toLowerCase()}: ${this.runnerError || "the runner didn't start."} See the console for details.`, 12_000);
      return null;
    }
    if (this.runner.isBusy()) {
      new Notice("A job is already running.");
      return null;
    }
    const p = this.runner.run(job, trigger, args);
    this.data.trigger("change");
    const run = await p;
    this.data.trigger("change");
    if (run.status === "ok") {
      new Notice(run.dryRun ? `${label} ready. Review it in the Assistant tile.` : job === "week" ? "Weekly review done. Proposals are in the triage tile." : `${label} done.`);
    } else if (run.status === "failed" || run.status === "rejected") {
      new Notice(`${label} failed: ${(run.error ?? "unknown error").slice(0, 140)}`, 10_000);
    }
    return run;
  }

  /**
   * Open the command bar. On the dashboard with a bar showing it just takes focus; anywhere else it opens as
   * a panel that remembers the note, the highlighted text, or the task under your cursor.
   */
  openCommandBar() {
    const ctx = this.intent.captureContext(); // before focus moves
    const dash = this.app.workspace.getActiveViewOfType(DigestView);
    const el = dash?.contentEl.querySelector<HTMLInputElement>(".vd-capture-input");
    if (el) return void el.focus();
    new CommandModal(this.app, this, ctx).open();
  }

  /** The tab to show: the one picked today, otherwise the front page. */
  activeTabId(ids: string[]): string {
    const { lastTab, lastTabDate } = this.settings;
    return lastTab && lastTabDate === isoDate() && ids.includes(lastTab) ? lastTab : (ids[0] ?? "today");
  }

  setTab(id: string) {
    this.settings.lastTab = id;
    this.settings.lastTabDate = isoDate();
    void this.saveData(this.settings);
    this.data.trigger("change"); // the view re-renders on this
  }

  /** Kept for the dashboard's existing callers. */
  runBrief(trigger: RunTrigger) {
    return this.runJob("brief", trigger);
  }

  private checkSchedule() {
    if (!this.runner) return;
    // CLI providers can't run on mobile; don't burn the day's attempts on guaranteed failures.
    if (needsDesktop(this.settings.provider) && !Platform.isDesktopApp) return;
    const now = new Date();
    const runs = this.store.state.runs;
    const busy = this.runner.isBusy();

    const brief = decideBrief(now, runs, { autoRun: this.settings.autoRun, time: this.settings.briefTime, weekdaysOnly: this.settings.weekdaysOnly }, busy);
    if (brief.run) return void this.runJob("brief", brief.trigger);
    const week = decideWeek(now, runs, { autoRun: this.settings.autoRun, time: this.settings.weekTime }, busy);
    if (week.run) return void this.runJob("week", week.trigger);
    void this.noticeClose(now);
  }

  /** Close is never automatic (it needs your input): nudge once, at the configured time. */
  private async noticeClose(now: Date) {
    const [h, m] = this.settings.closeTime.split(":").map(Number);
    const today = isoDate(now);
    const key = `notice:close:${today}`;
    const st = this.store.state;
    if (st.interactions.acks[key]) return;
    if (minutesOfDay(now) < h * 60 + (m || 0)) return;
    if (st.runs.some((r) => r.job === "close" && r.status === "ok" && isoDate(new Date(r.startedAt)) === today)) return;
    st.interactions.acks[key] = now.toISOString();
    await this.store.save();
    new Notice("Close the day? The form is on your dashboard.", 10_000);
  }

  /** Back-compat wrappers; the Assistant owns the logic. */
  applyPending() {
    return this.assistant.applyPending();
  }
  discardPending(runId: string) {
    return this.assistant.discardPending(runId);
  }

  /** Prompts live in the vault so they can be edited without a rebuild. */
  async readPrompt(file: keyof typeof PROMPT_FILES): Promise<string> {
    const path = normalizePath(`${this.settings.promptsFolder}/${file}`);
    try {
      if (await this.app.vault.adapter.exists(path)) return await this.app.vault.adapter.read(path);
    } catch {
      /* fall through to the shipped default */
    }
    return PROMPT_FILES[file];
  }

  private async seedPrompts() {
    const a = this.app.vault.adapter;
    const folder = normalizePath(this.settings.promptsFolder);
    try {
      let acc = "";
      for (const part of folder.split("/")) {
        acc = acc ? `${acc}/${part}` : part;
        if (!(await a.exists(acc))) await a.mkdir(acc);
      }
      for (const [name, text] of Object.entries(PROMPT_FILES)) {
        const p = `${folder}/${name}`;
        if (!(await a.exists(p))) {
          await a.write(p, text + "\n");
        } else if (!(await a.read(p)).includes(PROMPT_MARKER)) {
          // An older default: keep the user's copy as a backup, then install the current one.
          await a.write(`${p}.bak`, await a.read(p));
          await a.write(p, text + "\n");
        }
      }
    } catch (e) {
      console.warn("[vault-digest] could not seed prompts", e);
    }
  }

  /** Everything the Announcements tile shows, in one place. */
  allAnnouncements(): Announcement[] {
    const st = this.store.state;
    const now = new Date();
    const today = isoDate(now);
    const out: Announcement[] = [];

    // A failed job must never be silent.
    for (const job of ["brief", "close", "week"] as const) {
      const last = st.runs.find((r) => r.job === job && r.status !== "running" && r.status !== "cancelled");
      if (last && (last.status === "failed" || last.status === "rejected") && isoDate(new Date(last.startedAt)) >= addDays(today, -1)) {
        const label = { brief: "Brief", close: "Close", week: "Weekly review" }[job];
        out.push({
          id: `engine:run-failed:${last.id}`,
          level: "error",
          source: "engine",
          text: `**${label} failed at ${timeOfDay(new Date(last.startedAt))}.** ${(last.error ?? "").slice(0, 160)}`,
          actions: [
            { kind: "run", job, label: "Retry" },
            { kind: "log", runId: last.id, label: "View log" },
          ],
        });
      }
    }
    if (weekMissed(now, st.runs)) {
      out.push({
        id: `engine:week-missed:${today.slice(0, 7)}-${Math.floor(now.getTime() / (7 * 86_400_000))}`,
        level: "stale",
        source: "engine",
        text: "**The weekly review didn't run this week.** Inbox triage and the load forecast are waiting.",
        actions: [{ kind: "run", job: "week", label: "Run it" }],
      });
    }
    if (this.settings.messagesEnabled && st.messages.lastError && this.messages.ready) {
      out.push({
        id: `engine:messages-error:${st.messages.lastError.slice(0, 40)}`,
        level: "stale",
        source: "engine",
        topic: "inbox",
        text: `**Message channel:** ${st.messages.lastError}`,
        actions: [{ kind: "fetch-messages", label: "Fetch now" }],
      });
    }
    out.push(...this.data.engine);
    if (st.brief && st.brief.date === today) out.push(...st.brief.announcements);
    if (st.close && st.close.forDate === today) out.push(...st.close.announcements);
    if (st.week && st.week.date >= addDays(today, -6)) out.push(...st.week.announcements);
    // The hand-written note is only trusted on the day it was written: after that it's yesterday's news.
    if (this.settings.showLegacyAnnouncements && this.legacyIsFresh()) out.push(...this.data.announcements.items);
    return dedupeAnnouncements(out);
  }

  /** The hand-written Announcements note counts only if it's stamped today (or has no readable stamp). */
  legacyIsFresh(): boolean {
    const d = stampDate(this.data.announcements.updated, isoDate());
    return d === undefined || d === isoDate();
  }

  /** When the front page's announcements were last written, for the small label above them. */
  announcementStamp(): string | undefined {
    const b = this.store.state.brief;
    if (b && b.date === isoDate()) return `Brief ${timeOfDay(new Date(b.generatedAt))}`;
    return this.legacyIsFresh() && this.data.announcements.updated ? `Updated ${this.data.announcements.updated}` : undefined;
  }

  // ── Vault events ──────────────────────────────────────────────────────────

  private registerVaultEvents() {
    const v = this.app.vault;
    const touch = (f: unknown) => {
      if (f instanceof TFile && f.extension === "md") this.data.schedule(f);
    };
    this.registerEvent(v.on("modify", touch));
    this.registerEvent(v.on("create", touch));
    this.registerEvent(
      v.on("delete", (f) => {
        if (f instanceof TFile) {
          this.data.remove(f.path);
          this.data.schedule(null);
        }
      })
    );
    this.registerEvent(
      v.on("rename", (f, old) => {
        this.data.remove(old);
        touch(f);
      })
    );
    // Frontmatter-driven tiles (weak spots) depend on the metadata cache.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.data.schedule(null, () => this.data.trigger("change"))));
    // Full recompute every 15 minutes, which also catches the midnight rollover.
    this.registerInterval(window.setInterval(() => void this.data.recomputeAll(), 15 * 60 * 1000));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** Write the default tabs layout. An existing file is backed up first, never silently lost. */
  async createLayoutFile() {
    const path = normalizePath(this.settings.layoutFile);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
    if (existing instanceof TFile) {
      const backup = `${path}.bak`;
      await this.app.vault.adapter.write(backup, await this.app.vault.read(existing));
      await this.app.vault.modify(existing, DEFAULT_LAYOUT_YAML);
      new Notice(`Layout reset to the default tabs. Your previous file is saved as ${backup}.`, 10_000);
    } else {
      await this.app.vault.create(path, DEFAULT_LAYOUT_YAML);
      new Notice(`Created ${path}`);
    }
    this.data.trigger("change");
  }

  async loadSettings() {
    const saved = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Before providers existed there was one `model` field, and it was always a Claude model.
    const models = { ...DEFAULT_MODELS, ...(saved.models ?? {}) };
    if (typeof saved.model === "string" && saved.model && !saved.models) models["claude-code"] = saved.model;
    this.settings.models = models;
    delete (this.settings as unknown as Record<string, unknown>).model;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.data.trigger("change");
  }
}
