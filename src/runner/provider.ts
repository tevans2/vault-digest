import type { Schema } from "./validate";
import type { ClaudeOutcome } from "./claude";

export type Provider = "claude-code" | "codex" | "openrouter";
export const PROVIDERS: Provider[] = ["claude-code", "codex", "openrouter"];

export const PROVIDER_LABELS: Record<Provider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openrouter: "OpenRouter",
};

export const DEFAULT_MODELS: Record<Provider, string> = {
  "claude-code": "claude-sonnet-5-5",
  codex: "", // empty = whatever Codex is configured to use
  openrouter: "anthropic/claude-sonnet-5.5",
};

/**
 * Claude Code reads Google Calendar through the claude.ai connector; Codex through its own
 * Google Calendar plugin (when the user has added it). OpenRouter has no tool access to it.
 */
export const hasCalendar = (p: Provider, codexCalendar = true) => p === "claude-code" || (p === "codex" && codexCalendar);
/** CLI providers run a local binary and need the desktop app. */
export const needsDesktop = (p: Provider) => p !== "openrouter";

/** One model call, whichever backend serves it. */
export interface AgentRequest {
  provider: Provider;
  model: string;
  effort: string;
  fallbackModel: string; // Claude Code only
  budgetUsd: number; // Claude Code and OpenRouter
  system: string;
  prompt: string;
  schema: Schema;
  /** Allowed tools for Claude Code. Other backends have their own read-only access. */
  claudeTools: string[];
  sessionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

/** Every backend reports in the same shape, so retry, validation and logging stay provider-blind. */
export type AgentOutcome = ClaudeOutcome;
export type AgentBackend = (req: AgentRequest) => Promise<AgentOutcome>;

/** Providers other than Claude Code only accept low/medium/high. */
export function effortFor(provider: Provider, effort: string): string {
  if (!effort) return "";
  if (provider === "claude-code") return effort;
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export const SCHEMA_INSTRUCTION = (schema: Schema) =>
  `Reply with only one JSON object matching this JSON Schema. No prose and no code fences.\n<schema>\n${JSON.stringify(schema)}\n</schema>`;
