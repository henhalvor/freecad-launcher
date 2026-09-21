import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RateLimitInfo } from "../../shared/types.js";
import { ensureDir, pathExists, writeJsonAtomic } from "./atomic-json.js";

export const GITHUB_API = "https://api.github.com";
export const FREECAD_REPO = "FreeCAD/FreeCAD";
export const USER_AGENT = "freecad-launcher/1.0";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly rateLimit: RateLimitInfo,
    readonly offline: boolean,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubResponse<T> {
  data: T;
  rateLimit: RateLimitInfo;
  fromCache: boolean;
}

export interface GitHubClientOptions {
  cacheDir?: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface CacheEnvelope {
  storedAt: string;
  status: number;
  body: unknown;
}

function emptyRateLimit(authenticated: boolean): RateLimitInfo {
  return { limit: null, remaining: null, resetAt: null, authenticated };
}

function parseRateLimit(headers: Headers, authenticated: boolean): RateLimitInfo {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  return {
    limit: limit ? Number.parseInt(limit, 10) : null,
    remaining: remaining ? Number.parseInt(remaining, 10) : null,
    resetAt: reset ? new Date(Number.parseInt(reset, 10) * 1000).toISOString() : null,
    authenticated,
  };
}

export class GitHubClient {
  private readonly cacheDir: string | undefined;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private lastRateLimit: RateLimitInfo;

  constructor(options: GitHubClientOptions = {}) {
    this.cacheDir = options.cacheDir;
    this.token = options.token?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.lastRateLimit = emptyRateLimit(Boolean(this.token));
  }

  get authenticated(): boolean {
    return this.token !== null;
  }

  get rateLimit(): RateLimitInfo {
    return this.lastRateLimit;
  }

  private cachePath(url: string): string | undefined {
    if (!this.cacheDir) return undefined;
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    return join(this.cacheDir, `${hash}.json`);
  }

  private async readCache(url: string): Promise<GitHubResponse<unknown> | null> {
    const path = this.cachePath(url);
    if (!path || !(await pathExists(path))) return null;
    try {
      const raw = await readFile(path, "utf8");
      const envelope = JSON.parse(raw) as CacheEnvelope;
      return {
        data: envelope.body,
        rateLimit: emptyRateLimit(this.authenticated),
        fromCache: true,
      };
    } catch {
      return null;
    }
  }

  private async writeCache(url: string, status: number, body: unknown): Promise<void> {
    const path = this.cachePath(url);
    if (!path) return;
    await ensureDir(this.cacheDir!);
    const envelope: CacheEnvelope = { storedAt: this.now().toISOString(), status, body };
    await writeJsonAtomic(path, envelope);
  }

  /**
   * Perform an authenticated-when-possible GET. On a network failure the last
   * cached body is returned when available so the UI can run offline; otherwise
   * a GitHubError is thrown.
   */
  async get<T>(
    urlOrPath: string,
    init: { allowCacheFallback?: boolean } = {},
  ): Promise<GitHubResponse<T>> {
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${GITHUB_API}${urlOrPath}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, redirect: "follow" });
    } catch (error) {
      if (init.allowCacheFallback !== false) {
        const cached = await this.readCache(url);
        if (cached) return cached as GitHubResponse<T>;
      }
      throw new GitHubError(
        `Network request failed: ${(error as Error).message}`,
        null,
        emptyRateLimit(this.authenticated),
        true,
      );
    }

    const rateLimit = parseRateLimit(response.headers, this.authenticated);
    this.lastRateLimit = rateLimit;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const message =
        response.status === 403 && rateLimit.remaining === 0
          ? "GitHub API rate limit exceeded"
          : `GitHub request failed (${response.status}): ${bodyText.slice(0, 200)}`;
      throw new GitHubError(message, response.status, rateLimit, false);
    }

    const data = (await response.json()) as T;
    await this.writeCache(url, response.status, data);
    return { data, rateLimit, fromCache: false };
  }

  /**
   * Fetch a URL as text (used for `-SHA256.txt` sibling assets). Returns null
   * on any failure rather than throwing.
   */
  async getText(url: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }
}
