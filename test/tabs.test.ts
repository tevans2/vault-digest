import { describe, expect, it } from "vitest";
import { routeOf, forFront, forTab } from "../src/engine/routing";
import { computeBadges } from "../src/dashboard/badges";
import { parseTasks } from "../src/engine/collectors/tasks";
import type { Announcement } from "../src/engine/collectors/announcements";

const ctx = { tabs: ["today", "study", "work", "week", "inbox", "assistant"], courses: ["CS345", "DS346"] };
const a = (over: Partial<Announcement>): Announcement => ({ id: "x", level: "info", text: "hello", source: "brief", ...over });

describe("announcement routing", () => {
  it("keeps everything that needs action on the front page", () => {
    for (const level of ["urgent", "soon", "stale", "error"] as const) expect(routeOf(a({ level, text: "CS345 thing" }), ctx)).toBe("front");
  });
  it("sends info to the topic tab, from an explicit topic or the text", () => {
    expect(routeOf(a({ topic: "week" }), ctx)).toBe("week");
    expect(routeOf(a({ text: "CS345 venue announced: K303" }), ctx)).toBe("study");
    expect(routeOf(a({ text: "Acme standup moved" }), ctx)).toBe("work"); // generic work words
    expect(routeOf(a({ text: "Initech invoice approved" }), { ...ctx, workTerms: ["Initech"] })).toBe("work"); // your own work folder names
    expect(routeOf(a({ text: "Initech invoice approved" }), ctx)).toBe("front");
    expect(routeOf(a({ text: "7 notes waiting in the inbox" }), ctx)).toBe("inbox");
  });
  it("leaves unplaceable info at the bottom of the front page", () => {
    expect(routeOf(a({ text: "Public holiday on Monday" }), ctx)).toBe("front");
    expect(routeOf(a({ topic: "general" }), ctx)).toBe("front");
  });
  it("falls back to the front page when the topic's tab doesn't exist", () => {
    expect(routeOf(a({ topic: "study" }), { ...ctx, tabs: ["today"] })).toBe("front");
  });
  it("front and tab lists never overlap and together cover everything", () => {
    const all = [a({ id: "1", level: "urgent" }), a({ id: "2", topic: "study" }), a({ id: "3", text: "misc" }), a({ id: "4", topic: "work" })];
    const front = forFront(all, ctx).map((x) => x.id);
    const study = forTab(all, "study", ctx).map((x) => x.id);
    const work = forTab(all, "work", ctx).map((x) => x.id);
    expect([...front, ...study, ...work].sort()).toEqual(["1", "2", "3", "4"]);
  });
});

describe("tab badges", () => {
  const tasks = [
    ...parseTasks("Notes/Courses/CS345/Hub.md", "## Tasks\n- [ ] late one 📅 2026-09-30\n- [ ] DS346 catch-up 📅 2026-10-01\n- [ ] future 📅 2026-10-20\n"),
    ...parseTasks("Areas/Work/CURRENT.md", "## Tasks\n- [ ] ship fix 📅 2026-10-01\n"),
  ];
  const base = { tasks, today: "2026-10-03", courses: ["CS345", "DS346"], workFolders: ["Areas/Work"], triagePending: 0, ruleViolations: 0, weekMissed: false, pendingResults: 0, runs: [] };
  it("counts overdue per area", () => {
    const b = computeBadges(base);
    expect(b.study).toEqual({ count: 2, level: "bad" });
    expect(b.work).toEqual({ count: 1, level: "bad" });
    expect(b.week).toBeUndefined();
    expect(b.assistant).toBeUndefined();
  });
  it("flags week, inbox and assistant problems", () => {
    const run = { id: "r", job: "brief", trigger: "manual", startedAt: "x", status: "failed", model: "m", attempts: 1, log: [] } as never;
    const b = computeBadges({ ...base, triagePending: 7, ruleViolations: 2, weekMissed: true, pendingResults: 1, runs: [run] });
    expect(b.inbox).toEqual({ count: 7, level: "warn" });
    expect(b.week).toEqual({ count: 3, level: "warn" });
    expect(b.assistant).toEqual({ count: 2, level: "bad" }); // a failed run makes it red
  });
});
