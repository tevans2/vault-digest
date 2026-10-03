// Pure (no Obsidian imports) so the default layout can be tested.

export interface TileSpec {
  tile: string;
  span?: number;
  height?: number;
  cols?: number;
  /** radar: how many rows to show. */
  limit?: number;
  /** announcements / notices: "front" or a tab id. */
  scope?: string;
  /** No heading: for compact controls. */
  bare?: boolean;
  /** messages: hide the tile when there is nothing new. */
  hideEmpty?: boolean;
  [k: string]: unknown;
}

export interface TabSpec {
  id: string;
  title: string;
  tiles: TileSpec[];
}

/**
 * The front page holds only what needs you today. Everything else lives on a scoped tab.
 * Info-level notices go to the tab for their topic (see engine/routing.ts).
 */
export const DEFAULT_TABS: TabSpec[] = [
  {
    id: "today",
    title: "Today",
    tiles: [
      { tile: "capture", span: 9, bare: true },
      { tile: "run-bar", span: 3, bare: true },
      { tile: "announcements", span: 7, height: 240, scope: "front" },
      { tile: "radar", span: 5, height: 240, limit: 3 },
      { tile: "messages", span: 12, limit: 3, hideEmpty: true },
      { tile: "plan", span: 4, height: 340 },
      { tile: "timeline", span: 4, height: 340 },
      { tile: "today", span: 4, height: 340 },
      { tile: "close-form", span: 12 },
    ],
  },
  {
    id: "study",
    title: "Study",
    tiles: [
      { tile: "notices", span: 12, scope: "study" },
      { tile: "courses", span: 8, cols: 2 },
      { tile: "radar", span: 4 },
      { tile: "weak-spots", span: 12, height: 280 },
    ],
  },
  {
    id: "work",
    title: "Work",
    tiles: [
      { tile: "notices", span: 12, scope: "work" },
      { tile: "work", span: 8, height: 420 },
      { tile: "waiting", span: 4, height: 420 },
    ],
  },
  {
    id: "week",
    title: "Week",
    tiles: [
      { tile: "notices", span: 12, scope: "week" },
      { tile: "load", span: 12 },
      { tile: "week-review", span: 12 },
    ],
  },
  {
    id: "inbox",
    title: "Inbox",
    tiles: [
      { tile: "notices", span: 12, scope: "inbox" },
      { tile: "channel", span: 12 },
      { tile: "messages", span: 7, height: 520 },
      { tile: "triage", span: 5, height: 520 },
      { tile: "recent-inbox", span: 12, height: 320 },
    ],
  },
  {
    id: "assistant",
    title: "Assistant",
    tiles: [
      { tile: "notices", span: 12, scope: "assistant" },
      { tile: "actions", span: 7, height: 520 },
      { tile: "pa-status", span: 5, height: 520 },
      { tile: "calendar", span: 12 },
      { tile: "changes", span: 12, height: 320 },
    ],
  },
];

export const flow = (o: Record<string, unknown>) =>
  "{ " + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(", ") + " }";

/** The default layout as YAML, generated from DEFAULT_TABS so the file and the code can't drift apart. */
export function defaultLayoutYaml(): string {
  const out = [
    "# Vault Digest layout.",
    "# Each tab is a page of tiles on a 12-column grid. The first tab is the front page.",
    "# Tiles: capture (the command bar), run-bar, announcements, notices, radar, messages, plan, timeline, today, close-form,",
    "#        courses, weak-spots, work, waiting, load, week-review, channel, triage, recent-inbox,",
    "#        pa-status, actions, calendar, changes",
    "# Options: span (1-12), height (px, scrolls), cols (courses), limit (radar rows),",
    "#          scope (announcements/notices: front or a tab id), bare (no heading),",
    "#          hideEmpty (messages: hide when nothing is new)",
    "tabs:",
  ];
  for (const t of DEFAULT_TABS) {
    out.push(`  - id: ${t.id}`, `    title: ${t.title}`, "    tiles:");
    for (const tile of t.tiles) out.push(`      - ${flow(tile)}`);
  }
  return out.join("\n") + "\n";
}

export const DEFAULT_LAYOUT_YAML = defaultLayoutYaml();

