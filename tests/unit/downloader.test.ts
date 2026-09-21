import { constants } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DownloadCancelledError,
  DownloadError,
  downloadArtifact,
  sha256File,
} from "../../src/main/services/downloader.js";
import { readInstalledRelease } from "../../src/main/services/version-store.js";
import type { ReleaseArtifact } from "../../src/shared/types.js";
import { sha256, streamResponse, testPaths, withTempDir } from "./helpers.js";

const PAYLOAD = Buffer.from("this-is-an-appimage-payload");

function artifactFor(payload: Buffer, overrides: Partial<ReleaseArtifact> = {}): ReleaseArtifact {
  return {
    id: "1:2",
    releaseId: 1,
    assetId: 2,
    channel: "stable",
    tag: "1.0.0",
    version: "1.0.0",
    architecture: "x86_64",
    assetName: "FreeCAD_1.0.0-Linux-x86_64.AppImage",
    downloadUrl: "https://example.test/FreeCAD.AppImage",
    sizeBytes: payload.byteLength,
    sha256: sha256(payload),
    publishedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("downloadArtifact", () => {
  it("verifies, installs atomically, and records the release", async () => {
    await withTempDir(async (dir) => {
      const paths = testPaths(dir);
      const installed = await downloadArtifact({
        artifact: artifactFor(PAYLOAD),
        paths,
        fetchImpl: (async () =>
          streamResponse([PAYLOAD.subarray(0, 5), PAYLOAD.subarray(5)], {
            "content-length": String(PAYLOAD.byteLength),
          })) as typeof fetch,
      });

      expect(installed.path).toContain(installed.assetName);
      expect(await readFile(installed.path)).toEqual(PAYLOAD);
      await expect(access(installed.path, constants.X_OK)).resolves.toBeUndefined();
      expect(await sha256File(installed.path)).toBe(installed.sha256);

      const record = await readInstalledRelease(paths, installed.id);
      expect(record?.intact).toBe(true);
      expect(record?.verifiedAt).toBeTruthy();

      const partExists = await stat(`${installed.path}.part`).then(
        () => true,
        () => false,
      );
      expect(partExists).toBe(false);
    });
  });

  it("rejects a checksum mismatch and leaves nothing installed", async () => {
    await withTempDir(async (dir) => {
      const paths = testPaths(dir);
      const artifact = artifactFor(PAYLOAD, { sha256: "0".repeat(64) });
      await expect(
        downloadArtifact({
          artifact,
          paths,
          fetchImpl: (async () => streamResponse([PAYLOAD])) as typeof fetch,
        }),
      ).rejects.toBeInstanceOf(DownloadError);
      expect(await readInstalledRelease(paths, artifact.id)).toBeNull();
    });
  });

  it("rejects a size mismatch", async () => {
    await withTempDir(async (dir) => {
      const paths = testPaths(dir);
      const artifact = artifactFor(PAYLOAD, { sizeBytes: PAYLOAD.byteLength + 10 });
      await expect(
        downloadArtifact({
          artifact,
          paths,
          fetchImpl: (async () => streamResponse([PAYLOAD])) as typeof fetch,
        }),
      ).rejects.toBeInstanceOf(DownloadError);
      expect(await readInstalledRelease(paths, artifact.id)).toBeNull();
    });
  });

  it("refuses to install without a verified SHA-256", async () => {
    await withTempDir(async (dir) => {
      const paths = testPaths(dir);
      const artifact = artifactFor(PAYLOAD, { sha256: "" });
      await expect(
        downloadArtifact({
          artifact,
          paths,
          resolveSha256: async () => null,
          fetchImpl: (async () => streamResponse([PAYLOAD])) as typeof fetch,
        }),
      ).rejects.toBeInstanceOf(DownloadError);
    });
  });

  it("supports cancellation without leaving a partial install", async () => {
    await withTempDir(async (dir) => {
      const paths = testPaths(dir);
      const controller = new AbortController();
      controller.abort();
      await expect(
        downloadArtifact({
          artifact: artifactFor(PAYLOAD),
          paths,
          signal: controller.signal,
          fetchImpl: (async () => streamResponse([PAYLOAD])) as typeof fetch,
        }),
      ).rejects.toBeInstanceOf(DownloadCancelledError);
      expect(await readInstalledRelease(paths, "1:2")).toBeNull();
    });
  });

  it("downloads to a .part file inside the destination directory", async () => {
    await withTempDir(async (dir) => {
      const paths = testPaths(dir);
      let observedUrl = "";
      await downloadArtifact({
        artifact: artifactFor(PAYLOAD),
        paths,
        fetchImpl: (async (url: string) => {
          observedUrl = String(url);
          return streamResponse([PAYLOAD]);
        }) as unknown as typeof fetch,
      });
      expect(observedUrl).toBe("https://example.test/FreeCAD.AppImage");
      const dirEntry = join(paths.versionsDir, "1:2");
      const names = await readFile(join(dirEntry, "installed.json"), "utf8");
      expect(names).toContain("FreeCAD_1.0.0-Linux-x86_64.AppImage");
    });
  });
});
