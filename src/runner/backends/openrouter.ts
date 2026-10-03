import { SCHEMA_INSTRUCTION, type AgentBackend, type AgentOutcome, type AgentRequest } from "../provider";
import { jsonFromText } from "../stream";
import { VAULT_TOOLS, runVaultTool, type VaultReader } from "../vault-tools";

const BASE = "https://openrouter.ai/api/v1";
const MAX_TURNS = 16;

export interface HttpResponse {
  status: number;
  json: unknown;
}
/** A POST or GET returning parsed JSON. Injected so tests never touch the network. */
export type Http = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface Completion {
  usage?: Record<string, unknown>;
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  error?: { message?: string };
}

const TOOLS = VAULT_TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "HTTP-Referer": "https://obsidian.md",
  "X-Title": "Vault Digest",
});

const fail = (error: string, extra: { apiErrorStatus?: number; subtype?: string } = {}): AgentOutcome => ({
  kind: "result",
  exitCode: 0,
  stderr: "",
  result: { ok: false, error, ...extra },
});

/** Messages are written so the shared classifier retries 429/5xx/network and never retries auth, credits or budget. */
function httpFailure(status: number, body: unknown): AgentOutcome {
  const message = (body as Completion | undefined)?.error?.message ?? "";
  if (status === 401) return fail("OpenRouter authentication failed: the API key was rejected. Check it in settings.", { apiErrorStatus: 401 });
  if (status === 402) return fail("Your OpenRouter account is out of credits.", { apiErrorStatus: 402 });
  if (status === 429) return fail("Rate limited by OpenRouter (429).", { apiErrorStatus: 429 });
  return fail(`OpenRouter error ${status}${message ? `: ${message}` : ""}`, { apiErrorStatus: status });
}

const base = (p: unknown) => String(p ?? "").split("/").pop() ?? "";
function toolProgress(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (name === "read_note") return `Reading ${base(a.path)}…`;
  if (name === "search_notes") return "Searching the vault…";
  return "Listing notes…";
}

export interface OpenRouterDeps {
  vault: VaultReader;
  apiKey: () => string | null;
  http: Http;
  exclude?: string[];
}

export const openRouterBackend =
  (d: OpenRouterDeps): AgentBackend =>
  async (req: AgentRequest) => {
    const key = d.apiKey();
    if (!key) return fail("OpenRouter authentication failed: no API key is set. Add one in settings.");
    if (!req.model) return fail("Choose an OpenRouter model in settings (for example anthropic/claude-sonnet-5.5).");

    // Overall deadline and user cancel both end the loop; requestUrl itself can't be aborted, so we stop waiting.
    const ac = new AbortController();
    let reason: "timeout" | "cancelled" | null = null;
    const timer = setTimeout(() => ((reason = "timeout"), ac.abort()), req.timeoutMs);
    const onAbort = () => ((reason = "cancelled"), ac.abort());
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener("abort", onAbort);
    const until = <T>(work: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        if (ac.signal.aborted) return reject(new Error("aborted"));
        const stop = () => reject(new Error("aborted"));
        ac.signal.addEventListener("abort", stop, { once: true });
        work.then(
          (v) => (ac.signal.removeEventListener("abort", stop), resolve(v)),
          (e) => (ac.signal.removeEventListener("abort", stop), reject(e))
        );
      });

    const messages: Message[] = [
      { role: "system", content: req.system },
      { role: "user", content: `${req.prompt}\n\n${SCHEMA_INSTRUCTION(req.schema)}` },
    ];
    let structured = true;
    let cost = 0;
    let anyCost = false;
    const done = (o: AgentOutcome): AgentOutcome => {
      if (o.kind === "result" && anyCost) o.result.costUsd = Math.round(cost * 10_000) / 10_000;
      return o;
    };

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        req.onProgress?.(turn === 0 ? `Asking ${req.model}…` : "Thinking…");
        const body = {
          model: req.model,
          messages,
          max_tokens: 16000,
          tools: TOOLS,
          ...(structured ? { response_format: { type: "json_schema", json_schema: { name: "vault_digest_result", strict: false, schema: req.schema } } } : {}),
          ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
          usage: { include: true }, // token counts and cost in every response
        };
        let res: HttpResponse;
        try {
          res = await until(d.http(`${BASE}/chat/completions`, { method: "POST", headers: headers(key), body: JSON.stringify(body) }));
        } catch (e) {
          if (reason === "timeout") return { kind: "timeout", stderr: "" };
          if (reason === "cancelled") return { kind: "cancelled", stderr: "" };
          return done(fail(`network error: ${(e as Error).message}`));
        }
        // Some providers reject response_format alongside tools; the prompt still carries the schema.
        if (res.status === 400 && structured) {
          structured = false;
          turn--;
          continue;
        }
        if (res.status !== 200) return done(httpFailure(res.status, res.json));

        const c = res.json as Completion;
        const u = c.usage;
        if (u && typeof u.cost === "number") {
          cost += u.cost;
          anyCost = true;
        }
        if (anyCost && cost > req.budgetUsd) {
          return done(fail(`Budget of $${req.budgetUsd} reached.`, { subtype: "error_max_budget_usd" }));
        }
        const choice = c.choices?.[0];
        const message = choice?.message;
        if (!message) return done(fail(c.error?.message || "OpenRouter returned no reply."));
        if (choice.finish_reason === "length") return done(fail("The reply was cut off (length)."));

        if (message.tool_calls?.length) {
          messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
          for (const call of message.tool_calls) {
            let args: unknown = {};
            try {
              args = JSON.parse(call.function.arguments || "{}");
            } catch {
              /* the tool reports the bad input */
            }
            req.onProgress?.(toolProgress(call.function.name, args));
            messages.push({ role: "tool", tool_call_id: call.id, content: await runVaultTool(d.vault, call.function.name, args, d.exclude) });
          }
          continue;
        }

        req.onProgress?.("Writing result…");
        const text = message.content ?? "";
        return done({ kind: "result", exitCode: 0, stderr: "", result: { ok: true, text, structured: jsonFromText(text) } });
      }
      return done(fail("The model took too many steps without finishing."));
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  };

/** Models that can call tools, for the settings suggestions. */
export async function openRouterModels(http: Http): Promise<string[]> {
  const r = await http(`${BASE}/models`, { method: "GET", headers: {} });
  if (r.status !== 200) return [];
  const data = (r.json as { data?: { id?: unknown; supported_parameters?: unknown }[] } | undefined)?.data ?? [];
  return data
    .filter((m) => typeof m.id === "string" && (!Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools")))
    .map((m) => m.id as string)
    .sort();
}
