import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { AppPaths } from "../../shared/types.js";

const APP = "freecad-launcher";

function xdgDir(envVar: string, fallback: string, env: NodeJS.ProcessEnv): string {
  const value = env[envVar];
  if (value && value.trim() !== "" && isAbsolute(value)) return normalize(value);
  return join(homedir(), fallback);
}

export interface BaseDirs {
  config: string;
  data: string;
  state: string;
  cache: string;
  home: string;
}

export function baseDirs(env: NodeJS.ProcessEnv = process.env): BaseDirs {
  return {
    config: xdgDir("XDG_CONFIG_HOME", ".config", env),
    data: xdgDir("XDG_DATA_HOME", ".local/share", env),
    state: xdgDir("XDG_STATE_HOME", ".local/state", env),
    cache: xdgDir("XDG_CACHE_HOME", ".cache", env),
    home: env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(),
  };
}

export function defaultVersionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(baseDirs(env).data, APP, "versions");
}

export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(baseDirs(env).home, "Documents");
}

export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const dirs = baseDirs(env);
  const configDir = join(dirs.config, APP);
  const dataDir = join(dirs.data, APP);
  const stateDir = join(dirs.state, APP);
  const cacheDir = join(dirs.cache, APP);
  return {
    configFile: join(configDir, "config.json"),
    configDir,
    dataDir,
    cacheDir,
    stateDir,
    versionsDir: defaultVersionsDir(env),
    catalogFile: join(dataDir, "catalog.json"),
    statsFile: join(stateDir, "stats.json"),
    logsDir: join(stateDir, "logs"),
    downloadsDir: join(cacheDir, "downloads"),
    previewsDir: join(cacheDir, "previews"),
    githubCacheDir: join(cacheDir, "github"),
    prDir: join(dataDir, "pr"),
    prMirrorDir: join(dataDir, "pr", "mirror"),
    prWorktreesDir: join(dataDir, "pr", "worktrees"),
    prProfilesDir: join(dataDir, "pr", "profiles"),
  };
}

/** The stable and weekly profiles keep their historical Python-launcher locations. */
export function channelProfileDirs(
  channel: "stable" | "weekly",
  env: NodeJS.ProcessEnv = process.env,
): { configDir: string; dataDir: string } {
  const dirs = baseDirs(env);
  if (channel === "stable") {
    return {
      configDir: join(dirs.config, "FreeCAD"),
      dataDir: join(dirs.data, "FreeCAD"),
    };
  }
  return {
    configDir: join(dirs.config, "FreeCAD-weekly"),
    dataDir: join(dirs.data, "FreeCAD-weekly"),
  };
}

/**
 * Accept only absolute, user-owned (i.e. not system) paths for the mutable
 * storage locations. Relative paths, root, and system directories are refused.
 */
export function isAcceptableUserPath(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const normalized = normalize(candidate);
  if (normalized === "/") return false;
  const forbidden = [
    "/nix/store",
    "/usr",
    "/etc",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/sys",
    "/proc",
  ];
  for (const prefix of forbidden) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return false;
  }
  return true;
}
