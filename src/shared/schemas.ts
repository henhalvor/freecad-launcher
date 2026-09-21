import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const releaseChannelSchema = z.enum(["stable", "weekly"]);
export const buildBackendSchema = z.enum(["nix", "pixi"]);
export const themeSchema = z.enum(["dark", "light"]);

export const releaseArtifactSchema = z.object({
  id: z.string().min(1),
  releaseId: z.number().int().nonnegative(),
  assetId: z.number().int().nonnegative(),
  channel: releaseChannelSchema,
  tag: z.string().min(1),
  version: z.string().min(1),
  architecture: z.literal("x86_64"),
  assetName: z.string().min(1),
  downloadUrl: z.string().url(),
  sizeBytes: z.number().int().nonnegative(),
  // Empty when the catalog could not resolve a digest; the downloader then
  // requires a matching `-SHA256.txt` asset before anything is installed.
  sha256: z
    .string()
    .regex(/^([a-f0-9]{64})?$/i)
    .transform((v) => v.toLowerCase()),
  publishedAt: z.string(),
});

export const installedReleaseSchema = releaseArtifactSchema.extend({
  path: z.string().min(1),
  installedAt: z.string(),
  verifiedAt: z.string(),
  intact: z.boolean(),
});

export const channelDefaultsSchema = z.object({
  stable: z.string().optional(),
  weekly: z.string().optional(),
});

export const catalogSnapshotSchema = z.object({
  schemaVersion: z.number().int(),
  fetchedAt: z.string(),
  fromNetwork: z.boolean(),
  stable: z.array(releaseArtifactSchema),
  weekly: z.array(releaseArtifactSchema),
  error: z.string().optional(),
});

export const rateLimitInfoSchema = z.object({
  limit: z.number().int().nullable(),
  remaining: z.number().int().nullable(),
  resetAt: z.string().nullable(),
  authenticated: z.boolean(),
});

export const catalogResultSchema = z.object({
  stable: z.array(releaseArtifactSchema),
  weekly: z.array(releaseArtifactSchema),
  rateLimit: rateLimitInfoSchema,
  fromNetwork: z.boolean(),
  stale: z.boolean(),
  error: z.string().optional(),
});

export const appConfigSchema = z.object({
  schemaVersion: z.number().int(),
  versionsDir: z.string().min(1),
  projectsDir: z.string().min(1),
  theme: themeSchema,
  closeOnLaunch: z.boolean(),
  vanilla: z.boolean(),
  tutorialHidpi: z.boolean(),
  disableFreecadStartPage: z.boolean(),
  disableUpdateReminder: z.boolean(),
  prBuildBackend: buildBackendSchema,
  prHistory: z.array(z.number().int()),
  prFavorites: z.array(z.number().int()),
  lastSelectedReleaseId: z.string().nullable(),
  channelDefaults: z.object({
    stable: z.string().optional(),
    weekly: z.string().optional(),
  }),
  onboarded: z.boolean(),
});

export const statEntrySchema = z.object({
  launches: z.number().int().nonnegative(),
  timeSec: z.number().nonnegative(),
  lastUsedAt: z.string(),
});

export const statsFileSchema = z.object({
  schemaVersion: z.number().int(),
  entries: z.record(z.string(), statEntrySchema),
});

export const projectFormatSchema = z.enum(["FCStd", "STEP", "IGES", "STL", "BREP"]);

export const projectFileSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  format: projectFormatSchema,
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string(),
});

export const meshDataSchema = z.object({
  positions: z.array(z.number()),
  triangleCount: z.number().int().nonnegative(),
});

export const previewResultSchema = z.object({
  path: z.string(),
  kind: z.enum(["thumbnail", "mesh", "none"]),
  thumbnailDataUrl: z.string().optional(),
  mesh: meshDataSchema.optional(),
  metadata: z
    .object({
      programVersion: z.string().nullable(),
      label: z.string().nullable(),
      creator: z.string().nullable(),
    })
    .optional(),
  cached: z.boolean(),
  message: z.string().optional(),
});

export const pullRequestSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  author: z.string(),
  authorAvatarUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  htmlUrl: z.string(),
  labels: z.array(z.string()),
  comments: z.number().int().nonnegative(),
  isFavorite: z.boolean(),
});

export const pullRequestCommentSchema = z.object({
  id: z.number().int(),
  author: z.string(),
  authorAvatarUrl: z.string(),
  createdAt: z.string(),
  body: z.string(),
  bodyHtml: z.string(),
});

export const milestoneInfoSchema = z.object({
  title: z.string(),
  open: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percent: z.number(),
  dueOn: z.string().nullable(),
  url: z.string(),
});

export const pullRequestDetailsSchema = pullRequestSummarySchema.extend({
  body: z.string(),
  bodyHtml: z.string(),
  mergeableState: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  milestone: milestoneInfoSchema.nullable(),
  commentsList: z.array(pullRequestCommentSchema),
});

export const pullRequestSearchResultSchema = z.object({
  total: z.number().int().nonnegative(),
  incomplete: z.boolean(),
  items: z.array(pullRequestSummarySchema),
});

export const prWorkspaceSchema = z.object({
  number: z.number().int().positive(),
  mirrorDir: z.string(),
  worktreeDir: z.string(),
  buildDir: z.string(),
  backend: buildBackendSchema,
  preparedAt: z.string().nullable(),
  builtAt: z.string().nullable(),
  executable: z.string().nullable(),
  headSha: z.string().nullable(),
});

export const prBuildProgressSchema = z.object({
  number: z.number().int(),
  phase: z.enum([
    "idle",
    "fetching",
    "preparing",
    "configuring",
    "compiling",
    "finished",
    "failed",
    "cancelled",
  ]),
  percent: z.number().nullable(),
  message: z.string(),
  running: z.boolean(),
});

export const environmentInfoSchema = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  chromeVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  isNixOS: z.boolean(),
  hasAppimageRun: z.boolean(),
  appimageRunPath: z.string().nullable(),
  hasF3d: z.boolean(),
  f3dPath: z.string().nullable(),
  hasPixi: z.boolean(),
  pixiPath: z.string().nullable(),
  hasGit: z.boolean(),
  gitPath: z.string().nullable(),
  githubAuthenticated: z.boolean(),
});

/**
 * Parse persisted data, falling back to `fallback` when the value is absent or
 * invalid. A migration problem must never crash the launcher.
 */
export function parseWithFallback<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

/** Parse a persisted object with defaults merged underneath it. */
export function parseMerged<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  value: unknown,
  defaults: z.infer<z.ZodObject<T>>,
): z.infer<z.ZodObject<T>> {
  const merged = { ...defaults, ...(typeof value === "object" && value !== null ? value : {}) };
  const result = schema.safeParse(merged);
  return result.success ? result.data : defaults;
}
