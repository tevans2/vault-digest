import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine, progressOf, resultOf, structuredFrom } from "../src/runner/stream";
import { classifyFailure } from "../src/runner/errors";
import { validate } from "../src/runner/validate";
import { runClaude, ClaudeSpec } from "../src/runner/claude";
import { buildClaudeArgs } from "../src/runner/backends/claude";
import { buildCodexArgs, codexInput, codexProgress } from "../src/runner/backends/codex";
import { openRouterBackend, openRouterModels, Http } from "../src/runner/backends/openrouter";
import { effortFor, hasCalendar, AgentRequest, DEFAULT_MODELS } from "../src/runner/provider";
import { providerNote } from "../src/runner/prompts";
import { jsonFromText } from "../src/runner/stream";
import { JobRunner, JobDef, RunnerConfig } from "../src/runner/runner";
import { BRIEF_SCHEMA, BRIEF_TOOLS, applyBrief, buildBriefSnapshot } from "../src/runner/jobs/brief";
import { decideBrief } from "../src/engine/scheduler";
import { emptyState, reapStaleRuns, coerceState, RunRecord } from "../src/state/schema";
import { parseTasks } from "../src/engine/collectors/tasks";

const FAKE = path.join(__dirname, "fake-claude.mjs");

describe("stream parsing (real captured output)", () => {
  const events = fs
    .readFileSync(path.join(__dirname, "fixtures/structured-ok.jsonl"), "utf8")
    .split("\n")
    .map(parseLine)
    .filter(Boolean) as ReturnType<typeof parseLine>[];

  it("extracts structured output, cost and session from the result event", () => {
    const r = events.map((e) => resultOf(e!)).find(Boolean)!;
    expect(r.ok).toBe(true);
    expect(r.structured).toEqual({ greeting: "Hello! Ready to help with your project.", n: 3 });
    expect(r.costUsd).toBeCloseTo(0.0498, 3);
    expect(r.sessionId).toBeTruthy();
  });
  it("reports tool progress", () => {
    const p = events.map((e) => progressOf(e!)).filter(Boolean);
    expect(p).toContain("Writing result…");
  });
  it("ignores garbage lines", () => {
    expect(parseLine("not json")).toBeNull();
  });
  it("falls back to JSON in the text result", () => {
    expect(structuredFrom({ ok: true, text: '```json\n{"a":1}\n```' })).toEqual({ a: 1 });
    expect(structuredFrom({ ok: true, text: "plain" })).toBeUndefined();
  });
});

describe("classifyFailure", () => {
  const f = (message: string, extra = {}) => classifyFailure({ result: { ok: false, error: message, ...extra }, exitCode: 1 });
  it("treats socket, overload and 5xx as transient", () => {
    expect(f("API Error: socket closed").transient).toBe(true);
    expect(f("Overloaded").transient).toBe(true);
    expect(f("boom", { apiErrorStatus: 503 }).transient).toBe(true);
  });
  it("never retries budget, auth or a missing binary", () => {
    expect(f("x", { subtype: "error_max_budget_usd" }).transient).toBe(false);
    expect(f("Not logged in · Please run /login").transient).toBe(false);
    expect(classifyFailure({ spawnError: "spawn claude ENOENT" }).transient).toBe(false);
  });
  it("retries a non-zero exit with no result", () => {
    expect(classifyFailure({ exitCode: 1, stderr: "" }).transient).toBe(true);
  });
});

describe("validate", () => {
  it("accepts a good brief and reports readable errors for a bad one", () => {
    const good = { announcements: [], priorities: [], timeline: [{ start: "all-day", title: "x" }], notes: "n", missing: [], carriedForward: "", radar: [], taskOps: [], messages: [] };
    expect(validate(good, BRIEF_SCHEMA)).toEqual([]);
    const bad = { announcements: [{ id: "a", level: "panic", text: "t" }], priorities: [], timeline: [{ start: "9am", title: "x" }], notes: "n", missing: [], carriedForward: "", radar: [], taskOps: [], extra: 1 };
    const errs = validate(bad, BRIEF_SCHEMA);
    expect(errs.join("\n")).toMatch(/level: must be one of/);
    expect(errs.join("\n")).toMatch(/start: does not match/);
    expect(errs.join("\n")).toMatch(/extra: unexpected property/);
  });
});

describe("runClaude with a fake binary", () => {
  const spec = (env: Record<string, string>, over: Partial<ClaudeSpec> = {}): ClaudeSpec => ({
    binary: process.execPath,
    args: [FAKE],
    prompt: "hello",
    cwd: os.tmpdir(),
    env: { ...process.env, ...env },
    timeoutMs: 10_000,
    ...over,
  });
  it("returns the result and streams progress", async () => {
    const seen: string[] = [];
    const o = await runClaude(spec({ FAKE_MODE: "ok" }, { onProgress: (p) => seen.push(p) }));
    expect(o.kind).toBe("result");
    expect(seen).toEqual(["Checking calendar…", "Reading google-calendar.md…"]);
  });
  it("times out and kills a hung process", async () => {
    const o = await runClaude(spec({ FAKE_MODE: "hang" }, { timeoutMs: 300 }));
    expect(o.kind).toBe("timeout");
  });
  it("cancels on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const o = await runClaude(spec({ FAKE_MODE: "hang" }, { signal: ac.signal }));
    expect(o.kind).toBe("cancelled");
  });
  it("reports a missing binary", async () => {
    const o = await runClaude(spec({}, { binary: "/nonexistent/claude" }));
    expect(o.kind).toBe("spawn-error");
  });
});

describe("JobRunner", () => {
  let dir: string;
  let state = emptyState();
  const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    effort: "medium",
    fallbackModel: "",
    budgetUsd: 0.5,
    timeoutMs: 10_000,
    dryRun: false,
    backoffMs: [5, 5],
    ...over,
  });
  let applied: unknown[] = [];
  const job: JobDef = {
    id: "brief",
    schema: BRIEF_SCHEMA,
    tools: BRIEF_TOOLS,
    writesVault: true,
    prompts: async () => ({ system: "sys", task: "task" }),
    snapshot: () => ({ hi: 1 }),
    apply: async (r) => void applied.push(r),
  };
  const make = (env: Record<string, string>, over: Partial<RunnerConfig> = {}) => {
    let n = 0;
    return new JobRunner(
      {
        state: () => state,
        save: async () => undefined,
        config: () => cfg(over),
        agent: (r) =>
          runClaude({
            binary: process.execPath,
            args: [FAKE],
            prompt: r.prompt,
            cwd: os.tmpdir(),
            env: { ...process.env, ...env },
            timeoutMs: r.timeoutMs,
            signal: r.signal,
            onProgress: r.onProgress,
          }),
        sleep: async () => undefined,
        now: () => new Date(),
        uuid: () => `id-${++n}`,
      },
      { brief: job, close: job, week: job, intent: job }
    );
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-"));
    state = emptyState();
    applied = [];
  });

  it("runs, validates, applies and records cost", async () => {
    const run = await make({ FAKE_MODE: "ok" }).run("brief", "manual");
    expect(run.status).toBe("ok");
    expect(run.costUsd).toBeCloseTo(0.1);
    expect(applied).toHaveLength(1);
    expect(state.runs[0]).toBe(run);
  });
  it("holds the result for approval in dry-run", async () => {
    const run = await make({ FAKE_MODE: "ok" }, { dryRun: true }).run("brief", "manual");
    expect(run.status).toBe("ok");
    expect(applied).toHaveLength(0);
    expect(state.pending[0]?.runId).toBe(run.id);
  });
  it("the 1 Oct case: socket errors retry, then fail visibly", async () => {
    const run = await make({ FAKE_MODE: "socket" }).run("brief", "schedule");
    expect(run.status).toBe("failed");
    expect(run.attempts).toBe(3); // 1 + 2 retries
    expect(run.error).toMatch(/socket closed/);
    expect(applied).toHaveLength(0);
  });
  it("recovers when a retry succeeds", async () => {
    const counter = path.join(dir, "n");
    const run = await make({ FAKE_MODE: "flaky", FAKE_COUNTER: counter, FAKE_FAILS: "2" }).run("brief", "schedule");
    expect(run.status).toBe("ok");
    expect(run.attempts).toBe(3);
  });
  it("does not retry budget errors", async () => {
    const run = await make({ FAKE_MODE: "budget" }).run("brief", "manual");
    expect(run.status).toBe("failed");
    expect(run.attempts).toBe(1);
  });
  it("retries invalid output once with the errors appended, then rejects", async () => {
    const prompts = path.join(dir, "p.txt");
    const run = await make({ FAKE_MODE: "invalid", FAKE_PROMPT_FILE: prompts }).run("brief", "manual");
    expect(run.status).toBe("rejected");
    expect(run.attempts).toBe(2);
    expect(fs.readFileSync(prompts, "utf8")).toMatch(/failed validation/);
  });
  it("accepts a corrected answer on the schema retry", async () => {
    const run = await make({ FAKE_MODE: "invalid-once", FAKE_COUNTER: path.join(dir, "c") }).run("brief", "manual");
    expect(run.status).toBe("ok");
  });
  it("runs one at a time, in order", async () => {
    const r = make({ FAKE_MODE: "ok" });
    const [a, b] = await Promise.all([r.run("brief", "manual"), r.run("brief", "manual")]);
    expect(Date.parse(a.endedAt!)).toBeLessThanOrEqual(Date.parse(b.startedAt));
  });
  it("cancels a running job", async () => {
    const r = make({ FAKE_MODE: "hang" });
    const p = r.run("brief", "manual");
    await new Promise((res) => setTimeout(res, 300));
    r.cancel();
    expect((await p).status).toBe("cancelled");
  });
  it("builds the documented CLI arguments", () => {
    const a = buildClaudeArgs({ ...req(), fallbackModel: "claude-opus-5-5", effort: "medium", sessionId: "sid" });
    expect(a).toEqual(expect.arrayContaining(["-p", "--model", "claude-sonnet-5-5", "--effort", "medium", "--fallback-model", "claude-opus-5-5", "--permission-mode", "dontAsk", "--session-id", "sid"]));
    expect(a[a.indexOf("--allowedTools") + 1]).toContain("Google_Calendar__list_events");
    expect(a).not.toContain("bypassPermissions");
    expect(a.join(" ")).not.toMatch(/Edit|Write|Bash/);
  });
});

const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  effort: "",
  fallbackModel: "",
  budgetUsd: 0.5,
  system: "SYS",
  prompt: "PROMPT",
  schema: BRIEF_SCHEMA,
  claudeTools: BRIEF_TOOLS,
  sessionId: "sid",
  timeoutMs: 5000,
  ...over,
});

describe("providers", () => {
  it("clamps effort for providers that only take low/medium/high", () => {
    expect(effortFor("claude-code", "xhigh")).toBe("xhigh");
    expect(effortFor("codex", "xhigh")).toBe("high");
    expect(effortFor("openrouter", "max")).toBe("high");
    expect(effortFor("openrouter", "low")).toBe("low");
    expect(effortFor("codex", "")).toBe("");
  });
  it("has a default model per provider, and Codex defaults to its own", () => {
    expect(DEFAULT_MODELS["claude-code"]).toBe("claude-sonnet-5-5");
    expect(DEFAULT_MODELS.codex).toBe("");
    expect(DEFAULT_MODELS.openrouter).toMatch(/\//);
  });
  it("builds Codex args: read-only sandbox, model and effort only when set, prompt on stdin", () => {
    const bare = buildCodexArgs(req({ provider: "codex", model: "" }), "/tmp/x");
    expect(bare).toEqual(["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "--output-last-message", "/tmp/x", "-"]);
    const full = buildCodexArgs(req({ provider: "codex", model: "gpt-5", effort: "high" }), "/tmp/x");
    expect(full).toEqual(expect.arrayContaining(["--model", "gpt-5", "-c", "model_reasoning_effort=high"]));
    expect(full.at(-1)).toBe("-");
    expect(codexInput(req())).toMatch(/SYS[\s\S]*PROMPT[\s\S]*JSON Schema/);
  });
  it("knows which providers can read the calendar", () => {
    expect(hasCalendar("claude-code")).toBe(true);
    expect(hasCalendar("codex")).toBe(true);
    expect(hasCalendar("codex", false)).toBe(false);
    expect(hasCalendar("openrouter")).toBe(false);
  });
  it("tells each provider the truth about the calendar", () => {
    expect(providerNote("claude-code", { codexCalendar: true })).toBe("");
    expect(providerNote("codex", { codexCalendar: true })).toMatch(/Google Calendar plugin/);
    expect(providerNote("codex", { codexCalendar: true })).not.toMatch(/no calendar access/i);
    expect(providerNote("codex", { codexCalendar: false })).toMatch(/no calendar access/i);
    expect(providerNote("openrouter", { codexCalendar: true })).toMatch(/no calendar access/i);
  });
  it("labels Codex calendar tool calls", () => {
    expect(codexProgress({ type: "item.started", item: { type: "mcp_tool_call", tool: "google_calendar.search_events" } })).toBe("Checking calendar…");
    expect(codexProgress({ type: "item.started", item: { type: "mcp_tool_call", tool: "github.search" } })).toBe("Using github.search…");
  });
  it("reports Codex progress from item events", () => {
    expect(codexProgress({ type: "item.started", item: { type: "command_execution" } })).toBe("Reading the vault…");
    expect(codexProgress({ type: "item.completed", item: { type: "agent_message" } })).toBe("Writing result…");
    expect(codexProgress({ type: "turn.started" })).toBeUndefined();
  });
  it("pulls JSON out of prose and fences", () => {
    expect(jsonFromText('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(jsonFromText('Sure! {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
    expect(jsonFromText("no json")).toBeUndefined();
  });
});

describe("OpenRouter backend", () => {
  const good = { announcements: [], priorities: ["x"], timeline: [], notes: "n", missing: [], carriedForward: "", radar: [], taskOps: [], messages: [] };
  const vault = { paths: () => ["Areas/a.md", "Journal/20261001.md"], read: async (p: string) => `content of ${p}` };
  const reply = (message: object, extra: object = {}) => ({ status: 200, json: { choices: [{ message, finish_reason: "stop" }], usage: { cost: 0.01 }, ...extra } });
  const make = (responses: ({ status: number; json: unknown } | Error)[], calls: { body: Record<string, unknown> }[] = [], key: string | null = "k") => {
    const http: Http = async (_u, init) => {
      calls.push({ body: JSON.parse(init.body ?? "{}") });
      const r = responses.shift();
      if (!r) throw new Error("no more responses");
      if (r instanceof Error) throw r;
      return r;
    };
    return openRouterBackend({ vault, apiKey: () => key, http });
  };

  it("returns structured output and sums cost", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const out = await make([reply({ content: JSON.stringify(good) })], calls)(req({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5", effort: "high" }));
    expect(out.kind).toBe("result");
    if (out.kind !== "result") return;
    expect(out.result.ok).toBe(true);
    expect(out.result.structured).toEqual(good);
    expect(out.result.costUsd).toBeCloseTo(0.01);
    expect(calls[0].body.model).toBe("anthropic/claude-sonnet-5.5");
    expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    expect((calls[0].body.messages as { role: string }[])[0].role).toBe("system");
  });
  it("runs vault tools in a loop and reports progress", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const seen: string[] = [];
    const tool = { id: "c1", type: "function", function: { name: "read_note", arguments: '{"path":"Areas/a.md"}' } };
    const out = await make([reply({ content: null, tool_calls: [tool] }), reply({ content: JSON.stringify(good) })], calls)(req({ provider: "openrouter", model: "m", onProgress: (p) => seen.push(p) }));
    expect(out.kind === "result" && out.result.ok).toBe(true);
    expect(seen).toContain("Reading a.md…");
    const second = calls[1].body.messages as { role: string; content: string }[];
    expect(second.at(-1)).toMatchObject({ role: "tool", content: "content of Areas/a.md" });
  });
  it("falls back to prompt-only schema when response_format is rejected", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const out = await make([{ status: 400, json: {} }, reply({ content: JSON.stringify(good) })], calls)(req({ provider: "openrouter", model: "m" }));
    expect(out.kind === "result" && out.result.ok).toBe(true);
    expect(calls[0].body.response_format).toBeDefined();
    expect(calls[1].body.response_format).toBeUndefined();
  });
  it("maps errors so the classifier retries only the transient ones", async () => {
    const run = (status: number) => make([{ status, json: { error: { message: "x" } } }])(req({ provider: "openrouter", model: "m" }));
    const cls = async (status: number) => {
      const o = await run(status);
      if (o.kind !== "result") throw new Error("expected result");
      return classifyFailure({ result: o.result, exitCode: 0 }).transient;
    };
    expect(await cls(429)).toBe(true);
    expect(await cls(503)).toBe(true);
    expect(await cls(401)).toBe(false);
    expect(await cls(402)).toBe(false);
  });
  it("treats network errors as transient and a missing key or model as permanent", async () => {
    const net = await make([new Error("socket hang up")])(req({ provider: "openrouter", model: "m" }));
    if (net.kind !== "result") throw new Error("expected result");
    expect(classifyFailure({ result: net.result, exitCode: 0 }).transient).toBe(true);
    const nokey = await make([], [], null)(req({ provider: "openrouter", model: "m" }));
    if (nokey.kind !== "result") throw new Error("expected result");
    expect(classifyFailure({ result: nokey.result, exitCode: 0 }).transient).toBe(false);
    const nomodel = await make([])(req({ provider: "openrouter", model: "" }));
    expect(nomodel.kind === "result" && nomodel.result.error).toMatch(/Choose an OpenRouter model/);
  });
  it("stops when spend passes the budget", async () => {
    const tool = { id: "c1", type: "function", function: { name: "list_notes", arguments: "{}" } };
    const out = await make([reply({ content: null, tool_calls: [tool] }, { usage: { cost: 0.9 } })])(req({ provider: "openrouter", model: "m", budgetUsd: 0.5 }));
    expect(out.kind === "result" && out.result.subtype).toBe("error_max_budget_usd");
  });
  it("cancels while a request is in flight", async () => {
    const ac = new AbortController();
    const hang: Http = () => new Promise(() => undefined);
    const b = openRouterBackend({ vault, apiKey: () => "k", http: hang });
    setTimeout(() => ac.abort(), 50);
    expect((await b(req({ provider: "openrouter", model: "m", signal: ac.signal }))).kind).toBe("cancelled");
  });
  it("times out", async () => {
    const hang: Http = () => new Promise(() => undefined);
    const b = openRouterBackend({ vault, apiKey: () => "k", http: hang });
    expect((await b(req({ provider: "openrouter", model: "m", timeoutMs: 50 }))).kind).toBe("timeout");
  });
  it("lists only tool-capable models", async () => {
    const http: Http = async () => ({ status: 200, json: { data: [{ id: "b/x", supported_parameters: ["tools"] }, { id: "a/y", supported_parameters: ["temperature"] }, { id: "a/z" }] } });
    expect(await openRouterModels(http)).toEqual(["a/z", "b/x"]);
  });
});

describe("scheduler", () => {
  const sched = { autoRun: true, time: "06:30", weekdaysOnly: true };
  const run = (over: Partial<RunRecord>): RunRecord => ({
    id: "r", job: "brief", trigger: "schedule", startedAt: "2026-10-02T05:00:00Z", status: "ok", model: "m", attempts: 1, log: [], ...over,
  });
  const at = (iso: string) => new Date(iso);
  it("runs after the brief time on a weekday", () => {
    expect(decideBrief(at("2026-10-02T05:00:00Z"), [], sched, false)).toEqual({ run: true, trigger: "schedule" }); // 07:00 SAST Fri
  });
  it("catches up later in the day", () => {
    expect(decideBrief(at("2026-10-02T10:00:00Z"), [], sched, false)).toEqual({ run: true, trigger: "catch-up" });
  });
  it("waits before the time, skips weekends and respects the toggle", () => {
    expect(decideBrief(at("2026-10-02T03:00:00Z"), [], sched, false).run).toBe(false); // 05:00
    expect(decideBrief(at("2026-10-03T05:00:00Z"), [], sched, false).run).toBe(false); // Sat
    expect(decideBrief(at("2026-10-02T05:00:00Z"), [], { ...sched, autoRun: false }, false).run).toBe(false);
  });
  it("never runs twice after a success, including a manual one", () => {
    expect(decideBrief(at("2026-10-02T09:00:00Z"), [run({ trigger: "manual" })], sched, false).run).toBe(false);
  });
  it("backs off after a failure, then catches up, then gives up", () => {
    const fail = (end: string) => run({ status: "failed", endedAt: end, startedAt: "2026-10-02T04:50:00Z" });
    expect(decideBrief(at("2026-10-02T05:05:00Z"), [fail("2026-10-02T05:00:00Z")], sched, false).run).toBe(false);
    expect(decideBrief(at("2026-10-02T05:45:00Z"), [fail("2026-10-02T05:00:00Z")], sched, false)).toEqual({ run: true, trigger: "catch-up" });
    expect(decideBrief(at("2026-10-02T09:00:00Z"), [fail("2026-10-02T05:00:00Z"), fail("2026-10-02T05:40:00Z")], sched, false).run).toBe(false);
  });
  it("does not start while busy", () => {
    expect(decideBrief(at("2026-10-02T05:00:00Z"), [], sched, true).run).toBe(false);
  });
});

describe("brief job", () => {
  it("applies results with stable ids, deduped, timeline sorted", () => {
    const b = applyBrief(
      {
        announcements: [
          { id: "DS346 A1!", level: "urgent", text: "a" },
          { id: "ds346-a1", level: "urgent", text: "dupe" },
        ],
        priorities: ["x"],
        timeline: [{ start: "14:00", title: "b" }, { start: "all-day", title: "c" }, { start: "09:00", title: "a" }],
        notes: " hi ",
        missing: [],
      },
      "2026-10-02"
    );
    expect(b.announcements.map((a) => a.id)).toEqual(["brief:ds346-a1"]);
    expect(b.timeline.map((t) => t.title)).toEqual(["c", "a", "b"]);
    expect(b.notes).toBe("hi");
  });
  it("builds a capped snapshot with the date last", () => {
    const tasks = parseTasks("a.md", "## Tasks\n" + Array.from({ length: 40 }, (_, i) => `- [ ] t${i} 📅 2026-09-${String(10 + (i % 15)).padStart(2, "0")}`).join("\n"));
    const snap = buildBriefSnapshot({
      date: "2026-10-02", weekday: "Friday", time: "07:00", tasks, radar: [],
      journal: { todayExists: false, todayHasContent: false, gapDays: 3, lastContentDate: "2026-09-29", todayPath: "Journal/20261002.md" },
      engine: [], courses: [], previous: null, acked: [],
      recentNotes: Array.from({ length: 60 }, (_, i) => ({ path: `Areas/n${i}.md`, mtime: 1_000_000 - i * 1000 })), nowMs: 1_000_000 + 3 * 86_400_000,
    });
    expect(snap.tasks.overdue).toHaveLength(25);
    expect(snap.tasks.counts.overdue).toBe(40);
    expect(snap.journal.note).toMatch(/UNVERIFIED/);
    expect(Object.keys(snap).pop()).toBe("now");
    expect(snap.recentlyEditedNotes).toHaveLength(40);
    expect(snap.recentlyEditedNotes[0]).toEqual({ path: "Areas/n0.md", edited: "3d ago" });
  });
});

describe("state", () => {
  it("marks interrupted runs as failed on load", () => {
    const s = coerceState({ schemaVersion: 1, runs: [{ id: "a", job: "brief", startedAt: "2026-10-02T05:00:00Z", status: "running" }] });
    expect(reapStaleRuns(s)).toBe(1);
    expect(s.runs[0].status).toBe("failed");
    expect(s.runs[0].error).toMatch(/Interrupted/);
  });
});
