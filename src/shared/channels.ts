/** Names of renderer→main IPC handlers and main→renderer push events. */
export const IPC = {
  // Environment / app
  appEnvironment: "app:environment",
  appQuit: "app:quit",
  appMinimize: "app:minimize",
  appOpenExternal: "app:open-external",

  // Config
  configGet: "config:get",
  configUpdate: "config:update",

  // Catalog
  catalogFetch: "catalog:fetch",
  catalogCached: "catalog:cached",
  catalogReleaseNotes: "catalog:release-notes",

  // Versions
  versionsList: "versions:list",
  versionsInstall: "versions:install",
  versionsCancelInstall: "versions:cancel-install",
  versionsRemove: "versions:remove",
  versionsSetDefault: "versions:set-default",
  versionsCreateDesktopEntry: "versions:create-desktop-entry",

  // Launch
  launchRelease: "launch:release",

  // Projects
  projectsScan: "projects:scan",
  projectsPreview: "projects:preview",
  projectsOpenExternalViewer: "projects:open-external-viewer",

  // Pull requests
  prList: "pr:list",
  prSearch: "pr:search",
  prDetails: "pr:details",
  prToggleFavorite: "pr:toggle-favorite",
  prPrepare: "pr:prepare",
  prBuildStart: "pr:build-start",
  prBuildCancel: "pr:build-cancel",
  prBuildStatus: "pr:build-status",
  prLaunch: "pr:launch",
  prRemove: "pr:remove",

  // Statistics
  statsGet: "stats:get",
  statsReset: "stats:reset",

  // Migration
  migrationRun: "migration:run",

  // Dialog
  dialogPickDirectory: "dialog:pick-directory",
} as const;

/** main→renderer push events. */
export const EVENTS = {
  downloadProgress: "event:download-progress",
  catalogChanged: "event:catalog-changed",
  buildProgress: "event:build-progress",
  buildLog: "event:build-log",
  statsChanged: "event:stats-changed",
  sessionChanged: "event:session-changed",
  navigate: "event:navigate",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type IpcEvent = (typeof EVENTS)[keyof typeof EVENTS];
