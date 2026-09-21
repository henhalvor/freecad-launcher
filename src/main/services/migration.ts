import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { SCHEMA_VERSION, statsFileSchema } from "../../shared/schemas.js";
import type {
  AppConfig,
  AppPaths,
  MigrationReport,
  ReleaseArtifact,
  StatsFile,
} from "../../shared/types.js";
import { readJson } from "./atomic-json.js";
import {
  legacyConfigCandidates,
  legacyDefaultInstallDir,
  legacyStatsCandidates,
  loadConfig,
  mapLegacyConfig,
  normalizeConfig,
  saveConfig,
} from "./config-store.js";
import { sha256File } from "./downloader.js";
import { emptyStats, saveStats } from "./stats.js";
import { readInstalledRelease, writeInstalledRelease } from "./version-store.js";

export interface MigrationOptions {
  paths: AppPaths;
  artifacts: ReleaseArtifact[];
  /** When true the legacy config values are merged into the new config. */
  applyLegacyConfig: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export interface MigrationOutcome {
  config: AppConfig;
  stats: StatsFile;
  report: MigrationReport;
}

function legacyStatTotals(value: unknown): Record<string, { time_sec: number; launches: number }> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, { time_sec: number; launches: number }> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const time = Number(record.time_sec ?? 0);
    const launches = Number(record.launches ?? 0);
    if (Number.isFinite(time) && Number.isFinite(launches)) {
      out[key] = { time_sec: Math.max(0, time), launches: Math.max(0, launches) };
    }
  }
  return out;
}

async function readLegacyObject(
  candidates: string[],
): Promise<{ path: string; data: Record<string, unknown> } | null> {
  for (const path of candidates) {
    const data = await readJson(path);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { path, data: data as Record<string, unknown> };
    }
  }
  return null;
}

/** Adopt an AppImage only when its SHA-256 matches an official release asset. */
async function adoptAppImages(options: MigrationOptions, report: MigrationReport): Promise<void> {
  const { paths, artifacts } = options;
  const byName = new Map(artifacts.map((artifact) => [artifact.assetName.toLowerCase(), artifact]));
  const searchDirs = new Set<string>([legacyDefaultInstallDir(options.env), paths.versionsDir]);
  const seenPaths = new Set<string>();

  for (const dir of searchDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".appimage")) continue;
      const fullPath = join(dir, entry);
      let isFile = false;
      try {
        isFile = (await stat(fullPath)).isFile();
      } catch {
        continue;
      }
      if (!isFile || seenPaths.has(fullPath)) continue;
      seenPaths.add(fullPath);

      const artifact = byName.get(basename(entry).toLowerCase());
      if (!artifact) {
        report.unmatchedAppImages.push(fullPath);
        continue;
      }
      // Already installed under the managed layout: nothing to do.
      const existing = await readInstalledRelease(paths, artifact.id);
      if (existing && existing.path === fullPath) continue;

      options.onProgress?.(`Hashing ${entry}…`);
      let digest: string;
      try {
        digest = await sha256File(fullPath);
      } catch {
        report.unmatchedAppImages.push(fullPath);
        continue;
      }
      if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
        report.unmatchedAppImages.push(fullPath);
        continue;
      }
      const destination = join(paths.versionsDir, artifact.id, basename(entry));
      await mkdir(join(paths.versionsDir, artifact.id), { recursive: true });
      await copyFile(fullPath, destination);
      const now = (options.now ?? (() => new Date()))().toISOString();
      await writeInstalledRelease(paths, {
        ...artifact,
        path: destination,
        installedAt: now,
        verifiedAt: now,
        intact: true,
      });
      report.adoptedAppImages.push({
        sourcePath: fullPath,
        releaseId: artifact.id,
        assetName: artifact.assetName,
      });
    }
  }
}

/**
 * One-time import of Python-launcher state and AppImages. Sources are copied,
 * never deleted. Unmatched AppImages are left exactly where they are.
 */
export async function runMigration(options: MigrationOptions): Promise<MigrationOutcome> {
  const { paths } = options;
  const report: MigrationReport = {
    legacyConfigFound: false,
    legacyStatsFound: false,
    adoptedAppImages: [],
    unmatchedAppImages: [],
    copiedStats: 0,
    notes: [],
  };

  let config = await loadConfig(paths, options.env);

  const legacyConfig = await readLegacyObject(legacyConfigCandidates(options.env));
  if (legacyConfig) {
    report.legacyConfigFound = true;
    report.notes.push(`Legacy config found at ${legacyConfig.path}`);
    if (options.applyLegacyConfig) {
      const mapped = mapLegacyConfig(legacyConfig.data);
      config = normalizeConfig({ ...config, ...mapped }, options.env);
      await saveConfig(paths, config);
      report.notes.push("Legacy configuration imported into the launcher config.");
    }
  }

  let stats = emptyStats();
  const legacyStats = await readLegacyObject(legacyStatsCandidates(options.env));
  if (legacyStats) {
    report.legacyStatsFound = true;
    const totals = legacyStatTotals(legacyStats.data);
    const byAssetName = new Map(options.artifacts.map((a) => [a.assetName.toLowerCase(), a]));
    const entries: StatsFile["entries"] = {};
    const nowIso = (options.now ?? (() => new Date()))().toISOString();
    for (const [legacyKey, value] of Object.entries(totals)) {
      const artifact =
        byAssetName.get(legacyKey.toLowerCase()) ??
        options.artifacts.find((a) => legacyKey.toLowerCase().includes(a.version.toLowerCase()));
      const key = artifact ? `release:${artifact.id}` : `legacy:${legacyKey}`;
      entries[key] = { launches: value.launches, timeSec: value.time_sec, lastUsedAt: nowIso };
      report.copiedStats += 1;
    }
    const parsed = statsFileSchema.safeParse({ schemaVersion: SCHEMA_VERSION, entries });
    if (parsed.success) {
      stats = parsed.data;
      await saveStats(paths, stats);
      report.notes.push(`Imported ${report.copiedStats} legacy statistics entries.`);
    }
  }

  await adoptAppImages(options, report);
  return { config, stats, report };
}
