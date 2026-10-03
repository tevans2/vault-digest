# Vault Digest

An [Obsidian](https://obsidian.md) plugin that turns a vault into a live personal dashboard, with an assistant that does the tidying. It shows what needs you today, takes short instructions about whatever you point at, and keeps tasks, messages from your phone, and Google Calendar in step.

> Status: a personal project, built in the open. It works, but expect rough edges.

## What it does

- **A dashboard in tabs.** A slim front page (command bar, announcements, plan, timeline, today's tasks, deadline radar) and scoped boards for Study, Work, the week ahead, the Inbox, and the Assistant.
- **Select, then say.** Shift-click any task, deadline, message or notice (one or many), then type a short instruction: `next tues`, `done`, `waiting on sam`, `push 3 days`, `calendar friday 2pm`. Predictable instructions are understood locally and instantly. Anything else goes to an agent that is handed your selection, so it never has to guess what you meant.
- **Works from any note.** An Obsidian command opens the same bar anywhere. It picks up the note you have open, the text you highlighted, or the task under your cursor.
- **Every change is logged and undoable.** The Assistant tab keeps a history of what each instruction did, with an Undo on each entry. Nothing is deleted: removing a task marks it cancelled.
- **An assistant that reads and plans.** A morning *brief*, an evening *close* and a *weekly review* run through Claude Code, Codex or any OpenRouter model. The model proposes; the plugin validates and writes. Rules such as "never write below the raw-input boundary" and "don't duplicate tasks" are enforced in code, not left to a prompt.
- **A message channel from your phone.** Send text, photos and voice notes to a Telegram bot. They are fetched from a relay, saved as notes (voice notes transcribed with OpenAI), and handled by the same instruction pipeline.
- **Google Calendar kept aligned.** Tasks you choose to put on the calendar (`#cal`) become events and stay in step. The calendar wins on date and time; your notes win on the title and done state.

## Requirements

- Obsidian 1.11.4 or newer (for secure secret storage).
- For the assistant: [Claude Code](https://docs.claude.com/claude-code), [Codex](https://github.com/openai/codex), or an [OpenRouter](https://openrouter.ai) key. Claude Code and Codex need the desktop app; OpenRouter also works on mobile.
- Optional: a Telegram relay (see [docs/relay-api.md](docs/relay-api.md)), an OpenAI key for transcription, and a Google account for calendar sync (see [docs/google-calendar-setup.md](docs/google-calendar-setup.md)).

## Install

Releases attach `main.js`, `manifest.json` and `styles.css`. Put them in `<vault>/.obsidian/plugins/vault-digest/` and enable the plugin.

To build from source:

```bash
npm install
npm run build        # one-off build
npm run dev          # rebuild on change
npm run link -- /path/to/your/vault   # symlink into a vault for development
```

## Setting it up

1. **Open Settings → Vault Digest.** Choose an AI provider and model, then press **Test**.
2. **Layout.** The dashboard works out of the box. "Create from default" writes an editable `layout.yaml`.
3. **Hotkey.** Bind a key to *Vault Digest: Command bar* in Settings → Hotkeys.
4. **Messages and calendar** are optional and off by default; each has its own settings section and guide.

Credentials are held in Obsidian's secret storage. The plugin stores only the *names* of secrets in its own data, never the values.

## How it is built

```
src/
  dashboard/   tabbed view, tiles, command bar, selection
  intent/      the grammar, the agent fallback, apply and undo
  runner/      Claude Code, Codex and OpenRouter backends, jobs, prompts
  writers/     the only code that edits notes (journal, tasks, raw, board)
  messages/    relay client, Telegram parsing, transcription, note format
  calendar/    sync engine, Google API client, OAuth
  engine/      collectors: tasks, journal, radar, staleness, announcements
test/          unit tests, including failure paths, using fakes for the network and the vault
docs/          GitHub Pages site and setup guides
```

A few design rules run through it: the model proposes and the plugin writes; every write goes through one guarded, atomic, logged path; anything uncertain is skipped and reported rather than guessed; and the pure logic (parsing, planning, merging) has no Obsidian imports so it can be tested without the app.

```bash
npm test             # run the tests
npm run build        # type-check and bundle
```

## Known limitations

- Dates and times are fixed to **Africa/Johannesburg** (UTC+2, no daylight saving) in the dashboard, the prompts and the calendar sync. Making the timezone a setting is the next generalisation.
- Calendar connecting and the Claude Code and Codex providers are desktop-only.
- Recurring tasks and multi-day calendar events aren't synced to the calendar.

## Privacy

Everything runs on your own device. The plugin talks directly to the services you configure (your AI provider, your relay, Google). Nothing is sent to the author. See the [privacy policy](docs/privacy.html).

## Licence

[MIT](LICENSE)
