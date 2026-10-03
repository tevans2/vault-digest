import type { RunRecord } from "../state/schema";
import { isoDate, minutesOfDay } from "../util/dates";

export interface BriefSchedule {
  autoRun: boolean;
  /** "HH:MM" */
  time: string;
  weekdaysOnly: boolean;
}

export type Decision = { run: false; reason: string } | { run: true; trigger: "schedule" | "catch-up" };

const MAX_AUTO_FAILURES_PER_DAY = 2;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const CATCH_UP_AFTER_MIN = 60;

const parseHM = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 6 * 60 + 30;
};

/**
 * Should the brief run now? Pure: the plugin calls this every minute and on focus.
 * Never runs twice on one day once it has succeeded; backs off after failures.
 */
export function decideBrief(now: Date, runs: RunRecord[], s: BriefSchedule, busy: boolean): Decision {
  const dow = new Date(isoDate(now) + "T12:00:00Z").getUTCDay();
  return decideJob("brief", now, runs, { autoRun: s.autoRun, time: s.time, days: s.weekdaysOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6] }, busy, dow);
}

/** The weekly review: Sunday, first activity after the configured time. */
export function decideWeek(now: Date, runs: RunRecord[], s: { autoRun: boolean; time: string }, busy: boolean): Decision {
  const dow = new Date(isoDate(now) + "T12:00:00Z").getUTCDay();
  return decideJob("week", now, runs, { autoRun: s.autoRun, time: s.time, days: [0] }, busy, dow);
}

/** Was this week's review (since the last Sunday) missed? Used to offer it on Monday–Wednesday. */
export function weekMissed(now: Date, runs: RunRecord[]): boolean {
  const today = isoDate(now);
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  if (dow < 1 || dow > 3) return false;
  const sunday = new Date(Date.parse(today + "T00:00:00Z") - dow * 86_400_000).toISOString().slice(0, 10);
  return !runs.some((r) => r.job === "week" && r.status === "ok" && isoDate(new Date(r.startedAt)) >= sunday);
}

function decideJob(
  job: "brief" | "week",
  now: Date,
  runs: RunRecord[],
  s: { autoRun: boolean; time: string; days: number[] },
  busy: boolean,
  dow: number
): Decision {
  if (!s.autoRun) return { run: false, reason: "auto-run off" };
  if (busy) return { run: false, reason: "busy" };
  const today = isoDate(now);
  if (!s.days.includes(dow)) return { run: false, reason: "not a run day" };
  const start = parseHM(s.time);
  const mins = minutesOfDay(now);
  if (mins < start) return { run: false, reason: "before brief time" };

  const todays = runs.filter((r) => r.job === job && isoDate(new Date(r.startedAt)) === today);
  if (todays.some((r) => r.status === "ok" || r.status === "running")) return { run: false, reason: "already ran today" };
  // A rejected (invalid) result is a model problem, not a transient one: leave it to the user.
  if (todays.some((r) => r.status === "rejected")) return { run: false, reason: "rejected today; run manually" };

  const autoFails = todays.filter((r) => r.status === "failed" && r.trigger !== "manual");
  if (autoFails.length >= MAX_AUTO_FAILURES_PER_DAY) return { run: false, reason: "too many failures today" };
  const lastFail = autoFails[0];
  if (lastFail?.endedAt && now.getTime() - Date.parse(lastFail.endedAt) < RETRY_AFTER_FAILURE_MS) {
    return { run: false, reason: "backing off after a failure" };
  }
  return { run: true, trigger: mins - start >= CATCH_UP_AFTER_MIN || autoFails.length ? "catch-up" : "schedule" };
}

/** When will auto-run fire next? For the status tile. */
export function describeNextBrief(now: Date, s: BriefSchedule): string {
  if (!s.autoRun) return "Manual only";
  return `${s.time}${s.weekdaysOnly ? " weekdays" : " daily"}`;
}
