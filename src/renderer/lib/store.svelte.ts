import type { ReleaseNotes, StatsView, VersionList } from "@shared/api";
import type {
  AppConfig,
  BuildBackend,
  CatalogResult,
  DesktopEntryRequest,
  DisplayProject,
  DownloadProgressEvent,
  EnvironmentInfo,
  MigrationReport,
  PrBuildLogLine,
  PrBuildProgress,
  PrWorkspace,
  PreviewResult,
  PullRequestDetails,
  PullRequestSearchResult,
  PullRequestSummary,
  ReleaseChannel,
} from "@shared/types";
import { api } from "./api";

export type ViewId = "versions" | "projects" | "pullrequests" | "statistics" | "settings";
export type ToastKind = "info" | "success" | "error";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface PickDirectoryOptions {
  title?: string;
  startDir?: string;
}

const MAX_BUILD_LOG_LINES = 500;

function normalizeView(value: string | undefined): ViewId | null {
  switch ((value ?? "").toLowerCase()) {
    case "versions":
    case "version":
    case "releases":
      return "versions";
    case "projects":
    case "project":
      return "projects";
    case "pullrequests":
    case "pull-requests":
    case "pull_request":
    case "prs":
    case "pr":
      return "pullrequests";
    case "statistics":
    case "stats":
      return "statistics";
    case "settings":
    case "preferences":
      return "settings";
    default:
      return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

class LauncherStore {
  view = $state<ViewId>("versions");
  ready = $state(false);
  config = $state<AppConfig | null>(null);
  environment = $state<EnvironmentInfo | null>(null);
  catalog = $state<CatalogResult | null>(null);
  releaseNotes = $state<Record<string, ReleaseNotes>>({});
  notesLoading = $state<Record<string, boolean>>({});
  versions = $state<VersionList>({ installed: [], defaults: {} });
  downloads = $state<Record<string, DownloadProgressEvent>>({});
  projects = $state<DisplayProject[]>([]);
  selectedProject = $state<DisplayProject | null>(null);
  preview = $state<PreviewResult | null>(null);
  prList = $state<PullRequestSummary[]>([]);
  prSearchResult = $state<PullRequestSearchResult | null>(null);
  prQuery = $state("");
  selectedPrNumber = $state<number | null>(null);
  prDetails = $state<PullRequestDetails | null>(null);
  prWorkspace = $state<PrWorkspace | null>(null);
  buildProgress = $state<PrBuildProgress | null>(null);
  buildLog = $state<PrBuildLogLine[]>([]);
  stats = $state<StatsView | null>(null);
  migrationReport = $state<MigrationReport | null>(null);
  toasts = $state<ToastMessage[]>([]);
  busy = $state<Record<string, boolean>>({});

  installedStable = $derived(
    this.versions.installed.filter((release) => release.channel === "stable"),
  );
  installedWeekly = $derived(
    this.versions.installed.filter((release) => release.channel === "weekly"),
  );
  hasInstalled = $derived(this.versions.installed.length > 0);
  activeDownloads = $derived(
    Object.values(this.downloads).filter((event) => event.state === "downloading"),
  );
  favorites = $derived(this.config?.prFavorites ?? []);
  favoritePullRequests = $derived(this.prList.filter((pr) => pr.isFavorite));

  #initialized = false;
  #toastSeq = 0;

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#subscribe();

    $effect.root(() => {
      $effect(() => {
        if (typeof document !== "undefined") {
          document.documentElement.dataset.theme = this.config?.theme ?? "dark";
        }
      });
    });

    const [environment, config] = await Promise.all([
      this.run("environment", () => api.environment()),
      this.run("config", () => api.getConfig()),
    ]);
    if (environment) this.environment = environment;
    if (config) this.config = config;

    await this.refreshVersions();
    const cached = await this.run("catalog-cached", () => api.cachedCatalog());
    if (cached) this.catalog = cached;
    await this.refreshCatalog(false);
    this.ready = true;
  }

  #subscribe(): void {
    api.onDownloadProgress((event) => {
      this.downloads[event.releaseId] = event;
      if (event.state === "done") {
        this.toast("success", `Installed ${event.assetName}`);
        void this.refreshVersions();
      } else if (event.state === "error") {
        this.toast("error", event.message ?? `Failed to install ${event.assetName}`);
      }
    });

    api.onCatalogChanged((catalog) => {
      this.catalog = catalog;
    });

    api.onBuildProgress((event) => {
      this.buildProgress = event;
      this.busy["pr-build"] = event.running;
    });

    api.onBuildLog((event) => {
      const next = [...this.buildLog, event];
      this.buildLog =
        next.length > MAX_BUILD_LOG_LINES ? next.slice(next.length - MAX_BUILD_LOG_LINES) : next;
    });

    api.onStatsChanged((stats) => {
      this.stats = { stats, milestone: this.stats?.milestone ?? null };
    });

    api.onNavigate((event) => {
      const view = normalizeView(event.view);
      if (view) this.view = view;
      if (event.error) this.toast("error", event.error);
    });
  }

  setView(view: ViewId): void {
    this.view = view;
  }

  toast(kind: ToastKind, text: string): void {
    this.#toastSeq += 1;
    const id = this.#toastSeq;
    this.toasts = [...this.toasts, { id, kind, text }];
    const timeout = kind === "error" ? 9000 : 5000;
    setTimeout(() => this.dismissToast(id), timeout);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  /** Run an api call, tracking a busy flag and surfacing rejections as toasts. */
  async run<T>(key: string, action: () => Promise<T>): Promise<T | null> {
    this.busy[key] = true;
    try {
      return await action();
    } catch (error) {
      this.toast("error", errorMessage(error));
      return null;
    } finally {
      this.busy[key] = false;
    }
  }

  isBusy(key: string): boolean {
    return this.busy[key] === true;
  }

  /* ------------------------------------------------------------------ */
  /* Versions / catalog                                                  */
  /* ------------------------------------------------------------------ */

  async refreshVersions(): Promise<void> {
    const result = await this.run("versions", () => api.listVersions());
    if (result) {
      this.versions = result;
      if (this.config) this.config = { ...this.config, channelDefaults: result.defaults };
    }
  }

  async refreshCatalog(force: boolean): Promise<void> {
    const result = await this.run("catalog", () => api.fetchCatalog(force));
    if (result) {
      this.catalog = result;
      // Catalog refreshes can change the notes; drop the cache.
      this.releaseNotes = {};
    }
  }

  /** Lazily load and cache the rendered release notes for a release. */
  async loadReleaseNotes(releaseId: string): Promise<ReleaseNotes | null> {
    const cached = this.releaseNotes[releaseId];
    if (cached) return cached;
    this.notesLoading[releaseId] = true;
    try {
      const notes = await this.run(`notes:${releaseId}`, () => api.releaseNotes(releaseId));
      if (notes) this.releaseNotes = { ...this.releaseNotes, [releaseId]: notes };
      return notes;
    } finally {
      this.notesLoading[releaseId] = false;
    }
  }

  async installRelease(releaseId: string): Promise<void> {
    const key = `install:${releaseId}`;
    this.busy[key] = true;
    try {
      const installed = await api.installRelease(releaseId);
      if (installed) {
        this.toast("success", `Installed ${installed.assetName}`);
        await this.refreshVersions();
      }
    } catch (error) {
      this.toast("error", errorMessage(error));
    } finally {
      this.busy[key] = false;
    }
  }

  async cancelInstall(releaseId: string): Promise<void> {
    const cancelled = await this.run(`cancel:${releaseId}`, () => api.cancelInstall(releaseId));
    if (cancelled === false) this.toast("info", "That download is no longer running");
  }

  async removeRelease(releaseId: string, replacementId: string | null): Promise<boolean> {
    const removed = await this.run("remove", () => api.removeRelease(releaseId, replacementId));
    if (removed) {
      this.toast("success", "Release removed");
      await this.refreshVersions();
      return true;
    }
    return false;
  }

  async setChannelDefault(channel: ReleaseChannel, releaseId: string | null): Promise<void> {
    const defaults = await this.run("default", () => api.setChannelDefault(channel, releaseId));
    if (defaults) {
      this.versions = { ...this.versions, defaults };
      if (this.config) this.config = { ...this.config, channelDefaults: defaults };
    }
  }

  async createDesktopEntry(request: DesktopEntryRequest): Promise<void> {
    const entry = await this.run("desktop", () => api.createDesktopEntry(request));
    if (entry) this.toast("success", `Created ${entry.fileName}`);
  }

  latestForChannel(channel: ReleaseChannel): string | null {
    const list = channel === "stable" ? this.catalog?.stable : this.catalog?.weekly;
    return list?.[0]?.version ?? null;
  }

  defaultRelease(channel: ReleaseChannel): string | null {
    const id = channel === "stable" ? this.versions.defaults.stable : this.versions.defaults.weekly;
    return id ?? null;
  }

  installedForChannel(channel: ReleaseChannel): typeof this.versions.installed {
    return this.versions.installed.filter((release) => release.channel === channel);
  }

  /** Best installed release id: stable default, weekly default, then newest install. */
  preferredReleaseId(): string | null {
    const defaults = this.versions.defaults;
    if (defaults.stable) return defaults.stable;
    if (defaults.weekly) return defaults.weekly;
    const sorted = [...this.versions.installed].sort((a, b) =>
      b.installedAt.localeCompare(a.installedAt),
    );
    return sorted[0]?.id ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Projects                                                            */
  /* ------------------------------------------------------------------ */

  async refreshProjects(): Promise<void> {
    const projects = await this.run("projects", () => api.scanProjects());
    if (projects) this.projects = projects;
  }

  async chooseProjectsDir(): Promise<void> {
    const dir = await this.pickDirectory({
      title: "Select projects directory",
      startDir: this.config?.projectsDir,
    });
    if (!dir) return;
    await this.updateConfig({ projectsDir: dir });
    await this.refreshProjects();
  }

  async selectProject(project: DisplayProject): Promise<void> {
    this.selectedProject = project;
    this.preview = null;
    const preview = await this.run("preview", () => api.previewProject(project.path));
    if (preview) this.preview = preview;
  }

  async launchInstalledRelease(releaseId: string): Promise<void> {
    const result = await this.run("launch", () => api.launchRelease({ releaseId }));
    if (result) {
      if (result.ok) this.toast("success", "Launching FreeCAD");
      else this.toast("error", result.error ?? "FreeCAD failed to launch");
    }
  }

  async launchProject(singleInstance: boolean): Promise<void> {
    const project = this.selectedProject;
    if (!project) return;
    const releaseId = this.preferredReleaseId();
    if (!releaseId) {
      this.toast("error", "No installed FreeCAD release available");
      return;
    }
    const result = await this.run("launch", () =>
      api.launchRelease({ releaseId, projectPaths: [project.path], singleInstance }),
    );
    if (result) {
      if (result.ok) this.toast("success", `Launching ${project.displayName}`);
      else this.toast("error", result.error ?? "FreeCAD failed to launch");
    }
  }

  async openExternalViewer(): Promise<void> {
    const project = this.selectedProject;
    if (!project) return;
    const opened = await this.run("f3d", () => api.openExternalViewer(project.path));
    if (opened) this.toast("success", "Opened in F3D");
  }

  /* ------------------------------------------------------------------ */
  /* Pull requests                                                       */
  /* ------------------------------------------------------------------ */

  async loadPullRequests(): Promise<void> {
    const list = await this.run("pr-list", () => api.listPullRequests(25));
    if (list) this.prList = list;
  }

  async searchPullRequests(query: string): Promise<void> {
    const trimmed = query.trim();
    this.prQuery = trimmed;
    if (!trimmed) {
      this.prSearchResult = null;
      return;
    }
    const result = await this.run("pr-search", () => api.searchPullRequests(trimmed));
    if (result) this.prSearchResult = result;
  }

  clearSearch(): void {
    this.prQuery = "";
    this.prSearchResult = null;
  }

  async selectPullRequest(number: number): Promise<void> {
    this.selectedPrNumber = number;
    this.prDetails = null;
    this.prWorkspace = null;
    const details = await this.run("pr-details", () => api.getPullRequest(number));
    if (details) this.prDetails = details;
  }

  async toggleFavorite(number: number): Promise<void> {
    const favorites = await this.run("favorite", () => api.toggleFavorite(number));
    if (!favorites) return;
    if (this.config) this.config = { ...this.config, prFavorites: favorites };
    const isFavorite = favorites.includes(number);
    this.prList = this.prList.map((pr) => (pr.number === number ? { ...pr, isFavorite } : pr));
    if (this.prSearchResult) {
      this.prSearchResult = {
        ...this.prSearchResult,
        items: this.prSearchResult.items.map((pr) =>
          pr.number === number ? { ...pr, isFavorite } : pr,
        ),
      };
    }
    if (this.prDetails?.number === number) this.prDetails = { ...this.prDetails, isFavorite };
  }

  async preparePullRequest(number: number, backend: BuildBackend): Promise<void> {
    const workspace = await this.run("pr-prepare", () => api.preparePullRequest(number, backend));
    if (workspace) {
      this.prWorkspace = workspace;
      this.toast("success", `Workspace ready for PR #${number}`);
    }
  }

  async startPrBuild(number: number, backend: BuildBackend): Promise<void> {
    this.buildLog = [];
    this.buildProgress = null;
    const result = await this.run("pr-build", () => api.startPrBuild(number, backend));
    if (!result) return;
    if (result.ok) this.toast("success", `Build finished for PR #${number}`);
    else this.toast("error", result.error ?? "Build failed");
    if (result.executable && this.prWorkspace?.number === number) {
      this.prWorkspace = {
        ...this.prWorkspace,
        executable: result.executable,
        builtAt: new Date().toISOString(),
      };
    }
  }

  async cancelPrBuild(): Promise<void> {
    const cancelled = await this.run("pr-cancel", () => api.cancelPrBuild());
    if (cancelled) this.toast("info", "Build cancellation requested");
  }

  async launchPullRequest(
    number: number,
    projectPaths?: string[],
    singleInstance = false,
  ): Promise<void> {
    const result = await this.run("pr-launch", () =>
      api.launchPullRequest({ number, projectPaths, singleInstance }),
    );
    if (result) {
      if (result.ok) this.toast("success", `Launching PR #${number}`);
      else this.toast("error", result.error ?? "PR build failed to launch");
    }
  }

  async cleanPullRequest(number: number): Promise<void> {
    const removed = await this.run("pr-clean", () => api.removePullRequest(number));
    if (removed) {
      if (this.prWorkspace?.number === number) this.prWorkspace = null;
      this.buildLog = [];
      this.toast("success", `Removed workspace for PR #${number}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Statistics                                                          */
  /* ------------------------------------------------------------------ */

  async loadStats(): Promise<void> {
    const stats = await this.run("stats", () => api.getStats());
    if (stats) this.stats = stats;
  }

  async resetStats(): Promise<void> {
    const stats = await this.run("stats-reset", () => api.resetStats());
    if (stats) {
      this.stats = { stats, milestone: this.stats?.milestone ?? null };
      this.toast("success", "Statistics reset");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Settings / environment / app                                        */
  /* ------------------------------------------------------------------ */

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig | null> {
    const next = await this.run("config-save", () => api.updateConfig(patch));
    if (next) this.config = next;
    return next;
  }

  async chooseVersionsDir(): Promise<void> {
    const dir = await this.pickDirectory({
      title: "Select versions directory",
      startDir: this.config?.versionsDir,
    });
    if (!dir) return;
    await this.updateConfig({ versionsDir: dir });
  }

  async pickDirectory(options?: PickDirectoryOptions): Promise<string | null> {
    return this.run("pick-directory", () => api.pickDirectory(options));
  }

  async runMigration(): Promise<void> {
    const report = await this.run("migration", () => api.runMigration());
    if (report) {
      this.migrationReport = report;
      await this.refreshVersions();
      this.toast("success", "Import from the Python launcher finished");
    }
  }

  async openExternal(url: string): Promise<void> {
    await this.run("external", () => api.openExternal(url));
  }

  async quit(): Promise<void> {
    await this.run("quit", () => api.quit());
  }
}

export const store = new LauncherStore();
