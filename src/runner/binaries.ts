import { existsSync } from "fs";
import { homedir } from "os";
import { runProcess } from "./claude";

let cachedPath: Promise<string> | undefined;

/** Obsidian launched from the dock doesn't get the shell PATH, so ask a login shell once. */
export function loginPath(): Promise<string> {
  const home = homedir();
  const fallback = [process.env.PATH, `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.npm-global/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(":");
  cachedPath ??= (async () => {
    let out = "";
    await runProcess(
      {
        binary: process.env.SHELL || "/bin/zsh",
        args: ["-ilc", 'printf "__VD__%s__VD__\\n" "$PATH"'],
        prompt: "",
        cwd: home,
        env: { ...process.env, PATH: fallback },
        timeoutMs: 8000,
      },
      (line) => {
        out += line + "\n";
      }
    );
    const found = /__VD__(.*?)__VD__/s.exec(out)?.[1];
    return found ? `${found}:${fallback}` : fallback;
  })().catch(() => fallback);
  return cachedPath;
}

/** Find a CLI: explicit override first, then every directory on the login PATH. */
export async function findBinary(name: string, override: string): Promise<string | undefined> {
  if (override.trim()) return existsSync(override.trim()) ? override.trim() : undefined;
  const path = await loginPath();
  for (const dir of path.split(":")) {
    const candidate = `${dir.replace(/\/$/, "")}/${name}`;
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}
