import { contextBridge, ipcRenderer } from "electron";
import type { LauncherApi, Unsubscribe } from "../shared/api.js";
import { EVENTS, IPC } from "../shared/channels.js";

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: LauncherApi = {
  environment: () => ipcRenderer.invoke(IPC.appEnvironment),
  quit: () => ipcRenderer.invoke(IPC.appQuit),
  minimize: () => ipcRenderer.invoke(IPC.appMinimize),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url),

  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  updateConfig: (patch) => ipcRenderer.invoke(IPC.configUpdate, patch),

  fetchCatalog: (force?: boolean) => ipcRenderer.invoke(IPC.catalogFetch, force ?? false),
  cachedCatalog: () => ipcRenderer.invoke(IPC.catalogCached),

  listVersions: () => ipcRenderer.invoke(IPC.versionsList),
  installRelease: (releaseId: string) => ipcRenderer.invoke(IPC.versionsInstall, { releaseId }),
  cancelInstall: (releaseId: string) =>
    ipcRenderer.invoke(IPC.versionsCancelInstall, { releaseId }),
  removeRelease: (releaseId: string, replacementId?: string | null) =>
    ipcRenderer.invoke(IPC.versionsRemove, { releaseId, replacementId: replacementId ?? null }),
  setChannelDefault: (channel, releaseId: string | null) =>
    ipcRenderer.invoke(IPC.versionsSetDefault, { channel, releaseId }),
  createDesktopEntry: (request) => ipcRenderer.invoke(IPC.versionsCreateDesktopEntry, request),

  launchRelease: (request) => ipcRenderer.invoke(IPC.launchRelease, request),

  scanProjects: (dir?: string) => ipcRenderer.invoke(IPC.projectsScan, dir ? { dir } : {}),
  previewProject: (path: string) => ipcRenderer.invoke(IPC.projectsPreview, { path }),
  openExternalViewer: (path: string) =>
    ipcRenderer.invoke(IPC.projectsOpenExternalViewer, { path }),

  listPullRequests: (limit?: number) => ipcRenderer.invoke(IPC.prList, limit ? { limit } : {}),
  searchPullRequests: (query: string) => ipcRenderer.invoke(IPC.prSearch, { query }),
  getPullRequest: (number: number) => ipcRenderer.invoke(IPC.prDetails, { number }),
  toggleFavorite: (number: number) => ipcRenderer.invoke(IPC.prToggleFavorite, { number }),
  preparePullRequest: (number: number, backend) =>
    ipcRenderer.invoke(IPC.prPrepare, { number, backend }),
  startPrBuild: (number: number, backend) =>
    ipcRenderer.invoke(IPC.prBuildStart, { number, backend }),
  cancelPrBuild: () => ipcRenderer.invoke(IPC.prBuildCancel),
  prBuildStatus: () => ipcRenderer.invoke(IPC.prBuildStatus),
  launchPullRequest: (request) => ipcRenderer.invoke(IPC.prLaunch, request),
  removePullRequest: (number: number) => ipcRenderer.invoke(IPC.prRemove, { number }),

  getStats: () => ipcRenderer.invoke(IPC.statsGet),
  resetStats: () => ipcRenderer.invoke(IPC.statsReset),

  runMigration: () => ipcRenderer.invoke(IPC.migrationRun),

  pickDirectory: (options) => ipcRenderer.invoke(IPC.dialogPickDirectory, options ?? {}),

  onDownloadProgress: (callback) => subscribe(EVENTS.downloadProgress, callback),
  onCatalogChanged: (callback) => subscribe(EVENTS.catalogChanged, callback),
  onBuildProgress: (callback) => subscribe(EVENTS.buildProgress, callback),
  onBuildLog: (callback) => subscribe(EVENTS.buildLog, callback),
  onStatsChanged: (callback) => subscribe(EVENTS.statsChanged, callback),
  onNavigate: (callback) => subscribe(EVENTS.navigate, callback),
};

contextBridge.exposeInMainWorld("freecadLauncher", api);
