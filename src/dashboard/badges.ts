import type { Task } from "../engine/collectors/tasks";
import type { RunRecord } from "../state/schema";

export interface Badge {
  count: number;
  /** "bad" = needs action now; "warn" = worth a look. */
  level: "bad" | "warn";
}

export interface BadgeInput {
  tasks: Task[];
  today: string;
  courses: string[];
  workFolders: string[];
  triagePending: number;
  /** New messages from the phone. */
  newMessages?: number;
  ruleViolations: number;
  weekMissed: boolean;
  pendingResults: number;
  runs: RunRecord[];
}

const matchesCourse = (t: Task, code: string) => t.path.includes(code) || new RegExp(`^\\W*${code}`).test(t.text);

/** Counts shown on tabs, so a problem is visible even when its detail is a click away. */
export function computeBadges(i: BadgeInput): Record<string, Badge | undefined> {
  const overdue = i.tasks.filter((t) => !t.done && t.due && t.due < i.today);
  const study = overdue.filter((t) => i.courses.some((c) => matchesCourse(t, c))).length;
  const folders = i.workFolders.map((f) => f.replace(/\/+$/, "") + "/");
  const work = overdue.filter((t) => folders.some((f) => t.path.startsWith(f))).length;
  const week = i.ruleViolations + (i.weekMissed ? 1 : 0);
  const lastRun = i.runs.find((r) => r.status !== "running" && r.status !== "cancelled");
  const failed = lastRun && (lastRun.status === "failed" || lastRun.status === "rejected") ? 1 : 0;
  const assistant = i.pendingResults + failed;

  const mk = (count: number, level: Badge["level"]): Badge | undefined => (count > 0 ? { count, level } : undefined);
  return {
    study: mk(study, "bad"),
    work: mk(work, "bad"),
    week: mk(week, "warn"),
    inbox: mk(i.triagePending + (i.newMessages ?? 0), "warn"),
    assistant: mk(assistant, failed ? "bad" : "warn"),
  };
}
