import type { Announcement, Topic } from "./collectors/announcements";

/**
 * Where an announcement is shown. The front page carries everything that needs action (urgent, soon,
 * stale, error). Info-level notices go to the tab for their topic; any that don't belong to an
 * available tab sit at the bottom of the front page's announcements.
 */
export const FRONT = "front";

export interface RouteCtx {
  /** Tab ids that exist in the current layout. */
  tabs: string[];
  /** Course codes, so "CS345 …" routes to Study. */
  courses: string[];
  /** Words that mean work in this vault, taken from the configured work folders (e.g. "Acme"). */
  workTerms?: string[];
}

const TOPIC_TAB: Record<Topic, string | null> = {
  study: "study",
  work: "work",
  week: "week",
  inbox: "inbox",
  assistant: "assistant",
  general: null,
};

function infer(text: string, courses: string[], workTerms: string[] = []): Topic {
  const t = text.toLowerCase();
  if (courses.some((c) => t.includes(c.toLowerCase()))) return "study";
  if (/\b(work|standup|client|meeting)\b/.test(t) || workTerms.some((w) => w.length > 2 && t.includes(w.toLowerCase()))) return "work";
  if (/\b(inbox|triage|captures?)\b/.test(t)) return "inbox";
  if (/\b(weekly review|forecast|duplicate|rule)\b/.test(t)) return "week";
  if (/\b(provider|model|dry-run|brief failed|prompt)\b/.test(t)) return "assistant";
  return "general";
}

/** "front" or the id of the tab this announcement belongs on. */
export function routeOf(a: Announcement, ctx: RouteCtx): string {
  if (a.level !== "info") return FRONT;
  const topic = a.topic ?? infer(a.text, ctx.courses, ctx.workTerms);
  const tab = TOPIC_TAB[topic];
  return tab && ctx.tabs.includes(tab) ? tab : FRONT;
}

export const forFront = (all: Announcement[], ctx: RouteCtx) => all.filter((a) => routeOf(a, ctx) === FRONT);
export const forTab = (all: Announcement[], tab: string, ctx: RouteCtx) => all.filter((a) => a.level === "info" && routeOf(a, ctx) === tab);
