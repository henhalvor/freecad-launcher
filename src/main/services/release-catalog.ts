import { basename } from "node:path";
import type { z } from "zod";
import { SCHEMA_VERSION, catalogSnapshotSchema } from "../../shared/schemas.js";
import type { RateLimitInfo, ReleaseArtifact, ReleaseChannel } from "../../shared/types.js";
import { readJson, writeJsonAtomic } from "./atomic-json.js";
import { FREECAD_REPO, type GitHubClient, GitHubError } from "./github.js";

export interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name?: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GitHubAsset[];
}

export const CATALOG_PAGE_SIZE = 30;

/**
 * Stable means a published non-draft, non-prerelease release. Weekly means a
 * published non-draft prerelease whose tag starts with `weekly-`. Everything
 * else (release candidates, dev tags) is ignored.
 */
export function classifyRelease(
  release: Pick<GitHubRelease, "draft" | "prerelease" | "tag_name">,
): ReleaseChannel | null {
  if (release.draft) return null;
  const tag = release.tag_name?.trim() ?? "";
  if (!tag) return null;
  if (release.prerelease) {
    return tag.toLowerCase().startsWith("weekly-") ? "weekly" : null;
  }
  return "stable";
}

const CHECKSUM_MARKERS = [
  "sha256",
  ".sha256",
  ".zsync",
  ".sig",
  ".asc",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
];

/** Official Linux x86_64 AppImage assets only. Checksum sidecars are excluded. */
export function isMatchingAppImage(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".appimage")) return false;
  if (CHECKSUM_MARKERS.some((marker) => lower.includes(marker))) return false;
  if (!(lower.includes("x86_64") || lower.includes("amd64"))) return false;
  return true;
}

/** Extract the human version string from a tag, falling back to the asset name. */
export function extractVersion(tag: string, assetName: string, channel: ReleaseChannel): string {
  const haystack = `${tag} ${basename(assetName, ".AppImage")}`;
  if (channel === "weekly") {
    const weekly = /weekly[-_](\d+(?:\.\d+){1,3})/i.exec(haystack);
    if (weekly?.[1]) return `weekly-${weekly[1]}`;
    const date = /(\d{4})[.-](\d{2})[.-](\d{2})/.exec(haystack);
    if (date) return `weekly-${date[1]}.${date[2]}.${date[3]}`;
    return tag.trim();
  }
  const semver = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(haystack);
  return semver?.[1] ?? tag.replace(/^v/i, "").trim();
}

/** Sort newest first using a numeric version key, then tag, then asset name. */
export function versionSortKey(artifact: ReleaseArtifact): string {
  const match = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(artifact.version);
  const source = match?.[1] ?? artifact.version;
  const parts = source.split(".").map((p) => Number.parseInt(p, 10));
  while (parts.length < 4) parts.push(0);
  return parts
    .slice(0, 4)
    .map((p) => String(Number.isFinite(p) ? p : 0).padStart(6, "0"))
    .join(".");
}

export function sortArtifacts(artifacts: ReleaseArtifact[]): ReleaseArtifact[] {
  return [...artifacts].sort((a, b) => {
    const byVersion = versionSortKey(b).localeCompare(versionSortKey(a));
    if (byVersion !== 0) return byVersion;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
}

/** Read `sha256:abcd...` from a GitHub asset digest field. */
export function digestFromAsset(asset: Pick<GitHubAsset, "digest">): string | null {
  const digest = asset.digest?.trim();
  if (!digest) return null;
  const match = /(?:sha256:)?([a-f0-9]{64})/i.exec(digest);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Parse the content of a `*-SHA256.txt` asset. Accepts both
 * `<hash>  <filename>` and bare `<hash>` lines.
 */
export function parseSha256File(content: string, expectedFileName?: string): string | null {
  const expected = expectedFileName ? basename(expectedFileName).toLowerCase() : null;
  let sawNamedEntry = false;
  let firstHash: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-f0-9]{64})\b\s*\*?(.*)$/i.exec(line);
    if (!match) continue;
    const hash = match[1]!.toLowerCase();
    const file = match[2]?.trim();
    if (!firstHash) firstHash = hash;
    if (!expected) return hash;
    if (file) {
      sawNamedEntry = true;
      if (basename(file).toLowerCase() === expected) return hash;
    }
  }
  // If the file lists names and none matched, refuse rather than return a hash
  // for a different asset. A bare hash with no filename is still accepted.
  if (expected && sawNamedEntry) return null;
  return firstHash;
}

/** Find a checksum sidecar asset belonging to the same release. */
export function findChecksumAsset(asset: GitHubAsset, release: GitHubRelease): GitHubAsset | null {
  const base = basename(asset.name).toLowerCase();
  const stem = base.replace(/\.appimage$/, "");
  for (const candidate of release.assets) {
    const lower = candidate.name.toLowerCase();
    if (!lower.includes("sha256")) continue;
    if (lower.includes(stem) || stem.includes(lower.replace(/-sha256\.txt$/, ""))) return candidate;
  }
  return null;
}

export function artifactFromAsset(
  release: GitHubRelease,
  asset: GitHubAsset,
  channel: ReleaseChannel,
): ReleaseArtifact {
  return {
    id: `${release.id}:${asset.id}`,
    releaseId: release.id,
    assetId: asset.id,
    channel,
    tag: release.tag_name,
    version: extractVersion(release.tag_name, asset.name, channel),
    architecture: "x86_64",
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
    sizeBytes: asset.size,
    sha256: digestFromAsset(asset) ?? "",
    publishedAt: release.published_at ?? new Date(0).toISOString(),
  };
}

export function artifactsFromReleases(releases: GitHubRelease[]): {
  stable: ReleaseArtifact[];
  weekly: ReleaseArtifact[];
  skippedNoDigest: number;
} {
  const stable: ReleaseArtifact[] = [];
  const weekly: ReleaseArtifact[] = [];
  let skippedNoDigest = 0;
  for (const release of releases) {
    const channel = classifyRelease(release);
    if (!channel) continue;
    for (const asset of release.assets ?? []) {
      if (!isMatchingAppImage(asset.name)) continue;
      const artifact = artifactFromAsset(release, asset, channel);
      if (!artifact.sha256) skippedNoDigest += 1;
      if (channel === "weekly") weekly.push(artifact);
      else stable.push(artifact);
    }
  }
  return { stable: sortArtifacts(stable), weekly: sortArtifacts(weekly), skippedNoDigest };
}

/**
 * Resolve the SHA-256 for an artifact that the catalog could not digest. Tries
 * the conventional `<asset>-SHA256.txt` sibling URL, then lists the release's
 * assets to find the checksum file.
 */
export async function resolveArtifactSha256(
  client: GitHubClient,
  artifact: ReleaseArtifact,
): Promise<string | null> {
  if (artifact.sha256) return artifact.sha256;
  const guess = `${artifact.downloadUrl}-SHA256.txt`;
  const direct = await client.getText(guess);
  if (direct) {
    const hash = parseSha256File(direct, artifact.assetName);
    if (hash) return hash;
  }
  try {
    const assets = await client.get<GitHubAsset[]>(
      `/repos/${FREECAD_REPO}/releases/${artifact.releaseId}/assets?per_page=100`,
    );
    const release: GitHubRelease = {
      id: artifact.releaseId,
      tag_name: artifact.tag,
      draft: false,
      prerelease: artifact.channel === "weekly",
      published_at: artifact.publishedAt,
      assets: assets.data ?? [],
    };
    const checksum = findChecksumAsset(
      {
        id: artifact.assetId,
        name: artifact.assetName,
        size: artifact.sizeBytes,
        browser_download_url: artifact.downloadUrl,
      },
      release,
    );
    if (checksum) {
      const text = await client.getText(checksum.browser_download_url);
      if (text) return parseSha256File(text, artifact.assetName);
    }
  } catch {
    return null;
  }
  return null;
}

export interface CatalogFetchOptions {
  client: GitHubClient;
  cacheFile: string;
  perPage?: number;
  now?: () => Date;
}

/**
 * Fetch and classify the catalog. On a network error the last valid snapshot is
 * returned with `stale: true` and an honest error message so the UI can browse
 * offline. The snapshot is only overwritten by a live, non-empty response.
 */
export async function fetchCatalog(options: CatalogFetchOptions): Promise<{
  stable: ReleaseArtifact[];
  weekly: ReleaseArtifact[];
  rateLimit: RateLimitInfo;
  fromNetwork: boolean;
  stale: boolean;
  error?: string;
}> {
  const { client, cacheFile } = options;
  const now = options.now ?? (() => new Date());
  const perPage = options.perPage ?? CATALOG_PAGE_SIZE;
  const snapshot = await loadCatalogSnapshot(cacheFile);

  try {
    const response = await client.get<GitHubRelease[]>(
      `/repos/${FREECAD_REPO}/releases?per_page=${perPage}`,
      { allowCacheFallback: false },
    );
    const releases = Array.isArray(response.data) ? response.data : [];
    const { stable, weekly } = artifactsFromReleases(releases);
    if (stable.length === 0 && weekly.length === 0) {
      throw new GitHubError(
        "GitHub returned no matching FreeCAD releases",
        200,
        response.rateLimit,
        false,
      );
    }
    await writeJsonAtomic(cacheFile, {
      schemaVersion: SCHEMA_VERSION,
      fetchedAt: now().toISOString(),
      fromNetwork: true,
      stable,
      weekly,
    });
    return {
      stable,
      weekly,
      rateLimit: response.rateLimit,
      fromNetwork: true,
      stale: false,
    };
  } catch (error) {
    const rateLimit = error instanceof GitHubError ? error.rateLimit : client.rateLimit;
    const message = error instanceof Error ? error.message : String(error);
    if (snapshot) {
      return {
        stable: snapshot.stable,
        weekly: snapshot.weekly,
        rateLimit,
        fromNetwork: false,
        stale: true,
        error: message,
      };
    }
    return {
      stable: [],
      weekly: [],
      rateLimit,
      fromNetwork: false,
      stale: false,
      error: message,
    };
  }
}

export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;

export async function loadCatalogSnapshot(cacheFile: string): Promise<CatalogSnapshot | null> {
  const raw = await readJson(cacheFile);
  const parsed = catalogSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
