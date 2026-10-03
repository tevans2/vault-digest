/** Read-only vault access for API backends. The model only sees notes through these three tools. */
export interface VaultReader {
  paths(): string[];
  read(path: string): Promise<string>;
}

export const VAULT_TOOLS = [
  {
    name: "list_notes",
    description: "List Markdown notes in the vault, optionally under a folder. Returns vault-relative paths.",
    input_schema: {
      type: "object" as const,
      properties: { folder: { type: "string", description: 'Vault-relative folder, e.g. "Notes/CS345". Omit for the whole vault.' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "search_notes",
    description: "Find notes containing all the given words (case-insensitive). Returns up to 15 paths with a short excerpt.",
    input_schema: { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "read_note",
    description: "Read one Markdown note by its vault-relative path.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
];

const MAX_NOTE = 60_000;

export async function runVaultTool(vault: VaultReader, name: string, input: unknown, exclude: string[] = []): Promise<string> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const visible = vault.paths().filter((p) => p.endsWith(".md") && !exclude.some((x) => p === x || p.startsWith(x + "/")));
  if (name === "list_notes") {
    const folder = typeof args.folder === "string" ? args.folder.replace(/^\/+|\/+$/g, "") : "";
    const found = visible.filter((p) => !folder || p.startsWith(folder + "/"));
    return found.length
      ? found.slice(0, 400).join("\n") + (found.length > 400 ? `\n…and ${found.length - 400} more. Narrow by folder.` : "")
      : "No notes found.";
  }
  if (name === "search_notes") {
    const words = (typeof args.query === "string" ? args.query : "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return "Give a query.";
    const hits: string[] = [];
    for (const path of visible) {
      const text = await vault.read(path);
      const lower = text.toLowerCase();
      if (!words.every((w) => lower.includes(w) || path.toLowerCase().includes(w))) continue;
      const at = Math.max(0, lower.indexOf(words[0]) - 80);
      hits.push(`${path}\n  …${text.slice(at, at + 220).replace(/\s+/g, " ")}…`);
      if (hits.length >= 15) break;
    }
    return hits.length ? hits.join("\n") : "No matching notes.";
  }
  if (name === "read_note") {
    const path = typeof args.path === "string" ? args.path : "";
    if (!visible.includes(path)) return `No note at "${path}". Use list_notes or search_notes to find paths.`;
    const text = await vault.read(path);
    return text.length > MAX_NOTE ? text.slice(0, MAX_NOTE) + "\n\n[Truncated: the note is longer than this.]" : text;
  }
  return `Unknown tool ${name}.`;
}
