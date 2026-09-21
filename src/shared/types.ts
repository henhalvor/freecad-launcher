/**
 * Shared domain types. This module is the single source of truth for the
 * shapes that cross the main/renderer boundary and that are persisted to disk.
 * Runtime validation lives in `schemas.ts`.
 */

export type ReleaseChannel = "stable" | "weekly";
export type BuildBackend = "nix" | "pixi";
export type Architecture = "x86_64";
export type Theme = "dark" | "light";

/** An official FreeCAD GitHub release asset the launcher can install. */
export interface ReleaseArtifact {
  /** `${releaseId}:${assetId}` — stable identifier used as the install directory name. */
  id: string;
  releaseId: number;
  assetId: number;
  channel: ReleaseChannel;
  tag: string;
  version: string;
  architecture: Architecture;
  assetName: string;
  downloadUrl: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 from the asset digest or its `-SHA256.txt` sibling. */
  sha256: string;
  publishedAt: string;
  /** Release display name from GitHub, falling back to the tag. */
  releaseName: string;
  /** Raw Markdown release notes. Rendered and sanitized in the main process. */
  releaseNotes: string;
}

/** A release that has been downloaded, verified and installed. */
export interface InstalledRelease extends ReleaseArtifact {
  path: string;
  installedAt: string;
  verifiedAt: string;
  /** True when the file is executable and the size matches. Recomputed on scan. */
  intact: boolean;
}

export interface ChannelDefaults {
  stable?: string;
  weekly?: string;
}

/** Persisted catalog cache for offline browsing. */
export interface CatalogSnapshot {
  schemaVersion: number;
  fetchedAt: string;
  /** True when the snapshot was produced from a live GitHub response. */
  fromNetwork: boolean;
  stable: ReleaseArtifact[];
  weekly: ReleaseArtifact[];
  error?: string;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  authenticated: boolean;
}

export interface CatalogResult {
  stable: ReleaseArtifact[];
  weekly: ReleaseArtifact[];
  rateLimit: RateLimitInfo;
  fromNetwork: boolean;
  stale: boolean;
  error?: string;
}

/** Application configuration persisted at `$XDG_CONFIG_HOME/freecad-launcher/config.json`. */
export interface AppConfig {
  schemaVersion: number;
  /** Root directory that holds installed AppImages. Absolute, user-owned. */
  versionsDir: string;
  /** Directory scanned by the project library. Absolute, user-owned. */
  projectsDir: string;
  theme: Theme;
  closeOnLaunch: boolean;
  vanilla: boolean;
  tutorialHidpi: boolean;
  disableFreecadStartPage: boolean;
  disableUpdateReminder: boolean;
  prBuildBackend: BuildBackend;
  prHistory: number[];
  prFavorites: number[];
  lastSelectedReleaseId: string | null;
  /** Explicit per-channel default installed release ids. */
  channelDefaults: ChannelDefaults;
  /** Whether the first-run welcome has been shown. */
  onboarded: boolean;
}

/** Per-key usage statistics. Key is a release id, a PR key, or a channel. */
export interface StatEntry {
  launches: number;
  timeSec: number;
  lastUsedAt: string;
}

export interface StatsFile {
  schemaVersion: number;
  entries: Record<string, StatEntry>;
}

export interface SessionRecord {
  key: string;
  label: string;
  kind: "release" | "pr";
  startedAt: string;
  durationSec: number;
}

/** Resolved profile locations for a launch. */
export interface ProfilePaths {
  kind: "stable" | "weekly" | "pr" | "vanilla";
  configDir: string;
  dataDir: string;
  /** `-u` argument value. */
  userCfg: string;
  /** `-s` argument value. */
  systemCfg: string;
  /** When set the whole config/data tree is deleted after the session ends. */
  ephemeral: boolean;
}

export interface LaunchPlan {
  releaseId: string;
  channel: ReleaseChannel;
  /** Path to the Nix-provided `appimage-run` wrapper. */
  appimageRun: string;
  appImagePath: string;
  projectFiles: string[];
  singleInstance: boolean;
  profile: ProfilePaths;
  tutorialHidpi: boolean;
  /**
   * Environment overlay applied on top of the clean base environment. Keys with
   * a null value must be removed from the inherited environment.
   */
  env: Record<string, string | null>;
  /** Full argument vector, including the appimage-run launcher as argv[0]. */
  argv: string[];
  /** Set on extract-and-run retries. */
  extractAndRun: boolean;
}

export interface LaunchResult {
  ok: boolean;
  runtimeKind: "native" | "extract-and-run";
  pid?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Pull requests                                                       */
/* ------------------------------------------------------------------ */

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  authorAvatarUrl: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  labels: string[];
  comments: number;
  isFavorite: boolean;
}

export interface PullRequestDetails extends PullRequestSummary {
  body: string;
  bodyHtml: string;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRef: string;
  headRef: string;
  headSha: string;
  milestone: MilestoneInfo | null;
  commentsList: PullRequestComment[];
}

export interface PullRequestComment {
  id: number;
  author: string;
  authorAvatarUrl: string;
  createdAt: string;
  body: string;
  bodyHtml: string;
}

export interface MilestoneInfo {
  title: string;
  open: number;
  closed: number;
  total: number;
  percent: number;
  dueOn: string | null;
  url: string;
}

export interface PullRequestSearchResult {
  total: number;
  incomplete: boolean;
  items: PullRequestSummary[];
}

/** A launcher-owned worktree for a PR, never the user's checkout. */
export interface PrWorkspace {
  number: number;
  mirrorDir: string;
  worktreeDir: string;
  buildDir: string;
  backend: BuildBackend;
  preparedAt: string | null;
  builtAt: string | null;
  executable: string | null;
  headSha: string | null;
}

export interface DownloadProgressEvent {
  releaseId: string;
  assetName: string;
  state: "downloading" | "done" | "error" | "cancelled";
  percent: number | null;
  receivedBytes?: number;
  totalBytes?: number | null;
  message?: string;
}

export interface NavigateEvent {
  view?: string;
  error?: string;
}

export type PrBuildPhase =
  | "idle"
  | "fetching"
  | "preparing"
  | "configuring"
  | "compiling"
  | "finished"
  | "failed"
  | "cancelled";

export interface PrBuildProgress {
  number: number;
  phase: PrBuildPhase;
  /** 0-100 when known, otherwise null. */
  percent: number | null;
  message: string;
  /** True while a build owns the single build slot. */
  running: boolean;
}

export interface PrBuildLogLine {
  number: number;
  at: string;
  stream: "stdout" | "stderr" | "launcher";
  text: string;
}

/* ------------------------------------------------------------------ */
/* Projects and previews                                               */
/* ------------------------------------------------------------------ */

export type ProjectFormat = "FCStd" | "STEP" | "IGES" | "STL" | "BREP";

export interface ProjectFile {
  /** Absolute path — keeps duplicate basenames distinct. */
  path: string;
  name: string;
  format: ProjectFormat;
  sizeBytes: number;
  modifiedAt: string;
}

export interface DisplayProject extends ProjectFile {
  displayName: string;
  directory: string;
}

export interface PrBuildResult {
  ok: boolean;
  phase: PrBuildPhase;
  executable: string | null;
  error?: string;
}

export interface FcstdMetadata {
  programVersion: string | null;
  label: string | null;
  creator: string | null;
}

export interface MeshData {
  /** Flat XYZ positions, length = 9 * triangleCount. */
  positions: number[];
  triangleCount: number;
}

export interface PreviewResult {
  path: string;
  kind: "thumbnail" | "mesh" | "none";
  /** Data URL of the embedded FCStd thumbnail, when present. */
  thumbnailDataUrl?: string;
  mesh?: MeshData;
  metadata?: FcstdMetadata;
  cached: boolean;
  message?: string;
}

/* ------------------------------------------------------------------ */
/* Desktop entries                                                     */
/* ------------------------------------------------------------------ */

export interface DesktopEntryRequest {
  kind: "launcher" | "stable" | "weekly" | "version";
  releaseId?: string;
}

export interface DesktopEntry {
  fileName: string;
  path: string;
  name: string;
  exec: string;
  pinnedReleaseId: string | null;
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

export interface MigrationReport {
  legacyConfigFound: boolean;
  legacyStatsFound: boolean;
  adoptedAppImages: Array<{ sourcePath: string; releaseId: string; assetName: string }>;
  unmatchedAppImages: string[];
  copiedStats: number;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* API / environment                                                   */
/* ------------------------------------------------------------------ */

export interface EnvironmentInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  isNixOS: boolean;
  hasAppimageRun: boolean;
  appimageRunPath: string | null;
  hasF3d: boolean;
  f3dPath: string | null;
  hasPixi: boolean;
  pixiPath: string | null;
  hasGit: boolean;
  gitPath: string | null;
  githubAuthenticated: boolean;
}

export interface AppPaths {
  configFile: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  versionsDir: string;
  catalogFile: string;
  statsFile: string;
  logsDir: string;
  downloadsDir: string;
  previewsDir: string;
  githubCacheDir: string;
  prDir: string;
  prMirrorDir: string;
  prWorktreesDir: string;
  prProfilesDir: string;
}

export interface UserFacingError {
  title: string;
  message: string;
  detail?: string;
}
