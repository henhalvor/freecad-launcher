import type {
  AppConfig,
  AppPaths,
  InstalledRelease,
  LaunchPlan,
  LaunchResult,
  ProfilePaths,
  StatsFile,
} from "../../shared/types.js";
import { buildLaunchPlan, startLaunch } from "./launch.js";
import {
  applyStartPageSetting,
  cleanupProfile,
  ensureProfileDirs,
  materializeVanillaProfile,
  resolveProfile,
} from "./profiles.js";
import { recordSessionAndSave, releaseStatKey } from "./stats.js";

/** How long to wait for an immediate spawn failure before reporting success. */
const SPAWN_GRACE_MS = 1200;

export interface LaunchReleaseOptions {
  paths: AppPaths;
  config: AppConfig;
  release: InstalledRelease;
  appimageRun: string;
  stats: StatsFile;
  projectFiles?: string[];
  singleInstance?: boolean;
  vanilla?: boolean;
  tutorialHidpi?: boolean;
  prNumber?: number;
  baseEnv?: NodeJS.ProcessEnv;
  onPlan?: (plan: LaunchPlan) => void;
}

export interface SessionCompletion {
  result: LaunchResult;
  stats: StatsFile;
}

export interface LaunchReleaseOutcome {
  /** Resolves as soon as the process is running (or fails fast). */
  initial: Promise<LaunchResult>;
  /** Resolves when the FreeCAD process exits and the session is recorded. */
  completion: Promise<SessionCompletion>;
  plan: LaunchPlan;
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

export interface LaunchSessionOptions {
  plan: LaunchPlan;
  paths: AppPaths;
  stats: StatsFile;
  statKey: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Removed after exit when the profile is ephemeral (vanilla). */
  ephemeralProfile?: ProfilePaths;
}

/**
 * Spawn a prepared plan and track the session. `initial` resolves once the
 * process is running (or fails fast); `completion` resolves on exit.
 */
export function launchPlanSession(options: LaunchSessionOptions): {
  initial: Promise<LaunchResult>;
  completion: Promise<SessionCompletion>;
} {
  const startedAt = Date.now();
  const handle = startLaunch({
    plan: options.plan,
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
  });

  const completion: Promise<SessionCompletion> = (async () => {
    const result = await handle.result;
    const durationSec = (Date.now() - startedAt) / 1000;
    if (options.ephemeralProfile) await cleanupProfile(options.ephemeralProfile);
    let stats = options.stats;
    if (result.runtimeKind === "native") {
      stats = await recordSessionAndSave(options.paths, stats, {
        key: options.statKey,
        durationSec,
      });
    }
    return { result, stats };
  })();

  const initial = (async (): Promise<LaunchResult> => {
    const raced = await Promise.race([completion, delay(SPAWN_GRACE_MS)]);
    if (raced === null) {
      return {
        ok: true,
        runtimeKind: options.plan.extractAndRun ? "extract-and-run" : "native",
        ...(handle.pid ? { pid: handle.pid } : {}),
      };
    }
    return raced.result;
  })();

  return { initial, completion };
}

/**
 * Resolve the profile, apply the channel's settings, launch the release through
 * appimage-run, and record sessions longer than five seconds. The caller can
 * await `initial` for responsiveness while `completion` tracks the session in
 * the background. Extract-and-run fallbacks are intentionally not counted.
 */
export async function launchRelease(options: LaunchReleaseOptions): Promise<LaunchReleaseOutcome> {
  const vanilla = options.vanilla ?? options.config.vanilla;
  let profile = resolveProfile(options.paths, {
    channel: options.release.channel,
    ...(options.prNumber ? { prNumber: options.prNumber } : {}),
    vanilla,
    ...(options.baseEnv ? { env: options.baseEnv } : {}),
  });
  if (vanilla) profile = await materializeVanillaProfile(profile);
  await ensureProfileDirs(profile);
  await applyStartPageSetting(profile, options.config.disableFreecadStartPage);

  const plan = buildLaunchPlan({
    release: options.release,
    appimageRun: options.appimageRun,
    profile,
    projectFiles: options.projectFiles ?? [],
    singleInstance: options.singleInstance ?? false,
    tutorialHidpi: options.tutorialHidpi ?? options.config.tutorialHidpi,
  });
  options.onPlan?.(plan);

  const { initial, completion } = launchPlanSession({
    plan,
    paths: options.paths,
    stats: options.stats,
    statKey: releaseStatKey(options.release.id),
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    ephemeralProfile: profile,
  });

  return { initial, completion, plan };
}
