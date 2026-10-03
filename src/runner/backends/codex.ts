import { readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runProcess } from "../claude";
import { jsonFromText } from "../stream";
import { SCHEMA_INSTRUCTION, type AgentBackend, type AgentRequest } from "../provider";
import type { NodeEnv } from "./claude";

/** Codex non-interactive mode in a read-only sandbox, rooted at the vault. */
export function buildCodexArgs(req: AgentRequest, lastMessageFile: string): string[] {
  const a = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "--output-last-message", lastMessageFile];
  if (req.model) a.push("--model", req.model);
  if (req.effort) a.push("-c", `model_reasoning_effort=${req.effort}`);
  a.push("-"); // prompt on stdin
  return a;
}

export const codexInput = (req: AgentRequest) => `${req.system}\n\n${req.prompt}\n\n${SCHEMA_INSTRUCTION(req.schema)}`;

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; tool?: string };
  message?: string;
  error?: { message?: string };
}

export function codexProgress(ev: CodexEvent): string | undefined {
  if (ev.type !== "item.started" && ev.type !== "item.completed") return undefined;
  const t = ev.item?.type;
  if (t === "command_execution") return ev.type === "item.started" ? "Reading the vault…" : undefined;
  if (t === "mcp_tool_call") {
    const tool = ev.item?.tool ?? "a tool";
    return /calendar/i.test(tool) ? "Checking calendar…" : `Using ${tool}…`;
  }
  if (t === "agent_message" && ev.type === "item.completed") return "Writing result…";
  return undefined;
}

export const codexBackend =
  (n: NodeEnv): AgentBackend =>
  async (req) => {
    const last = join(tmpdir(), `vault-digest-codex-${Date.now()}.txt`);
    let thread: string | undefined;
    let lastAgentText: string | undefined;
    let streamError: string | undefined;
    try {
      const o = await runProcess(
        {
          binary: await n.binary(),
          args: buildCodexArgs(req, last),
          prompt: codexInput(req),
          cwd: n.cwd,
          env: await n.env(),
          timeoutMs: req.timeoutMs,
          signal: req.signal,
        },
        (line) => {
          let ev: CodexEvent;
          try {
            ev = JSON.parse(line) as CodexEvent;
          } catch {
            return;
          }
          if (ev.type === "thread.started") thread = ev.thread_id;
          if (ev.type === "item.completed" && ev.item?.type === "agent_message") lastAgentText = ev.item.text;
          if (ev.type === "error") streamError = ev.message;
          if (ev.type === "turn.failed") streamError = ev.error?.message ?? streamError;
          const p = codexProgress(ev);
          if (p) req.onProgress?.(p);
        }
      );
      if (o.kind !== "exit") return o;
      if (o.exitCode !== 0) {
        return { kind: "result", exitCode: o.exitCode, stderr: o.stderr, result: { ok: false, error: streamError || o.stderr.trim().split("\n").slice(-3).join(" ") || `codex exited with code ${o.exitCode}` } };
      }
      const text = existsSync(last) ? readFileSync(last, "utf8") : lastAgentText;
      const structured = jsonFromText(text);
      if (structured === undefined) {
        return { kind: "result", exitCode: 0, stderr: o.stderr, result: { ok: true, text, sessionId: thread } };
      }
      // Codex doesn't report dollars, so cost stays unset rather than estimated.
      return { kind: "result", exitCode: 0, stderr: o.stderr, result: { ok: true, structured, text, sessionId: thread } };
    } finally {
      if (existsSync(last)) rmSync(last, { force: true });
    }
  };
