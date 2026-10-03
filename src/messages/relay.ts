import type { Net } from "./net";
import { redact } from "./net";

/** A stored Telegram update, as the relay returns it. */
export interface RelayItem {
  relay_id: number;
  update_id: number;
  chat_id: string | number | null;
  message_id: number | null;
  received_at: string;
  status: string;
  error?: string | null;
  update: Record<string, unknown>;
}

export type RelayErrorKind = "config" | "auth" | "network" | "server";

export class RelayError extends Error {
  constructor(message: string, public kind: RelayErrorKind) {
    super(redact(message));
  }
}

export interface RelayStats {
  pending: number;
  done: number;
  failed: number;
}

/** Normalise and sanity-check the relay URL. Plain http is only allowed for localhost. */
export function normaliseBase(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!u) throw new RelayError("No relay URL is set. Add it in settings.", "config");
  if (!/^https:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u)) {
    throw new RelayError("The relay URL must start with https://", "config");
  }
  return u;
}

export class RelayClient {
  constructor(private net: Net, private base: string, private token: () => string | null) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = this.token();
    if (!token) throw new RelayError("No relay API token is set. Add it in settings.", "config");
    let res;
    try {
      res = await this.net(`${normaliseBase(this.base)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "vault-digest/0.1" },
        ...(body !== undefined ? { body: JSON.stringify(body), contentType: "application/json" } : {}),
      });
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw new RelayError(`Couldn't reach the relay: ${(e as Error).message}`, "network");
    }
    if (res.status === 401 || res.status === 403) throw new RelayError("The relay rejected the API token.", "auth");
    if (res.status >= 500) throw new RelayError(`The relay had a problem (HTTP ${res.status}).`, "server");
    if (res.status !== 200) throw new RelayError(`Unexpected relay response (HTTP ${res.status}).`, "server");
    const json = res.json;
    if (!json || typeof json !== "object") throw new RelayError("The relay returned something that isn't JSON.", "server");
    return json as Record<string, unknown>;
  }

  /** Oldest first, as the relay orders them. */
  async pending(limit = 50): Promise<RelayItem[]> {
    const r = await this.call("GET", `/api/captures?status=pending&limit=${Math.max(1, Math.min(limit, 100))}`);
    const items = Array.isArray(r.captures) ? r.captures : [];
    return items.filter((x): x is RelayItem => !!x && typeof x === "object" && typeof (x as RelayItem).relay_id === "number" && typeof (x as RelayItem).update === "object");
  }

  async ack(relayId: number, status: "done" | "failed" | "pending", error?: string): Promise<void> {
    await this.call("POST", `/api/captures/${relayId}/ack`, { status, error: error ? redact(error).slice(0, 400) : null });
  }

  async stats(): Promise<RelayStats> {
    const r = await this.call("GET", "/api/stats");
    const c = (r.counts && typeof r.counts === "object" ? r.counts : {}) as Record<string, number>;
    return { pending: c.pending ?? 0, done: c.done ?? 0, failed: c.failed ?? 0 };
  }
}
