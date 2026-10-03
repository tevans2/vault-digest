import type { Announcement } from "./announcements";
import type { Task } from "./tasks";
import type { JournalSummary } from "./journal";
import type { RadarRow } from "./radar";
import { countdown } from "./radar";
import { daysBetween, shortDue } from "../../util/dates";

export interface StalenessInput {
  today: string;
  now: number;
  tasks: Task[];
  journal: JournalSummary;
  radar: RadarRow[]; // scored
  duplicates: Task[][];
  mtimeOf: (path: string) => number | undefined;
}

const DAY = 86_400_000;
const names = (ts: Task[], n = 2) => {
  const shown = ts.slice(0, n).map((t) => `“${t.text.length > 40 ? t.text.slice(0, 38) + "…" : t.text}”`);
  return shown.join(", ") + (ts.length > n ? ` and ${ts.length - n} more` : "");
};

/** Announcements the engine can produce on its own, with no model involved. */
export function engineAnnouncements(i: StalenessInput): Announcement[] {
  const out: Announcement[] = [];
  const add = (id: string, level: Announcement["level"], text: string, topic?: Announcement["topic"]) =>
    out.push({ id: `engine:${id}`, level, text, source: "engine", topic });
  const open = i.tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due && t.due < i.today);

  // Journal gap → everything below it is unverified.
  const gap = i.journal.gapDays;
  if (gap === null) {
    add("journal-none", "stale", "**No journal entries found.** Check the journal folder in settings.");
  } else if (gap >= 2) {
    const since = shortDue(i.journal.lastContentDate!);
    add(
      `journal-gap:${i.journal.lastContentDate}`,
      "stale",
      `**No journal since ${since}** (${gap} days).` +
        (overdue.length
          ? ` ${overdue.length} overdue ${overdue.length === 1 ? "task is" : "tasks are"} unverified, which isn't proof of slippage.`
          : "")
    );
  }

  // Deadlines inside 24h, live from the radar.
  for (const r of i.radar) {
    if (r.hoursLeft !== undefined && r.hoursLeft <= 24) {
      add(`radar:${r.id}`, "urgent", `**${r.name}** is due in ${countdown(r.hoursLeft)}.`);
    }
  }

  // Overdue for 3+ weeks: probably dead or forgotten.
  const ancient = overdue.filter((t) => daysBetween(t.due!, i.today) >= 21);
  if (ancient.length) {
    add("ancient", "stale", `**${ancient.length} overdue 3+ weeks:** ${names(ancient)}. Do them, re-date them or drop them.`);
  }

  // #waiting items whose note hasn't been touched in 14+ days.
  const quiet = open.filter((t) => {
    const m = t.waiting ? i.mtimeOf(t.path) : undefined;
    return m !== undefined && (i.now - m) / DAY >= 14;
  });
  if (quiet.length) {
    add("waiting-quiet", "stale", `**${quiet.length} waiting ${quiet.length === 1 ? "item" : "items"} quiet 14+ days:** ${names(quiet)}.`);
  }

  if (i.duplicates.length) {
    const first = i.duplicates[0][0];
    add(
      "duplicates",
      "info",
      `**${i.duplicates.length} possible duplicate ${i.duplicates.length === 1 ? "task" : "tasks"}**, e.g. “${first.text.slice(0, 50)}”. Carry forward by reference, not by copy.`,
      "week"
    );
  }
  return out;
}
