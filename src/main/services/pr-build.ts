import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BuildBackend, PrBuildPhase } from "../../shared/types.js";

export const MAX_LOG_LINES = 4000;

const PERCENT_RE = /\[\s*(\d{1,3})%\]/;
const FRACTION_RE = /\[(\d+)\/(\d+)\]/;

export interface PrBuildCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export interface PrBuildPaths {
  buildDir: string;
  source: string;
  jobs: number;
  backend: BuildBackend;
  runners: {
    /** Nix-provided `freecad-pr-runner`. */
    prRunner: string | null;
    pixi: string | null;
  };
}

/** Build the fixed command sequence for a backend, never a shell string. */
export function buildCommands(paths: PrBuildPaths): PrBuildCommand[] {
  if (paths.backend === "pixi") {
    if (!paths.runners.pixi) throw new Error("pixi is not available; install it through Nix");
    return [
      { command: paths.runners.pixi, args: ["run", "configure"], cwd: paths.source },
      {
        command: paths.runners.pixi,
        args: ["run", "build", "--", "-j", String(paths.jobs)],
        cwd: paths.source,
      },
    ];
  }
  if (!paths.runners.prRunner) {
    throw new Error("freecad-pr-runner is not available; install it through Nix");
  }
  return [
    {
      command: paths.runners.prRunner,
      args: [
        "build",
        "--source",
        paths.source,
        "--build-dir",
        paths.buildDir,
        "--jobs",
        String(paths.jobs),
      ],
      cwd: paths.source,
    },
  ];
}

export type PrBuildLogger = (line: string, stream: "stdout" | "stderr" | "launcher") => void;

export type PrBuildReporter = (
  phase: PrBuildPhase,
  percent: number | null,
  message: string,
) => void;

export interface PrBuildResult {
  ok: boolean;
  phase: PrBuildPhase;
  executable: string | null;
  error?: string;
}

export function parseProgress(line: string): number | null {
  const percent = PERCENT_RE.exec(line);
  if (percent?.[1]) return Math.min(100, Math.max(0, Number.parseInt(percent[1], 10)));
  const fraction = FRACTION_RE.exec(line);
  if (fraction?.[1] && fraction[2]) {
    const done = Number.parseInt(fraction[1], 10);
    const total = Number.parseInt(fraction[2], 10);
    if (total > 0) return Math.min(100, Math.round((done * 100) / total));
  }
  return null;
}

export function findExecutableInBuildDir(buildDir: string): string | null {
  const candidates = [
    join(buildDir, "bin", "FreeCAD"),
    join(buildDir, "debug", "bin", "FreeCAD"),
    join(buildDir, "release", "bin", "FreeCAD"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface RunOutput {
  code: number | null;
  cancelled: boolean;
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 3000).unref?.();
}

/**
 * Owns the single PR build slot. Streams structured log lines, reports
 * progress, and kills the whole process group on cancellation.
 */
export class PrBuilder {
  private child: ChildProcess | null = null;
  private controller = new AbortController();
  private running = false;
  private currentPhase: PrBuildPhase = "idle";

  get isRunning(): boolean {
    return this.running;
  }

  get phase(): PrBuildPhase {
    return this.currentPhase;
  }

  cancel(): void {
    this.controller.abort();
    if (this.child) killProcessTree(this.child);
  }

  async run(
    paths: PrBuildPaths,
    log: PrBuildLogger,
    report: PrBuildReporter,
  ): Promise<PrBuildResult> {
    if (this.running)
      return { ok: false, phase: "failed", executable: null, error: "A build is already running" };
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const setPhase = (phase: PrBuildPhase, percent: number | null, message: string) => {
      this.currentPhase = phase;
      report(phase, percent, message);
    };

    try {
      await mkdir(paths.buildDir, { recursive: true });
      const commands = buildCommands(paths);
      for (const command of commands) {
        if (signal.aborted) {
          setPhase("cancelled", null, "Build cancelled");
          return { ok: false, phase: "cancelled", executable: null };
        }
        setPhase("compiling", 0, `Running ${command.command}`);
        log(`$ ${command.command} ${command.args.join(" ")}`, "launcher");
        const output = await this.runCommand(command, signal, log, (percent) => {
          setPhase("compiling", percent, `Compiling… ${percent}%`);
        });
        if (output.cancelled) {
          setPhase("cancelled", null, "Build cancelled");
          return { ok: false, phase: "cancelled", executable: null };
        }
        if (output.code !== 0) {
          setPhase("failed", null, `Command failed with exit code ${output.code}`);
          return {
            ok: false,
            phase: "failed",
            executable: null,
            error: `Command failed: ${command.command}`,
          };
        }
      }

      const executable =
        findExecutableInBuildDir(paths.buildDir) ??
        findExecutableInBuildDir(join(paths.source, "build")) ??
        (existsSync(join(paths.source, "build", "bin", "FreeCAD"))
          ? join(paths.source, "build", "bin", "FreeCAD")
          : null);
      if (!executable) {
        setPhase("failed", null, "Build finished but no FreeCAD executable was found");
        return {
          ok: false,
          phase: "failed",
          executable: null,
          error: "Compiled FreeCAD executable not found",
        };
      }
      setPhase("finished", 100, `Build complete: ${executable}`);
      return { ok: true, phase: "finished", executable };
    } catch (error) {
      if (signal.aborted) {
        setPhase("cancelled", null, "Build cancelled");
        return { ok: false, phase: "cancelled", executable: null };
      }
      const message = error instanceof Error ? error.message : String(error);
      log(message, "stderr");
      setPhase("failed", null, message);
      return { ok: false, phase: "failed", executable: null, error: message };
    } finally {
      this.running = false;
      this.child = null;
    }
  }

  private runCommand(
    command: PrBuildCommand,
    signal: AbortSignal,
    log: PrBuildLogger,
    onPercent: (percent: number) => void,
  ): Promise<RunOutput> {
    return new Promise<RunOutput>((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: { ...process.env, CMAKE_COLOR_DIAGNOSTICS: "OFF" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      this.child = child;
      let cancelled = false;
      let lastPercent = -1;
      const handleLine = (line: string, stream: "stdout" | "stderr") => {
        if (!line.trim()) return;
        log(line, stream);
        const percent = parseProgress(line);
        if (percent !== null && percent !== lastPercent) {
          lastPercent = percent;
          onPercent(percent);
        }
      };
      const pipe = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
        let buffer = "";
        stream?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            handleLine(buffer.slice(0, index), name);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
          }
        });
        stream?.on("end", () => {
          if (buffer) handleLine(buffer, name);
        });
      };
      pipe(child.stdout, "stdout");
      pipe(child.stderr, "stderr");

      const onAbort = () => {
        cancelled = true;
        killProcessTree(child);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        signal.removeEventListener("abort", onAbort);
        log(error.message, "stderr");
        resolve({ code: null, cancelled });
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ code, cancelled });
      });
    });
  }
}

/** Remove a PR's build output only, leaving the worktree intact. */
export async function cleanBuildDir(buildDir: string): Promise<void> {
  await rm(buildDir, { recursive: true, force: true });
}
