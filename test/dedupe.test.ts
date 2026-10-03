import { describe, expect, it } from "vitest";
import { dedupeAnnouncements, sameNotice, stampDate } from "../src/engine/dedupe";
import type { Announcement } from "../src/engine/collectors/announcements";

// The real texts from the dashboard on 3 Oct: yesterday's hand-written note and today's brief.
const LEGACY_CS345 = "**CS345 BPE DFA project (group, 40%) is due Mon 5 Oct, 14:00.** Three days. If you're in the coast this weekend, Sunday is the last full day. Repo state at the deadline is the submission.";
const BRIEF_CS345 = "CS345 BPE DFA project (40%) is due Mon 5 Oct 14:00. Calendar confirms it. Repo state on GitLab at the deadline is the submission, and about 43 hours remain.";
const BRIEF_LUNCH = "Alex's lunch is tomorrow (Sun 4 Oct) at 13:00. You still need a present, so buy it today.";
const BRIEF_INTERVIEW = "CS345 project interview is Mon 12 Oct at 16:15, the Monday after the deadline. It isn't on the calendar yet.";

const a = (id: string, text: string, level: Announcement["level"] = "soon", source = "brief"): Announcement => ({ id, level, text, source });

describe("sameNotice", () => {
  it("recognises the real duplicate: the same project deadline worded two ways", () => {
    expect(sameNotice(LEGACY_CS345, BRIEF_CS345)).toBe(true);
  });
  it("does not merge different things about the same course, or different dates", () => {
    expect(sameNotice(BRIEF_CS345, BRIEF_INTERVIEW)).toBe(false); // same course, a different event on a different day
    expect(sameNotice(BRIEF_CS345, BRIEF_LUNCH)).toBe(false);
    expect(sameNotice("CS343 Project 2 is due Tue 13 Oct, 17:00.", "CS345 Project is due Mon 5 Oct, 14:00.")).toBe(false);
  });
  it("matches near-identical wording", () => {
    expect(sameNotice("**No journal since Wed 30 Sep** (3 days).", "No journal since Wed 30 Sep (3 days)")).toBe(true);
  });
});

describe("dedupeAnnouncements", () => {
  it("keeps the first of each group, so the preferred source goes first", () => {
    const out = dedupeAnnouncements([a("brief:p", BRIEF_CS345, "urgent"), a("legacy-p", LEGACY_CS345, "soon", "legacy"), a("brief:l", BRIEF_LUNCH)]);
    expect(out.map((x) => x.id)).toEqual(["brief:p", "brief:l"]);
  });
  it("drops the same id twice, and never drops an error", () => {
    expect(dedupeAnnouncements([a("x", "one"), a("x", "two")])).toHaveLength(1);
    const err = (id: string) => a(id, "Brief failed at 07:00. socket closed", "error", "engine");
    expect(dedupeAnnouncements([err("e1"), err("e2")])).toHaveLength(2);
  });
  it("leaves genuinely different notices alone", () => {
    expect(dedupeAnnouncements([a("1", BRIEF_CS345), a("2", BRIEF_INTERVIEW), a("3", BRIEF_LUNCH)])).toHaveLength(3);
  });
});

describe("stampDate", () => {
  it("reads the old note's stamp", () => {
    expect(stampDate("Fri 2 Oct, 07:30", "2026-10-03")).toBe("2026-10-02");
    expect(stampDate("Sat 3 Oct, 19:00", "2026-10-03")).toBe("2026-10-03");
  });
  it("never reads a stamp as the future", () => {
    expect(stampDate("Mon 28 Dec, 07:00", "2027-01-02")).toBe("2026-12-28");
  });
  it("returns undefined when there's no date", () => {
    expect(stampDate(undefined, "2026-10-03")).toBeUndefined();
    expect(stampDate("recently", "2026-10-03")).toBeUndefined();
  });
});
