import { join } from "node:path";
import type { DesktopEntry, DesktopEntryRequest, InstalledRelease } from "../../shared/types.js";
import { ensureDir, writeTextAtomic } from "./atomic-json.js";
import { baseDirs } from "./xdg.js";

export const DEFAULT_FREECAD_ICON = "org.freecad.FreeCAD";
export const LAUNCHER_ICON = "freecad-launcher";
export const STARTUP_WM_CLASS = "FreeCAD";

/** Resolve the CLI name used by generated desktop entries. */
export function launcherCli(env: NodeJS.ProcessEnv = process.env): string {
  return env.FREECAD_LAUNCHER_CLI?.trim() || "freecad-launcher";
}

export function desktopEntriesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(baseDirs(env).data, "applications");
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return normalized || "version";
}

export function desktopEntryName(request: DesktopEntryRequest, release?: InstalledRelease): string {
  if (request.kind === "launcher") return "FreeCAD Launcher";
  if (request.kind === "stable") return "FreeCAD Stable";
  if (request.kind === "weekly") return "FreeCAD Weekly";
  return release ? `FreeCAD ${release.version}` : "FreeCAD";
}

export function desktopFileName(request: DesktopEntryRequest): string {
  switch (request.kind) {
    case "launcher":
      return "freecad-launcher.desktop";
    case "stable":
      return "freecad-stable.desktop";
    case "weekly":
      return "freecad-weekly.desktop";
    default:
      return `freecad-${slug(request.releaseId ?? "version")}.desktop`;
  }
}

/** Validate a release id for safe use as an Exec argument. */
export function isSafeReleaseId(releaseId: string): boolean {
  return /^[A-Za-z0-9:._-]+$/.test(releaseId);
}

export interface RenderDesktopOptions {
  cli?: string;
  icon?: string;
  env?: NodeJS.ProcessEnv;
}

/** Render a `.desktop` entry that routes through the launcher CLI. */
export function renderDesktopEntry(
  request: DesktopEntryRequest,
  release: InstalledRelease | undefined,
  options: RenderDesktopOptions = {},
): string {
  const cli = options.cli ?? launcherCli(options.env);
  const icon = options.icon ?? (request.kind === "launcher" ? LAUNCHER_ICON : DEFAULT_FREECAD_ICON);
  let exec: string;
  let comment: string;

  switch (request.kind) {
    case "launcher":
      exec = cli;
      comment = "Manage and launch FreeCAD AppImages";
      break;
    case "stable":
      exec = `${cli} launch --channel stable %F`;
      comment = "Launch the FreeCAD stable build managed by FreeCAD Launcher";
      break;
    case "weekly":
      exec = `${cli} launch --channel weekly %F`;
      comment = "Launch the FreeCAD weekly build managed by FreeCAD Launcher";
      break;
    default: {
      if (!request.releaseId || !isSafeReleaseId(request.releaseId)) {
        throw new Error(`Unsafe release id for desktop entry: ${request.releaseId ?? "<missing>"}`);
      }
      exec = `${cli} launch --version ${request.releaseId} %F`;
      comment = release
        ? `Launch FreeCAD ${release.version} managed by FreeCAD Launcher`
        : "Launch a pinned FreeCAD build managed by FreeCAD Launcher";
      break;
    }
  }

  const name = desktopEntryName(request, release);
  const lines = [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    `Name=${name}`,
    "GenericName=CAD Application",
    `Comment=${comment}`,
    `Exec=${exec}`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Graphics;Science;Education;Engineering;X-CNC;",
    "StartupNotify=true",
    `StartupWMClass=${STARTUP_WM_CLASS}`,
    "MimeType=application/x-extension-fcstd;model/step;model/stl;application/iges;model/iges;",
    "",
  ];
  return lines.join("\n");
}

export interface WriteDesktopEntryOptions extends RenderDesktopOptions {
  dir?: string;
}

export async function writeDesktopEntry(
  request: DesktopEntryRequest,
  release: InstalledRelease | undefined,
  options: WriteDesktopEntryOptions = {},
): Promise<DesktopEntry> {
  const dir = options.dir ?? desktopEntriesDir(options.env);
  await ensureDir(dir);
  const fileName = desktopFileName(request);
  const path = join(dir, fileName);
  const content = renderDesktopEntry(request, release, options);
  await writeTextAtomic(path, content, 0o755);
  return {
    fileName,
    path,
    name: desktopEntryName(request, release),
    exec:
      content
        .split("\n")
        .find((line) => line.startsWith("Exec="))
        ?.slice(5) ?? "",
    pinnedReleaseId: request.kind === "version" ? (request.releaseId ?? null) : null,
  };
}
