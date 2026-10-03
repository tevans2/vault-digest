import { requestUrl } from "obsidian";
import type { Net } from "./net";

/** requestUrl works on desktop and mobile, with no CORS. Fields are lazy so a binary body is never decoded as text. */
export const obsidianNet: Net = async (url, req) => {
  const r = await requestUrl({ url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
  return {
    status: r.status,
    get text() {
      try {
        return r.text;
      } catch {
        return "";
      }
    },
    get bytes() {
      return r.arrayBuffer;
    },
    get json() {
      try {
        return r.json as unknown;
      } catch {
        return undefined;
      }
    },
  };
};
