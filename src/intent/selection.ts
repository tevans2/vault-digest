import type { Subject } from "./types";

/** What's currently selected on the dashboard. Survives re-renders; knows nothing about the DOM. */
export class SelectionStore {
  private items: Subject[] = [];
  private listeners = new Set<() => void>();

  get all(): readonly Subject[] {
    return this.items;
  }
  get size() {
    return this.items.length;
  }
  has(key: string): boolean {
    return this.items.some((s) => s.key === key);
  }

  /** Shift-click: add if absent, remove if present. */
  toggle(s: Subject) {
    this.items = this.has(s.key) ? this.items.filter((x) => x.key !== s.key) : [...this.items, s];
    this.emit();
  }
  remove(key: string) {
    if (!this.has(key)) return;
    this.items = this.items.filter((x) => x.key !== key);
    this.emit();
  }
  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }
}
