import type { DigestStateV1, JobId, RunRecord, RunTrigger } from "../state/schema";
import { MAX_RUNS } from "../state/schema";
import { effortFor, type AgentBackend, type Provider } from "./provider";
import { ApplyError } from "./jobs/execute";
import { classifyFailure } from "./errors";
import { structuredFrom } from "./stream";
import { Schema, validate } from "./validate";

export interface RunnerConfig {
  provider: Provider;
  model: string;
  effort: string;
  fallbackModel: string;
  budgetUsd: number;
  timeoutMs: number;
  dryRun: boolean;
  /** Backoff before each retry, in ms. Length = max retries. */
  backoffMs: number[];
}

export interface JobDef {
  id: JobId;
  schema: Schema;
  tools: string[];
  /** System prompt and task text, read fresh on every run so edits apply without a reload. */
  prompts(provider: Provider): Promise<{ system: string; task: string }>;
  /** Per-job overrides, e.g. the command bar's agent should be quick and cheap. */
  effort?: string;
  budgetUsd?: number;
  timeoutMs?: number;
  /** True when applying the result edits notes. Those wait for approval in dry-run; others apply at once. */
  writesVault: boolean;
  /** Precomputed state handed to the model as fenced JSON. `args` carries user input, like the close form. */
  snapshot(args?: unknown): unknown | Promise<unknown>;
  /** Apply a validated result. Called directly, or later from the pending list. */
  apply(result: unknown, runId: string, args?: unknown): Promise<void>;
}

export interface RunnerDeps {
  state: () => DigestStateV1;
  save: () => Promise<void>;
  config: () => RunnerConfig;
  /** Dispatches to the configured provider's backend. */
  agent: AgentBackend;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  uuid: () => string;
}

const LOG_CAP = 60;

export class JobRunner {
  current: { run: RunRecord; abort: AbortController } | null = null;
  progress = "";
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private waiting = 0;

  constructor(private deps: RunnerDeps, private jobs: Record<JobId, JobDef>) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  isBusy() {
    return this.current !== null || this.waiting > 0;
  }

  /** FIFO, single-flight: one `claude` process at a time. */
  run(job: JobId, trigger: RunTrigger, args?: unknown): Promise<RunRecord> {
    this.waiting++;
    const p = this.queue.then(() => this.execute(job, trigger, args)).finally(() => this.waiting--);
    this.queue = p.catch(() => undefined);
    return p;
  }

  cancel() {
    this.current?.abort.abort();
  }

  private log(run: RunRecord, line: string) {
    run.log.push(`${this.deps.now().toISOString().slice(11, 19)} ${line}`);
    if (run.log.length > LOG_CAP) run.log.splice(0, run.log.length - LOG_CAP);
  }

  private async execute(jobId: JobId, trigger: RunTrigger, args?: unknown): Promise<RunRecord> {
    const d = this.deps;
    const cfg = d.config();
    const job = this.jobs[jobId];
    const run: RunRecord = {
      id: d.uuid(),
      job: jobId,
      trigger,
      startedAt: d.now().toISOString(),
      status: "running",
      provider: cfg.provider,
      model: cfg.model,
      effort: (job.effort ?? cfg.effort) || undefined,
      attempts: 0,
      log: [],
      dryRun: cfg.dryRun && job.writesVault,
    };
    const abort = new AbortController();
    this.current = { run, abort };
    this.progress = "Starting…";
    const state = d.state();
    state.runs.unshift(run);
    state.runs.length = Math.min(state.runs.length, MAX_RUNS);
    this.log(run, `started (${trigger}) ${cfg.provider} model=${cfg.model || "default"}`);
    await d.save();
    this.emit();

    let cost = 0;
    try {
      const { system, task } = await job.prompts(cfg.provider);
      const snapshot = JSON.stringify(await job.snapshot(args), null, 1);
      let prompt = `${task}\n\n## Snapshot\n\n\`\`\`json\n${snapshot}\n\`\`\`\n`;
      let schemaRetried = false;

      for (;;) {
        run.attempts++;
        const sessionId = d.uuid();
        this.log(run, `attempt ${run.attempts}`);
        const outcome = await d.agent({
          provider: cfg.provider,
          model: cfg.model,
          effort: effortFor(cfg.provider, job.effort ?? cfg.effort),
          fallbackModel: cfg.provider === "claude-code" ? cfg.fallbackModel : "",
          budgetUsd: job.budgetUsd ?? cfg.budgetUsd,
          system,
          prompt,
          schema: job.schema,
          claudeTools: job.tools,
          sessionId,
          timeoutMs: job.timeoutMs ?? cfg.timeoutMs,
          signal: abort.signal,
          onProgress: (line) => {
            this.progress = line;
            this.log(run, line);
            this.emit();
          },
        });

        if (outcome.kind === "cancelled") {
          run.status = "cancelled";
          this.log(run, "cancelled");
          break;
        }
        if (outcome.kind === "timeout") {
          run.status = "failed";
          run.error = `Timed out after ${Math.round((job.timeoutMs ?? cfg.timeoutMs) / 1000)}s.`;
          this.log(run, run.error);
          break;
        }

        const result = outcome.kind === "result" ? outcome.result : undefined;
        if (result?.costUsd) cost += result.costUsd;
        if (result?.sessionId) run.sessionId = result.sessionId;

        if (result?.ok) {
          const out = structuredFrom(result);
          const errors = out === undefined ? ["no structured output was returned"] : validate(out, job.schema);
          if (!errors.length) {
            if (run.dryRun) {
              d.state().pending.push({ runId: run.id, job: jobId, at: d.now().toISOString(), result: out });
              this.log(run, "result held for approval (dry-run)");
            } else {
              await job.apply(out, run.id, args);
              this.log(run, "result applied");
            }
            run.status = "ok";
            break;
          }
          this.log(run, `invalid output: ${errors.slice(0, 3).join("; ")}`);
          if (!schemaRetried) {
            schemaRetried = true;
            prompt += `\n\nYour previous answer failed validation:\n${errors.map((e) => `- ${e}`).join("\n")}\nReturn a corrected result.\n`;
            continue;
          }
          run.status = "rejected";
          run.error = `Output failed validation: ${errors.slice(0, 3).join("; ")}`;
          break;
        }

        const failure = classifyFailure({
          result,
          exitCode: outcome.kind === "exit" || outcome.kind === "result" ? outcome.exitCode : undefined,
          stderr: outcome.stderr,
          spawnError: outcome.kind === "spawn-error" ? outcome.message : undefined,
        });
        this.log(run, `failed: ${failure.message.slice(0, 200)}`);
        const delay = cfg.backoffMs[run.attempts - 1];
        if (failure.transient && delay !== undefined) {
          this.progress = `Retrying in ${Math.round(delay / 1000)}s…`;
          this.log(run, this.progress);
          this.emit();
          await d.sleep(delay);
          if (abort.signal.aborted) {
            run.status = "cancelled";
            break;
          }
          continue;
        }
        run.status = "failed";
        run.error = failure.message.slice(0, 500);
        break;
      }
    } catch (e) {
      run.status = "failed";
      // Apply errors (like a missing RAW boundary) are the user's to act on, so show them plainly.
      run.error = e instanceof ApplyError ? e.message : `Internal error: ${(e as Error).message}`;
      this.log(run, run.error);
    } finally {
      run.endedAt = d.now().toISOString();
      if (cost) run.costUsd = Math.round(cost * 10_000) / 10_000;
      this.current = null;
      this.progress = "";
      await d.save();
      this.emit();
    }
    return run;
  }
}
