/** Parsing for `claude -p --output-format stream-json --verbose`. Pure; no Node or Obsidian imports. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StreamEvent = Record<string, any>;

export interface ClaudeResult {
  ok: boolean;
  structured?: unknown;
  text?: string;
  costUsd?: number;
  sessionId?: string;
  durationMs?: number;
  subtype?: string;
  apiErrorStatus?: number | null;
  error?: string;
}

export function parseLine(line: string): StreamEvent | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as StreamEvent;
  } catch {
    return null;
  }
}

const base = (p: unknown) => String(p ?? "").split("/").pop() ?? "";

/** A short human-readable progress line for a tool call, or undefined for noise. */
export function progressOf(ev: StreamEvent): string | undefined {
  if (ev.type !== "assistant") return undefined;
  for (const c of ev.message?.content ?? []) {
    if (c.type !== "tool_use") continue;
    const name: string = c.name ?? "";
    if (name === "StructuredOutput") return "Writing result…";
    if (/google_calendar/i.test(name)) return "Checking calendar…";
    if (name === "Read") return `Reading ${base(c.input?.file_path)}…`;
    if (name === "Grep" || name === "Glob") return "Searching the vault…";
    if (name === "Bash") return "Running a command…";
    return `Using ${name.replace(/^mcp__/, "")}…`;
  }
  return undefined;
}

export function resultOf(ev: StreamEvent): ClaudeResult | null {
  if (ev.type !== "result") return null;
  const isError = ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
  return {
    ok: !isError,
    structured: ev.structured_output,
    text: typeof ev.result === "string" ? ev.result : undefined,
    costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
    sessionId: ev.session_id,
    durationMs: ev.duration_ms,
    subtype: ev.subtype,
    apiErrorStatus: ev.api_error_status ?? null,
    error: isError ? (typeof ev.result === "string" && ev.result) || String(ev.subtype ?? "error") : undefined,
  };
}

/** If structured_output is absent, fall back to parsing the text result as JSON. */
export function structuredFrom(r: ClaudeResult): unknown {
  if (r.structured !== undefined) return r.structured;
  return jsonFromText(r.text);
}

/** Models sometimes wrap JSON in prose or fences; take the outermost object. */
export function jsonFromText(text: string | undefined): unknown {
  if (!text) return undefined;
  const t = text.trim();
  const attempts: string[] = [t];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) attempts.push(fenced[1]);
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) attempts.push(t.slice(a, b + 1));
  for (const x of attempts) {
    try {
      return JSON.parse(x);
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}
