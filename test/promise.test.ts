import { describe, expect, it } from "vitest";
import { whenReady } from "../src/util/promise";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Mimics Obsidian 1.13+'s Setting: a builder whose `then` runs the callback with itself. */
function mockSetting() {
  const s = {
    thenCalls: 0,
    desc: "",
    setDesc(d: string) {
      s.desc = d;
      return s;
    },
    then(cb: (v: unknown) => unknown) {
      s.thenCalls++;
      if (s.thenCalls > 1000) throw new Error("infinite thenable loop");
      return cb(s);
    },
  };
  return s;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Setting thenable loop (Obsidian 1.13+)", () => {
  it("the naive pattern loops: returning a Setting from a promise callback never settles", async () => {
    const setting = mockSetting();
    // This is the bug. The guard stands in for the frozen window.
    Promise.resolve("found").then((f) => setting.setDesc(f)).catch(() => undefined);
    await flush();
    expect(setting.thenCalls).toBeGreaterThan(1000);
  });

  it("whenReady runs the effect and never touches the Setting's then", async () => {
    const setting = mockSetting();
    whenReady(Promise.resolve("/usr/local/bin/claude"), (f) => setting.setDesc(`Found at ${f}`));
    await flush();
    expect(setting.desc).toBe("Found at /usr/local/bin/claude");
    expect(setting.thenCalls).toBe(0);
  });

  it("whenReady survives a throwing effect and a rejected promise", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      whenReady(Promise.resolve(1), () => {
        throw new Error("boom");
      });
      whenReady(Promise.reject(new Error("nope")), () => undefined);
      await flush();
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(2);
  });
});

describe("source guard", () => {
  // Cheap tripwire: no `.then(` callback in the UI code may be a bare expression body that
  // could return a Setting/component. Use whenReady, or braces so nothing is returned.
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(__dirname, "../src/settings"));
  walk(join(__dirname, "../src/dashboard"));

  it("has no expression-bodied .then() callbacks in settings or dashboard code", () => {
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // `.then((x) => expr` without a `{` right after the arrow
        if (/\.then\(\s*(\(?[\w, ]*\)?)\s*=>\s*[^{\s]/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
