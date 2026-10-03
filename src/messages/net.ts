/** One HTTP interface for the relay, Telegram and OpenAI. Obsidian's requestUrl in the app, a fake in tests. */
export interface NetResponse {
  status: number;
  text: string;
  bytes: ArrayBuffer;
  json: unknown;
}

export interface NetRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** A string (JSON) or raw bytes (multipart). */
  body?: string | ArrayBuffer;
  contentType?: string;
}

export type Net = (url: string, req: NetRequest) => Promise<NetResponse>;

/** Strip anything that looks like a bot token or API key from text bound for logs, notices or notes. */
export function redact(s: string): string {
  return s
    .replace(/bot\d{6,}:[\w-]{20,}/g, "bot<token>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "<token>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-<key>")
    .replace(/Bearer\s+[\w.~+/-]+=*/gi, "Bearer <token>");
}
