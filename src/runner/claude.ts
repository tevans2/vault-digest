import { spawn, ChildProcess } from "child_process";
import { ClaudeResult, parseLine, progressOf, resultOf } from "./stream";

/** A process to run with a prompt on stdin. Shared by every CLI backend. */
export interface ProcessSpec {
  binary: string;
  args: string[];
  /** Sent on stdin so large snapshots never hit argv limits. */
  prompt: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ClaudeSpec extends ProcessSpec {
  onProgress?: (line: string) => void;
}

export type ProcessOutcome =
  | { kind: "exit"; exitCode: number | null; stderr: string }
  | { kind: "timeout"; stderr: string }
  | { kind: "cancelled"; stderr: string }
  | { kind: "spawn-error"; message: string; stderr: string };

export type ClaudeOutcome =
  | { kind: "result"; result: ClaudeResult; stderr: string; exitCode: number | null }
  | ProcessOutcome;

const KILL_GRACE_MS = 5000;
const STDERR_CAP = 8000;

/** Electron doesn't inherit the login shell, so build PATH explicitly. */
export function buildEnv(
  path?: string,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const home = process.env.HOME ?? "";
  const fallback = [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return { ...process.env, PATH: path ?? fallback, _ZO_DOCTOR: "0", ...extra };
}

/** Run a process, feed it the prompt, stream stdout lines, kill the whole group on timeout or abort. */
export function runProcess(spec: ProcessSpec, onLine?: (line: string) => void): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let stderr = "";
    let buf = "";
    let settled = false;
    let reason: "timeout" | "cancelled" | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (o: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };

    try {
      child = spawn(spec.binary, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? buildEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // own process group, so we can kill children too
      });
    } catch (e) {
      return resolve({ kind: "spawn-error", message: (e as Error).message, stderr });
    }

    const kill = (r: "timeout" | "cancelled") => {
      if (reason) return;
      reason = r;
      signalGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => kill("cancelled");
    const timer = setTimeout(() => kill("timeout"), spec.timeoutMs);
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine?.(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      stderr = (stderr + c).slice(-STDERR_CAP);
    });

    child.on("error", (e) => finish({ kind: "spawn-error", message: e.message, stderr }));
    child.on("close", (code) => {
      if (buf.trim()) onLine?.(buf);
      if (reason === "timeout") return finish({ kind: "timeout", stderr });
      if (reason === "cancelled") return finish({ kind: "cancelled", stderr });
      finish({ kind: "exit", exitCode: code, stderr });
    });

    child.stdin?.on("error", () => undefined); // EPIPE if it dies early
    child.stdin?.end(spec.prompt);
  });
}

/** Claude Code: parse stream-json lines into progress and the final result event. */
export async function runClaude(spec: ClaudeSpec): Promise<ClaudeOutcome> {
  let result: ClaudeResult | null = null;
  const o = await runProcess(spec, (line) => {
    const ev = parseLine(line);
    if (!ev) return;
    const p = progressOf(ev);
    if (p) spec.onProgress?.(p);
    const r = resultOf(ev);
    if (r) result = r;
  });
  if (o.kind === "exit" && result) return { kind: "result", result, stderr: o.stderr, exitCode: o.exitCode };
  return o;
}

function signalGroup(child: ChildProcess, sig: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}
