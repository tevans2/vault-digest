import type { Net } from "../messages/net";
import { redact } from "../messages/net";

/**
 * Google OAuth for a desktop app: authorization code with PKCE and a loopback redirect. The plugin never
 * sees your Google password. It stores one refresh token, in Obsidian's secret storage.
 */

export const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

export class AuthError extends Error {
  constructor(message: string, public kind: "config" | "denied" | "revoked" | "network" | "other") {
    super(redact(message));
  }
}

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export function buildAuthUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // so we get a refresh token
    prompt: "consent", // and Google always returns one, even on a repeat sign-in
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    state: o.state,
  });
  return `${AUTH}?${q.toString()}`;
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenCall(net: Net, form: Record<string, string>): Promise<TokenReply> {
  let res;
  try {
    res = await net(TOKEN, { method: "POST", body: new URLSearchParams(form).toString(), contentType: "application/x-www-form-urlencoded" });
  } catch (e) {
    throw new AuthError(`Couldn't reach Google: ${(e as Error).message}`, "network");
  }
  const j = (res.json ?? {}) as TokenReply;
  if (res.status === 200 && j.access_token) return j;
  if (j.error === "invalid_grant") throw new AuthError("Google no longer accepts the saved sign-in (it was revoked or expired). Connect again in settings.", "revoked");
  if (j.error === "invalid_client" || j.error === "unauthorized_client") throw new AuthError("Google rejected the client id or secret. Check them in settings.", "config");
  throw new AuthError(`Google sign-in failed: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`, "other");
}

export async function exchangeCode(net: Net, o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string }) {
  const j = await tokenCall(net, { grant_type: "authorization_code", client_id: o.clientId, client_secret: o.clientSecret, code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri });
  if (!j.refresh_token) throw new AuthError("Google didn't return a refresh token. Remove the app's access in your Google account and connect again.", "other");
  return { refreshToken: j.refresh_token, accessToken: j.access_token!, expiresIn: j.expires_in ?? 3600 };
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Hands out a valid access token, refreshing it a minute before it expires. */
export class GoogleAuth {
  private token: { value: string; expires: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private net: Net, private creds: () => Credentials | null, private now: () => number = Date.now) {}

  invalidate() {
    this.token = null;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expires - 60_000 > this.now()) return this.token.value;
    // Several requests at once share one refresh.
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const c = this.creds();
    if (!c?.clientId || !c.clientSecret) throw new AuthError("Add the Google client id and secret in settings.", "config");
    if (!c.refreshToken) throw new AuthError("Not connected to Google Calendar. Press Connect in settings.", "config");
    const j = await tokenCall(this.net, { grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken });
    this.token = { value: j.access_token!, expires: this.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
}
