import { createServer, Server } from "http";
import type { AddressInfo } from "net";

/** A one-shot local web server that catches Google's redirect after you approve access. Desktop only. */

export interface Loopback {
  redirectUri: string;
  /** Resolves with the authorization code, or rejects (denied, wrong state, timeout). Closes the server either way. */
  wait(state: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;text-align:center"><h2>${title}</h2><p>${body}</p></body>`;

export function startLoopback(): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let settle: ((r: { code?: string; error?: string; state?: string }) => void) | null = null;
    const got = new Promise<{ code?: string; error?: string; state?: string }>((r) => (settle = r));
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code") ?? undefined;
      const error = u.searchParams.get("error") ?? undefined;
      const state = u.searchParams.get("state") ?? undefined;
      if (!code && !error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(PAGE("Nothing to do", "This page only receives the Google sign-in."));
        return;
      }
      const ok = !!code && !error;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" }).end(ok ? PAGE("Connected", "You can close this tab and go back to Obsidian.") : PAGE("Not connected", "Access wasn't granted. You can close this tab."));
      settle?.({ code, error, state });
    });
    server.on("error", reject);
    // Port 0 lets the OS pick a free port. 127.0.0.1 only, so nothing else on the network can reach it.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        redirectUri: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        async wait(state, timeoutMs = 180_000) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const r = await Promise.race([got, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("Timed out waiting for you to approve access.")), timeoutMs)))]);
            if (r.error) throw new Error(r.error === "access_denied" ? "Access was denied." : `Google said: ${r.error}`);
            if (r.state !== state) throw new Error("The sign-in response didn't match this request, so it was ignored.");
            return r.code!;
          } finally {
            clearTimeout(timer);
            server.close();
          }
        },
      });
    });
  });
}
