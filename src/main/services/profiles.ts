import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppPaths, ProfilePaths, ReleaseChannel } from "../../shared/types.js";
import { pathExists, writeTextAtomic } from "./atomic-json.js";
import { disableStartPageInConfig } from "./freecad-xml.js";
import { channelProfileDirs } from "./xdg.js";

export interface ProfileRequest {
  channel: ReleaseChannel;
  releaseId?: string;
  prNumber?: number;
  vanilla?: boolean;
  env?: NodeJS.ProcessEnv;
}

function build(
  kind: ProfilePaths["kind"],
  configDir: string,
  dataDir: string,
  ephemeral: boolean,
): ProfilePaths {
  return {
    kind,
    configDir,
    dataDir,
    userCfg: join(configDir, "user.cfg"),
    systemCfg: join(configDir, "system.cfg"),
    ephemeral,
  };
}

/**
 * Resolve the profile locations for a launch. Stable and weekly keep the
 * historical Python-launcher paths; PRs get a persistent per-PR profile under
 * launcher data; vanilla gets a throwaway temp profile removed after exit.
 */
export function resolveProfile(paths: AppPaths, request: ProfileRequest): ProfilePaths {
  const env = request.env ?? process.env;
  if (request.vanilla) {
    return build("vanilla", "", "", true);
  }
  if (request.prNumber && Number.isInteger(request.prNumber)) {
    const root = join(paths.prProfilesDir, String(request.prNumber));
    return build("pr", join(root, "config"), join(root, "data"), false);
  }
  const dirs = channelProfileDirs(request.channel, env);
  return build(request.channel, dirs.configDir, dirs.dataDir, false);
}

/** Create a temporary directory for a vanilla profile. */
export async function materializeVanillaProfile(profile: ProfilePaths): Promise<ProfilePaths> {
  const root = await mkdtemp(join(tmpdir(), "freecad-launcher-vanilla-"));
  return {
    ...profile,
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    userCfg: join(root, "config", "user.cfg"),
    systemCfg: join(root, "config", "system.cfg"),
    ephemeral: true,
  };
}

export async function ensureProfileDirs(profile: ProfilePaths): Promise<void> {
  await mkdir(profile.configDir, { recursive: true });
  await mkdir(profile.dataDir, { recursive: true });
}

export async function cleanupProfile(profile: ProfilePaths): Promise<void> {
  if (!profile.ephemeral) return;
  const root = join(profile.configDir, "..");
  await rm(root, { recursive: true, force: true });
}

/**
 * Apply the explicit "disable FreeCAD start page" setting to the selected
 * channel profile's `user.cfg`. Does nothing when the file is absent, so a
 * first launch lets FreeCAD create its own defaults.
 */
export async function applyStartPageSetting(
  profile: ProfilePaths,
  disabled: boolean,
): Promise<void> {
  if (!disabled) return;
  if (!(await pathExists(profile.userCfg))) return;
  const source = await readFile(profile.userCfg, "utf8");
  const updated = disableStartPageInConfig(source);
  if (updated !== source) await writeTextAtomic(profile.userCfg, updated);
}
