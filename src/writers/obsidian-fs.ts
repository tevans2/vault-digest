import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { FileInfo, VaultFs } from "./fs";

/** Obsidian-backed vault access. Edits are atomic (`vault.process`); moves keep links (`fileManager`). */
export class ObsidianFs implements VaultFs {
  constructor(private app: App) {}

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`No note at ${path}`);
    return f;
  }

  async exists(path: string) {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null || (await this.app.vault.adapter.exists(normalizePath(path)));
  }

  async read(path: string) {
    return this.app.vault.read(this.file(path));
  }

  async modify(path: string, fn: (text: string) => string) {
    const f = this.file(path);
    let before = "";
    let after = "";
    // vault.process re-reads the file inside its lock, so we never clobber a concurrent edit.
    await this.app.vault.process(f, (data) => {
      before = data;
      after = fn(data); // throwing here aborts the write
      return after;
    });
    return { before, after };
  }

  async create(path: string, text: string) {
    await this.app.vault.create(normalizePath(path), text);
  }

  async mkdirp(folder: string) {
    let acc = "";
    for (const part of normalizePath(folder).split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(acc)) await this.app.vault.createFolder(acc);
    }
  }

  async rename(from: string, to: string) {
    await this.app.fileManager.renameFile(this.file(from), normalizePath(to));
  }

  async trash(path: string) {
    await this.app.fileManager.trashFile(this.file(path));
  }

  async stat(path: string): Promise<FileInfo | null> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? { size: f.stat.size, ctime: f.stat.ctime, mtime: f.stat.mtime } : null;
  }

  async writeBinary(path: string, bytes: ArrayBuffer) {
    await this.app.vault.createBinary(normalizePath(path), bytes);
  }

  async readBinary(path: string) {
    return this.app.vault.readBinary(this.file(path));
  }

  async list(folder: string): Promise<string[]> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(folder));
    return f instanceof TFolder ? f.children.filter((c): c is TFile => c instanceof TFile).map((c) => c.path) : [];
  }

  folders(): string[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.path.startsWith(".") && f.path !== "/")
      .map((f) => f.path);
  }
}
