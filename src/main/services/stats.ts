import { SCHEMA_VERSION, statsFileSchema } from "../../shared/schemas.js";
import type { AppPaths, StatEntry, StatsFile } from "../../shared/types.js";
import { readJson, writeJsonAtomic } from "./atomic-json.js";

/** Only sessions longer than this many seconds count. */
export const MIN_SESSION_SECONDS = 5;

export function emptyStats(): StatsFile {
  return { schemaVersion: SCHEMA_VERSION, entries: {} };
}

export async function loadStats(paths: AppPaths): Promise<StatsFile> {
  const raw = await readJson(paths.statsFile);
  const parsed = statsFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyStats();
}

export async function saveStats(paths: AppPaths, stats: StatsFile): Promise<void> {
  await writeJsonAtomic(paths.statsFile, stats, 0o600);
}

export function releaseStatKey(releaseId: string): string {
  return `release:${releaseId}`;
}

export function prStatKey(prNumber: number): string {
  return `pr:${prNumber}`;
}

export function channelStatKey(channel: "stable" | "weekly"): string {
  return `channel:${channel}`;
}

export interface RecordSessionInput {
  key: string;
  durationSec: number;
  now?: () => Date;
}

/**
 * Add a finished session to the statistics and return the updated file. Short
 * sessions and negative durations are ignored, matching the Python launcher.
 */
export function recordSession(stats: StatsFile, input: RecordSessionInput): StatsFile {
  const duration = Math.floor(input.durationSec);
  if (!Number.isFinite(duration) || duration <= MIN_SESSION_SECONDS) return stats;
  const now = input.now ?? (() => new Date());
  const existing: StatEntry = stats.entries[input.key] ?? {
    launches: 0,
    timeSec: 0,
    lastUsedAt: "",
  };
  const updated: StatEntry = {
    launches: existing.launches + 1,
    timeSec: existing.timeSec + duration,
    lastUsedAt: now().toISOString(),
  };
  return {
    schemaVersion: stats.schemaVersion,
    entries: { ...stats.entries, [input.key]: updated },
  };
}

export async function recordSessionAndSave(
  paths: AppPaths,
  stats: StatsFile,
  input: RecordSessionInput,
): Promise<StatsFile> {
  const next = recordSession(stats, input);
  if (next !== stats) await saveStats(paths, next);
  return next;
}

export function totalTimeSec(stats: StatsFile): number {
  return Object.values(stats.entries).reduce((sum, entry) => sum + entry.timeSec, 0);
}

export function totalLaunches(stats: StatsFile): number {
  return Object.values(stats.entries).reduce((sum, entry) => sum + entry.launches, 0);
}
