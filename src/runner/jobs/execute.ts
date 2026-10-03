import type { DigestStateV1, TriageItem } from "../../state/schema";
import type { Task } from "../../engine/collectors/tasks";
import type { Announcement } from "../../engine/collectors/announcements";
import { slug } from "../../engine/collectors/announcements";
import { BOUNDARY_RE } from "../../writers/journal";
import type { VaultWriter, Report } from "../../writers/writer";
import { applyBrief } from "./brief";
import { BriefResult, CloseResult, WeekResult, TriageCtx, planBrief, planClose, planTriage } from "./plan";

/** A failure the user should see as-is, not as an "internal error". */
export class ApplyError extends Error {
  constructor(message: string, public lines: string[] = []) {
    super(message);
  }
}

export interface ExecDeps {
  writer: VaultWriter;
  state: DigestStateV1;
  tasks: () => Task[];
  now: () => Date;
  /** The message channel, when it's in use. */
  messages?: {
    newPaths: () => Set<string>;
    mark: (path: string, status: "actioned" | "acknowledged" | "ignored", by: string, summary: string) => Promise<void>;
  };
}

async function markMessages(d: ExecDeps, plan: { valid: { path: string; disposition: "actioned" | "acknowledged" | "ignored"; summary: string }[]; rejected: string[] }, by: string): Promise<string[]> {
  const lines: string[] = plan.rejected.map((r) => `rejected: ${r}`);
  for (const m of plan.valid) {
    try {
      await d.messages?.mark(m.path, m.disposition, by, m.summary);
      lines.push(`message ${m.disposition}: ${m.path.split("/").pop()}`);
    } catch (e) {
      lines.push(`rejected: message ${m.path.split("/").pop()}: ${(e as Error).message}`);
    }
  }
  return lines;
}

export interface ExecReport {
  lines: string[];
}

const summarise = (rep: Report): string[] => [
  ...rep.applied.map((a) => `applied: ${a}`),
  ...rep.dropped.map((d) => `skipped: ${d}`),
  ...rep.rejected.map((r) => `rejected: ${r}`),
];

const toAnnouncements = (items: { id: string; level: string; text: string; topic?: string }[], source: string): Announcement[] => {
  const seen = new Set<string>();
  const out: Announcement[] = [];
  for (const a of items) {
    const id = `${source}:${slug(a.id) || slug(a.text)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, level: a.level as Announcement["level"], text: a.text, source, topic: a.topic as Announcement["topic"] });
  }
  return out;
};

export async function executeBrief(d: ExecDeps, result: BriefResult, date: string, runId: string, calendarChecked: boolean): Promise<ExecReport> {
  const plan = planBrief(result, { today: date, tasks: d.tasks(), calendarChecked, newMessages: d.messages?.newPaths() });
  const lines: string[] = [];

  // Authored state first, so the dashboard is right even if the journal can't be written.
  d.state.brief = applyBrief(result, date, d.now());
  if (plan.radar.length) d.state.radar = plan.radar;

  const j = await d.writer.writeJournal(date, plan.sections, runId);
  if (j.error) lines.push(`journal not written: ${j.error}`);
  else lines.push(`journal: updated ${j.changed.join(", ") || "nothing"}${j.skipped.length ? `; missing sections: ${j.skipped.join(", ")}` : ""}`);

  const rep = await d.writer.applyOps(plan.results, date, runId, { createsHandled: !j.error });
  lines.push(...summarise(rep), ...plan.resolveRejected.map((r) => `rejected: ${r}`));
  lines.push(...(await markMessages(d, plan.messages, "brief")));
  if (j.error) throw new ApplyError(j.error, lines);
  return { lines };
}

export async function executeClose(d: ExecDeps, result: CloseResult, date: string, tomorrow: string, runId: string): Promise<ExecReport> {
  const rawText = await d.writer.rawText(date);
  const plan = planClose(result, { today: date, tasks: d.tasks(), rawText, newMessages: d.messages?.newPaths() });
  const lines: string[] = [];

  d.state.close = {
    date,
    forDate: tomorrow,
    generatedAt: d.now().toISOString(),
    summary: result.summary,
    notes: result.notes.trim(),
    announcements: toAnnouncements(result.announcements, "close"),
  };

  const sp = await d.writer.spelling(date, result.rawEdits, runId);
  lines.push(`raw spelling: ${sp.applied.length} fixed, ${sp.rejected.length} left alone`);
  const j = await d.writer.writeJournal(date, plan.sections, runId);
  if (j.error) lines.push(`journal not written: ${j.error}`);
  const rep = await d.writer.applyOps(plan.results, date, runId, { createsHandled: !j.error });
  lines.push(...summarise(rep), ...plan.resolveRejected.map((r) => `rejected: ${r}`));
  lines.push(...(await markMessages(d, plan.messages, "close")));
  if (j.error) throw new ApplyError(j.error, lines);
  return { lines };
}

/** The week job only proposes: triage items wait for a click, and nothing in the vault is touched here. */
export function applyWeek(d: ExecDeps, result: WeekResult, ctx: TriageCtx, date: string, runId: string): ExecReport {
  const items = planTriage(result.triage, ctx, runId);
  d.state.week = {
    date,
    generatedAt: d.now().toISOString(),
    announcements: toAnnouncements(result.announcements, "week"),
    loadForecast: result.loadForecast,
    ruleViolations: result.ruleViolations,
  };
  d.state.triage = items;
  const pending = items.filter((i) => i.status === "pending").length;
  return { lines: [`triage: ${pending} proposals awaiting approval, ${items.length - pending} skipped`] };
}

/** Carry out one approved triage item, re-checking it against the vault as it is now. */
export async function approveTriage(d: ExecDeps, id: string, ctx: TriageCtx): Promise<TriageItem> {
  const item = d.state.triage.find((t) => t.id === id);
  if (!item) throw new Error("That proposal no longer exists.");
  if (item.status !== "pending") return item;
  // Re-validate: the vault may have changed since the week job ran.
  const [fresh] = planTriage([{ path: item.path, action: item.action, destination: item.destination, reason: item.reason }], ctx, item.runId);
  if (fresh.status !== "pending") {
    item.status = "failed";
    item.error = fresh.reason;
    return item;
  }
  try {
    if (item.action === "delete-empty") await d.writer.deleteEmptyStub(item.path, item.runId);
    else await d.writer.move(item.path, `${item.destination}/${item.path.split("/").pop()}`, item.runId);
    item.status = "done";
  } catch (e) {
    item.status = "failed";
    item.error = (e as Error).message;
  }
  return item;
}

export { BOUNDARY_RE };
