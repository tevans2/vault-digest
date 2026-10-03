import { parseYaml } from "obsidian";
import type { TabSpec, TileSpec } from "./layout-default";

export { DEFAULT_TABS, DEFAULT_LAYOUT_YAML, defaultLayoutYaml } from "./layout-default";
export type { TabSpec, TileSpec } from "./layout-default";

export interface LayoutFile {
  tabs: TabSpec[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse and sanitise. Returns null if the file isn't a usable tabs layout. */
export function parseLayout(text: string): LayoutFile | null {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || !Array.isArray(raw.tabs)) return null;
  const tabs: TabSpec[] = [];
  for (const t of raw.tabs) {
    if (!isObj(t) || typeof t.id !== "string" || !Array.isArray(t.tiles)) continue;
    const tiles = t.tiles.filter((x): x is TileSpec => isObj(x) && typeof x.tile === "string");
    tabs.push({ id: t.id, title: typeof t.title === "string" ? t.title : t.id, tiles });
  }
  return tabs.length ? { tabs } : null;
}

/** The previous single-page format (profiles). Detected so we can say so rather than silently ignore it. */
export function isLegacyLayout(text: string): boolean {
  try {
    const raw = parseYaml(text);
    return isObj(raw) && isObj(raw.profiles) && !Array.isArray(raw.tabs);
  } catch {
    return false;
  }
}
