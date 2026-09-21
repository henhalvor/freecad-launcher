import { EVENTS } from "../shared/channels.js";
import type { InstalledRelease, LaunchResult, ReleaseChannel } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { launchRelease } from "./services/launcher.js";
import { readInstalledRelease, scanInstalled } from "./services/version-store.js";

/** Choose the release a channel-following invocation should launch. */
export async function resolveChannelRelease(
  ctx: AppContext,
  channel: ReleaseChannel,
): Promise<InstalledRelease | null> {
  const defaultId = ctx.config.channelDefaults[channel];
  if (defaultId) {
    const release = await readInstalledRelease(ctx.effectivePaths, defaultId);
    if (release?.intact) return release;
  }
  const installed = await scanInstalled(ctx.effectivePaths);
  return installed.find((release) => release.channel === channel && release.intact) ?? null;
}

export interface CliLaunchInput {
  channel: ReleaseChannel | null;
  version: string | null;
  singleInstance: boolean;
  files: string[];
}

/** Execute a `freecad-launcher launch …` invocation from a desktop entry. */
export async function executeLaunchCommand(
  ctx: AppContext,
  input: CliLaunchInput,
): Promise<LaunchResult> {
  if (!ctx.tools.appimageRun) {
    throw new Error("appimage-run was not found; FreeCAD Launcher must be installed through Nix");
  }

  let release: InstalledRelease | null = null;
  if (input.version) {
    release = await readInstalledRelease(ctx.effectivePaths, input.version);
    if (!release) throw new Error(`Release ${input.version} is not installed`);
  } else if (input.channel) {
    release = await resolveChannelRelease(ctx, input.channel);
    if (!release) throw new Error(`No installed FreeCAD ${input.channel} release to launch`);
  }
  if (!release) throw new Error("No release selected");

  ctx.runningReleaseIds.add(release.id);
  try {
    const outcome = await launchRelease({
      paths: ctx.effectivePaths,
      config: ctx.config,
      release,
      appimageRun: ctx.tools.appimageRun,
      stats: ctx.stats,
      projectFiles: input.files,
      singleInstance: input.singleInstance,
    });
    const { result, stats } = await outcome.completion;
    ctx.stats = stats;
    ctx.broadcast(EVENTS.statsChanged, stats);
    return result;
  } finally {
    ctx.runningReleaseIds.delete(release.id);
  }
}
