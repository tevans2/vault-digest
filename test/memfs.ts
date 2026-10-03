import type { FileInfo, VaultFs } from "../src/writers/fs";

/** An in-memory vault for testing the writers, including their failure paths. */
export class MemFs implements VaultFs {
  files = new Map<string, string>();
  trashed: string[] = [];
  folders = new Set<string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async exists(p: string) {
    return this.files.has(p) || this.binaries.has(p) || this.folders.has(p);
  }
  async read(p: string) {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`ENOENT ${p}`);
    return t;
  }
  async modify(p: string, fn: (t: string) => string) {
    const before = await this.read(p);
    const after = fn(before); // throws → nothing written
    this.files.set(p, after);
    return { before, after };
  }
  async create(p: string, t: string) {
    if (this.files.has(p)) throw new Error(`exists ${p}`);
    this.files.set(p, t);
  }
  async mkdirp(f: string) {
    if (f) this.folders.add(f);
  }
  async rename(a: string, b: string) {
    this.files.set(b, await this.read(a));
    this.files.delete(a);
  }
  async trash(p: string) {
    this.trashed.push(p);
    this.files.delete(p);
  }
  binaries = new Map<string, ArrayBuffer>();
  async writeBinary(p: string, bytes: ArrayBuffer) {
    if (this.binaries.has(p) || this.files.has(p)) throw new Error(`exists ${p}`);
    this.binaries.set(p, bytes);
  }
  async readBinary(p: string) {
    const b = this.binaries.get(p);
    if (!b) throw new Error(`ENOENT ${p}`);
    return b;
  }
  async list(folder: string) {
    const pre = folder.replace(/\/+$/, "") + "/";
    const direct = (k: string) => k.startsWith(pre) && !k.slice(pre.length).includes("/");
    return [...this.files.keys(), ...this.binaries.keys()].filter(direct);
  }
  async stat(p: string): Promise<FileInfo | null> {
    const t = this.files.get(p);
    if (t !== undefined) return { size: t.length, ctime: 0, mtime: 0 };
    const b = this.binaries.get(p);
    return b ? { size: b.byteLength, ctime: 0, mtime: 0 } : null;
  }
}
