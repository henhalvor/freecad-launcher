import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_UNSET } from "./launch.js";

export interface ConsoleRunOptions {
  appimageRun: string;
  appimage: string;
  script: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ConsoleRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  attempts: number;
}

function buildEnv(
  baseEnv: NodeJS.ProcessEnv,
  dataDir: string,
  configDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of ENV_UNSET) delete env[key];
  env.QT_QPA_PLATFORM = "offscreen";
  env.SDL_VIDEODRIVER = "dummy";
  env.DESKTOPINTEGRATION = "1";
  env.FREECAD_USER_HOME = dataDir;
  env.APPIMAGE_EXTRACT_AND_RUN = env.APPIMAGE_EXTRACT_AND_RUN ?? "";
  return env;
}

function runOnce(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ConsoleRunResult> {
  return new Promise<ConsoleRunResult>((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({
          ok: false,
          stdout,
          stderr: `${stderr}\nTimed out after ${timeoutMs}ms`,
          attempts: 1,
        });
      }
    }, timeoutMs);
    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve({ ok: false, stdout, stderr: `${stderr}\nCancelled`, attempts: 1 });
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`, attempts: 1 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: code === 0, stdout, stderr, attempts: 1 });
    });
  });
}

/**
 * Run a Python macro with a FreeCAD AppImage in console mode using a throwaway
 * profile, trying the documented console entry points in turn.
 */
export async function runFreecadConsole(options: ConsoleRunOptions): Promise<ConsoleRunResult> {
  const baseEnv = options.baseEnv ?? process.env;
  const root = await mkdtemp(join(tmpdir(), "freecad-launcher-console-"));
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  await writeFile(join(root, ".keep"), "");
  const env = buildEnv(baseEnv, dataDir, configDir);
  const script = options.script;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const attempts: string[][] = [
    ["-c", script],
    ["--console", script],
    ["--console", "-c", script],
  ];
  try {
    let last: ConsoleRunResult = { ok: false, stdout: "", stderr: "", attempts: 0 };
    for (const extra of attempts) {
      if (options.signal?.aborted) return { ...last, stderr: `${last.stderr}\nCancelled` };
      const result = await runOnce(
        options.appimageRun,
        [options.appimage, ...extra],
        env,
        timeoutMs,
        options.signal,
      );
      last = { ...result, attempts: last.attempts + 1 };
      if (result.ok) return last;
    }
    return last;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Read a file the macro wrote, tolerating absence. */
export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
