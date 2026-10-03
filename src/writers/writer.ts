import type { VaultFs } from "./fs";
import type { WriteOp, WriteRecord } from "../state/schema";
import { hash } from "./hash";
import { BOUNDARY_RE, FALLBACK_TEMPLATE, JournalSections, appendToSection, createJournalText, renderJournal } from "./journal";
import { appendRawBlock, applySpellingEdits, SpellingEdit } from "./raw";
import { OpResult, TaskOp, formatTaskLine, hasDueMarker, locateLine } from "./tasks";
import { completeLine, redateLine } from "../engine/collectors/tasks";
import { patchTaskLine } from "../intent/taskline";
import type { TaskPatch } from "../intent/types";
import { addDays } from "../util/dates";
import { replaceRadarTable } from "./board";

export interface WriterConfig {
  journalPath(iso: string): string;
  /** Vault path of the daily template, if one is configured. */
  templatePath(): string | null;
  /** Moment-style formatter for template placeholders. */
  format(iso: string, pattern: string): string;
  /** Daily-note basename for a date (for the yesterday/tomorrow links). */
  journalName(iso: string): string;
  /** Find a course's hub note path, if it exists. */
  courseHub(code: string): string | null;
  record(rec: WriteRecord): void;
  now(): Date;
  uuid(): string;
}

export interface Report {
  applied: string[];
  dropped: string[];
  rejected: string[];
}

const TASKS_HEADING = /^##\s+Tasks\b/;
const ACTIONS_HEADING = /^##\s+Actions\b/;

/** Every vault edit goes through here, so every edit is guarded, atomic and logged. */
export class VaultWriter {
  constructor(private fs: VaultFs, private cfg: WriterConfig) {}

  private log(source: string, op: WriteOp, path: string, summary: string, before?: string, after?: string) {
    this.cfg.record({
      id: this.cfg.uuid(),
      at: this.cfg.now().toISOString(),
      source,
      op,
      path,
      summary,
      before: before === undefined ? undefined : hash(before),
      after: after === undefined ? undefined : hash(after),
    });
  }

  /** Create today's note from the daily template if it doesn't exist. Never overwrites. */
  async ensureJournal(iso: string, source: string): Promise<string> {
    const path = this.cfg.journalPath(iso);
    if (await this.fs.exists(path)) return path;
    const tplPath = this.cfg.templatePath();
    const template = tplPath && (await this.fs.exists(tplPath)) ? await this.fs.read(tplPath) : FALLBACK_TEMPLATE;
    const text = createJournalText(template, (f) => this.cfg.format(iso, f), {
      yesterday: this.cfg.journalName(addDays(iso, -1)),
      tomorrow: this.cfg.journalName(addDays(iso, 1)),
    });
    await this.fs.mkdirp(path.split("/").slice(0, -1).join("/"));
    await this.fs.create(path, text);
    this.log(source, "journal-create", path, "Created the daily note from the template", undefined, text);
    return path;
  }

  /** Write the generated sections. Returns an error string if the journal can't be written safely. */
  async writeJournal(iso: string, sections: JournalSections, source: string): Promise<{ path: string; changed: string[]; skipped: string[]; error?: string }> {
    const path = await this.ensureJournal(iso, source);
    let result: ReturnType<typeof renderJournal> | undefined;
    const { before, after } = await this.fs.modify(path, (text) => {
      result = renderJournal(text, sections);
      return result.error ? text : result.text; // on error: no change at all
    });
    if (result?.error) return { path, changed: [], skipped: [], error: result.error };
    if (before !== after) this.log(source, "journal-sections", path, `Updated ${result!.changed.join(", ")}`, before, after);
    return { path, changed: result!.changed, skipped: result!.skipped };
  }

  /** Append a task line to today's journal Actions, creating the note if needed. */
  private async appendJournalAction(iso: string, line: string, source: string): Promise<string> {
    const path = await this.ensureJournal(iso, source);
    let err: string | undefined;
    const { before, after } = await this.fs.modify(path, (text) => {
      const r = renderJournal(text, { actionsAppend: [line] });
      err = r.error;
      return r.error ? text : r.text;
    });
    if (err) throw new Error(err);
    if (before !== after) this.log(source, "actions-append", path, `Added task: ${line.slice(0, 80)}`, before, after);
    return path;
  }

  /** Create a task line in `path` (a note with a Tasks/Actions heading) or today's journal. */
  async createTask(
    text: string,
    due: string | undefined,
    where: { path?: string; iso: string },
    source: string,
    extra: { time?: string; calendar?: boolean | string } = {}
  ): Promise<{ path: string; line: string }> {
    // Dated tasks must carry the machine-readable marker or they are invisible to every engine.
    let target = where.path;
    const needsTag = !!target; // journal Actions and hub Tasks headings already count tasks
    let line = formatTaskLine(text, due, false, extra);
    if (due && !hasDueMarker(line)) throw new Error("a dated task must carry a 📅 marker");

    if (target && (await this.fs.exists(target))) {
      let placed = false;
      const { before, after } = await this.fs.modify(target, (t) => {
        const r = appendToSection(t, TASKS_HEADING, [line]) ?? appendToSection(t, ACTIONS_HEADING, [line]);
        if (!r) return t;
        placed = true;
        return r.text;
      });
      if (placed) {
        if (before !== after) this.log(source, "task-create", target, `Added task: ${line.slice(0, 80)}`, before, after);
        return { path: target, line };
      }
      // The note has no Tasks heading: fall back to the journal and tag it so engines still count it.
      line = formatTaskLine(text, due, true, extra);
    } else if (needsTag) {
      line = formatTaskLine(text, due, false, extra);
    }
    target = await this.appendJournalAction(where.iso, line, source);
    return { path: target, line };
  }

  /** Route a captured task: course hub if a course leads, otherwise today's journal. */
  async capture(text: string, due: string | undefined, course: string | undefined, iso: string, source = "user", extra: { time?: string; calendar?: boolean | string } = {}) {
    const hub = course ? this.cfg.courseHub(course) : null;
    return this.createTask(text, due, { path: hub ?? undefined, iso }, source, extra);
  }

  async redate(op: Extract<TaskOp, { op: "redate" }>, source: string): Promise<void> {
    let newLine = "";
    const { before, after } = await this.fs.modify(op.ref.path, (text) => {
      const lines = text.split("\n");
      const at = locateLine(lines, op.ref);
      if ("error" in at) throw new Error(at.error === "ambiguous" ? "that task line appears more than once" : "that task line has changed");
      newLine = redateLine(lines[at.index], op.due);
      lines[at.index] = newLine;
      return lines.join("\n");
    });
    this.log(source, "task-redate", op.ref.path, `Re-dated to ${op.due}: ${newLine.slice(0, 80)}`, before, after);
  }

  async complete(op: Extract<TaskOp, { op: "complete" }>, source: string): Promise<void> {
    if (!op.doneDate) throw new Error("completion needs the real date");
    let newLine = "";
    const { before, after } = await this.fs.modify(op.ref.path, (text) => {
      const lines = text.split("\n");
      const at = locateLine(lines, op.ref);
      if ("error" in at) throw new Error(at.error === "ambiguous" ? "that task line appears more than once" : "that task line has changed");
      newLine = completeLine(lines[at.index], op.doneDate!);
      lines[at.index] = newLine;
      return lines.join("\n");
    });
    this.log(source, "task-complete", op.ref.path, `Completed ✅ ${op.doneDate}: ${newLine.slice(0, 80)}`, before, after);
  }

  /** Edit one task line with a patch. Returns the line before and after, for the history and for undo. */
  async editTaskLine(ref: { path: string; line: number; expectedText: string }, patch: TaskPatch, today: string, source: string): Promise<{ before: string; after: string }> {
    let before = "";
    let after = "";
    const { before: b, after: a } = await this.fs.modify(ref.path, (text) => {
      const lines = text.split("\n");
      const at = locateLine(lines, ref);
      if ("error" in at) throw new Error(at.error === "ambiguous" ? "that task line appears more than once" : "that task has changed since you selected it");
      before = lines[at.index];
      const r = patchTaskLine(before, patch, today);
      if ("error" in r) throw new Error(r.error);
      after = r.line;
      lines[at.index] = after;
      return lines.join("\n");
    });
    this.log(source, "task-edit", ref.path, `${after.trim().slice(0, 90)}`, b, a);
    return { before, after };
  }

  /** Swap one exact line for another. Used to undo an edit; refuses if the line isn't there any more. */
  async replaceLine(path: string, expected: string, replacement: string, source: string): Promise<void> {
    const { before, after } = await this.fs.modify(path, (text) => {
      const lines = text.split("\n");
      const hits = lines.flatMap((l, i) => (l === expected ? [i] : []));
      if (hits.length !== 1) throw new Error(hits.length ? "that line appears more than once" : "that line has changed since");
      lines[hits[0]] = replacement;
      return lines.join("\n");
    });
    this.log(source, "task-undo", path, `Restored: ${replacement.trim().slice(0, 80)}`, before, after);
  }

  /** Remove one exact line (undoing a created task). Refuses if it isn't there exactly once. */
  async removeLine(path: string, line: string, source: string): Promise<void> {
    const { before, after } = await this.fs.modify(path, (text) => {
      const lines = text.split("\n");
      const hits = lines.flatMap((l, i) => (l === line ? [i] : []));
      if (hits.length !== 1) throw new Error(hits.length ? "that line appears more than once" : "that line has changed since");
      lines.splice(hits[0], 1);
      return lines.join("\n");
    });
    this.log(source, "task-undo", path, `Removed: ${line.trim().slice(0, 80)}`, before, after);
  }

  /** Apply validated ops. One failure never blocks the others. `skipCreate` leaves creates to the journal pass. */
  async applyOps(results: OpResult[], iso: string, source: string, opts: { createsHandled?: boolean } = {}): Promise<Report> {
    const rep: Report = { applied: [], dropped: [], rejected: [] };
    for (const r of results) {
      const desc = describeOp(r.op);
      if (r.verdict === "drop") {
        rep.dropped.push(`${desc}: ${r.reason}`);
        continue;
      }
      if (r.verdict === "reject") {
        rep.rejected.push(`${desc}: ${r.reason}`);
        continue;
      }
      const op = r.converted ?? r.op;
      try {
        if (op.op === "create") {
          if (opts.createsHandled) {
            rep.applied.push(desc);
            continue;
          }
          await this.createTask(op.text, op.due, { path: op.path, iso }, source, { time: op.time, calendar: op.calendar });
        } else if (op.op === "redate") await this.redate(op, source);
        else await this.complete(op, source);
        rep.applied.push(desc);
      } catch (e) {
        rep.rejected.push(`${desc}: ${(e as Error).message}`);
      }
    }
    return rep;
  }

  /** The user's own words from the close form. The only plain append below the boundary. */
  async appendRaw(iso: string, block: string, source = "user"): Promise<void> {
    const path = await this.ensureJournal(iso, source);
    let err: string | undefined;
    const { before, after } = await this.fs.modify(path, (t) => {
      const r = appendRawBlock(t, block);
      err = r.error;
      return r.error ? t : r.text;
    });
    if (err) throw new Error(err);
    this.log(source, "raw-append", path, "Added your close-form answers to Raw", before, after);
  }

  /** The text below the boundary (your Raw), or "" if there's no journal yet. */
  async rawText(iso: string): Promise<string> {
    const path = this.cfg.journalPath(iso);
    if (!(await this.fs.exists(path))) return "";
    const lines = (await this.fs.read(path)).split("\n");
    const b = lines.findIndex((l) => BOUNDARY_RE.test(l));
    return b < 0 ? "" : lines.slice(b + 1).join("\n").trim();
  }

  async spelling(iso: string, edits: SpellingEdit[], source: string) {
    const path = this.cfg.journalPath(iso);
    if (!edits.length || !(await this.fs.exists(path))) return { applied: [] as SpellingEdit[], rejected: [] as { edit: SpellingEdit; reason: string }[] };
    let out: ReturnType<typeof applySpellingEdits> | undefined;
    const { before, after } = await this.fs.modify(path, (t) => {
      out = applySpellingEdits(t, edits);
      return out.text;
    });
    if (before !== after) this.log(source, "raw-spelling", path, `Fixed spelling in Raw (${out!.applied.length})`, before, after);
    return { applied: out!.applied, rejected: out!.rejected };
  }

  /** Swap the hand-written radar table on the Task Board for the live pa-radar block. */
  async replaceBoardRadar(path: string, source = "user"): Promise<boolean> {
    if (!(await this.fs.exists(path))) throw new Error(`${path} doesn't exist`);
    let changed = false;
    const { before, after } = await this.fs.modify(path, (t) => {
      const out = replaceRadarTable(t);
      changed = out !== null;
      return out ?? t;
    });
    if (changed) this.log(source, "board-radar", path, "Replaced the radar table with a live pa-radar block", before, after);
    return changed;
  }

  // ── Inbox triage ──────────────────────────────────────────────────────────

  /** Move a note. Never overwrites, never leaves the vault, never touches journals or config. */
  async move(from: string, to: string, source: string): Promise<void> {
    assertMovable(from, to);
    if (!(await this.fs.exists(from))) throw new Error("the note no longer exists");
    if (await this.fs.exists(to)) throw new Error(`${to} already exists`);
    await this.fs.mkdirp(to.split("/").slice(0, -1).join("/"));
    await this.fs.rename(from, to);
    this.log(source, "triage-move", to, `Moved ${from} → ${to}`);
  }

  /** Delete only an empty Untitled* stub. Anything else is refused. */
  async deleteEmptyStub(path: string, source: string): Promise<void> {
    const name = path.split("/").pop() ?? "";
    if (!/^Untitled/i.test(name)) throw new Error("only empty Untitled* stubs may be deleted");
    const st = await this.fs.stat(path);
    if (!st) throw new Error("the note no longer exists");
    if (st.size !== 0) throw new Error("the note is no longer empty");
    await this.fs.trash(path);
    this.log(source, "triage-delete", path, `Moved empty stub to trash: ${path}`);
  }
}

export function assertMovable(from: string, to: string) {
  const bad = (p: string) => p.startsWith("/") || p.split("/").includes("..") || p.startsWith(".") || /^Journal\//.test(p) || /^\.?obsidian\//.test(p);
  if (bad(from) || bad(to)) throw new Error("that path is protected");
  if (!to.endsWith(".md") || !from.endsWith(".md")) throw new Error("only Markdown notes can be moved");
}

export function describeOp(op: TaskOp): string {
  if (op.op === "create") return `create "${op.text.slice(0, 60)}"${op.due ? ` 📅 ${op.due}` : ""}`;
  const t = op.ref.expectedText.replace(/^\s*- \[.\]\s*/, "").slice(0, 60);
  return op.op === "redate" ? `re-date "${t}" → ${op.due}` : `complete "${t}"${op.doneDate ? ` ✅ ${op.doneDate}` : ""}`;
}
