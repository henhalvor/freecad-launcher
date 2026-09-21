import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "../../shared/types.js";
import { ensureDir, pathExists } from "./atomic-json.js";

const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

function isHttps(url: string): boolean {
  return /^https:\/\//i.test(url);
}

export function mediaCachePath(paths: AppPaths, url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 40);
  return join(paths.githubCacheDir, "media", hash);
}

/** Guess a content type from magic bytes; defaults to octet-stream. */
export function mediaContentType(buffer: Buffer): string {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii").startsWith("GIF8"))
    return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  const head = buffer.subarray(0, 512).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return "application/octet-stream";
}

export interface MediaResult {
  path: string;
  contentType: string;
}

/**
 * Fetch a remote image into the cache, or return the cached copy. Only HTTPS
 * URLs are fetched, and oversized responses are rejected.
 */
export async function fetchMedia(
  paths: AppPaths,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MediaResult | null> {
  if (!isHttps(url)) return null;
  const path = mediaCachePath(paths, url);
  if (await pathExists(path)) {
    const buffer = await readFile(path);
    return { path, contentType: mediaContentType(buffer) };
  }
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: { "User-Agent": "freecad-launcher/1.0" },
    });
    if (!response.ok) return null;
    const length = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(length) && length > MAX_MEDIA_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) return null;
    await ensureDir(join(paths.githubCacheDir, "media"));
    await writeFile(path, buffer);
    return { path, contentType: mediaContentType(buffer) };
  } catch {
    return null;
  }
}
