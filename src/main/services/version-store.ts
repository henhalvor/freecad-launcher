import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { installedReleaseSchema } from "../../shared/schemas.js";
import type { AppPaths, InstalledRelease } from "../../shared/types.js";
import { readJson, writeJsonAtomic } from "./atomic-json.js";

export const INSTALL_RECORD = "installed.json";

export function versionDir(paths: AppPaths, id: string): string {
  return join(paths.versionsDir, id);
}

export function versionBinaryPath(paths: AppPaths, id: string, assetName: string): string {
  return join(versionDir(paths, id), assetName);
}

function recordPath(paths: AppPaths, id: string): string {
  return join(versionDir(paths, id), INSTALL_RECORD);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeInstalledRelease(
  paths: AppPaths,
  release: InstalledRelease,
): Promise<void> {
  await mkdir(versionDir(paths, release.id), { recursive: true });
  await writeJsonAtomic(recordPath(paths, release.id), release, 0o600);
}

export async function readInstalledRelease(
  paths: AppPaths,
  id: string,
): Promise<InstalledRelease | null> {
  const raw = await readJson(recordPath(paths, id));
  const parsed = installedReleaseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Recompute `intact` from the filesystem: exists, executable, and size matches. */
export async function verifyInstalled(release: InstalledRelease): Promise<InstalledRelease> {
  try {
    const stats = await stat(release.path);
    const sizeOk = release.sizeBytes <= 0 || stats.size === release.sizeBytes;
    const exec = await isExecutable(release.path);
    return { ...release, intact: sizeOk && exec };
  } catch {
    return { ...release, intact: false };
  }
}

/** Scan the versions root for every installed release, newest first. */
export async function scanInstalled(paths: AppPaths): Promise<InstalledRelease[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.versionsDir);
  } catch {
    return [];
  }
  const installed: InstalledRelease[] = [];
  for (const entry of entries) {
    const dir = join(paths.versionsDir, entry);
    let isDir = false;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const record = await readInstalledRelease(paths, entry);
    if (!record) continue;
    installed.push(await verifyInstalled(record));
  }
  return installed.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
}

/** Remove an installed release. Returns the removed record, or null if absent. */
export async function removeInstalled(
  paths: AppPaths,
  id: string,
): Promise<InstalledRelease | null> {
  const record = await readInstalledRelease(paths, id);
  await rm(versionDir(paths, id), { recursive: true, force: true });
  return record;
}

/** Mark a freshly downloaded AppImage executable before it is recorded. */
export async function makeExecutable(path: string): Promise<void> {
  await chmod(path, 0o755);
}
