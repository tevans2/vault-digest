import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_TABS, defaultLayoutYaml } from "../src/dashboard/layout-default";

const tileIds = new Set(
  readdirSync(join(__dirname, "../src/dashboard/tiles"))
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [...readFileSync(join(__dirname, "../src/dashboard/tiles", f), "utf8").matchAll(/\bid: "([\w-]+)"/g)].map((m) => m[1]))
);

describe("default layout", () => {
  it("round-trips through YAML so the file and the code can't drift", () => {
    expect(parse(defaultLayoutYaml()).tabs).toEqual(DEFAULT_TABS);
  });
  it("only uses tiles that exist", () => {
    const unknown = DEFAULT_TABS.flatMap((t) => t.tiles).map((t) => t.tile).filter((id) => !tileIds.has(id));
    expect(unknown).toEqual([]);
  });
  it("keeps the crucial controls on the front page", () => {
    const front = DEFAULT_TABS[0];
    expect(front.id).toBe("today");
    const ids = front.tiles.map((t) => t.tile);
    expect(ids).toEqual(expect.arrayContaining(["capture", "run-bar", "announcements", "plan", "timeline", "today"]));
    // and nothing from the scoped boards
    for (const heavy of ["courses", "weak-spots", "work", "waiting", "load", "triage", "recent-inbox", "pa-status", "changes"]) expect(ids).not.toContain(heavy);
  });
  it("has a tab for every announcement topic, each with its own notices tile", () => {
    for (const id of ["study", "work", "week", "inbox", "assistant"]) {
      const tab = DEFAULT_TABS.find((t) => t.id === id);
      expect(tab, id).toBeTruthy();
      expect(tab!.tiles.some((t) => t.tile === "notices" && t.scope === id), id).toBe(true);
    }
  });
  it("is a valid 12-column grid and has unique tab ids", () => {
    expect(new Set(DEFAULT_TABS.map((t) => t.id)).size).toBe(DEFAULT_TABS.length);
    for (const tab of DEFAULT_TABS) {
      for (const tile of tab.tiles) expect(tile.span ?? 12).toBeGreaterThanOrEqual(1);
      // each row of tiles adds up to a full 12 columns
      let sum = 0;
      for (const tile of tab.tiles) {
        sum += tile.span ?? 12;
        if (sum > 12) sum = tile.span ?? 12;
      }
      const rows: number[] = [];
      let acc = 0;
      for (const tile of tab.tiles) {
        const sp = tile.span ?? 12;
        if (acc + sp > 12) { rows.push(acc); acc = 0; }
        acc += sp;
      }
      rows.push(acc);
      expect(rows.every((r) => r === 12 || tab.tiles.some((t) => t.tile === "notices")), `${tab.id}: ${rows}`).toBe(true);
    }
  });
});
