import { TFile, setIcon } from "obsidian";
import { TileType, empty, openPath } from "./common";
import { CaptureModal } from "./capture";
import type { MessageNote } from "../../messages/collect";
import { findUrls } from "../../messages/telegram";
import { ago } from "../../util/dates";
import { makeSelectable } from "../selectable";
import { messageSubject } from "../../intent/subjects";

const ICON: Record<string, string> = { text: "message-square", link: "link", photo: "image", voice: "mic", audio: "music", document: "file", video: "video", location: "map-pin", contact: "user", other: "message-square" };

/** Plain text with links made clickable. Message text is untrusted, so it's never rendered as markdown or HTML. */
function linkify(el: HTMLElement, text: string) {
  let rest = text;
  for (const url of findUrls(text)) {
    const i = rest.indexOf(url);
    if (i < 0) continue;
    if (i > 0) el.appendText(rest.slice(0, i));
    el.createEl("a", { text: url, href: url, attr: { target: "_blank", rel: "noopener noreferrer" } });
    rest = rest.slice(i + url.length);
  }
  if (rest) el.appendText(rest);
}

/** Connection health for the Telegram relay, with the actions that fix it. */
export const channel: TileType = {
  id: "channel",
  title: "Message channel",
  render(body, ctx) {
    const plugin = ctx.plugin;
    const svc = plugin.messages;
    const st = plugin.store.state.messages;

    if (!plugin.settings.messagesEnabled) {
      empty(body, "Off. Turn it on in Settings → Vault Digest → Messages to receive notes from your phone.");
      return;
    }
    const missing = svc.problems();
    if (missing.length) {
      body.createDiv({ cls: "vd-error", text: `Set ${missing.join(" and ")} in Settings → Vault Digest → Messages.` });
      return;
    }

    const line = body.createDiv({ cls: "vd-channel-line" });
    const healthy = !!st.lastOkAt && !st.lastError;
    line.createSpan({ cls: "vd-dot" + (healthy ? " is-ok" : st.lastError ? " is-bad" : "") });
    line.createSpan({
      text: st.lastOkAt ? `Fetched ${ago(Date.parse(st.lastOkAt))} ago${st.lastSummary ? ` · ${st.lastSummary}` : ""}` : "Not fetched yet",
    });
    if (st.relayPending) line.createSpan({ cls: "vd-chip is-today", text: `${st.relayPending} waiting on the relay` });
    if (st.lastError) body.createDiv({ cls: "vd-error", text: st.lastError });
    for (const w of svc.warnings()) body.createDiv({ cls: "vd-dateline", text: w });

    const row = body.createDiv({ cls: "vd-row" });
    const go = row.createEl("button", { text: svc.isBusy ? "Fetching…" : "Fetch now", cls: "vd-btn" });
    go.disabled = svc.isBusy;
    go.addEventListener("click", () => void svc.fetchNow());
    const retry = plugin.data.messageNotes.filter((m) => m.needsRetry).length;
    if (retry) {
      row.createEl("button", { text: `Retry ${retry} incomplete`, cls: "vd-btn" }).addEventListener("click", () => void svc.retry());
    }
  },
};

function card(ul: HTMLElement, m: MessageNote, ctx: Parameters<TileType["render"]>[1]) {
  const plugin = ctx.plugin;
  const li = ul.createEl("li", { cls: "vd-msg" + (m.status !== "new" ? " is-handled" : "") });
  if (m.status === "new") makeSelectable(li, messageSubject(m), plugin);
  const head = li.createDiv({ cls: "vd-msg-head" });
  setIcon(head.createSpan({ cls: "vd-msg-icon" }), ICON[m.kind] ?? "message-square");
  head.createSpan({ cls: "vd-faint", text: m.received ? `${ago(Date.parse(m.received))} ago` : "" });
  if (m.forwardedFrom) head.createSpan({ cls: "vd-chip", text: `from ${m.forwardedFrom}` });
  if (m.edited) head.createSpan({ cls: "vd-chip", text: "edited" });
  if (m.status !== "new") head.createSpan({ cls: "vd-chip", text: m.status });
  if (m.needsRetry) head.createSpan({ cls: "vd-chip is-today", text: "incomplete" });

  const text = li.createDiv({ cls: "vd-msg-text" });
  if (m.excerpt) linkify(text, m.excerpt);
  else text.createSpan({ cls: "vd-faint", text: m.kind === "voice" ? "Voice message, not transcribed yet." : `(${m.kind})` });

  for (const path of m.attachments.slice(0, 3)) {
    const f = ctx.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) continue;
    const src = ctx.app.vault.getResourcePath(f);
    if (/\.(jpe?g|png|webp|gif)$/i.test(path)) {
      const img = li.createEl("img", { cls: "vd-msg-img", attr: { src, alt: "Photo" } });
      img.addEventListener("click", () => void openPath(ctx.app, path));
    } else if (/\.(ogg|oga|opus|mp3|m4a|wav)$/i.test(path)) {
      li.createEl("audio", { cls: "vd-msg-audio", attr: { controls: "true", preload: "none", src } });
    }
  }

  const row = li.createDiv({ cls: "vd-msg-actions" });
  const btn = (label: string, fn: () => void) => row.createEl("button", { text: label, cls: "vd-btn" }).addEventListener("click", fn);
  if (m.status === "new") {
    btn("Task", () => new CaptureModal(ctx.app, plugin, { prefill: m.excerpt, onAdded: () => plugin.messages.mark(m.path, "actioned", "made a task") }).open());
    btn("Done", () => void plugin.messages.mark(m.path, "acknowledged"));
    btn("Ignore", () => void plugin.messages.mark(m.path, "ignored"));
  }
  btn("Open", () => void openPath(ctx.app, m.path));
}

/** Notes you sent from your phone. New ones first; handled ones tucked behind a toggle. */
export const messages: TileType = {
  id: "messages",
  title: "Messages",
  render(body, ctx) {
    const plugin = ctx.plugin;
    if (!plugin.settings.messagesEnabled) return ctx.hideTile();
    const all = plugin.data.messageNotes;
    const fresh = all.filter((m) => m.status === "new");
    if (!fresh.length && ctx.spec.hideEmpty) return ctx.hideTile();

    const limit = ctx.spec.limit ?? 30;
    const shown = (plugin.showHandledMessages ? all : fresh).slice(0, limit);
    if (!ctx.spec.limit) {
      const tabs = body.createDiv({ cls: "vd-tabs" });
      for (const [label, handled] of [[`New (${fresh.length})`, false], ["All", true]] as const) {
        const t = tabs.createEl("button", { text: label, cls: "vd-tab" + (plugin.showHandledMessages === handled ? " is-active" : "") });
        t.addEventListener("click", () => {
          plugin.showHandledMessages = handled;
          ctx.rerender();
        });
      }
    }
    if (!shown.length) return empty(body, "No new messages. Anything you send the bot appears here.");
    const ul = body.createEl("ul", { cls: "vd-msgs" });
    for (const m of shown) card(ul, m, ctx);
    if (ctx.spec.limit && fresh.length > limit) {
      body.createEl("a", { cls: "vd-more", text: `${fresh.length - limit} more in the Inbox tab` }).addEventListener("click", () => ctx.setTab("inbox"));
    }
  },
};
