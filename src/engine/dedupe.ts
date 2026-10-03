import type { Announcement } from "./collectors/announcements";

/**
 * The same fact often arrives from two places: the brief says the project is due Monday 14:00, and so does an
 * older note or the engine. Show it once. The first one listed wins, so callers list the preferred source first.
 */

const MONTHS = new Set(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);
const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "in", "on", "at", "it", "you", "your", "for", "this", "that", "with", "be", "by", "as", "or", "so", "if", "was", "has", "have"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\*\*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

/** The words that pin a notice to a particular thing: a course code, a date, a time, a weight. */
function anchors(t: string[]): { codes: Set<string>; facts: Set<string> } {
  const codes = new Set(t.filter((x) => /^[a-z]{2}\d{3}$/.test(x)));
  const facts = new Set(t.filter((x) => /^\d{1,4}$/.test(x) || MONTHS.has(x)));
  return { codes, facts };
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

export function sameNotice(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const jaccard = overlap(sa, sb) / (sa.size + sb.size - overlap(sa, sb));
  if (jaccard >= 0.6) return true;
  // Same course and the same date/time facts, even if the surrounding words differ.
  const x = anchors(ta);
  const y = anchors(tb);
  const codes = overlap(x.codes, y.codes);
  const facts = overlap(x.facts, y.facts);
  return (codes >= 1 && facts >= 3) || (codes === 0 && x.codes.size === 0 && y.codes.size === 0 && facts >= 4 && jaccard >= 0.4);
}

/** Keep the first of each group of near-identical notices. Errors are never dropped. */
export function dedupeAnnouncements(list: Announcement[]): Announcement[] {
  const kept: Announcement[] = [];
  for (const a of list) {
    if (a.level !== "error" && kept.some((k) => k.id === a.id || (k.level !== "error" && sameNotice(k.text, a.text)))) continue;
    kept.push(a);
  }
  return kept;
}

/** "Fri 2 Oct, 07:30" → "2026-10-02". Undefined if it can't be read. */
export function stampDate(stamp: string | undefined, today: string): string | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3})/.exec(stamp ?? "");
  if (!m) return undefined;
  const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase());
  if (mi < 0) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  let year = Number(today.slice(0, 4));
  let iso = `${year}-${pad(mi + 1)}-${pad(Number(m[1]))}`;
  // A stamp can't be from the future: "28 Dec" read in January means last year.
  if (iso > today) iso = `${--year}-${pad(mi + 1)}-${pad(Number(m[1]))}`;
  return iso;
}
