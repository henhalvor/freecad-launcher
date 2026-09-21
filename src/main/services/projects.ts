import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DisplayProject, ProjectFile, ProjectFormat } from "../../shared/types.js";

export const PROJECT_LIMIT = 20;

const EXTENSION_FORMATS: Record<string, ProjectFormat> = {
  ".fcstd": "FCStd",
  ".step": "STEP",
  ".stp": "STEP",
  ".iges": "IGES",
  ".igs": "IGES",
  ".stl": "STL",
  ".brep": "BREP",
};

export function formatForPath(path: string): ProjectFormat | null {
  return EXTENSION_FORMATS[extname(path).toLowerCase()] ?? null;
}

export function isSupportedProjectPath(path: string): boolean {
  return formatForPath(path) !== null;
}

export async function projectFromPath(path: string): Promise<ProjectFile | null> {
  const format = formatForPath(path);
  if (!format) return null;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    return {
      path,
      name: basename(path),
      format,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export interface ScanOptions {
  dir: string;
  limit?: number;
  signal?: AbortSignal;
  /** Max directory depth; guards against pathological trees. */
  maxDepth?: number;
}

/**
 * Recursively scan for supported CAD files and return the newest ones. Full
 * paths are preserved so duplicate filenames remain distinct. Symlinked
 * directories are not followed.
 */
export async function scanProjects(options: ScanOptions): Promise<ProjectFile[]> {
  const limit = options.limit ?? PROJECT_LIMIT;
  const maxDepth = options.maxDepth ?? 64;
  const found: ProjectFile[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: options.dir, depth: 0 }];

  while (stack.length > 0) {
    if (options.signal?.aborted) return [];
    const current = stack.pop()!;
    if (current.depth > maxDepth) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (options.signal?.aborted) return [];
      const fullPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const format = formatForPath(entry.name);
      if (!format) continue;
      const project = await projectFromPath(fullPath);
      if (project) found.push(project);
    }
  }

  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

/** Disambiguate duplicate basenames by appending the parent directory. */
export function withDisplayNames(projects: ProjectFile[]): DisplayProject[] {
  const counts = new Map<string, number>();
  for (const project of projects) {
    counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  }
  return projects.map((project) => {
    const duplicate = (counts.get(project.name) ?? 0) > 1;
    const directory = project.path.slice(0, project.path.length - project.name.length - 1);
    return {
      ...project,
      directory,
      displayName: duplicate ? `${project.name} — ${basename(directory)}` : project.name,
    };
  });
}
