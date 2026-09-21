import { isAbsolute } from "node:path";
import { SCHEMA_VERSION, appConfigSchema } from "../../shared/schemas.js";
import type { AppConfig, AppPaths } from "../../shared/types.js";
import { readJson, writeJsonAtomic } from "./atomic-json.js";
import { baseDirs, defaultProjectsDir, defaultVersionsDir, isAcceptableUserPath } from "./xdg.js";

export const CONFIG_BASENAME = "launcher_config.json";
export const STATS_BASENAME = "time_tracker.json";
export const LEGACY_CONFIG_FILE = ".freecad_launcher_config.json";
export const LEGACY_STATS_FILE = ".freecad_time_tracker.json";

export function legacyDefaultInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return `${baseDirs(env).home}/Applications/FreeCAD`;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    versionsDir: defaultVersionsDir(env),
    projectsDir: defaultProjectsDir(env),
    theme: "dark",
    closeOnLaunch: true,
    vanilla: false,
    tutorialHidpi: false,
    disableFreecadStartPage: false,
    disableUpdateReminder: false,
    prBuildBackend: "nix",
    prHistory: [],
    prFavorites: [],
    lastSelectedReleaseId: null,
    channelDefaults: {},
    onboarded: false,
  };
}

function sanitizePath(value: unknown, fallback: string): string {
  return typeof value === "string" && isAcceptableUserPath(value) ? value : fallback;
}

function intArray(value: unknown, limit?: number): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = value
    .map((entry) => (typeof entry === "number" ? entry : Number.parseInt(String(entry), 10)))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  const unique = [...new Set(numbers)];
  return limit ? unique.slice(0, limit) : unique;
}

export function normalizeConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaults = defaultConfig(env);
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  // Coerce arrays before validation so one malformed entry does not discard
  // the entire configuration.
  const merged: Record<string, unknown> = {
    ...defaults,
    ...source,
    prHistory: intArray(source.prHistory ?? defaults.prHistory, 10),
    prFavorites: intArray(source.prFavorites ?? defaults.prFavorites),
  };
  const parsed = appConfigSchema.safeParse(merged);
  const config = parsed.success ? parsed.data : defaults;
  config.versionsDir = sanitizePath(config.versionsDir, defaults.versionsDir);
  config.projectsDir = isAbsolute(config.projectsDir) ? config.projectsDir : defaults.projectsDir;
  return config;
}

export async function loadConfig(
  paths: AppPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const raw = await readJson(paths.configFile);
  return normalizeConfig(raw, env);
}

export async function saveConfig(paths: AppPaths, config: AppConfig): Promise<void> {
  const validated = normalizeConfig(config);
  await writeJsonAtomic(paths.configFile, validated, 0o600);
}

/** Legacy Python config file locations probed during migration. */
export function legacyConfigCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = baseDirs(env).home;
  return [`${legacyDefaultInstallDir(env)}/${CONFIG_BASENAME}`, `${home}/${LEGACY_CONFIG_FILE}`];
}

export function legacyStatsCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = baseDirs(env).home;
  return [`${legacyDefaultInstallDir(env)}/${STATS_BASENAME}`, `${home}/${LEGACY_STATS_FILE}`];
}

/** Map a legacy `launcher_config.json` object onto the new config shape. */
export function mapLegacyConfig(legacy: Record<string, unknown>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  if (isAcceptableUserPath(String(legacy.install_dir ?? "")))
    out.versionsDir = String(legacy.install_dir);
  if (typeof legacy.scan_folder === "string" && isAbsolute(legacy.scan_folder)) {
    out.projectsDir = legacy.scan_folder;
  }
  if (typeof legacy.dark_mode === "boolean") out.theme = legacy.dark_mode ? "dark" : "light";
  if (typeof legacy.auto_close === "boolean") out.closeOnLaunch = legacy.auto_close;
  if (typeof legacy.vanilla_launch === "boolean") out.vanilla = legacy.vanilla_launch;
  if (typeof legacy.use_custom_script_env === "boolean")
    out.tutorialHidpi = legacy.use_custom_script_env;
  if (typeof legacy.disable_update_reminder === "boolean")
    out.disableUpdateReminder = legacy.disable_update_reminder;
  if (typeof legacy.use_pixi_build === "boolean")
    out.prBuildBackend = legacy.use_pixi_build ? "pixi" : "nix";
  if (Array.isArray(legacy.pr_history)) {
    out.prHistory = legacy.pr_history
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  if (Array.isArray(legacy.pr_favorites)) {
    out.prFavorites = legacy.pr_favorites
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  return out;
}
