import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths, BuildBackend, PrWorkspace } from "../../shared/types.js";
import { pathExists } from "./atomic-json.js";

export const FREECAD_REPO_URL = "https://github.com/FreeCAD/FreeCAD.git";
export const PR_REF_PREFIX = "refs/freecad-launcher/pr";

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runGit(
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
  } = {},
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const emit = (chunk: Buffer, into: "out" | "err") => {
      const text = chunk.toString("utf8");
      if (into === "out") stdout += text;
      else stderr += text;
      if (!options.onLine) return;
      buffer += text;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        options.onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => emit(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => emit(chunk, "err"));
    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (buffer && options.onLine) options.onLine(buffer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export interface MirrorOptions {
  paths: AppPaths;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

/** Ensure the launcher-owned bare mirror of FreeCAD/FreeCAD exists. */
export async function ensureMirror(options: MirrorOptions): Promise<string> {
  const { paths } = options;
  const mirror = paths.prMirrorDir;
  await mkdir(join(paths.prDir), { recursive: true });
  const isRepo = await pathExists(join(mirror, "HEAD"));
  if (!isRepo) {
    await rm(mirror, { recursive: true, force: true });
    await mkdir(mirror, { recursive: true });
    const result = await runGit(["init", "--bare", mirror], { onLine: options.onLog });
    if (!result.ok)
      throw new Error(`Failed to create PR mirror: ${result.stderr || result.stdout}`);
    await runGit(["remote", "add", "origin", FREECAD_REPO_URL], {
      cwd: mirror,
      onLine: options.onLog,
    });
  }
  return mirror;
}

export function worktreeDir(paths: AppPaths, number: number): string {
  return join(paths.prWorktreesDir, String(number));
}

export function buildDirFor(paths: AppPaths, number: number, backend: BuildBackend): string {
  return join(worktreeDir(paths, number), "build", backend === "pixi" ? "pixi" : "launcher");
}

export function workspaceFor(paths: AppPaths, number: number, backend: BuildBackend): PrWorkspace {
  return {
    number,
    mirrorDir: paths.prMirrorDir,
    worktreeDir: worktreeDir(paths, number),
    buildDir: buildDirFor(paths, number, backend),
    backend,
    preparedAt: null,
    builtAt: null,
    executable: null,
    headSha: null,
  };
}

export interface PreparePrOptions {
  paths: AppPaths;
  number: number;
  backend: BuildBackend;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  onPhase?: (phase: "fetching" | "preparing", message: string) => void;
}

/**
 * Fetch `pull/<n>/head` into the launcher namespace and check it out in the
 * launcher-owned worktree. The user's own checkout is never touched.
 */
export async function preparePrWorktree(options: PreparePrOptions): Promise<PrWorkspace> {
  const { paths, number, backend } = options;
  const log = options.onLog ?? (() => undefined);
  const mirror = await ensureMirror({
    paths,
    ...(options.signal ? { signal: options.signal } : {}),
    onLog: log,
  });
  const ref = `${PR_REF_PREFIX}/${number}`;

  options.onPhase?.("fetching", `Fetching PR #${number}…`);
  log(`$ git fetch origin pull/${number}/head:${ref} --force`);
  const fetch = await runGit(["fetch", "origin", `pull/${number}/head:${ref}`, "--force"], {
    cwd: mirror,
    ...(options.signal ? { signal: options.signal } : {}),
    onLine: log,
  });
  if (!fetch.ok) throw new Error(`Failed to fetch PR #${number}: ${fetch.stderr || fetch.stdout}`);

  options.onPhase?.("preparing", `Preparing worktree for PR #${number}…`);
  await mkdir(paths.prWorktreesDir, { recursive: true });
  const dir = worktreeDir(paths, number);
  const alreadyWorktree = await pathExists(join(dir, ".git"));
  if (!alreadyWorktree) {
    await rm(dir, { recursive: true, force: true });
    log(`$ git worktree add --force ${dir} ${ref}`);
    const add = await runGit(["worktree", "add", "--force", dir, ref], {
      cwd: mirror,
      ...(options.signal ? { signal: options.signal } : {}),
      onLine: log,
    });
    if (!add.ok) throw new Error(`Failed to create worktree: ${add.stderr || add.stdout}`);
  } else {
    const reset = await runGit(["checkout", "--force", ref], {
      cwd: dir,
      ...(options.signal ? { signal: options.signal } : {}),
      onLine: log,
    });
    if (!reset.ok) throw new Error(`Failed to reset worktree: ${reset.stderr || reset.stdout}`);
    await runGit(["reset", "--hard", ref], { cwd: dir, onLine: log });
  }

  const head = await runGit(["rev-parse", "HEAD"], { cwd: dir });
  await runGit(["submodule", "update", "--init", "--recursive"], {
    cwd: dir,
    ...(options.signal ? { signal: options.signal } : {}),
    onLine: log,
  });

  return {
    ...workspaceFor(paths, number, backend),
    preparedAt: new Date().toISOString(),
    headSha: head.stdout.trim() || null,
  };
}

/** Remove the managed worktree and its build output for a PR. */
export async function removePrWorkspace(paths: AppPaths, number: number): Promise<void> {
  const dir = worktreeDir(paths, number);
  if (await pathExists(join(dir, ".git"))) {
    await runGit(["worktree", "remove", "--force", dir], { cwd: paths.prMirrorDir });
    await runGit(["worktree", "prune"], { cwd: paths.prMirrorDir });
  }
  await rm(dir, { recursive: true, force: true });
}

export function findPrExecutable(dir: string): string | null {
  const candidates = [
    join(dir, "build", "debug", "bin", "FreeCAD"),
    join(dir, "build", "release", "bin", "FreeCAD"),
    join(dir, "build", "bin", "FreeCAD"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
