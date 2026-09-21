import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopFileName,
  isSafeReleaseId,
  renderDesktopEntry,
} from "../../src/main/services/desktop-entries.js";
import {
  ENV_SET,
  ENV_UNSET,
  buildBinaryLaunchPlan,
  buildLaunchPlan,
  extractAndRunPlan,
  materializeEnv,
  resolveAppimageRun,
} from "../../src/main/services/launch.js";
import { resolveProfile } from "../../src/main/services/profiles.js";
import type { InstalledRelease } from "../../src/shared/types.js";
import { testPaths, withTempDir } from "./helpers.js";

const release: InstalledRelease = {
  id: "1:2",
  releaseId: 1,
  assetId: 2,
  channel: "stable",
  tag: "1.0.0",
  version: "1.0.0",
  architecture: "x86_64",
  assetName: "FreeCAD_1.0.0-Linux-x86_64.AppImage",
  downloadUrl: "https://example.test/x.AppImage",
  sizeBytes: 100,
  sha256: "a".repeat(64),
  publishedAt: "2024-01-01T00:00:00Z",
  path: "/home/u/.local/share/freecad-launcher/versions/1:2/FreeCAD_1.0.0-Linux-x86_64.AppImage",
  installedAt: "2024-01-01T00:00:00Z",
  verifiedAt: "2024-01-01T00:00:00Z",
  intact: true,
};

const paths = testPaths("/tmp/fcl-launch-test");

describe("launch plan", () => {
  it("applies the NixOS-safe environment and profile arguments", () => {
    const profile = resolveProfile(paths, { channel: "weekly" });
    const plan = buildLaunchPlan({
      release: { ...release, channel: "weekly" },
      appimageRun: "/nix/store/appimage-run/bin/appimage-run",
      profile,
      projectFiles: ["/home/u/Documents/part with spaces.FCStd"],
      singleInstance: true,
    });

    expect(plan.argv[0]).toBe("/nix/store/appimage-run/bin/appimage-run");
    expect(plan.argv).toContain("-u");
    expect(plan.argv).toContain(profile.userCfg);
    expect(plan.argv).toContain("-s");
    expect(plan.argv).toContain("--single-instance");
    expect(plan.argv[plan.argv.length - 1]).toBe("/home/u/Documents/part with spaces.FCStd");

    expect(plan.env.QT_QPA_PLATFORM).toBe(ENV_SET.QT_QPA_PLATFORM);
    expect(plan.env.SDL_VIDEODRIVER).toBe("x11");
    expect(plan.env.DESKTOPINTEGRATION).toBe("1");
    expect(plan.env.FREECAD_USER_HOME).toBe(profile.dataDir);
    for (const key of ENV_UNSET) expect(plan.env[key]).toBeNull();
  });

  it("enables tutorial HiDPI scaling", () => {
    const profile = resolveProfile(paths, { channel: "stable" });
    const plan = buildLaunchPlan({
      release,
      appimageRun: "appimage-run",
      profile,
      tutorialHidpi: true,
    });
    expect(plan.env.QT_SCALE_FACTOR).toBe("1.66");
    expect(plan.env.XCURSOR_SIZE).toBe("80");
  });

  it("removes unset variables from the child environment", () => {
    const profile = resolveProfile(paths, { channel: "stable" });
    const plan = buildLaunchPlan({ release, appimageRun: "appimage-run", profile });
    const env = materializeEnv(plan, {
      ...process.env,
      QT_STYLE_OVERRIDE: "kvantum",
      PYTHONPATH: "/leak",
    });
    expect(env.QT_STYLE_OVERRIDE).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.QT_QPA_PLATFORM).toBe("xcb");
  });

  it("retries in extract-and-run mode", () => {
    const profile = resolveProfile(paths, { channel: "stable" });
    const plan = extractAndRunPlan(
      buildLaunchPlan({ release, appimageRun: "appimage-run", profile }),
    );
    expect(plan.extractAndRun).toBe(true);
    expect(materializeEnv(plan, {}).APPIMAGE_EXTRACT_AND_RUN).toBe("1");
  });

  it("builds a plan for a compiled PR binary without appimage-run", () => {
    const profile = resolveProfile(paths, { channel: "stable", prNumber: 42 });
    const plan = buildBinaryLaunchPlan({
      executable:
        "/home/u/.local/share/freecad-launcher/pr/worktrees/42/build/launcher/bin/FreeCAD",
      profile,
      projectFiles: ["/home/u/a.FCStd"],
    });
    expect(plan.argv[0]).toContain("FreeCAD");
    expect(plan.argv).not.toContain("appimage-run");
    expect(plan.env.FREECAD_USER_HOME).toBe(profile.dataDir);
  });

  it("resolves appimage-run from an explicit environment variable", async () => {
    await withTempDir(async (dir) => {
      const binary = join(dir, "appimage-run");
      await writeFile(binary, "#!/bin/sh\n");
      await chmod(binary, 0o755);
      expect(resolveAppimageRun({ PATH: "", APPIMAGE_RUN: binary })).toBe(binary);
      expect(resolveAppimageRun({ PATH: dir })).toBe(binary);
      expect(resolveAppimageRun({ PATH: "" })).toBeNull();
    });
  });
});

describe("desktop entries", () => {
  it("routes channel entries through the launcher CLI", () => {
    const content = renderDesktopEntry({ kind: "stable" }, undefined, { cli: "freecad-launcher" });
    expect(content).toContain("Exec=freecad-launcher launch --channel stable %F");
    expect(content).not.toContain(".AppImage");
    expect(content).toContain("StartupWMClass=FreeCAD");
  });

  it("pins a version entry to the release id", () => {
    const content = renderDesktopEntry({ kind: "version", releaseId: "12:34" }, undefined, {
      cli: "freecad-launcher",
    });
    expect(content).toContain("Exec=freecad-launcher launch --version 12:34 %F");
  });

  it("refuses unsafe release ids", () => {
    expect(isSafeReleaseId("12:34")).toBe(true);
    expect(isSafeReleaseId("12; rm -rf /")).toBe(false);
    expect(() =>
      renderDesktopEntry({ kind: "version", releaseId: "$(evil)" }, undefined),
    ).toThrow();
  });

  it("derives stable file names", () => {
    expect(desktopFileName({ kind: "stable" })).toBe("freecad-stable.desktop");
    expect(desktopFileName({ kind: "weekly" })).toBe("freecad-weekly.desktop");
    expect(desktopFileName({ kind: "launcher" })).toBe("freecad-launcher.desktop");
  });
});
