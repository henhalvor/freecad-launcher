import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appArgsFromArgv, parseArgv } from "../../src/main/cli.js";
import { runMigration } from "../../src/main/services/migration.js";
import { buildCommands, parseProgress } from "../../src/main/services/pr-build.js";
import type { ReleaseArtifact } from "../../src/shared/types.js";
import { sha256, testPaths, withTempDir } from "./helpers.js";

describe("CLI parsing", () => {
  it("defaults to the GUI", () => {
    expect(parseArgv([])).toEqual({ kind: "gui" });
  });

  it("parses channel launches with files", () => {
    expect(parseArgv(["launch", "--channel", "stable", "--", "a.FCStd", "b.FCStd"])).toEqual({
      kind: "launch",
      channel: "stable",
      version: null,
      singleInstance: false,
      files: ["a.FCStd", "b.FCStd"],
    });
  });

  it("parses version-pinned launches and single-instance", () => {
    expect(parseArgv(["launch", "--release-id", "12:34", "--single-instance", "a.FCStd"])).toEqual({
      kind: "launch",
      channel: null,
      version: "12:34",
      singleInstance: true,
      files: ["a.FCStd"],
    });
    expect(parseArgv(["launch", "--version", "12:34"])).toEqual({
      kind: "launch",
      channel: null,
      version: "12:34",
      singleInstance: false,
      files: [],
    });
  });

  it("handles the wrapper-rewritten help and version flags", () => {
    expect(parseArgv(["--launcher-help"]).kind).toBe("help");
    expect(parseArgv(["--launcher-version"]).kind).toBe("version");
  });

  it("rejects unknown flags and missing selectors", () => {
    expect(() => parseArgv(["launch", "--channel", "beta"])).toThrow();
    expect(() => parseArgv(["launch"])).toThrow();
    expect(() => parseArgv(["--nonsense"])).toThrow();
  });

  it("strips Electron switches before app parsing", () => {
    expect(appArgsFromArgv(["electron", ".", "launch", "--channel", "stable"])).toEqual([
      "launch",
      "--channel",
      "stable",
    ]);
  });

  it("drops the app directory that Electron inserts at argv[1]", () => {
    expect(
      appArgsFromArgv(
        ["electron", "/nix/store/app/share/freecad-launcher", "--launcher-version"],
        "/nix/store/app/share/freecad-launcher",
      ),
    ).toEqual(["--launcher-version"]);
    expect(
      appArgsFromArgv(
        [
          "electron",
          "/nix/store/app/share/freecad-launcher",
          "launch",
          "--channel",
          "weekly",
          "a.FCStd",
        ],
        "/nix/store/app/share/freecad-launcher",
      ),
    ).toEqual(["launch", "--channel", "weekly", "a.FCStd"]);
  });
});

describe("legacy migration", () => {
  it("imports config and statistics and adopts matching AppImages without deleting sources", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const env = { ...process.env, HOME: home };
      const legacyDir = join(home, "Applications", "FreeCAD");
      await mkdir(legacyDir, { recursive: true });

      const payload = Buffer.from("appimage-bytes");
      const assetName = "FreeCAD_1.0.0-Linux-x86_64.AppImage";
      const legacyImage = join(legacyDir, assetName);
      await writeFile(legacyImage, payload);

      await writeFile(
        join(legacyDir, "launcher_config.json"),
        JSON.stringify({ install_dir: legacyDir, dark_mode: false, pr_history: ["7"] }),
      );
      await writeFile(
        join(home, ".freecad_time_tracker.json"),
        JSON.stringify({ [assetName]: { time_sec: 120, launches: 3 } }),
      );

      const artifact: ReleaseArtifact = {
        id: "1:2",
        releaseId: 1,
        assetId: 2,
        channel: "stable",
        tag: "1.0.0",
        version: "1.0.0",
        architecture: "x86_64",
        assetName,
        downloadUrl: "https://example.test/x",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
        publishedAt: "2024-01-01T00:00:00Z",
        releaseName: "FreeCAD 1.0.0",
        releaseNotes: "",
      };

      const paths = testPaths(dir);
      const result = await runMigration({
        paths,
        artifacts: [artifact],
        applyLegacyConfig: true,
        env,
      });

      expect(result.report.legacyConfigFound).toBe(true);
      expect(result.report.legacyStatsFound).toBe(true);
      expect(result.report.adoptedAppImages).toHaveLength(1);
      expect(result.report.copiedStats).toBe(1);
      expect(result.config.theme).toBe("light");
      expect(result.config.prHistory).toEqual([7]);
      expect(result.stats.entries["release:1:2"]?.launches).toBe(3);

      // Source files are never deleted.
      await expect(stat(legacyImage)).resolves.toBeTruthy();
      await expect(stat(join(home, ".freecad_time_tracker.json"))).resolves.toBeTruthy();

      // The adopted copy is registered.
      const record = await readFile(join(paths.versionsDir, "1:2", "installed.json"), "utf8");
      expect(record).toContain(assetName);
    });
  });

  it("leaves unmatched AppImages untouched", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const legacyDir = join(home, "Applications", "FreeCAD");
      await mkdir(legacyDir, { recursive: true });
      const stray = join(legacyDir, "SomeOtherBuild.AppImage");
      await writeFile(stray, "not official");
      const paths = testPaths(dir);
      const result = await runMigration({
        paths,
        artifacts: [],
        applyLegacyConfig: false,
        env: { ...process.env, HOME: home },
      });
      expect(result.report.unmatchedAppImages).toContain(stray);
      await expect(stat(stray)).resolves.toBeTruthy();
    });
  });
});

describe("PR build", () => {
  it("parses ninja and cmake progress lines", () => {
    expect(parseProgress("[ 42%] Building CXX object")).toBe(42);
    expect(parseProgress("[12/34] Linking")).toBe(35);
    expect(parseProgress("no progress here")).toBeNull();
  });

  it("builds a fixed argv for the nix backend", () => {
    const commands = buildCommands({
      source: "/src",
      buildDir: "/build",
      jobs: 8,
      backend: "nix",
      runners: { prRunner: "/nix/store/pr-runner", pixi: null },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe("/nix/store/pr-runner");
    expect(commands[0]!.args).toEqual([
      "build",
      "--source",
      "/src",
      "--build-dir",
      "/build",
      "--jobs",
      "8",
    ]);
  });

  it("builds pixi configure/build steps", () => {
    const commands = buildCommands({
      source: "/src",
      buildDir: "/build",
      jobs: 4,
      backend: "pixi",
      runners: { prRunner: null, pixi: "/nix/store/pixi" },
    });
    expect(commands.map((c) => c.args)).toEqual([
      ["run", "configure"],
      ["run", "build", "--", "-j", "4"],
    ]);
  });

  it("fails when the backend runner is unavailable", () => {
    expect(() =>
      buildCommands({
        source: "/src",
        buildDir: "/build",
        jobs: 4,
        backend: "nix",
        runners: { prRunner: null, pixi: null },
      }),
    ).toThrow(/freecad-pr-runner/);
  });
});
