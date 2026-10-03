export interface FileInfo {
  size: number;
  ctime: number;
  mtime: number;
}

/** The only vault operations the writers need. Obsidian implements it; tests use memory. */
export interface VaultFs {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Atomic read-modify-write. If `fn` throws, nothing is written and the error propagates. */
  modify(path: string, fn: (text: string) => string): Promise<{ before: string; after: string }>;
  create(path: string, text: string): Promise<void>;
  mkdirp(folder: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  stat(path: string): Promise<FileInfo | null>;
  /** Create a binary file (photos, voice notes). Fails if it already exists. */
  writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  /** File paths directly inside a folder (not recursive). Empty if the folder doesn't exist. */
  list(folder: string): Promise<string[]>;
}
