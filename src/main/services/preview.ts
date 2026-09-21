import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AppPaths,
  FcstdMetadata,
  MeshData,
  PreviewResult,
  ProjectFile,
} from "../../shared/types.js";
import { pathExists } from "./atomic-json.js";
import { runFreecadConsole } from "./freecad-console.js";
import { DEFAULT_MAX_TRIANGLES, parseStl, parseStlBuffer } from "./stl.js";
import { findZipEntryName, readZipEntry } from "./zip.js";

export function previewCacheKey(path: string, mtimeMs: number): string {
  return createHash("sha256").update(`${path}:${mtimeMs}`).digest("hex").slice(0, 32);
}

interface CacheRecord {
  kind: PreviewResult["kind"];
  thumbnailDataUrl?: string;
  mesh?: MeshData;
  metadata?: FcstdMetadata;
}

async function readCache(paths: AppPaths, key: string): Promise<CacheRecord | null> {
  const file = join(paths.previewsDir, `${key}.json`);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as CacheRecord;
  } catch {
    return null;
  }
}

async function writeCache(paths: AppPaths, key: string, record: CacheRecord): Promise<void> {
  await mkdir(paths.previewsDir, { recursive: true });
  const file = join(paths.previewsDir, `${key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record), "utf8");
  await rename(tmp, file);
}

/** Parse `Document.xml` for FreeCAD's program version, label and creator. */
export async function readFcstdMetadata(path: string): Promise<FcstdMetadata> {
  const metadata: FcstdMetadata = { programVersion: null, label: null, creator: null };
  const name = await findZipEntryName(
    path,
    (entry) => entry === "document.xml" || entry.endsWith("/document.xml"),
  );
  if (!name) return metadata;
  const buffer = await readZipEntry(path, name);
  if (!buffer) return metadata;
  const text = buffer.toString("utf8").slice(0, 4096);
  metadata.programVersion = /ProgramVersion="([^"]*)"/.exec(text)?.[1] ?? null;
  metadata.label = /Label="([^"]*)"/.exec(text)?.[1] ?? null;
  metadata.creator = /Creator="([^"]*)"/.exec(text)?.[1] ?? null;
  return metadata;
}

export async function readFcstdThumbnail(path: string): Promise<string | null> {
  const name = await findZipEntryName(
    path,
    (entry) => entry.endsWith("thumbnail.png") || entry.endsWith("thumbnail.jpg"),
  );
  if (!name) return null;
  const buffer = await readZipEntry(path, name);
  if (!buffer || buffer.length === 0) return null;
  const mime = name.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function tessellationMacro(source: string, outputPath: string, maxTriangles: number): string {
  return [
    "import json",
    "import sys",
    "import FreeCAD as App",
    "import Part",
    `src = ${JSON.stringify(source)}`,
    `out = ${JSON.stringify(outputPath)}`,
    `max_tri = ${maxTriangles}`,
    "triangles = []",
    "doc = None",
    "def tess(shape):",
    "    result = []",
    "    try:",
    "        vertices, facets = shape.tessellate(0.8)",
    "    except Exception as exc:",
    "        sys.stderr.write('tessellate failed: %s\\n' % exc)",
    "        return result",
    "    for tri in facets:",
    "        for idx in tri:",
    "            v = vertices[idx]",
    "            result.append([v.x, v.y, v.z])",
    "    return result",
    "try:",
    "    if src.lower().endswith('.fcstd'):",
    "        doc = App.open(src)",
    "        shapes = [o.Shape for o in doc.Objects if getattr(o, 'Shape', None) and not o.Shape.isNull()]",
    "    else:",
    "        doc = App.newDocument('preview')",
    "        Part.insert(src, doc.Name)",
    "        shapes = [o.Shape for o in doc.Objects if getattr(o, 'Shape', None) and not o.Shape.isNull()]",
    "    for shape in shapes:",
    "        triangles.extend(tess(shape))",
    "except Exception as exc:",
    "    sys.stderr.write('preview failed: %s\\n' % exc)",
    "finally:",
    "    with open(out, 'w') as handle:",
    "        json.dump(triangles[:max_tri * 3], handle)",
    "    try:",
    "        if doc is not None:",
    "            App.closeDocument(doc.Name)",
    "    except Exception:",
    "        pass",
    "",
  ].join("\n");
}

/**
 * Turn the tessellation macro's JSON output into a mesh.
 *
 * The macro emits a flat list of `[x, y, z]` points, where every three points
 * form one triangle. For robustness a list of flat 9-number triangles is also
 * accepted.
 */
export function meshFromTessellation(value: unknown): MeshData | null {
  if (!Array.isArray(value)) return null;
  const positions: number[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) continue;
    const take = entry.length >= 9 ? 9 : entry.length >= 3 ? 3 : 0;
    if (take === 0) continue;
    const coords = entry.slice(0, take).map(Number);
    if (coords.some((coordinate) => !Number.isFinite(coordinate))) continue;
    positions.push(...coords);
  }
  const triangleCount = Math.floor(positions.length / 9);
  if (triangleCount === 0) return null;
  return { positions: positions.slice(0, triangleCount * 9), triangleCount };
}

export interface TessellateOptions {
  paths: AppPaths;
  appimageRun: string;
  release: { path: string };
  source: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTriangles?: number;
}

/** Tessellate a CAD file to a triangle mesh using the selected FreeCAD build. */
export async function tessellateWithFreecad(options: TessellateOptions): Promise<MeshData | null> {
  await mkdir(options.paths.previewsDir, { recursive: true });
  const workDir = join(options.paths.previewsDir, "tessellate");
  await mkdir(workDir, { recursive: true });
  const key = createHash("sha256").update(options.source).digest("hex").slice(0, 16);
  const macroPath = join(workDir, `${key}_macro.py`);
  const outputPath = join(workDir, `${key}.json`);
  await writeFile(
    macroPath,
    tessellationMacro(options.source, outputPath, options.maxTriangles ?? DEFAULT_MAX_TRIANGLES),
  );

  const result = await runFreecadConsole({
    appimageRun: options.appimageRun,
    appimage: options.release.path,
    script: macroPath,
    timeoutMs: options.timeoutMs ?? 180_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.signal?.aborted) return null;
  if (!(await pathExists(outputPath))) {
    if (!result.ok) {
      console.error(`[tessellate] FreeCAD failed for ${options.source}: ${result.stderr.slice(-2000)}`);
    }
    return null;
  }
  try {
    const raw = await readFile(outputPath, "utf8");
    const mesh = meshFromTessellation(JSON.parse(raw));
    if (!mesh) {
      console.error(`[tessellate] no usable geometry for ${options.source}`);
    }
    return mesh;
  } catch (error) {
    console.error(`[tessellate] could not read ${outputPath}: ${(error as Error).message}`);
    return null;
  } finally {
    await rm(outputPath, { force: true });
  }
}

export interface PreviewOptions {
  paths: AppPaths;
  file: ProjectFile;
  appimageRun: string | null;
  release?: { path: string } | null;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

/** Resolve a preview for a project: FCStd thumbnail, or a cached triangle mesh. */
export async function getPreview(options: PreviewOptions): Promise<PreviewResult> {
  const { paths, file } = options;
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(file.path)).mtimeMs;
  } catch {
    return { path: file.path, kind: "none", cached: false, message: "File not found" };
  }
  const key = previewCacheKey(file.path, mtimeMs);
  if (!options.forceRefresh) {
    const cached = await readCache(paths, key);
    if (cached) {
      return {
        path: file.path,
        kind: cached.kind,
        cached: true,
        ...(cached.thumbnailDataUrl ? { thumbnailDataUrl: cached.thumbnailDataUrl } : {}),
        ...(cached.mesh ? { mesh: cached.mesh } : {}),
        ...(cached.metadata ? { metadata: cached.metadata } : {}),
      };
    }
  }

  let record: CacheRecord | null = null;

  if (file.format === "FCStd") {
    const metadata = await readFcstdMetadata(file.path);
    const thumbnail = await readFcstdThumbnail(file.path);
    if (thumbnail) {
      record = { kind: "thumbnail", thumbnailDataUrl: thumbnail, metadata };
    } else {
      const mesh = await maybeTessellate(options, file.path);
      record = mesh ? { kind: "mesh", mesh, metadata } : { kind: "none", metadata };
    }
  } else if (file.format === "STL") {
    try {
      const mesh = await parseStl(file.path, DEFAULT_MAX_TRIANGLES);
      record = { kind: "mesh", mesh };
    } catch {
      record = { kind: "none" };
    }
  } else {
    const mesh = await maybeTessellate(options, file.path);
    record = mesh ? { kind: "mesh", mesh } : { kind: "none" };
  }

  if (!record) return { path: file.path, kind: "none", cached: false };
  await writeCache(paths, key, record);
  return {
    path: file.path,
    kind: record.kind,
    cached: false,
    ...(record.thumbnailDataUrl ? { thumbnailDataUrl: record.thumbnailDataUrl } : {}),
    ...(record.mesh ? { mesh: record.mesh } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
    ...(record.kind === "none" ? { message: "Preview unavailable" } : {}),
  };
}

async function maybeTessellate(options: PreviewOptions, source: string): Promise<MeshData | null> {
  if (options.signal?.aborted) return null;
  if (!options.appimageRun || !options.release) return null;
  return tessellateWithFreecad({
    paths: options.paths,
    appimageRun: options.appimageRun,
    release: options.release,
    source,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export interface F3dOptions {
  f3dPath: string;
  file: string;
  baseEnv?: NodeJS.ProcessEnv;
}

/** Open a file in the Nix-provided F3D viewer. */
export function openWithF3d(options: F3dOptions): boolean {
  try {
    const child = spawn(options.f3dPath, [options.file], {
      env: { ...(options.baseEnv ?? process.env) },
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export { parseStlBuffer, basename };
