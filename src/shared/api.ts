import type {
  AppConfig,
  BuildBackend,
  CatalogResult,
  ChannelDefaults,
  DesktopEntry,
  DesktopEntryRequest,
  DisplayProject,
  DownloadProgressEvent,
  EnvironmentInfo,
  InstalledRelease,
  LaunchResult,
  MigrationReport,
  MilestoneInfo,
  NavigateEvent,
  PrBuildLogLine,
  PrBuildPhase,
  PrBuildProgress,
  PrBuildResult,
  PrWorkspace,
  PreviewResult,
  PullRequestDetails,
  PullRequestSearchResult,
  PullRequestSummary,
  ReleaseChannel,
  StatsFile,
} from "./types.js";

export interface LaunchRequest {
  releaseId: string;
  projectPaths?: string[];
  singleInstance?: boolean;
}

export interface PrLaunchRequest {
  number: number;
  projectPaths?: string[];
  singleInstance?: boolean;
}

export interface VersionList {
  installed: InstalledRelease[];
  defaults: ChannelDefaults;
}

export interface StatsView {
  stats: StatsFile;
  milestone: MilestoneInfo | null;
}

export type Unsubscribe = () => void;

/**
 * The complete surface exposed to the renderer through `contextBridge`. It is
 * intentionally narrow: no generic fs, ipc, shell, or process access.
 */
export interface LauncherApi {
  environment(): Promise<EnvironmentInfo>;
  quit(): Promise<void>;
  minimize(): Promise<void>;
  openExternal(url: string): Promise<boolean>;

  getConfig(): Promise<AppConfig>;
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>;

  fetchCatalog(force?: boolean): Promise<CatalogResult>;
  cachedCatalog(): Promise<CatalogResult | null>;

  listVersions(): Promise<VersionList>;
  installRelease(releaseId: string): Promise<InstalledRelease | null>;
  cancelInstall(releaseId: string): Promise<boolean>;
  removeRelease(releaseId: string, replacementId?: string | null): Promise<boolean>;
  setChannelDefault(channel: ReleaseChannel, releaseId: string | null): Promise<ChannelDefaults>;
  createDesktopEntry(request: DesktopEntryRequest): Promise<DesktopEntry>;

  launchRelease(request: LaunchRequest): Promise<LaunchResult>;

  scanProjects(dir?: string): Promise<DisplayProject[]>;
  previewProject(path: string): Promise<PreviewResult>;
  openExternalViewer(path: string): Promise<boolean>;

  listPullRequests(limit?: number): Promise<PullRequestSummary[]>;
  searchPullRequests(query: string): Promise<PullRequestSearchResult>;
  getPullRequest(number: number): Promise<PullRequestDetails>;
  toggleFavorite(number: number): Promise<number[]>;
  preparePullRequest(number: number, backend?: BuildBackend): Promise<PrWorkspace>;
  startPrBuild(number: number, backend?: BuildBackend): Promise<PrBuildResult>;
  cancelPrBuild(): Promise<boolean>;
  prBuildStatus(): Promise<{ running: boolean; phase: PrBuildPhase }>;
  launchPullRequest(request: PrLaunchRequest): Promise<LaunchResult>;
  removePullRequest(number: number): Promise<boolean>;

  getStats(): Promise<StatsView>;
  resetStats(): Promise<StatsFile>;

  runMigration(): Promise<MigrationReport>;

  pickDirectory(options?: { title?: string; startDir?: string }): Promise<string | null>;

  onDownloadProgress(callback: (event: DownloadProgressEvent) => void): Unsubscribe;
  onCatalogChanged(callback: (catalog: CatalogResult) => void): Unsubscribe;
  onBuildProgress(callback: (event: PrBuildProgress) => void): Unsubscribe;
  onBuildLog(callback: (event: PrBuildLogLine) => void): Unsubscribe;
  onStatsChanged(callback: (stats: StatsFile) => void): Unsubscribe;
  onNavigate(callback: (event: NavigateEvent) => void): Unsubscribe;
}
