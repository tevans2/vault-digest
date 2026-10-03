import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { GoogleCalendar, ApiError, toEvent } from "../src/calendar/api";
import { GoogleAuth, AuthError, buildAuthUrl, exchangeCode, makePkce, SCOPES } from "../src/calendar/oauth";
import { startLoopback } from "../src/calendar/loopback";
import type { Net, NetRequest } from "../src/messages/net";

const res = (status: number, json: unknown = {}) => ({ status, json, text: JSON.stringify(json), bytes: new ArrayBuffer(0) });
const creds = { clientId: "cid", clientSecret: "sec", refreshToken: "rtok" };

describe("PKCE and the auth URL", () => {
  it("makes a challenge that is the SHA-256 of the verifier", async () => {
    const { verifier, challenge } = await makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
  it("asks for offline access, the narrow calendar scopes, and PKCE", () => {
    const u = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", challenge: "ch", state: "st" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(u.searchParams.get("scope")).not.toMatch(/auth\/calendar$/); // not full calendar access
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555");
  });
});

describe("token exchange and refresh", () => {
  it("exchanges a code, sending the verifier and the redirect", async () => {
    let form = new URLSearchParams();
    const net: Net = async (_u, req) => ((form = new URLSearchParams(String(req.body))), res(200, { access_token: "a", refresh_token: "r", expires_in: 3599 }));
    const t = await exchangeCode(net, { clientId: "cid", clientSecret: "sec", code: "CODE", verifier: "VER", redirectUri: "http://127.0.0.1:1" });
    expect(t).toMatchObject({ refreshToken: "r", accessToken: "a" });
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "CODE", code_verifier: "VER", client_id: "cid" });
  });
  it("explains the failures people actually hit", async () => {
    const fail = (json: unknown, status = 400) => exchangeCode(async () => res(status, json), { clientId: "c", clientSecret: "s", code: "x", verifier: "v", redirectUri: "r" }).catch((e: AuthError) => e);
    expect(((await fail({ error: "invalid_client" })) as AuthError).kind).toBe("config");
    expect(((await fail({ error: "invalid_grant" })) as AuthError).kind).toBe("revoked");
    expect(((await exchangeCode(async () => res(200, { access_token: "a" }), { clientId: "c", clientSecret: "s", code: "x", verifier: "v", redirectUri: "r" }).catch((e: AuthError) => e)) as AuthError).message).toMatch(/refresh token/);
  });
  it("caches the access token until a minute before it expires, and shares one refresh", async () => {
    let calls = 0;
    let now = 1_000_000;
    const auth = new GoogleAuth(async () => (calls++, res(200, { access_token: `tok${calls}`, expires_in: 3600 })), () => creds, () => now);
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    now += 3000 * 1000;
    expect(await auth.accessToken()).toBe("tok1");
    now += 600 * 1000; // inside the last minute
    expect(await auth.accessToken()).toBe("tok2");
  });
  it("reports a missing or revoked sign-in plainly", async () => {
    await expect(new GoogleAuth(async () => res(200), () => null).accessToken()).rejects.toThrow(/client id and secret/);
    await expect(new GoogleAuth(async () => res(200), () => ({ ...creds, refreshToken: "" })).accessToken()).rejects.toThrow(/Not connected/);
    await expect(new GoogleAuth(async () => res(400, { error: "invalid_grant" }), () => creds).accessToken()).rejects.toThrow(/Connect again/);
  });
});

describe("GoogleCalendar", () => {
  const make = (handler: (url: string, req: NetRequest) => ReturnType<typeof res> | Promise<ReturnType<typeof res>>, sleeps: number[] = []) => {
    const log: { url: string; req: NetRequest }[] = [];
    const net: Net = async (url, req) => {
      if (url.includes("oauth2.googleapis.com")) return res(200, { access_token: "ACCESS", expires_in: 3600 });
      log.push({ url, req });
      return handler(url, req);
    };
    return { cal: new GoogleCalendar(net, new GoogleAuth(net, () => creds), async (ms) => void sleeps.push(ms)), log };
  };

  it("lists calendars with their roles", async () => {
    const { cal, log } = make(() => res(200, { items: [{ id: "a@x.com", summary: "Me", primary: true, accessRole: "owner" }, { id: "h", accessRole: "reader" }] }));
    const r = await cal.calendars();
    expect(r).toEqual([{ id: "a@x.com", summary: "Me", primary: true, role: "owner" }, { id: "h", summary: "h", primary: false, role: "reader" }]);
    expect(log[0].req.headers?.Authorization).toBe("Bearer ACCESS");
  });
  it("reads events, following pages, and maps them into Johannesburg time", async () => {
    let page = 0;
    const { cal, log } = make(() => res(200, page++ === 0
      ? { items: [{ id: "e1", status: "confirmed", summary: "A", start: { dateTime: "2026-10-05T14:00:00+02:00" }, end: { dateTime: "2026-10-05T15:00:00+02:00" }, extendedProperties: { private: { vdId: "vd-1" } } }], nextPageToken: "p2" }
      : { items: [{ id: "e2", status: "cancelled" }] }));
    const evs = await cal.events("primary", { updatedMin: "2026-10-03T00:00:00Z", showDeleted: true });
    expect(evs.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(evs[0]).toMatchObject({ summary: "A", priv: { vdId: "vd-1" }, when: { date: "2026-10-05", start: "14:00", end: "15:00" } });
    expect(evs[1]).toMatchObject({ status: "cancelled", when: null });
    expect(log[0].url).toContain("updatedMin=2026-10-03T00%3A00%3A00Z");
    expect(log[0].url).toContain("showDeleted=true");
    expect(log[1].url).toContain("pageToken=p2");
  });
  it("creates, patches with an etag (compare-and-set), and deletes", async () => {
    const { cal, log } = make((url, req) => (req.method === "DELETE" ? res(204) : res(200, { id: "new1", etag: '"e"', summary: "S" })));
    expect((await cal.insert("primary", { summary: "S" })).id).toBe("new1");
    await cal.patch("primary", "new1", { summary: "T" }, '"etag1"');
    await cal.remove("primary", "new1");
    expect(log[1].req.headers?.["If-Match"]).toBe('"etag1"');
    expect(log.map((l) => l.req.method)).toEqual(["POST", "PATCH", "DELETE"]);
    expect(JSON.parse(String(log[1].req.body))).toEqual({ summary: "T" });
  });
  it("treats deleting something already gone as success", async () => {
    await expect(make(() => res(410)).cal.remove("primary", "x")).resolves.toBeUndefined();
    await expect(make(() => res(404)).cal.remove("primary", "x")).resolves.toBeUndefined();
  });
  it("reports a changed event as a conflict rather than overwriting it", async () => {
    const e = await make(() => res(412, { error: { message: "Precondition Failed" } })).cal.patch("primary", "e", {}, '"old"').catch((x: ApiError) => x);
    expect((e as ApiError).kind).toBe("conflict");
  });
  it("retries rate limits and server errors with backoff, then gives up", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const ok = make(() => (n++ < 2 ? res(429) : res(200, { items: [] })), sleeps);
    await ok.cal.calendars();
    expect(sleeps).toEqual([500, 1500]);
    const sleeps2: number[] = [];
    const bad = await make(() => res(503), sleeps2).cal.calendars().catch((e: ApiError) => e);
    expect((bad as ApiError).kind).toBe("server");
    expect(sleeps2).toEqual([500, 1500, 4000]);
  });
  it("refreshes the token once if Google says it's stale, but not forever", async () => {
    let n = 0;
    const { cal } = make(() => (n++ === 0 ? res(401) : res(200, { items: [] })));
    await cal.calendars();
    expect(n).toBe(2);
    const e = await make(() => res(401)).cal.calendars().catch((x: ApiError) => x);
    expect((e as ApiError).kind).toBe("auth");
  });
  it("names the common failures", async () => {
    const kind = async (status: number) => ((await make(() => res(status, { error: { message: "m" } })).cal.calendars().catch((e: ApiError) => e)) as ApiError).kind;
    expect(await kind(403)).toBe("forbidden");
    expect(await kind(404)).toBe("not-found");
    expect(await kind(400)).toBe("bad-request");
  });
  it("never lets a token into an error", () => {
    expect(new ApiError("failed with Bearer ya29.abc-def_123", "server").message).toBe("failed with Bearer <token>");
  });
  it("maps an all-day and a malformed event safely", () => {
    expect(toEvent("c", { id: "x", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } }).when).toEqual({ date: "2026-10-05" });
    expect(toEvent("c", { id: "x" }).when).toBeNull();
  });
});

describe("loopback redirect server", () => {
  it("returns the code when state matches, and shows a friendly page", async () => {
    const lb = await startLoopback();
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const waiting = lb.wait("S1", 5000);
    const r = await fetch(`${lb.redirectUri}/?code=THE_CODE&state=S1`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Connected");
    expect(await waiting).toBe("THE_CODE");
  });
  it("rejects a response with the wrong state, and a denied request", async () => {
    const a = await startLoopback();
    const wa = a.wait("RIGHT", 5000).catch((e: Error) => e.message);
    await fetch(`${a.redirectUri}/?code=X&state=WRONG`);
    expect(await wa).toMatch(/didn't match/);
    const b = await startLoopback();
    const wb = b.wait("S", 5000).catch((e: Error) => e.message);
    await fetch(`${b.redirectUri}/?error=access_denied&state=S`);
    expect(await wb).toBe("Access was denied.");
  });
  it("ignores stray requests, and times out", async () => {
    const lb = await startLoopback();
    const w = lb.wait("S", 150).catch((e: Error) => e.message);
    expect((await fetch(`${lb.redirectUri}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${lb.redirectUri}/`)).status).toBe(400);
    expect(await w).toMatch(/Timed out/);
  });
});
