import { existsSync } from "node:fs";
import type { AppConfig, AppPaths, CatalogResult, StatsFile } from "../shared/types.js";
import { loadConfig, saveConfig } from "./services/config-store.js";
import { GitHubClient } from "./services/github.js";
import { resolveAppimageRun } from "./services/launch.js";
import { PrBuilder } from "./services/pr-build.js";
import { loadStats, saveStats } from "./services/stats.js";
import { appPaths } from "./services/xdg.js";

export interface ToolPaths {
  appimageRun: string | null;
  f3d: string | null;
  pixi: string | null;
  git: string | null;
  prRunner: string | null;
  electron: string | null;
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[`FREECAD_LAUNCHER_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (explicit && existsSync(explicit)) return explicit;
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveTools(env: NodeJS.ProcessEnv = process.env): ToolPaths {
  return {
    appimageRun: resolveAppimageRun(env),
    f3d: findOnPath("f3d", env),
    pixi: findOnPath("pixi", env),
    git: findOnPath("git", env),
    prRunner: findOnPath("freecad-pr-runner", env),
    electron: findOnPath("electron", env),
  };
}

export type Broadcaster = (channel: string, payload: unknown) => void;

/** Long-lived state shared by every IPC handler. */
export class AppContext {
  readonly paths: AppPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly github: GitHubClient;
  readonly builder: PrBuilder;
  readonly tools: ToolPaths;
  readonly installs = new Map<string, AbortController>();
  readonly runningReleaseIds = new Set<string>();
  config: AppConfig;
  stats: StatsFile;
  catalog: CatalogResult | null = null;
  broadcast: Broadcaster = () => undefined;

  private constructor(
    paths: AppPaths,
    config: AppConfig,
    stats: StatsFile,
    env: NodeJS.ProcessEnv,
    github: GitHubClient,
  ) {
    this.paths = paths;
    this.config = config;
    this.stats = stats;
    this.env = env;
    this.github = github;
    this.builder = new PrBuilder();
    this.tools = resolveTools(env);
  }

  static async create(env: NodeJS.ProcessEnv = process.env): Promise<AppContext> {
    const paths = appPaths(env);
    const config = await loadConfig(paths, env);
    const stats = await loadStats(paths);
    const github = new GitHubClient({
      cacheDir: paths.githubCacheDir,
      token: env.GITHUB_TOKEN ?? null,
    });
    return new AppContext(paths, config, stats, env, github);
  }

  get versionsDir(): string {
    return this.config.versionsDir || this.paths.versionsDir;
  }

  /** Paths resolved against the configurable versions root. */
  get effectivePaths(): AppPaths {
    return { ...this.paths, versionsDir: this.versionsDir };
  }

  /** Every artifact currently known, from the live catalog or a snapshot. */
  knownArtifacts(): import("../shared/types.js").ReleaseArtifact[] {
    if (this.catalog) return [...this.catalog.stable, ...this.catalog.weekly];
    return [];
  }

  async persistConfig(): Promise<void> {
    await saveConfig(this.paths, this.config);
  }

  async persistStats(): Promise<void> {
    await saveStats(this.paths, this.stats);
  }
}
