import { isAbsolute } from "node:path";
import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import { EVENTS, IPC } from "../shared/channels.js";
import type {
  CatalogResult,
  EnvironmentInfo,
  InstalledRelease,
  LaunchResult,
  ProjectFile,
  PullRequestDetails,
  PullRequestSearchResult,
  PullRequestSummary,
  ReleaseArtifact,
} from "../shared/types.js";
import type { AppContext } from "./context.js";
import { readJson } from "./services/atomic-json.js";
import {
  desktopEntryName,
  isSafeReleaseId,
  writeDesktopEntry,
} from "./services/desktop-entries.js";
import { DownloadCancelledError, downloadArtifact } from "./services/downloader.js";
import {
  getNextMilestone,
  getPullRequestDetails,
  listRecentPullRequests,
  searchPullRequests,
} from "./services/github-pr.js";
import { buildBinaryLaunchPlan } from "./services/launch.js";
import { launchPlanSession } from "./services/launcher.js";
import { launchRelease } from "./services/launcher.js";
import { encodeMediaUrl, renderMarkdown } from "./services/markdown.js";
import { fetchMedia } from "./services/media.js";
import { runMigration } from "./services/migration.js";
import { getPreview, openWithF3d, tessellateWithFreecad } from "./services/preview.js";
import { ensureProfileDirs, resolveProfile } from "./services/profiles.js";
import { projectFromPath, scanProjects, withDisplayNames } from "./services/projects.js";
import {
  type GitHubRelease,
  fetchCatalog,
  loadCatalogSnapshot,
  resolveArtifactSha256,
} from "./services/release-catalog.js";
import { FREECAD_REPO } from "./services/github.js";
import { channelStatKey, prStatKey, releaseStatKey } from "./services/stats.js";
import { meshToStlBuffer } from "./services/stl.js";
import {
  readInstalledRelease,
  removeInstalled,
  scanInstalled,
  writeInstalledRelease,
} from "./services/version-store.js";
import { isAcceptableUserPath } from "./services/xdg.js";

const releaseIdSchema = z.string().min(1).max(200);
const pathSchema = z.string().min(1).max(4096);
const dirSchema = z.string().min(1).max(4096);

const installRequestSchema = z.object({ releaseId: releaseIdSchema });
const releaseNotesRequestSchema = z.object({ releaseId: releaseIdSchema });
const removeRequestSchema = z.object({
  releaseId: releaseIdSchema,
  replacementId: releaseIdSchema.nullable().optional(),
});
const setDefaultSchema = z.object({
  channel: z.enum(["stable", "weekly"]),
  releaseId: releaseIdSchema.nullable(),
});
const launchRequestSchema = z.object({
  releaseId: releaseIdSchema,
  projectPaths: z.array(pathSchema).max(64).optional(),
  singleInstance: z.boolean().optional(),
});
const desktopEntrySchema = z.object({
  kind: z.enum(["launcher", "stable", "weekly", "version"]),
  releaseId: releaseIdSchema.optional(),
});
const scanSchema = z.object({ dir: dirSchema.optional() }).optional();
const previewSchema = z.object({ path: pathSchema });
const prListSchema = z.object({ limit: z.number().int().min(1).max(100).optional() }).optional();
const prSearchSchema = z.object({ query: z.string().max(300) });
const prDetailsSchema = z.object({ number: z.number().int().positive() });
const configPatchSchema = z
  .object({
    versionsDir: dirSchema.optional(),
    projectsDir: dirSchema.optional(),
    theme: z.enum(["dark", "light"]).optional(),
    closeOnLaunch: z.boolean().optional(),
    vanilla: z.boolean().optional(),
    tutorialHidpi: z.boolean().optional(),
    disableFreecadStartPage: z.boolean().optional(),
    disableUpdateReminder: z.boolean().optional(),
    prBuildBackend: z.enum(["nix", "pixi"]).optional(),
    onboarded: z.boolean().optional(),
    lastSelectedReleaseId: z.union([releaseIdSchema, z.null()]).optional(),
  })
  .strict();

const prBuildRequestSchema = z.object({
  number: z.number().int().positive(),
  backend: z.enum(["nix", "pixi"]).optional(),
});
const prLaunchSchema = z.object({
  number: z.number().int().positive(),
  projectPaths: z.array(pathSchema).max(64).optional(),
  singleInstance: z.boolean().optional(),
});

const ALLOWED_EXTERNAL_SUFFIXES = [
  "github.com",
  "githubusercontent.com",
  "freecad.org",
  "freecadweb.org",
  "f3d.app",
];

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_EXTERNAL_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

export interface IpcOptions {
  getWindow: () => BrowserWindow | null;
  devServerUrl?: string | null;
  onQuit: () => void;
}

export function registerIpc(ctx: AppContext, options: IpcOptions): void {
  const trustedOrigins = new Set<string>();
  trustedOrigins.add("file://");
  if (options.devServerUrl) trustedOrigins.add(options.devServerUrl);

  const isTrusted = (event: IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url ?? "";
    if (url.startsWith("file://")) return true;
    if (options.devServerUrl && url.startsWith(options.devServerUrl)) return true;
    return false;
  };

  const handle = <T>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, payload: T) => Promise<unknown> | unknown,
  ) => {
    ipcMain.handle(channel, async (event, payload: T) => {
      if (!isTrusted(event)) throw new Error(`Untrusted IPC sender for ${channel}`);
      return fn(event, payload);
    });
  };

  async function ensureCatalog(force = false): Promise<CatalogResult> {
    if (ctx.catalog && !force) return ctx.catalog;
    if (!force) {
      const snapshot = await loadCatalogSnapshot(ctx.paths.catalogFile);
      if (snapshot && snapshot.stable.length + snapshot.weekly.length > 0) {
        ctx.catalog = {
          stable: snapshot.stable,
          weekly: snapshot.weekly,
          rateLimit: {
            limit: null,
            remaining: null,
            resetAt: null,
            authenticated: ctx.github.authenticated,
          },
          fromNetwork: false,
          stale: true,
        };
        return ctx.catalog;
      }
    }
    const result = await fetchCatalog({ client: ctx.github, cacheFile: ctx.paths.catalogFile });
    ctx.catalog = result;
    return result;
  }

  async function findArtifact(releaseId: string): Promise<ReleaseArtifact | null> {
    const catalog = await ensureCatalog(false);
    return (
      [...catalog.stable, ...catalog.weekly].find((artifact) => artifact.id === releaseId) ?? null
    );
  }

  handle(
    IPC.appEnvironment,
    async (): Promise<EnvironmentInfo> => ({
      appVersion: process.env.npm_package_version ?? "1.0.0",
      electronVersion: process.versions.electron ?? "",
      chromeVersion: process.versions.chrome ?? "",
      nodeVersion: process.versions.node ?? "",
      platform: process.platform,
      isNixOS: Boolean(process.env.NIXOS_LAUNCHER) || Boolean(process.env.NIX_STORE),
      hasAppimageRun: ctx.tools.appimageRun !== null,
      appimageRunPath: ctx.tools.appimageRun,
      hasF3d: ctx.tools.f3d !== null,
      f3dPath: ctx.tools.f3d,
      hasPixi: ctx.tools.pixi !== null,
      pixiPath: ctx.tools.pixi,
      hasGit: ctx.tools.git !== null,
      gitPath: ctx.tools.git,
      githubAuthenticated: ctx.github.authenticated,
    }),
  );

  handle(IPC.appQuit, () => {
    options.onQuit();
  });
  handle(IPC.appMinimize, () => {
    options.getWindow()?.minimize();
  });
  handle(IPC.appOpenExternal, async (_event, url: unknown) => {
    const parsed = z.string().url().safeParse(url);
    if (!parsed.success || !isAllowedExternalUrl(parsed.data)) {
      throw new Error("Refusing to open a non-allowlisted URL");
    }
    await shell.openExternal(parsed.data);
    return true;
  });

  handle(IPC.configGet, () => ctx.config);
  handle(IPC.configUpdate, async (_event, patch: unknown) => {
    const parsed = configPatchSchema.safeParse(patch);
    if (!parsed.success) throw new Error(`Invalid config patch: ${parsed.error.message}`);
    const next = { ...ctx.config };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === "versionsDir" && typeof value === "string") {
        if (!isAcceptableUserPath(value))
          throw new Error("versionsDir must be an absolute user-owned path");
      }
      if (key === "projectsDir" && typeof value === "string") {
        if (!isAbsolute(value)) throw new Error("projectsDir must be an absolute path");
      }
      (next as Record<string, unknown>)[key] = value;
    }
    ctx.config = next;
    await ctx.persistConfig();
    return ctx.config;
  });

  handle(IPC.catalogFetch, async (_event, force: unknown) => {
    const result = await ensureCatalog(force === true);
    ctx.broadcast(EVENTS.catalogChanged, result);
    return result;
  });
  handle(IPC.catalogCached, async (): Promise<CatalogResult | null> => {
    if (ctx.catalog) return ctx.catalog;
    const snapshot = await loadCatalogSnapshot(ctx.paths.catalogFile);
    if (!snapshot) return null;
    ctx.catalog = {
      stable: snapshot.stable,
      weekly: snapshot.weekly,
      rateLimit: {
        limit: null,
        remaining: null,
        resetAt: null,
        authenticated: ctx.github.authenticated,
      },
      fromNetwork: false,
      stale: true,
    };
    return ctx.catalog;
  });

  handle(IPC.catalogReleaseNotes, async (_event, payload: unknown) => {
    const parsed = releaseNotesRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid release notes request");
    const artifact = await findArtifact(parsed.data.releaseId);
    if (!artifact) throw new Error(`Unknown release ${parsed.data.releaseId}`);
    let notes = artifact.releaseNotes;
    let releaseName = artifact.releaseName;
    // Catalogs cached before notes were captured have no body: fetch it on
    // demand. Offline, the panel simply reports that notes are unavailable.
    if (!notes) {
      try {
        const response = await ctx.github.get<GitHubRelease>(
          `/repos/${FREECAD_REPO}/releases/${artifact.releaseId}`,
        );
        notes = (response.data.body ?? "").trim();
        releaseName = releaseName || (response.data.name ?? "").trim();
      } catch {
        // Leave notes empty.
      }
    }
    return {
      releaseId: artifact.id,
      releaseName: releaseName || artifact.tag,
      tag: artifact.tag,
      html: renderMarkdown(notes, { rewriteImage: (url) => encodeMediaUrl(url) }),
      url: `https://github.com/FreeCAD/FreeCAD/releases/tag/${encodeURIComponent(artifact.tag)}`,
      publishedAt: artifact.publishedAt,
    };
  });

  handle(IPC.versionsList, async () => {
    const installed = await scanInstalled(ctx.effectivePaths);
    return { installed, defaults: ctx.config.channelDefaults };
  });
  handle(IPC.versionsInstall, async (_event, payload: unknown) => {
    const parsed = installRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid install request");
    const artifact = await findArtifact(parsed.data.releaseId);
    if (!artifact) throw new Error(`Unknown release ${parsed.data.releaseId}`);
    if (ctx.installs.has(artifact.id)) throw new Error("This release is already downloading");
    if (await readInstalledRelease(ctx.effectivePaths, artifact.id))
      throw new Error("This release is already installed");

    const controller = new AbortController();
    ctx.installs.set(artifact.id, controller);
    const base = { releaseId: artifact.id, assetName: artifact.assetName };
    try {
      ctx.broadcast(EVENTS.downloadProgress, {
        ...base,
        state: "downloading",
        percent: 0,
        receivedBytes: 0,
        totalBytes: artifact.sizeBytes,
      });
      const installed = await downloadArtifact({
        artifact,
        paths: ctx.effectivePaths,
        signal: controller.signal,
        resolveSha256: () => resolveArtifactSha256(ctx.github, artifact),
        onProgress: (progress) => {
          ctx.broadcast(EVENTS.downloadProgress, {
            ...base,
            state: "downloading",
            percent: progress.percent,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
          });
        },
      });
      const defaults = { ...ctx.config.channelDefaults };
      if (artifact.channel === "stable" || artifact.channel === "weekly") {
        if (!defaults[artifact.channel]) {
          defaults[artifact.channel] = installed.id;
          ctx.config = { ...ctx.config, channelDefaults: defaults };
          await ctx.persistConfig();
        }
      }
      ctx.broadcast(EVENTS.downloadProgress, { ...base, state: "done", percent: 100 });
      return installed;
    } catch (error) {
      const cancelled = error instanceof DownloadCancelledError;
      ctx.broadcast(EVENTS.downloadProgress, {
        ...base,
        state: cancelled ? "cancelled" : "error",
        percent: null,
        message: error instanceof Error ? error.message : String(error),
      });
      if (cancelled) return null;
      throw error;
    } finally {
      ctx.installs.delete(artifact.id);
    }
  });
  handle(IPC.versionsCancelInstall, (_event, payload: unknown) => {
    const parsed = installRequestSchema.safeParse(payload);
    if (!parsed.success) return false;
    const controller = ctx.installs.get(parsed.data.releaseId);
    controller?.abort();
    return Boolean(controller);
  });
  handle(IPC.versionsRemove, async (_event, payload: unknown) => {
    const parsed = removeRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid remove request");
    const { releaseId, replacementId } = parsed.data;
    if (ctx.runningReleaseIds.has(releaseId))
      throw new Error("Refusing to remove a running release");
    const defaults = { ...ctx.config.channelDefaults };
    const channel = (
      Object.entries(defaults) as Array<["stable" | "weekly", string | undefined]>
    ).find(([, id]) => id === releaseId)?.[0];
    if (channel && !replacementId) {
      delete defaults[channel];
    } else if (channel && replacementId) {
      const replacement = await readInstalledRelease(ctx.effectivePaths, replacementId);
      if (!replacement) throw new Error("Replacement release is not installed");
      defaults[channel] = replacementId;
    }
    await removeInstalled(ctx.effectivePaths, releaseId);
    ctx.config = { ...ctx.config, channelDefaults: defaults };
    await ctx.persistConfig();
    return true;
  });
  handle(IPC.versionsSetDefault, async (_event, payload: unknown) => {
    const parsed = setDefaultSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid default request");
    const defaults = { ...ctx.config.channelDefaults };
    if (parsed.data.releaseId === null) delete defaults[parsed.data.channel];
    else {
      const release = await readInstalledRelease(ctx.effectivePaths, parsed.data.releaseId);
      if (!release) throw new Error("Release is not installed");
      if (release.channel !== parsed.data.channel)
        throw new Error("Release is not part of that channel");
      defaults[parsed.data.channel] = parsed.data.releaseId;
    }
    ctx.config = { ...ctx.config, channelDefaults: defaults };
    await ctx.persistConfig();
    return ctx.config.channelDefaults;
  });
  handle(IPC.versionsCreateDesktopEntry, async (_event, payload: unknown) => {
    const parsed = desktopEntrySchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid desktop entry request");
    let release: InstalledRelease | null = null;
    if (parsed.data.kind === "version") {
      if (!parsed.data.releaseId || !isSafeReleaseId(parsed.data.releaseId)) {
        throw new Error("A valid release id is required");
      }
      release = await readInstalledRelease(ctx.effectivePaths, parsed.data.releaseId);
      if (!release) throw new Error("Release is not installed");
    }
    return writeDesktopEntry(parsed.data, release ?? undefined, { env: ctx.env });
  });

  handle(IPC.launchRelease, async (_event, payload: unknown): Promise<LaunchResult> => {
    const parsed = launchRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid launch request");
    const release = await readInstalledRelease(ctx.effectivePaths, parsed.data.releaseId);
    if (!release) throw new Error("Release is not installed");
    if (!ctx.tools.appimageRun)
      throw new Error("appimage-run was not found; it must be provided by Nix");
    ctx.runningReleaseIds.add(release.id);
    try {
      const outcome = await launchRelease({
        paths: ctx.effectivePaths,
        config: ctx.config,
        release,
        appimageRun: ctx.tools.appimageRun,
        stats: ctx.stats,
        projectFiles: parsed.data.projectPaths ?? [],
        singleInstance: parsed.data.singleInstance ?? false,
      });
      void outcome.completion
        .then(({ stats }) => {
          ctx.stats = stats;
          ctx.broadcast(EVENTS.statsChanged, stats);
        })
        .finally(() => ctx.runningReleaseIds.delete(release.id));
      return outcome.initial;
    } catch (error) {
      ctx.runningReleaseIds.delete(release.id);
      throw error;
    }
  });

  handle(IPC.projectsScan, async (_event, payload: unknown) => {
    const parsed = scanSchema.safeParse(payload);
    const dir = parsed.success && parsed.data?.dir ? parsed.data.dir : ctx.config.projectsDir;
    const projects = await scanProjects({ dir });
    return withDisplayNames(projects);
  });
  handle(IPC.projectsPreview, async (_event, payload: unknown) => {
    const parsed = previewSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid preview request");
    const file: ProjectFile | null = await projectFromPath(parsed.data.path);
    if (!file) throw new Error("Unsupported or missing project file");
    const defaults = ctx.config.channelDefaults;
    let release = defaults.stable
      ? await readInstalledRelease(ctx.effectivePaths, defaults.stable)
      : null;
    if (!release) {
      const installed = await scanInstalled(ctx.effectivePaths);
      release = installed[0] ?? null;
    }
    return getPreview({
      paths: ctx.effectivePaths,
      file,
      appimageRun: ctx.tools.appimageRun,
      release: release ? { path: release.path } : null,
    });
  });
  handle(IPC.projectsOpenExternalViewer, async (_event, payload: unknown) => {
    const parsed = previewSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid viewer request");
    let target = parsed.data.path;
    const file = await projectFromPath(target);
    if (!file) throw new Error("Unsupported or missing project file");

    if (file.format !== "STL") {
      // FCStd, STEP, IGES and BREP are not natively readable by F3D; tessellate
      // with the selected FreeCAD build and write a cached binary STL.
      const installed = await scanInstalled(ctx.effectivePaths);
      const defaults = ctx.config.channelDefaults;
      const release =
        (defaults.stable ? installed.find((r) => r.id === defaults.stable) : undefined) ??
        (defaults.weekly ? installed.find((r) => r.id === defaults.weekly) : undefined) ??
        installed[0];
      if (!release || !ctx.tools.appimageRun) {
        throw new Error("An installed FreeCAD release is required to view this file in F3D");
      }
      const mesh = await tessellateWithFreecad({
        paths: ctx.effectivePaths,
        appimageRun: ctx.tools.appimageRun,
        release: { path: release.path },
        source: file.path,
      });
      if (!mesh) throw new Error("Could not tessellate the file for F3D");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(ctx.paths.previewsDir, "f3d");
      await mkdir(dir, { recursive: true });
      const stlPath = join(dir, `${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}.stl`);
      await writeFile(stlPath, meshToStlBuffer(mesh));
      target = stlPath;
    }
    if (!ctx.tools.f3d) throw new Error("F3D is not installed; it is provided by Nix");
    if (!openWithF3d({ f3dPath: ctx.tools.f3d, file: target, baseEnv: ctx.env })) {
      throw new Error("Could not start F3D");
    }
    return true;
  });

  handle(IPC.prList, async (_event, payload: unknown): Promise<PullRequestSummary[]> => {
    const parsed = prListSchema.safeParse(payload);
    const limit = parsed.success ? (parsed.data?.limit ?? 25) : 25;
    return listRecentPullRequests({ client: ctx.github, favorites: ctx.config.prFavorites }, limit);
  });
  handle(IPC.prSearch, async (_event, payload: unknown): Promise<PullRequestSearchResult> => {
    const parsed = prSearchSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid search request");
    return searchPullRequests(
      { client: ctx.github, favorites: ctx.config.prFavorites },
      parsed.data.query,
    );
  });
  handle(IPC.prDetails, async (_event, payload: unknown): Promise<PullRequestDetails> => {
    const parsed = prDetailsSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid PR request");
    return getPullRequestDetails(
      {
        client: ctx.github,
        favorites: ctx.config.prFavorites,
        markdownOptions: { rewriteImage: (url) => encodeMediaUrl(url) },
      },
      parsed.data.number,
    );
  });
  handle(IPC.prToggleFavorite, async (_event, payload: unknown) => {
    const parsed = prDetailsSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid favorite request");
    const favorites = new Set(ctx.config.prFavorites);
    if (favorites.has(parsed.data.number)) favorites.delete(parsed.data.number);
    else favorites.add(parsed.data.number);
    ctx.config = { ...ctx.config, prFavorites: [...favorites] };
    await ctx.persistConfig();
    return ctx.config.prFavorites;
  });
  handle(IPC.prPrepare, async (_event, payload: unknown) => {
    const parsed = prBuildRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid PR prepare request");
    const { preparePrWorktree } = await import("./services/pr-workspaces.js");
    const backend = parsed.data.backend ?? ctx.config.prBuildBackend;
    ctx.broadcast(EVENTS.buildProgress, {
      number: parsed.data.number,
      phase: "fetching",
      percent: null,
      message: `Preparing PR #${parsed.data.number}`,
      running: true,
    });
    const workspace = await preparePrWorktree({
      paths: ctx.paths,
      number: parsed.data.number,
      backend,
      onPhase: (phase, message) =>
        ctx.broadcast(EVENTS.buildProgress, {
          number: parsed.data.number,
          phase,
          percent: null,
          message,
          running: true,
        }),
      onLog: (line) =>
        ctx.broadcast(EVENTS.buildLog, {
          number: parsed.data.number,
          at: new Date().toISOString(),
          stream: "stdout",
          text: line,
        }),
    });
    return workspace;
  });
  handle(IPC.prBuildStart, async (_event, payload: unknown) => {
    const parsed = prBuildRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid build request");
    if (ctx.builder.isRunning) throw new Error("A build is already running");
    const { preparePrWorktree, buildDirFor } = await import("./services/pr-workspaces.js");
    const backend = parsed.data.backend ?? ctx.config.prBuildBackend;
    const report = (phase: string, percent: number | null, message: string) =>
      ctx.broadcast(EVENTS.buildProgress, {
        number: parsed.data.number,
        phase,
        percent,
        message,
        running: phase !== "finished" && phase !== "failed" && phase !== "cancelled",
      });
    const log = (line: string, stream: "stdout" | "stderr" | "launcher") =>
      ctx.broadcast(EVENTS.buildLog, {
        number: parsed.data.number,
        at: new Date().toISOString(),
        stream,
        text: line,
      });

    const workspace = await preparePrWorktree({
      paths: ctx.paths,
      number: parsed.data.number,
      backend,
      onPhase: (phase, message) => report(phase, null, message),
      onLog: (line) => log(line, "stdout"),
    });
    const result = await ctx.builder.run(
      {
        source: workspace.worktreeDir,
        buildDir: buildDirFor(ctx.paths, parsed.data.number, backend),
        jobs: Math.max(1, (await import("node:os")).cpus().length || 4),
        backend,
        runners: { prRunner: ctx.tools.prRunner, pixi: ctx.tools.pixi },
      },
      log,
      (phase, percent, message) => report(phase, percent, message),
    );
    if (result.ok && result.executable) {
      await writeInstalledPrRecord(ctx, parsed.data.number, result.executable);
    }
    return result;
  });
  handle(IPC.prBuildCancel, () => {
    ctx.builder.cancel();
    return true;
  });
  handle(IPC.prBuildStatus, () => ({
    running: ctx.builder.isRunning,
    phase: ctx.builder.phase,
  }));
  handle(IPC.prLaunch, async (_event, payload: unknown) => {
    const parsed = prLaunchSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid PR launch request");
    const executable = await readPrExecutable(ctx, parsed.data.number);
    if (!executable) throw new Error("No compiled build found for this PR; build it first");
    const profile = resolveProfile(ctx.paths, { channel: "stable", prNumber: parsed.data.number });
    await ensureProfileDirs(profile);
    const plan = buildBinaryLaunchPlan({
      executable,
      profile,
      projectFiles: parsed.data.projectPaths ?? [],
      singleInstance: parsed.data.singleInstance ?? false,
      tutorialHidpi: ctx.config.tutorialHidpi,
    });
    const { initial, completion } = launchPlanSession({
      plan,
      paths: ctx.effectivePaths,
      stats: ctx.stats,
      statKey: prStatKey(parsed.data.number),
      baseEnv: ctx.env,
    });
    void completion.then(({ stats }) => {
      ctx.stats = stats;
      ctx.broadcast(EVENTS.statsChanged, stats);
    });
    return initial;
  });
  handle(IPC.prRemove, async (_event, payload: unknown) => {
    const parsed = prDetailsSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid PR remove request");
    const { removePrWorkspace } = await import("./services/pr-workspaces.js");
    await removePrWorkspace(ctx.paths, parsed.data.number);
    return true;
  });

  handle(IPC.statsGet, async () => {
    const next = await getNextMilestone(ctx.github).catch(() => null);
    return { stats: ctx.stats, milestone: next };
  });
  handle(IPC.statsReset, async () => {
    ctx.stats = { schemaVersion: 1, entries: {} };
    await ctx.persistStats();
    ctx.broadcast(EVENTS.statsChanged, ctx.stats);
    return ctx.stats;
  });

  handle(IPC.migrationRun, async () => {
    const result = await runMigration({
      paths: ctx.effectivePaths,
      artifacts: ctx.knownArtifacts(),
      applyLegacyConfig: !ctx.config.onboarded,
    });
    ctx.config = result.config;
    ctx.stats = result.stats;
    await ctx.persistConfig();
    await ctx.persistStats();
    return result.report;
  });

  handle(IPC.dialogPickDirectory, async (_event, payload: unknown) => {
    const parsed = z
      .object({ title: z.string().max(200).optional(), startDir: dirSchema.optional() })
      .safeParse(payload ?? {});
    const window = options.getWindow();
    const dialogOptions: import("electron").OpenDialogOptions = {
      title: parsed.success ? (parsed.data.title ?? "Select directory") : "Select directory",
      defaultPath:
        parsed.success && parsed.data.startDir ? parsed.data.startDir : ctx.config.projectsDir,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
}

/** Persist the executable path for a PR so it can be launched later. */
async function writeInstalledPrRecord(
  ctx: AppContext,
  number: number,
  executable: string,
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(ctx.paths.prDir, "builds");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${number}.json`),
    JSON.stringify({ number, executable, builtAt: new Date().toISOString() }),
    "utf8",
  );
}

async function readPrExecutable(ctx: AppContext, number: number): Promise<string | null> {
  const { join } = await import("node:path");
  const record = await readJson(join(ctx.paths.prDir, "builds", `${number}.json`));
  if (
    record &&
    typeof record === "object" &&
    typeof (record as { executable?: unknown }).executable === "string"
  ) {
    return (record as { executable: string }).executable;
  }
  return null;
}

export { isAllowedExternalUrl };
