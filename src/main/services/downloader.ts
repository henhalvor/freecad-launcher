import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppPaths, InstalledRelease, ReleaseArtifact } from "../../shared/types.js";
import {
  makeExecutable,
  versionBinaryPath,
  versionDir,
  writeInstalledRelease,
} from "./version-store.js";

export class DownloadCancelledError extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "DownloadCancelledError";
  }
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface DownloadOptions {
  artifact: ReleaseArtifact;
  /** Resolve the expected SHA-256 when the catalog could not provide it. */
  resolveSha256?: () => Promise<string | null>;
  paths: AppPaths;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadCancelledError();
}

/**
 * Download, verify, and atomically install a single release artifact.
 *
 * The `.part` file lives in the destination directory so the final rename is
 * atomic on one filesystem. Nothing is recorded unless size and SHA-256 both
 * match; a cancelled or failed download leaves no installed version behind.
 */
export async function downloadArtifact(options: DownloadOptions): Promise<InstalledRelease> {
  const { artifact, paths } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const signal = options.signal;

  assertNotCancelled(signal);

  const expectedSha = artifact.sha256 || (await options.resolveSha256?.()) || null;
  if (!expectedSha || !/^[a-f0-9]{64}$/i.test(expectedSha)) {
    throw new DownloadError(
      `No verified SHA-256 available for ${artifact.assetName}. Refusing to install an unverified download.`,
    );
  }

  const dir = versionDir(paths, artifact.id);
  await mkdir(dir, { recursive: true });
  const finalPath = versionBinaryPath(paths, artifact.id, basename(artifact.assetName));
  const partPath = `${finalPath}.part`;

  await rm(partPath, { force: true });

  let response: Response;
  try {
    response = await fetchImpl(artifact.downloadUrl, {
      headers: { "User-Agent": "freecad-launcher/1.0", Accept: "application/octet-stream" },
      redirect: "follow",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new DownloadCancelledError();
    throw new DownloadError(`Download failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new DownloadError(
      `Download failed with HTTP ${response.status} for ${artifact.assetName}`,
    );
  }
  if (!response.body) {
    throw new DownloadError("Download response had no body");
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength
    ? Number.parseInt(contentLength, 10)
    : artifact.sizeBytes || null;
  const hash = createHash("sha256");
  let received = 0;

  const handle = await open(partPath, "w", 0o755);
  try {
    const reader = response.body.getReader();
    for (;;) {
      assertNotCancelled(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      hash.update(value);
      await handle.write(value);
      received += value.byteLength;
      const percent =
        totalBytes && totalBytes > 0
          ? Math.min(100, Math.floor((received * 100) / totalBytes))
          : null;
      options.onProgress?.({ receivedBytes: received, totalBytes, percent });
    }
    assertNotCancelled(signal);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partPath, { force: true });
    if ((error as Error).name === "AbortError" || error instanceof DownloadCancelledError) {
      throw new DownloadCancelledError();
    }
    throw error instanceof DownloadError ? error : new DownloadError((error as Error).message);
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    const actualSize = (await stat(partPath)).size;
    if (artifact.sizeBytes > 0 && actualSize !== artifact.sizeBytes) {
      throw new DownloadError(
        `Incomplete download for ${artifact.assetName}: got ${actualSize} bytes, expected ${artifact.sizeBytes}.`,
      );
    }
    const actualSha = hash.digest("hex");
    if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new DownloadError(
        `Checksum mismatch for ${artifact.assetName}: expected ${expectedSha}, got ${actualSha}.`,
      );
    }
    await makeExecutable(partPath);
    await rename(partPath, finalPath);
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }

  const installed: InstalledRelease = {
    ...artifact,
    sha256: expectedSha.toLowerCase(),
    path: finalPath,
    installedAt: now().toISOString(),
    verifiedAt: now().toISOString(),
    intact: true,
  };
  await writeInstalledRelease(paths, installed);
  options.onProgress?.({
    receivedBytes: received,
    totalBytes: totalBytes ?? received,
    percent: 100,
  });
  return installed;
}
