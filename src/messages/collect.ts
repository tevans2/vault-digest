import { MessageStatus, blockText, jsonList, messageBody, readFrontmatter } from "./note";

/** What the dashboard and the PA snapshot need to know about one message note. */
export interface MessageNote {
  path: string;
  kind: string;
  /** ISO with offset. */
  received: string;
  status: MessageStatus;
  /** The words (or the transcript / description for voice and photos), trimmed. */
  excerpt: string;
  /** Full text for the PA snapshot, capped. */
  text: string;
  transcript?: string;
  description?: string;
  attachments: string[];
  forwardedFrom?: string;
  /** Something is missing (a download, transcript or description) and a retry may fill it in. */
  needsRetry: boolean;
  edited: boolean;
}

const unquote = (s: string | undefined) => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as string;
  } catch {
    return s;
  }
};

const dequote = (b: string | null) =>
  b
    ? b
        .split("\n")
        .map((l) => l.replace(/^>\s?/, ""))
        .filter((l) => !/^\*\*.*:\*\*$/.test(l.trim()) && !/^\*.*\*$/.test(l.trim()))
        .join("\n")
        .replace(/^\*\*[^*]+\*\*\s*/, "")
        .trim()
    : "";

/** Returns null for anything that isn't a message note. */
export function parseMessageNote(path: string, text: string): MessageNote | null {
  const fm = readFrontmatter(text);
  if (fm.type !== "message") return null;
  const status = (["new", "actioned", "acknowledged", "ignored"].includes(fm.status) ? fm.status : "new") as MessageStatus;
  const body = messageBody(text);
  const transcript = dequote(blockText(text, "transcript")) || undefined;
  const description = dequote(blockText(text, "description")) || undefined;
  const words = body || transcript || description || "";
  return {
    path,
    kind: fm.kind ?? "text",
    received: fm.received ?? "",
    status,
    excerpt: words.replace(/\s+/g, " ").slice(0, 260),
    text: [body, transcript && `Transcript: ${transcript}`, description && `Photo: ${description}`].filter(Boolean).join("\n\n").slice(0, 900),
    transcript,
    description,
    attachments: jsonList(fm.attachments),
    forwardedFrom: unquote(fm.forwarded_from),
    needsRetry: fm.attachment === "pending" || fm.transcript === "pending" || fm.description === "pending",
    edited: fm.edited === "true",
  };
}

/** Newest first. */
export const byReceivedDesc = (a: MessageNote, b: MessageNote) => b.received.localeCompare(a.received);
