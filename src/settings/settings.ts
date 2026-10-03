import { App, Notice, Platform, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type VaultDigestPlugin from "../main";
import { DEFAULT_MODELS, PROVIDERS, PROVIDER_LABELS, needsDesktop, type Provider } from "../runner/provider";
import { openRouterModels } from "../runner/backends/openrouter";
import { obsidianHttp } from "../runner/http";
import { whenReady } from "../util/promise";
import { testConnections } from "../messages/service";

export interface CourseConfig {
  code: string;
  title: string;
}

export interface DigestSettings {
  openOnStartup: boolean;
  replaceNewTab: boolean;
  courses: CourseConfig[];
  announcementsPath: string;
  taskBoardPath: string;
  stateFolder: string;
  layoutFile: string;
  workFolders: string[];
  quickLinks: { label: string; path: string }[];
  inboxFolder: string;
  inboxIgnore: string;
  recentFolders: string[];
  journalFolder: string; // empty = read from daily-notes core plugin
  journalFormat: string;
  paperName: string;
  /** Calendar aliases for #cal/alias, mapped to Google calendar ids. */
  calendarAliases: Record<string, string>;
  // Google Calendar
  googleClientIdSecret: string;
  googleClientSecretSecret: string;
  /** off: nothing. manual: preview, then you approve. auto: keep aligned on its own. */
  calendarSync: "off" | "manual" | "auto";
  /** The calendar #cal tasks go to: a name, an id, or "primary". */
  calendarDefault: string;
  calendarPollMin: number;
  // Messages (Telegram relay)
  messagesEnabled: boolean;
  relayUrl: string;
  /** Names of Obsidian secrets, never the secrets themselves. */
  relaySecret: string;
  botSecret: string;
  openaiSecret: string;
  messagesFolder: string;
  /** Only accept messages from this Telegram chat id. Empty = trust the relay. */
  messagesChatId: string;
  /** Import only messages on or after this date (YYYY-MM-DD). Empty = everything waiting. */
  messagesSince: string;
  messagesPollMin: number;
  /** Run each new message through the same instruction pipeline as the command bar. */
  messagesAutoProcess: boolean;
  transcribeVoice: boolean;
  transcribeModel: string;
  transcribeLanguage: string;
  describePhotos: boolean;
  visionModel: string;
  // AI provider
  provider: Provider;
  /** Each provider remembers its own model. Empty = that provider's default. */
  models: Record<Provider, string>;
  claudeBinary: string; // empty = auto-detect
  codexBinary: string;
  /** Tell Codex it has a Google Calendar plugin. Turn off if you remove the plugin. */
  codexCalendar: boolean;
  /** Name of the Obsidian secret holding the OpenRouter key (never the key itself). */
  openrouterSecret: string;
  fallbackModel: string; // Claude Code only
  effort: string;
  budgetUsd: number;
  timeoutMin: number;
  promptsFolder: string;
  // Engine
  dryRun: boolean;
  autoRun: boolean;
  briefTime: string;
  weekdaysOnly: boolean;
  closeTime: string;
  /** The tab last open, and the day it was chosen: each new day starts on the front page. */
  lastTab: string;
  lastTabDate: string;
  weekTime: string;
  showLegacyAnnouncements: boolean;
}

export const DEFAULT_SETTINGS: DigestSettings = {
  openOnStartup: true,
  replaceNewTab: true,
  // Personal to each vault, so empty until you add yours in settings.
  courses: [],
  // A hand-written notes page and a Task Board table are optional legacy sources; empty turns them off.
  announcementsPath: "",
  taskBoardPath: "",
  stateFolder: "Vault Digest",
  layoutFile: "Vault Digest/layout.yaml",
  workFolders: [],
  quickLinks: [],
  inboxFolder: "Inbox",
  inboxIgnore: "",
  recentFolders: [],
  journalFolder: "",
  journalFormat: "",
  paperName: "Vault Digest",
  calendarAliases: {},
  googleClientIdSecret: "google-client-id",
  googleClientSecretSecret: "google-client-secret",
  calendarSync: "manual",
  calendarDefault: "primary",
  calendarPollMin: 5,
  messagesEnabled: false,
  relayUrl: "",
  relaySecret: "telegram-relay-token",
  botSecret: "telegram-bot-token",
  openaiSecret: "openai-api-key",
  messagesFolder: "Inbox/messages",
  messagesChatId: "",
  messagesSince: "",
  messagesPollMin: 5,
  messagesAutoProcess: true,
  transcribeVoice: true,
  transcribeModel: "gpt-4o-mini-transcribe",
  transcribeLanguage: "en",
  describePhotos: true,
  visionModel: "gpt-4o-mini",
  provider: "claude-code",
  models: { ...DEFAULT_MODELS },
  claudeBinary: "",
  codexBinary: "",
  codexCalendar: true,
  openrouterSecret: "openrouter-api-key",
  fallbackModel: "",
  effort: "medium",
  budgetUsd: 0.5,
  timeoutMin: 6,
  promptsFolder: "Vault Digest/prompts",
  dryRun: true,
  autoRun: false,
  briefTime: "06:30",
  weekdaysOnly: true,
  closeTime: "18:00",
  lastTab: "",
  lastTabDate: "",
  weekTime: "10:00",
  showLegacyAnnouncements: true,
};

export class DigestSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultDigestPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl: el } = this;
    el.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };

    new Setting(el).setName("Dashboard").setHeading();
    new Setting(el)
      .setName("Masthead title")
      .setDesc("The name printed across the top of the dashboard.")
      .addText((t) =>
        t.setValue(s.paperName).onChange(async (v) => {
          s.paperName = v.trim() || DEFAULT_SETTINGS.paperName;
          await save();
        })
      );
    new Setting(el).setName("Open on startup").addToggle((t) =>
      t.setValue(s.openOnStartup).onChange(async (v) => {
        s.openOnStartup = v;
        await save();
      })
    );
    new Setting(el)
      .setName("Replace new tab")
      .setDesc("Show the dashboard instead of an empty new tab.")
      .addToggle((t) =>
        t.setValue(s.replaceNewTab).onChange(async (v) => {
          s.replaceNewTab = v;
          await save();
        })
      );
    new Setting(el)
      .setName("Layout file")
      .setDesc("YAML tabs and tiles. If the file is missing, the built-in tabs are used. “Create from default” writes the editable file (an existing one is backed up).")
      .addText((t) =>
        t.setValue(s.layoutFile).onChange(async (v) => {
          s.layoutFile = v.trim();
          await save();
        })
      )
      .addButton((b) =>
        b.setButtonText("Create from default").onClick(async () => {
          await this.plugin.createLayoutFile();
        })
      );

    this.renderProvider(el, save);

    new Setting(el)
      .setName("Prompts folder")
      .setDesc("system.md and brief.md live here. Created from the defaults on first run; edit them freely.")
      .addText((t) =>
        t.setValue(s.promptsFolder).onChange(async (v) => {
          s.promptsFolder = v.trim() || DEFAULT_SETTINGS.promptsFolder;
          await save();
        })
      );

    new Setting(el).setName("Engine").setHeading();
    new Setting(el)
      .setName("Dry-run")
      .setDesc("Hold each result in the Assistant tile until you press Apply.")
      .addToggle((t) =>
        t.setValue(s.dryRun).onChange(async (v) => {
          s.dryRun = v;
          await save();
        })
      );
    new Setting(el)
      .setName("Run the brief automatically")
      .setDesc("The first time Obsidian is active after the brief time. Off by default, so nothing spends money until you've checked a manual run.")
      .addToggle((t) =>
        t.setValue(s.autoRun).onChange(async (v) => {
          s.autoRun = v;
          await save();
        })
      );
    new Setting(el).setName("Brief time").setDesc("24h HH:MM").addText((t) =>
      t.setValue(s.briefTime).onChange(async (v) => {
        if (/^\d{1,2}:\d{2}$/.test(v.trim())) {
          s.briefTime = v.trim();
          await save();
        }
      })
    );
    new Setting(el).setName("Close the day prompt").setDesc("From this time the close form opens on the dashboard and you get one reminder. Close never runs by itself.").addText((t) =>
      t.setValue(s.closeTime).onChange(async (v) => {
        if (/^\d{1,2}:\d{2}$/.test(v.trim())) {
          s.closeTime = v.trim();
          await save();
        }
      })
    );
    new Setting(el).setName("Weekly review time").setDesc("Sunday, the first time Obsidian is active after this (when auto-run is on).").addText((t) =>
      t.setValue(s.weekTime).onChange(async (v) => {
        if (/^\d{1,2}:\d{2}$/.test(v.trim())) {
          s.weekTime = v.trim();
          await save();
        }
      })
    );
    new Setting(el).setName("Weekdays only").addToggle((t) =>
      t.setValue(s.weekdaysOnly).onChange(async (v) => {
        s.weekdaysOnly = v;
        await save();
      })
    );
    new Setting(el)
      .setName("Show legacy announcements")
      .setDesc("Keep showing the hand-written Announcements note beside the brief's own.")
      .addToggle((t) =>
        t.setValue(s.showLegacyAnnouncements).onChange(async (v) => {
          s.showLegacyAnnouncements = v;
          await save();
        })
      );

    this.renderMessages(el, save);
    this.renderCalendar(el, save);

    new Setting(el).setName("Paths").setHeading();
    const pathSetting = (
      name: string,
      desc: string,
      key: "announcementsPath" | "taskBoardPath" | "stateFolder" | "inboxFolder" | "inboxIgnore"
    ) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim();
            await save();
          })
        );
    pathSetting("Announcements note", "Read between the pa:announcements markers.", "announcementsPath");
    pathSetting("Task Board note", "The deadline radar table is read from here.", "taskBoardPath");
    pathSetting("State folder", "Where state.json will live.", "stateFolder");
    pathSetting("Inbox folder", "Shown in the Inbox view, oldest first.", "inboxFolder");
    pathSetting("Inbox ignore", "Subfolder skipped by the Inbox view.", "inboxIgnore");

    new Setting(el)
      .setName("Work folders")
      .setDesc("One per line. Open tasks in these folders appear under Work.")
      .addTextArea((t) =>
        t.setValue(s.workFolders.join("\n")).onChange(async (v) => {
          s.workFolders = v.split("\n").map((x) => x.trim()).filter(Boolean);
          await save();
        })
      );
    new Setting(el)
      .setName("Active courses")
      .setDesc("One per line as CODE | Title. Each gets a card; hub notes are found as “CODE Course Hub”.")
      .addTextArea((t) =>
        t
          .setValue(s.courses.map((c) => `${c.code} | ${c.title}`).join("\n"))
          .onChange(async (v) => {
            s.courses = v
              .split("\n")
              .map((l) => l.split("|").map((x) => x.trim()))
              .filter((p) => p[0])
              .map((p) => ({ code: p[0], title: p[1] ?? "" }));
            await save();
          })
      );
    new Setting(el)
      .setName("Quick links")
      .setDesc("One per line as Label | path/to/note.md")
      .addTextArea((t) =>
        t
          .setValue(s.quickLinks.map((l) => `${l.label} | ${l.path}`).join("\n"))
          .onChange(async (v) => {
            s.quickLinks = v
              .split("\n")
              .map((l) => l.split("|").map((x) => x.trim()))
              .filter((p) => p[0] && p[1])
              .map((p) => ({ label: p[0], path: p[1] }));
            await save();
          })
      );
  }

  /** Telegram relay → vault. Keys live in Obsidian's secret storage, never in this plugin's data. */
  private renderMessages(el: HTMLElement, save: () => Promise<void>) {
    const s = this.plugin.settings;
    new Setting(el).setName("Messages").setHeading();
    el.createDiv({
      cls: "setting-item-description",
      text: "Notes you send to your Telegram bot are fetched from the relay and saved in the vault, where the brief and close can read and act on them.",
    });

    new Setting(el)
      .setName("Receive messages")
      .addToggle((t) =>
        t.setValue(s.messagesEnabled).onChange(async (v) => {
          s.messagesEnabled = v;
          await save();
          this.display();
        })
      );
    if (!s.messagesEnabled) return;

    const hasSecrets = !!this.app.secretStorage;
    const secret = (name: string, desc: string, key: "relaySecret" | "botSecret" | "openaiSecret") =>
      new Setting(el)
        .setName(name)
        .setDesc(hasSecrets ? desc : "Needs Obsidian 1.11.4 or newer for secure key storage.")
        .addComponent((c) =>
          new SecretComponent(this.app, c).setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await save();
          })
        );

    new Setting(el)
      .setName("Relay URL")
      .setDesc("Your relay's address, like https://capture-relay-yourname.fly.dev. Must be https.")
      .addText((t) =>
        t.setPlaceholder("https://…").setValue(s.relayUrl).onChange(async (v) => {
          s.relayUrl = v.trim();
          await save();
        })
      );
    secret("Relay API token", "The relay's RELAY_API_TOKEN. Pick an existing secret or create one.", "relaySecret");
    secret("Telegram bot token", "Needed to download photos and voice notes (the relay only stores the message text). Optional: without it you still get the words.", "botSecret");
    secret("OpenAI key", "Used to transcribe voice notes and describe photos. Optional: without it voice notes are saved untranscribed.", "openaiSecret");

    new Setting(el)
      .setName("Your Telegram chat id")
      .setDesc("Only messages from this chat are imported. Strongly recommended. Leave empty to trust everything the relay forwards.")
      .addText((t) =>
        t.setValue(s.messagesChatId).onChange(async (v) => {
          s.messagesChatId = v.trim();
          await save();
        })
      );
    new Setting(el)
      .setName("Only import since")
      .setDesc("YYYY-MM-DD. Older messages waiting on the relay are cleared without being imported. Empty imports everything waiting, which may be a lot on a first run.")
      .addText((t) =>
        t.setPlaceholder("2026-10-01").setValue(s.messagesSince).onChange(async (v) => {
          if (!v.trim() || /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
            s.messagesSince = v.trim();
            await save();
          }
        })
      );
    new Setting(el).setName("Messages folder").addText((t) =>
      t.setValue(s.messagesFolder).onChange(async (v) => {
        s.messagesFolder = v.trim() || DEFAULT_SETTINGS.messagesFolder;
        await save();
      })
    );
    new Setting(el)
      .setName("Check every (minutes)")
      .setDesc("While Obsidian is open, and whenever you switch back to it.")
      .addText((t) =>
        t.setValue(String(s.messagesPollMin)).onChange(async (v) => {
          const n = parseFloat(v);
          if (n >= 1) {
            s.messagesPollMin = n;
            await save();
          }
        })
      );

    new Setting(el)
      .setName("Process new messages automatically")
      .setDesc("Each message is read like a command: “buy milk friday” becomes a task, “move the A1 prep to tuesday” edits it. Everything is logged and can be undone on the Assistant tab. Costs a few cents per message that needs the agent. Off leaves them for the brief and close.")
      .addToggle((t) =>
        t.setValue(s.messagesAutoProcess).onChange(async (v) => {
          s.messagesAutoProcess = v;
          await save();
        })
      );
    new Setting(el)
      .setName("Transcribe voice notes")
      .setDesc("OpenAI gpt-4o-mini-transcribe: about $0.003 a minute, handles Telegram's voice format, and works on mobile too.")
      .addToggle((t) =>
        t.setValue(s.transcribeVoice).onChange(async (v) => {
          s.transcribeVoice = v;
          await save();
        })
      );
    new Setting(el)
      .setName("Transcription model")
      .addText((t) =>
        t.setValue(s.transcribeModel).onChange(async (v) => {
          s.transcribeModel = v.trim() || DEFAULT_SETTINGS.transcribeModel;
          await save();
        })
      );
    new Setting(el)
      .setName("Language")
      .setDesc("A two-letter code like en. Empty lets the model detect it, which is slower and less accurate for short notes.")
      .addText((t) =>
        t.setValue(s.transcribeLanguage).onChange(async (v) => {
          s.transcribeLanguage = v.trim();
          await save();
        })
      );
    new Setting(el)
      .setName("Describe photos")
      .setDesc("A short description, including any visible text, so photos can be read and searched. A fraction of a cent each.")
      .addToggle((t) =>
        t.setValue(s.describePhotos).onChange(async (v) => {
          s.describePhotos = v;
          await save();
        })
      );

    new Setting(el)
      .setName("Test connections")
      .setDesc("Checks the relay, the bot token and the OpenAI key without sending anything.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true).setButtonText("Testing…");
          const lines = await testConnections(this.plugin);
          new Notice(lines.map((l) => `${l.ok ? "✓" : "✕"} ${l.text}`).join("\n"), 14_000);
          b.setDisabled(false).setButtonText("Test");
        })
      );
  }

  /** Google Calendar: your own OAuth client, one sign-in, and how tasks get onto the calendar. */
  private renderCalendar(el: HTMLElement, save: () => Promise<void>) {
    const s = this.plugin.settings;
    const cal = this.plugin.calendar;
    new Setting(el).setName("Google Calendar").setHeading();
    el.createDiv({
      cls: "setting-item-description",
      text: "Tasks you put on the calendar (tag #cal, or tell the command bar “calendar friday 2pm”) become events and stay aligned. The calendar wins on date and time; your notes win on the title and done.",
    });

    new Setting(el)
      .setName("Sync mode")
      .setDesc("Manual shows what would change and waits for you. Automatic keeps both sides aligned on its own.")
      .addDropdown((d) =>
        d
          .addOptions({ off: "Off", manual: "Manual (preview, then approve)", auto: "Automatic" })
          .setValue(s.calendarSync)
          .onChange(async (v) => {
            s.calendarSync = v as typeof s.calendarSync;
            await save();
          })
      );

    const details = el.createEl("details", { cls: "setting-item-description" });
    details.createEl("summary", { text: "One-time setup in Google Cloud (about 5 minutes)" });
    const ol = details.createEl("ol");
    for (const step of [
      "Open console.cloud.google.com, create a project, then APIs & Services → Library → enable “Google Calendar API”.",
      "OAuth consent screen: choose External, give it a name and your email, and add the scopes calendar.events and calendar.calendarlist.readonly.",
      "Set the publishing status to “In production”. Otherwise Google expires the sign-in every 7 days. For personal use no verification is needed, but sign-in shows an “unverified app” warning: choose Advanced, then continue.",
      "Credentials → Create credentials → OAuth client ID → application type “Desktop app”. Copy the client id and secret into the two secrets below.",
      "Press Connect.",
    ]) ol.createEl("li", { text: step });

    const hasSecrets = !!this.app.secretStorage;
    const secret = (name: string, key: "googleClientIdSecret" | "googleClientSecretSecret") =>
      new Setting(el)
        .setName(name)
        .setDesc(hasSecrets ? "Kept in Obsidian's secure storage." : "Needs Obsidian 1.11.4 or newer.")
        .addComponent((c) =>
          new SecretComponent(this.app, c).setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await save();
          })
        );
    secret("Google client id", "googleClientIdSecret");
    secret("Google client secret", "googleClientSecretSecret");

    const status = cal.connected ? `Connected${this.plugin.store.state.calendar.connectedAs ? ` as ${this.plugin.store.state.calendar.connectedAs}` : ""}.` : "Not connected.";
    new Setting(el)
      .setName("Connection")
      .setDesc(status)
      .addButton((b) => b.setButtonText(cal.connected ? "Reconnect" : "Connect").setCta().onClick(async () => {
        b.setDisabled(true);
        await cal.connect();
        b.setDisabled(false);
        this.display();
      }))
      .addButton((b) =>
        b.setButtonText("Disconnect").setDisabled(!cal.connected).onClick(async () => {
          await cal.disconnect();
          this.display();
        })
      );

    new Setting(el)
      .setName("Default calendar")
      .setDesc("Where #cal tasks go: a calendar's name, or “primary”.")
      .addText((t) =>
        t.setPlaceholder("primary").setValue(s.calendarDefault).onChange(async (v) => {
          s.calendarDefault = v.trim() || "primary";
          await save();
        })
      );
    new Setting(el)
      .setName("Calendar aliases")
      .setDesc("One per line as alias = calendar name. Then #cal/study or “calendar study” puts a task on that calendar. For example: study = Coursework")
      .addTextArea((t) =>
        t
          .setPlaceholder("study = Coursework\nwork = Work")
          .setValue(Object.entries(s.calendarAliases).map(([k, v]) => `${k} = ${v}`).join("\n"))
          .onChange(async (v) => {
            s.calendarAliases = Object.fromEntries(
              v.split("\n").map((l) => l.split("=").map((x) => x.trim())).filter((p) => p[0] && p[1] && /^[a-z][\w-]*$/i.test(p[0])).map((p) => [p[0].toLowerCase(), p[1]])
            );
            await save();
          })
      );
    new Setting(el).setName("Check every (minutes)").addText((t) =>
      t.setValue(String(s.calendarPollMin)).onChange(async (v) => {
        const n = parseFloat(v);
        if (n >= 1) {
          s.calendarPollMin = n;
          await save();
        }
      })
    );
    new Setting(el)
      .setName("Sync now")
      .addButton((b) =>
        b.setButtonText("Preview").onClick(async () => {
          b.setDisabled(true);
          await cal.sync({ apply: false });
          b.setDisabled(false);
        })
      )
      .addButton((b) =>
        b.setButtonText("Sync").setCta().onClick(async () => {
          b.setDisabled(true);
          await cal.sync({ apply: true });
          b.setDisabled(false);
        })
      );
  }

  /** Provider, model, credentials and limits: only the fields that apply to the chosen provider. */
  private renderProvider(el: HTMLElement, save: () => Promise<void>) {
    const s = this.plugin.settings;
    const p = s.provider;
    new Setting(el).setName("AI provider").setHeading();

    new Setting(el)
      .setName("Provider")
      .setDesc(
        p === "claude-code"
          ? "Uses your Claude Code login. The only provider that can read Google Calendar."
          : p === "codex"
            ? "Uses your Codex login. Reads the vault, and the calendar if you've added Codex's Google Calendar plugin."
            : "Any OpenRouter model. Works on mobile. Reads the vault; no calendar access."
      )
      .addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(PROVIDERS.map((x) => [x, PROVIDER_LABELS[x]])))
          .setValue(p)
          .onChange(async (v) => {
            s.provider = v as Provider;
            await save();
            this.display();
          })
      );
    if (needsDesktop(p) && !Platform.isDesktopApp) {
      el.createDiv({ cls: "setting-item-description", text: `${PROVIDER_LABELS[p]} needs the desktop app. Choose OpenRouter on mobile.` });
    }

    // Model: free text (any value the provider accepts) with suggestions.
    const listId = `vd-models-${p}`;
    const model = new Setting(el)
      .setName("Model")
      .setDesc(
        p === "claude-code"
          ? "Anything `claude --model` accepts: a full name or an alias like sonnet, opus or haiku."
          : p === "codex"
            ? "Anything `codex --model` accepts. Leave empty to use Codex's own default."
            : "An OpenRouter model id, like anthropic/claude-sonnet-5.5 or openai/gpt-5."
      );
    model.addText((t) => {
      t.setPlaceholder(DEFAULT_MODELS[p] || "default")
        .setValue(s.models[p])
        .onChange(async (v) => {
          s.models[p] = v.trim();
          await save();
        });
      const list = t.inputEl.parentElement?.createEl("datalist", { attr: { id: listId } });
      t.inputEl.setAttribute("list", listId);
      whenReady(this.suggestions(p), (items) => {
        items.forEach((m) => list?.createEl("option", { attr: { value: m } }));
      });
      if (p === "openrouter") {
        model.addButton((b) =>
          b.setButtonText("Load model list").onClick(async () => {
            const items = await openRouterModels(obsidianHttp).catch(() => []);
            list?.empty();
            items.forEach((m) => list?.createEl("option", { attr: { value: m } }));
            new Notice(items.length ? `Loaded ${items.length} models.` : "Couldn't load the model list.");
          })
        );
      }
    });

    if (p === "claude-code" || p === "codex") {
      const key = p === "claude-code" ? "claudeBinary" : "codexBinary";
      const bin = new Setting(el).setName(`${PROVIDER_LABELS[p]} binary`).setDesc("Checking…");
      bin.addText((t) =>
        t.setPlaceholder("auto").setValue(s[key]).onChange(async (v) => {
          s[key] = v.trim();
          await save();
        })
      );
      // Never return the Setting from a promise callback: see util/promise.ts.
      whenReady(this.plugin.detectBinary(p), (found) => {
        bin.setDesc(found ? `Found at ${found}` : "Not found. Install it, or enter its full path.");
      });
    }

    if (p === "codex") {
      new Setting(el)
        .setName("Codex has Google Calendar")
        .setDesc("Your Codex Google Calendar plugin is used for the timeline and deadline weights. Turn off if you remove it, so the brief doesn't expect it.")
        .addToggle((t) =>
          t.setValue(s.codexCalendar).onChange(async (v) => {
            s.codexCalendar = v;
            await save();
          })
        );
    }

    if (p === "openrouter") {
      const hasSecrets = !!this.app.secretStorage;
      new Setting(el)
        .setName("OpenRouter API key")
        .setDesc(
          hasSecrets
            ? "Kept in Obsidian's secure storage; only the secret's name is saved here. Pick an existing secret (another plugin's key works) or create one."
            : "Needs Obsidian 1.11.4 or newer for secure key storage."
        )
        .addComponent((c) =>
          new SecretComponent(this.app, c).setValue(s.openrouterSecret).onChange(async (v) => {
            s.openrouterSecret = v;
            await save();
          })
        );
    }

    new Setting(el).setName("Effort").setDesc(p === "claude-code" ? "How hard the model thinks." : "How hard the model thinks (low, medium or high).").addDropdown((d) =>
      d
        .addOptions(
          p === "claude-code"
            ? { "": "Default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }
            : { "": "Default", low: "Low", medium: "Medium", high: "High" }
        )
        .setValue(p !== "claude-code" && (s.effort === "xhigh" || s.effort === "max") ? "high" : s.effort)
        .onChange(async (v) => {
          s.effort = v;
          await save();
        })
    );
    if (p === "claude-code") {
      new Setting(el)
        .setName("Fallback model")
        .setDesc("Optional. Used if the main model is overloaded.")
        .addText((t) =>
          t.setValue(s.fallbackModel).onChange(async (v) => {
            s.fallbackModel = v.trim();
            await save();
          })
        );
    }
    if (p !== "codex") {
      new Setting(el)
        .setName("Budget per run (USD)")
        .setDesc(p === "claude-code" ? "Hard cap passed to Claude Code. A bare run costs about $0.05 before it does any work." : "The run stops once OpenRouter reports spend above this.")
        .addText((t) =>
          t.setValue(String(s.budgetUsd)).onChange(async (v) => {
            const n = parseFloat(v);
            if (n > 0) {
              s.budgetUsd = n;
              await save();
            }
          })
        );
    }
    new Setting(el).setName("Timeout (minutes)").addText((t) =>
      t.setValue(String(s.timeoutMin)).onChange(async (v) => {
        const n = parseFloat(v);
        if (n > 0) {
          s.timeoutMin = n;
          await save();
        }
      })
    );
    new Setting(el)
      .setName("Test connection")
      .setDesc("Sends a tiny request to confirm the provider, model and login work. Costs a fraction of a cent.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true).setButtonText("Testing…");
          await this.plugin.testConnection();
          b.setDisabled(false).setButtonText("Test");
        })
      );
  }

  private async suggestions(p: Provider): Promise<string[]> {
    if (p === "claude-code") {
      return ["sonnet", "opus", "haiku", "fable", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];
    }
    if (p === "codex" && Platform.isDesktopApp) {
      // Codex lists the models for this account in its own cache.
      try {
        const [{ readFileSync, existsSync }, { homedir }] = await Promise.all([import("fs"), import("os")]);
        const file = `${process.env.CODEX_HOME || `${homedir()}/.codex`}/models_cache.json`;
        if (!existsSync(file)) return [];
        const models = (JSON.parse(readFileSync(file, "utf8")) as { models?: { slug?: unknown; visibility?: unknown; priority?: unknown }[] }).models ?? [];
        return models
          .filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
          .sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99))
          .map((m) => m.slug as string);
      } catch {
        return [];
      }
    }
    return [];
  }
}
