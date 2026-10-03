import type { Net } from "./net";
import { redact } from "./net";

/** Audio transcription and photo description through OpenAI. Pure over `Net`, so it runs in the app and in tests. */

export class AiError extends Error {
  constructor(message: string, public kind: "auth" | "quota" | "rate" | "bad-input" | "network" | "server") {
    super(redact(message));
  }
}

const enc = new TextEncoder();

/** Hand-built multipart/form-data, because requestUrl takes raw bytes rather than a FormData. */
export function buildMultipart(
  fields: Record<string, string>,
  file: { field: string; name: string; mime: string; bytes: ArrayBuffer },
  boundary = `----vd${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
): { body: ArrayBuffer; contentType: string } {
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  const safe = file.name.replace(/[\r\n"]/g, "_");
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safe}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(new Uint8Array(file.bytes));
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** OpenAI accepts .ogg but not Telegram's .oga spelling of the same Opus-in-Ogg voice notes. */
export function uploadName(name: string): string {
  return name.replace(/\.oga$/i, ".ogg");
}

function fail(status: number, body: unknown): AiError {
  const err = (body as { error?: { message?: string; code?: string; type?: string } } | undefined)?.error;
  const msg = err?.message ?? `HTTP ${status}`;
  if (status === 401) return new AiError("OpenAI rejected the API key.", "auth");
  if (status === 429) return new AiError(err?.code === "insufficient_quota" ? "The OpenAI account is out of credit." : "OpenAI rate limit hit.", err?.code === "insufficient_quota" ? "quota" : "rate");
  if (status === 400 || status === 413 || status === 415) return new AiError(`OpenAI couldn't use that file: ${msg}`, "bad-input");
  return new AiError(`OpenAI error: ${msg}`, "server");
}

export interface TranscribeOpts {
  model: string;
  /** ISO-639-1, e.g. "en". Empty lets the model detect it. */
  language?: string;
  /** Spelling hints (names, jargon). */
  prompt?: string;
}

export async function transcribe(net: Net, key: string, opts: TranscribeOpts, file: { name: string; mime: string; bytes: ArrayBuffer }): Promise<string> {
  const fields: Record<string, string> = { model: opts.model, response_format: "json" };
  if (opts.language) fields.language = opts.language;
  if (opts.prompt) fields.prompt = opts.prompt;
  const { body, contentType } = buildMultipart(fields, { field: "file", name: uploadName(file.name), mime: file.mime, bytes: file.bytes });
  let res;
  try {
    res = await net("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, contentType });
  } catch (e) {
    throw new AiError(`Couldn't reach OpenAI: ${(e as Error).message}`, "network");
  }
  if (res.status !== 200) throw fail(res.status, res.json);
  const text = (res.json as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") throw new AiError("OpenAI returned no transcript.", "server");
  return text.trim();
}

export function toBase64(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

const DESCRIBE_PROMPT =
  "This photo was sent by its owner to their personal assistant. Describe what it shows in 2 to 4 sentences, then transcribe any visible text exactly. " +
  "If it is a receipt, invoice, document, whiteboard, screenshot or timetable, say so and list the key details (names, dates, times, amounts, places). " +
  "State only what you can see. Do not guess.";

export async function describeImage(net: Net, key: string, model: string, img: { mime: string; bytes: ArrayBuffer }): Promise<string> {
  const body = JSON.stringify({
    model,
    max_tokens: 500,
    messages: [{ role: "user", content: [{ type: "text", text: DESCRIBE_PROMPT }, { type: "image_url", image_url: { url: `data:${img.mime};base64,${toBase64(img.bytes)}`, detail: "auto" } }] }],
  });
  let res;
  try {
    res = await net("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, contentType: "application/json" });
  } catch (e) {
    throw new AiError(`Couldn't reach OpenAI: ${(e as Error).message}`, "network");
  }
  if (res.status !== 200) throw fail(res.status, res.json);
  const text = (res.json as { choices?: { message?: { content?: string } }[] } | undefined)?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new AiError("OpenAI returned no description.", "server");
  return text.trim();
}
