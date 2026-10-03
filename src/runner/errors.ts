import type { ClaudeResult } from "./stream";

export interface Failure {
  message: string;
  transient: boolean;
}

const TRANSIENT =
  /socket|econnreset|econnrefused|etimedout|enotfound|network|overloaded|fetch failed|connection (closed|error|reset)|stream (ended|closed)|temporarily|try again|rate.?limit|\b(408|409|429|500|502|503|504|529)\b/i;
const PERMANENT = /credit balance|out of credits|not logged in|\/login|invalid api key|authentication|unauthor|forbidden|budget|permission denied|enoent/i;

/** Decide whether a failed attempt is worth retrying. Budget, auth and missing-binary errors never are. */
export function classifyFailure(input: {
  result?: ClaudeResult;
  exitCode?: number | null;
  stderr?: string;
  spawnError?: string;
}): Failure {
  const r = input.result;
  const message =
    input.spawnError ||
    r?.error ||
    (input.stderr?.trim().split("\n").slice(-3).join(" ") ?? "") ||
    (input.exitCode != null ? `claude exited with code ${input.exitCode}` : "claude failed");

  if (input.spawnError || r?.subtype === "error_max_budget_usd") return { message, transient: false };
  if (PERMANENT.test(message)) return { message, transient: false };

  const status = r?.apiErrorStatus;
  if (status && (status === 408 || status === 409 || status === 429 || status >= 500)) return { message, transient: true };
  if (TRANSIENT.test(message)) return { message, transient: true };
  // Non-zero exit with no result at all usually means the process or connection died.
  if (!r && input.exitCode) return { message, transient: true };
  return { message, transient: false };
}
