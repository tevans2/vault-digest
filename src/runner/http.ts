import { requestUrl } from "obsidian";
import type { Http } from "./backends/openrouter";

/** Obsidian's requestUrl: works on desktop and mobile, no CORS. */
export const obsidianHttp: Http = async (url, init) => {
  const r = await requestUrl({ url, method: init.method, headers: init.headers, body: init.body, throw: false });
  let json: unknown;
  try {
    json = r.json as unknown;
  } catch {
    json = undefined;
  }
  return { status: r.status, json };
};
