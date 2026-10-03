import { parseDueText } from "../../util/dates";

export interface RadarRow {
  id: string;
  name: string;
  dueText: string;
  weightText: string;
  score?: number;
  days?: number;
  /** Live values, computed from the due text and weight against `now`. */
  dueAt?: number;
  weight?: number;
  hoursLeft?: number;
  liveScore?: number;
}

const clean = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

/** Parse the first markdown table under `## 📊 Deadline radar`. */
export function parseRadar(content: string): RadarRow[] {
  const start = content.search(/^##\s+.*Deadline radar/im);
  if (start < 0) return [];
  const rest = content.slice(start).split("\n").slice(1);
  const rows: RadarRow[] = [];
  let seenTable = false;

  for (const line of rest) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith("|")) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(clean);
    if (cells.length < 5) continue;
    if (/^score$/i.test(cells[0]) || /^[-: ]+$/.test(cells[0])) continue;
    const score = parseFloat(cells[0]);
    const days = parseInt(cells[4], 10);
    rows.push({
      id: cells[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48),
      name: cells[1],
      dueText: cells[2],
      weightText: cells[3] === "—" ? "" : cells[3],
      score: Number.isFinite(score) ? score : undefined,
      days: Number.isFinite(days) ? days : undefined,
    });
  }
  return rows;
}

const MIN_DAYS = 1 / 24;

/**
 * Score = weight ÷ days remaining, fractional so it ticks up through the day.
 * Rows we can't parse keep the table's own score/days. Past-due rows drop out.
 */
export function scoreRadar(rows: RadarRow[], today: string, now: number = Date.now()): RadarRow[] {
  const out: RadarRow[] = [];
  for (const r of rows) {
    const dueAt = r.dueAt ?? parseDueText(r.dueText, today);
    const w = r.weight ?? (/^\d+(\.\d+)?%?$/.test(r.weightText) ? parseFloat(r.weightText) : undefined);
    const live: RadarRow = { ...r, dueAt, weight: w };
    if (dueAt !== undefined) {
      const hours = (dueAt - now) / 3_600_000;
      if (hours < 0) continue;
      live.hoursLeft = hours;
      live.days = Math.ceil(hours / 24);
      if (w !== undefined) live.liveScore = w / Math.max(hours / 24, MIN_DAYS);
    } else if (r.score !== undefined) {
      live.liveScore = r.score;
    }
    out.push(live);
  }
  // Weighted first (highest score), then by nearest due.
  return out.sort(
    (a, b) =>
      (b.liveScore ?? -1) - (a.liveScore ?? -1) ||
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)
  );
}

export function countdown(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.ceil(hours / 24)}d`;
}

/** Authored radar items (from the brief) as rows, so one scoring path serves both sources. */
export function rowsFromItems(items: { id: string; name: string; due: string; weight?: number; course?: string; note?: string }[]): RadarRow[] {
  return items.map((i) => {
    const dueAt = Date.parse(i.due.includes("T") ? `${i.due}:00+02:00` : `${i.due}T23:59:00+02:00`);
    const label = new Intl.DateTimeFormat("en-ZA", {
      timeZone: "Africa/Johannesburg",
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(i.due.includes("T") ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
    }).format(new Date(dueAt));
    return {
      id: i.id,
      name: i.course ? `${i.course} · ${i.name}` : i.name,
      dueText: label,
      weightText: i.weight !== undefined ? String(i.weight) : "",
      weight: i.weight,
      dueAt: Number.isNaN(dueAt) ? undefined : dueAt,
    };
  });
}
