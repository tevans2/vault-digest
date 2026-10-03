import { runClaude } from "../claude";
import type { AgentBackend, AgentRequest } from "../provider";

/** Claude Code in print mode. Read-only tools only; the plugin does the writing. */
export function buildClaudeArgs(req: AgentRequest): string[] {
  const a = ["-p", "--model", req.model];
  if (req.effort) a.push("--effort", req.effort);
  if (req.fallbackModel) a.push("--fallback-model", req.fallbackModel);
  a.push(
    "--append-system-prompt",
    req.system,
    "--json-schema",
    JSON.stringify(req.schema),
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    req.claudeTools.join(","),
    "--permission-mode",
    "dontAsk",
    "--max-budget-usd",
    String(req.budgetUsd),
    "--session-id",
    req.sessionId
  );
  return a;
}

export interface NodeEnv {
  cwd: string;
  binary: () => Promise<string>;
  env: () => Promise<Record<string, string | undefined>>;
}

export const claudeBackend =
  (n: NodeEnv): AgentBackend =>
  async (req) =>
    runClaude({
      binary: await n.binary(),
      args: buildClaudeArgs(req),
      prompt: req.prompt,
      cwd: n.cwd,
      env: await n.env(),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onProgress: req.onProgress,
    });
