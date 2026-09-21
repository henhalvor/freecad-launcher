import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  InstalledRelease,
  LaunchPlan,
  LaunchResult,
  ProfilePaths,
} from "../../shared/types.js";

/** Qt/Python variables that leak from a desktop session and destabilise FreeCAD. */
export const ENV_UNSET = [
  "QT_STYLE_OVERRIDE",
  "QT_QPA_PLATFORMTHEME",
  "QT_PLUGIN_PATH",
  "QML2_IMPORT_PATH",
  "PYTHONPATH",
  "PYTHONUSERBASE",
] as const;

/** NixOS-safe platform and integration variables, always forced. */
export const ENV_SET: Record<string, string> = {
  QT_QPA_PLATFORM: "xcb",
  SDL_VIDEODRIVER: "x11",
  DESKTOPINTEGRATION: "1",
};

export interface BuildLaunchOptions {
  release: InstalledRelease;
  appimageRun: string;
  profile: ProfilePaths;
  projectFiles?: string[];
  singleInstance?: boolean;
  tutorialHidpi?: boolean;
}

/** Build the full argv and environment overlay for a launch. */
export function buildLaunchPlan(options: BuildLaunchOptions): LaunchPlan {
  const { release, appimageRun, profile } = options;
  const projectFiles = (options.projectFiles ?? []).filter((file) => file.length > 0);
  const args = [release.path, "-u", profile.userCfg, "-s", profile.systemCfg];
  if (options.singleInstance) args.push("--single-instance");
  args.push(...projectFiles);

  const env: Record<string, string | null> = { ...ENV_SET };
  for (const key of ENV_UNSET) env[key] = null;
  env.FREECAD_USER_HOME = profile.dataDir;
  if (options.tutorialHidpi) {
    env.QT_SCALE_FACTOR = "1.66";
    env.QT_AUTO_SCREEN_SCALE_FACTOR = "0";
    env.XCURSOR_SIZE = "80";
  }

  return {
    releaseId: release.id,
    channel: release.channel,
    appimageRun,
    appImagePath: release.path,
    projectFiles,
    singleInstance: Boolean(options.singleInstance),
    profile,
    tutorialHidpi: Boolean(options.tutorialHidpi),
    env,
    argv: [appimageRun, ...args],
    extractAndRun: false,
  };
}

export interface BuildBinaryLaunchOptions {
  executable: string;
  profile: ProfilePaths;
  projectFiles?: string[];
  singleInstance?: boolean;
  tutorialHidpi?: boolean;
}

/** Launch plan for a natively compiled build (a PR), not an AppImage. */
export function buildBinaryLaunchPlan(options: BuildBinaryLaunchOptions): LaunchPlan {
  const projectFiles = (options.projectFiles ?? []).filter((file) => file.length > 0);
  const args = ["-u", options.profile.userCfg, "-s", options.profile.systemCfg];
  if (options.singleInstance) args.push("--single-instance");
  args.push(...projectFiles);
  const env: Record<string, string | null> = { ...ENV_SET };
  for (const key of ENV_UNSET) env[key] = null;
  env.FREECAD_USER_HOME = options.profile.dataDir;
  if (options.tutorialHidpi) {
    env.QT_SCALE_FACTOR = "1.66";
    env.QT_AUTO_SCREEN_SCALE_FACTOR = "0";
    env.XCURSOR_SIZE = "80";
  }
  return {
    releaseId: "pr-binary",
    channel: "stable",
    appimageRun: options.executable,
    appImagePath: options.executable,
    projectFiles,
    singleInstance: Boolean(options.singleInstance),
    profile: options.profile,
    tutorialHidpi: Boolean(options.tutorialHidpi),
    env,
    argv: [options.executable, ...args],
    extractAndRun: false,
  };
}

/** Produce a concrete environment for `child_process.spawn`. */
export function materializeEnv(
  plan: LaunchPlan,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(plan.env)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  if (plan.extractAndRun) env.APPIMAGE_EXTRACT_AND_RUN = "1";
  return env;
}

/** A copy of the plan that retries in extract-and-run mode. */
export function extractAndRunPlan(plan: LaunchPlan): LaunchPlan {
  return { ...plan, extractAndRun: true };
}

const FUSE_SIGNATURE = /fuse|dlopen|libfuse|appimage/i;

export interface LaunchHandle {
  plan: LaunchPlan;
  pid: number | undefined;
  /** Resolves with the outcome of the final attempt. */
  result: Promise<LaunchResult>;
  cancel: () => void;
}

export interface StartLaunchOptions {
  plan: LaunchPlan;
  baseEnv?: NodeJS.ProcessEnv;
  /** Called when the child fails fast with a FUSE/runtime signature. */
  onExtractRetry?: (plan: LaunchPlan) => void;
  spawnImpl?: typeof spawn;
}

/**
 * Spawn a launch and, when the AppImage runtime fails fast with a
 * FUSE/dlopen signature, transparently retry in extract-and-run mode.
 */
export function startLaunch(options: StartLaunchOptions): LaunchHandle {
  const spawnImpl = options.spawnImpl ?? spawn;
  const baseEnv = options.baseEnv ?? process.env;
  let current: ChildProcess | null = null;
  let cancelled = false;

  const run = (plan: LaunchPlan): Promise<LaunchResult> =>
    new Promise<LaunchResult>((resolve) => {
      const [command, ...args] = plan.argv;
      if (!command) {
        resolve({ ok: false, runtimeKind: "native", error: "Empty launch command" });
        return;
      }
      const startedAt = Date.now();
      let fuseSignature = false;
      const child = spawnImpl(command, args, {
        env: materializeEnv(plan, baseEnv),
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      current = child;
      child.stderr?.on("data", (chunk: Buffer) => {
        if (Date.now() - startedAt <= 2000 && FUSE_SIGNATURE.test(chunk.toString("utf8"))) {
          fuseSignature = true;
        }
      });
      child.on("error", (error) => {
        resolve({
          ok: false,
          runtimeKind: plan.extractAndRun ? "extract-and-run" : "native",
          error: error.message,
        });
      });
      child.on("close", async (code) => {
        current = null;
        if (cancelled) {
          resolve({
            ok: true,
            runtimeKind: plan.extractAndRun ? "extract-and-run" : "native",
            pid: child.pid,
          });
          return;
        }
        if (code === 0) {
          resolve({
            ok: true,
            runtimeKind: plan.extractAndRun ? "extract-and-run" : "native",
            pid: child.pid,
          });
          return;
        }
        const fastFailure = Date.now() - startedAt <= 2000;
        if (!plan.extractAndRun && fastFailure && fuseSignature) {
          const retryPlan = extractAndRunPlan(plan);
          options.onExtractRetry?.(retryPlan);
          const retry = await run(retryPlan);
          resolve(retry);
          return;
        }
        resolve({
          ok: false,
          runtimeKind: plan.extractAndRun ? "extract-and-run" : "native",
          pid: child.pid,
          error: `FreeCAD exited with code ${code}`,
        });
      });
    });

  const result = run(options.plan);

  return {
    plan: options.plan,
    get pid() {
      return current?.pid;
    },
    result,
    cancel: () => {
      cancelled = true;
      if (current?.pid) {
        try {
          process.kill(-current.pid, "SIGTERM");
        } catch {
          current.kill("SIGTERM");
        }
      }
    },
  };
}

/** Locate the Nix-provided appimage-run. Never falls back to a guessed path. */
export function resolveAppimageRun(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.APPIMAGE_RUN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/appimage-run`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
