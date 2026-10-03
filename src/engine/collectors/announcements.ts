export type AnnouncementLevel = "urgent" | "soon" | "info" | "stale" | "error";

export type AnnouncementAction =
  | { kind: "run"; job: string; label: string }
  | { kind: "log"; runId: string; label: string }
  | { kind: "open"; path: string; label: string }
  | { kind: "fetch-messages"; label: string };

export const TOPICS = ["study", "work", "week", "inbox", "assistant", "general"] as const;
export type Topic = (typeof TOPICS)[number];

export interface Announcement {
  id: string;
  level: AnnouncementLevel;
  text: string;
  source: string; // "engine" | "brief" | "legacy" | …
  /** Which tab an info-level notice belongs on. Missing means infer it from the text. */
  topic?: Topic;
  actions?: AnnouncementAction[];
}

export interface AnnouncementBlock {
  updated?: string;
  items: Announcement[];
}

const LEVELS: [string, AnnouncementLevel][] = [
  ["🔴", "urgent"],
  ["🟠", "soon"],
  ["🟡", "soon"],
  ["⚠️", "stale"],
  ["⚠", "stale"],
  ["❌", "error"],
];

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/**
 * Parse the legacy Announcements.md note: bullets between the
 * `pa:announcements` markers, with a leading emoji as the level.
 */
export function parseAnnouncements(content: string): AnnouncementBlock {
  const m = /<!--\s*pa:announcements:start\s*-->([\s\S]*?)<!--\s*pa:announcements:end\s*-->/.exec(
    content
  );
  const body = m ? m[1] : "";
  const items: Announcement[] = [];
  let updated: string | undefined;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const u = /^\*Updated (.+?)\*$/.exec(line);
    if (u) {
      updated = u[1];
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (!b) continue;
    let text = b[1];
    let level: AnnouncementLevel = "info";
    for (const [emoji, lvl] of LEVELS) {
      if (text.startsWith(emoji)) {
        level = lvl;
        text = text.slice(emoji.length).trim();
        break;
      }
    }
    // Drop other leading emoji (🗓 etc.) from the text; level stays "info".
    text = text.replace(/^\p{Extended_Pictographic}️?\s*/u, "");
    items.push({ id: slug(text), level, text, source: "legacy" });
  }
  return { updated, items };
}
