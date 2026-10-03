import { App, normalizePath } from "obsidian";

import { DigestStateV1, coerceState, emptyState } from "./schema";

export class StateStore {
  state: DigestStateV1 = emptyState();
  private saving: Promise<void> = Promise.resolve();

  constructor(private app: App, private folder: () => string) {}

  private get path() {
    return normalizePath(`${this.folder()}/state.json`);
  }

  async load() {
    const a = this.app.vault.adapter;
    try {
      if (await a.exists(this.path)) {
        this.state = coerceState(JSON.parse(await a.read(this.path)));
      }
    } catch (e) {
      console.warn("[vault-digest] could not read state.json, starting fresh", e);
      this.state = emptyState();
    }
  }

  /** Atomic write: temp file then rename. Serialised so writes never interleave. */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const a = this.app.vault.adapter;
      this.state.updatedAt = new Date().toISOString();
      const tmp = this.path + ".tmp";
      try {
        const dir = normalizePath(this.folder());
        if (!(await a.exists(dir))) await a.mkdir(dir);
        await a.write(tmp, JSON.stringify(this.state, null, 2));
        if (await a.exists(this.path)) await a.remove(this.path);
        await a.rename(tmp, this.path);
      } catch (e) {
        console.error("[vault-digest] failed to save state", e);
      }
    });
    return this.saving;
  }

  isHidden(id: string, now = new Date()): boolean {
    if (this.state.interactions.acks[id]) return true;
    const until = this.state.interactions.snoozes[id];
    return !!until && new Date(until) > now;
  }

  ack(id: string) {
    this.state.interactions.acks[id] = new Date().toISOString();
    return this.save();
  }

  snooze(id: string, until: Date) {
    this.state.interactions.snoozes[id] = until.toISOString();
    return this.save();
  }

  clearInteractions() {
    this.state.interactions = { acks: {}, snoozes: {} };
    return this.save();
  }
}
