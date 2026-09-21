import { describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../../src/main/services/atomic-json.js";
import { GitHubClient } from "../../src/main/services/github.js";
import {
  artifactsFromReleases,
  classifyRelease,
  digestFromAsset,
  extractVersion,
  fetchCatalog,
  isMatchingAppImage,
  loadCatalogSnapshot,
  parseSha256File,
  resolveArtifactSha256,
  sortArtifacts,
} from "../../src/main/services/release-catalog.js";
import type { GitHubRelease } from "../../src/main/services/release-catalog.js";
import { SCHEMA_VERSION } from "../../src/shared/schemas.js";
import { jsonResponse, sequenceFetch, sha256, withTempDir } from "./helpers.js";

function release(
  partial: Partial<GitHubRelease> & { id: number; tag_name: string },
): GitHubRelease {
  return {
    draft: false,
    prerelease: false,
    published_at: "2024-01-01T00:00:00Z",
    assets: [],
    ...partial,
  };
}

function asset(name: string, id = 1, digest?: string, size = 100) {
  return {
    id,
    name,
    size,
    browser_download_url: `https://github.com/FreeCAD/FreeCAD/releases/download/tag/${name}`,
    ...(digest ? { digest } : {}),
  };
}

describe("release classification", () => {
  it("treats non-draft, non-prerelease as stable", () => {
    expect(classifyRelease(release({ id: 1, tag_name: "1.0.0" }))).toBe("stable");
  });

  it("treats weekly-* prereleases as weekly", () => {
    expect(
      classifyRelease(release({ id: 1, tag_name: "weekly-2024.11.20", prerelease: true })),
    ).toBe("weekly");
    expect(classifyRelease(release({ id: 1, tag_name: "WEEKLY-1.0", prerelease: true }))).toBe(
      "weekly",
    );
  });

  it("ignores drafts and non-weekly prereleases", () => {
    expect(classifyRelease(release({ id: 1, tag_name: "1.0.0", draft: true }))).toBeNull();
    expect(classifyRelease(release({ id: 1, tag_name: "1.0.0rc1", prerelease: true }))).toBeNull();
  });
});

describe("asset filtering", () => {
  it("accepts only Linux x86_64 AppImages", () => {
    expect(isMatchingAppImage("FreeCAD_1.0.0-Linux-x86_64.AppImage")).toBe(true);
    expect(isMatchingAppImage("FreeCAD_weekly-2024.11.20-Linux-x86_64.AppImage")).toBe(true);
    expect(isMatchingAppImage("FreeCAD_1.0.0-Linux-aarch64.AppImage")).toBe(false);
    expect(isMatchingAppImage("FreeCAD_1.0.0-Linux-x86_64.AppImage.zsync")).toBe(false);
    expect(isMatchingAppImage("FreeCAD_1.0.0-Linux-x86_64.AppImage-SHA256.txt")).toBe(false);
    expect(isMatchingAppImage("FreeCAD_1.0.0-Linux-x86_64.AppImage.sha256")).toBe(false);
  });

  it("classifies and sorts releases, filtering by architecture", () => {
    const { stable, weekly } = artifactsFromReleases([
      release({
        id: 10,
        tag_name: "0.21.2",
        assets: [asset("FreeCAD_0.21.2-Linux-x86_64.AppImage", 100, `sha256:${"a".repeat(64)}`)],
      }),
      release({
        id: 11,
        tag_name: "1.0.0",
        assets: [
          asset("FreeCAD_1.0.0-Linux-x86_64.AppImage", 101, `sha256:${"b".repeat(64)}`),
          asset("FreeCAD_1.0.0-Linux-aarch64.AppImage", 102, `sha256:${"c".repeat(64)}`),
        ],
      }),
      release({
        id: 12,
        tag_name: "weekly-2024.11.20",
        prerelease: true,
        assets: [
          asset("FreeCAD_weekly-2024.11.20-Linux-x86_64.AppImage", 103, `sha256:${"d".repeat(64)}`),
        ],
      }),
    ]);
    expect(stable.map((a) => a.version)).toEqual(["1.0.0", "0.21.2"]);
    expect(stable.every((a) => a.architecture === "x86_64")).toBe(true);
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.version).toBe("weekly-2024.11.20");
  });

  it("carries release names and notes from GitHub", () => {
    const { stable } = artifactsFromReleases([
      release({
        id: 20,
        tag_name: "1.0.0",
        name: "FreeCAD 1.0.0 release",
        body: "# Highlights\n\n- A fix",
        assets: [asset("FreeCAD_1.0.0-Linux-x86_64.AppImage", 1, `sha256:${"a".repeat(64)}`)],
      }),
    ]);
    expect(stable[0]!.releaseName).toBe("FreeCAD 1.0.0 release");
    expect(stable[0]!.releaseNotes).toContain("# Highlights");
  });

  it("falls back to the tag when a release has no name or notes", () => {
    const { stable } = artifactsFromReleases([
      release({
        id: 21,
        tag_name: "0.21.2",
        assets: [asset("FreeCAD_0.21.2-Linux-x86_64.AppImage", 1, `sha256:${"a".repeat(64)}`)],
      }),
    ]);
    expect(stable[0]!.releaseName).toBe("0.21.2");
    expect(stable[0]!.releaseNotes).toBe("");
  });
});

describe("version and checksum parsing", () => {
  it("extracts stable and weekly versions", () => {
    expect(extractVersion("1.0.0", "FreeCAD_1.0.0-Linux-x86_64.AppImage", "stable")).toBe("1.0.0");
    expect(extractVersion("weekly-2024.11.20", "x.AppImage", "weekly")).toBe("weekly-2024.11.20");
    expect(extractVersion("weekly-2024-11-20", "x.AppImage", "weekly")).toBe("weekly-2024.11.20");
  });

  it("parses GitHub asset digests", () => {
    expect(digestFromAsset({ digest: `sha256:${"A".repeat(64)}` })).toBe("a".repeat(64));
    expect(digestFromAsset({ digest: null })).toBeNull();
    expect(digestFromAsset({ digest: "md5:abc" })).toBeNull();
  });

  it("parses sha256 sidecar files and rejects mismatched names", () => {
    const hash = "f".repeat(64);
    expect(parseSha256File(`${hash}  FreeCAD_1.0.0.AppImage`)).toBe(hash);
    expect(parseSha256File(`${hash}`)).toBe(hash);
    expect(parseSha256File("# comment\nnot a hash")).toBeNull();
    expect(parseSha256File(`${hash}  other.AppImage`, "FreeCAD_1.0.0.AppImage")).toBeNull();
  });

  it("sorts artifacts newest first", () => {
    const sorted = sortArtifacts([
      { version: "0.20.0" },
      { version: "1.0.0" },
      { version: "0.21.2" },
    ] as never);
    expect(sorted.map((a) => a.version)).toEqual(["1.0.0", "0.21.2", "0.20.0"]);
  });
});

describe("catalog fetching", () => {
  it("caches a live response and can fall back to it offline", async () => {
    await withTempDir(async (dir) => {
      const cacheFile = `${dir}/catalog.json`;
      const live = [
        release({
          id: 1,
          tag_name: "1.0.0",
          assets: [asset("FreeCAD_1.0.0-Linux-x86_64.AppImage", 1, `sha256:${"a".repeat(64)}`)],
        }),
      ];
      const online = new GitHubClient({
        cacheDir: `${dir}/cache`,
        fetchImpl: sequenceFetch([jsonResponse(live)]),
      });
      const first = await fetchCatalog({ client: online, cacheFile });
      expect(first.fromNetwork).toBe(true);
      expect(first.stable).toHaveLength(1);

      const snapshot = await loadCatalogSnapshot(cacheFile);
      expect(snapshot?.stable).toHaveLength(1);

      const offline = new GitHubClient({
        cacheDir: `${dir}/cache`,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      });
      const second = await fetchCatalog({ client: offline, cacheFile });
      expect(second.stale).toBe(true);
      expect(second.fromNetwork).toBe(false);
      expect(second.stable).toHaveLength(1);
      expect(second.error).toContain("offline");
    });
  });

  it("reports rate-limit failures honestly", async () => {
    await withTempDir(async (dir) => {
      const cacheFile = `${dir}/catalog.json`;
      const client = new GitHubClient({
        cacheDir: `${dir}/cache`,
        fetchImpl: sequenceFetch([
          new Response("rate limited", {
            status: 403,
            headers: {
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1700000000",
            },
          }),
        ]),
      });
      const result = await fetchCatalog({ client, cacheFile });
      expect(result.error).toContain("rate limit");
      expect(result.rateLimit.limit).toBe(60);
      expect(result.rateLimit.remaining).toBe(0);
      expect(result.stable).toHaveLength(0);
    });
  });

  it("tolerates a corrupt snapshot file", async () => {
    await withTempDir(async (dir) => {
      const cacheFile = `${dir}/catalog.json`;
      await writeJsonAtomic(cacheFile, { schemaVersion: SCHEMA_VERSION, garbage: true });
      expect(await loadCatalogSnapshot(cacheFile)).toBeNull();
    });
  });

  it("resolves a checksum from a sibling -SHA256.txt asset", async () => {
    await withTempDir(async (dir) => {
      const hash = sha256("appimage-bytes");
      const artifact = {
        id: "1:1",
        releaseId: 1,
        assetId: 1,
        channel: "stable" as const,
        tag: "1.0.0",
        version: "1.0.0",
        architecture: "x86_64" as const,
        assetName: "FreeCAD_1.0.0-Linux-x86_64.AppImage",
        downloadUrl:
          "https://github.com/FreeCAD/FreeCAD/releases/download/1.0.0/FreeCAD_1.0.0-Linux-x86_64.AppImage",
        sizeBytes: 10,
        sha256: "",
        publishedAt: "2024-01-01T00:00:00Z",
        releaseName: "FreeCAD 1.0.0",
        releaseNotes: "",
      };
      const client = new GitHubClient({
        cacheDir: `${dir}/cache`,
        fetchImpl: sequenceFetch([
          new Response(`${hash}  FreeCAD_1.0.0-Linux-x86_64.AppImage\n`, { status: 200 }),
        ]),
      });
      expect(await resolveArtifactSha256(client, artifact)).toBe(hash);
    });
  });
});
