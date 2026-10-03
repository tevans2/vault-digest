import type { Task } from "./tasks";

export const normalise = (s: string) =>
  s.toLowerCase().replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/[^a-z0-9]+/g, " ").trim();

/** Open tasks with identical normalised text and due date, across files. */
export function findDuplicates(tasks: Task[]): Task[][] {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.done) continue;
    const text = normalise(t.text);
    if (text.length < 6) continue;
    const key = `${text}|${t.due ?? ""}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
