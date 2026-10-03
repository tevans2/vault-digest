import { BOUNDARY_RE } from "./journal";

/**
 * The only two ways the plugin ever writes below the RAW INPUT BOUNDARY:
 *  1. appending the user's own close-form answers (their words, via an explicit form submit)
 *  2. spelling-only fixes the close job proposes, each checked by `isSpellingOnly`
 */

export function appendRawBlock(text: string, block: string): { text: string; error?: string } {
  const lines = text.split("\n");
  const b = lines.findIndex((l) => BOUNDARY_RE.test(l));
  if (b < 0) return { text, error: "The RAW INPUT BOUNDARY marker is missing, so nothing was written." };
  const hasRaw = lines.slice(b).some((l) => /^##\s+Raw\s*$/.test(l));
  const base = text.replace(/\s+$/, "");
  return { text: `${base}${hasRaw ? "" : "\n\n## Raw"}\n\n${block.trim()}\n` };
}

/** Edit distance where swapping two adjacent letters costs one (the commonest typo). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const strip = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** Words whose change would alter the meaning, not just the spelling. */
const MEANING = new Set(["not", "no", "never", "nor", "dont", "didnt", "cant", "wont", "isnt", "wasnt", "cannot", "without", "yes"]);

/** Same words in the same order, each differing only by case, punctuation or a small typo. */
export function isSpellingOnly(find: string, replace: string): boolean {
  const a = find.trim().split(/\s+/);
  const b = replace.trim().split(/\s+/);
  if (a.length !== b.length || !find.trim()) return false;
  return a.every((w, i) => {
    if (w === b[i]) return true;
    const x = strip(w);
    const y = strip(b[i]);
    if (x === y) return true; // case or punctuation only
    if (!x || !y) return false;
    if (/\d/.test(x + y)) return false; // numbers and dates are never "spelling"
    if (MEANING.has(x) || MEANING.has(y)) return false;
    return distance(x, y) <= Math.min(2, Math.max(1, Math.floor(Math.max(x.length, y.length) / 3)));
  });
}

export interface SpellingEdit {
  find: string;
  replace: string;
}
export interface SpellingResult {
  text: string;
  applied: SpellingEdit[];
  rejected: { edit: SpellingEdit; reason: string }[];
}

/** Apply spelling fixes inside Raw only. Anything ambiguous, missing or more than spelling is rejected. */
export function applySpellingEdits(text: string, edits: SpellingEdit[]): SpellingResult {
  const lines = text.split("\n");
  const b = lines.findIndex((l) => BOUNDARY_RE.test(l));
  const applied: SpellingEdit[] = [];
  const rejected: SpellingResult["rejected"] = [];
  if (b < 0) return { text, applied, rejected: edits.map((edit) => ({ edit, reason: "RAW INPUT BOUNDARY marker is missing" })) };

  const head = lines.slice(0, b + 1).join("\n");
  let raw = lines.slice(b + 1).join("\n");
  for (const edit of edits) {
    if (!isSpellingOnly(edit.find, edit.replace)) {
      rejected.push({ edit, reason: "more than a spelling or punctuation fix" });
      continue;
    }
    const count = raw.split(edit.find).length - 1;
    if (count !== 1) {
      rejected.push({ edit, reason: count === 0 ? "text not found in Raw" : "text appears more than once in Raw" });
      continue;
    }
    raw = raw.replace(edit.find, () => edit.replace);
    applied.push(edit);
  }
  return { text: `${head}\n${raw}`, applied, rejected };
}
