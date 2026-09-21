import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  mapLegacyConfig,
  normalizeConfig,
} from "../../src/main/services/config-store.js";
import { resolveProfile } from "../../src/main/services/profiles.js";
import { emptyStats, recordSession } from "../../src/main/services/stats.js";
import { channelProfileDirs, isAcceptableUserPath } from "../../src/main/services/xdg.js";
import { testPaths } from "./helpers.js";

describe("config", () => {
  it("provides absolute default paths", () => {
    const config = defaultConfig({
      XDG_CONFIG_HOME: "/home/u/.config",
      XDG_DATA_HOME: "/home/u/.local/share",
    });
    expect(config.versionsDir).toContain("/home/u/.local/share/freecad-launcher/versions");
    expect(config.theme).toBe("dark");
    expect(config.channelDefaults).toEqual({});
  });

  it("rejects system and relative storage paths", () => {
    expect(isAcceptableUserPath("/nix/store/abcd")).toBe(false);
    expect(isAcceptableUserPath("/usr/share/FreeCAD")).toBe(false);
    expect(isAcceptableUserPath("relative/path")).toBe(false);
    expect(isAcceptableUserPath("/")).toBe(false);
    expect(isAcceptableUserPath("/home/u/FreeCAD")).toBe(true);
  });

  it("sanitizes invalid values and clamps history", () => {
    const config = normalizeConfig({
      versionsDir: "/nix/store/evil",
      projectsDir: "not-absolute",
      prHistory: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, "x", -1],
      prFavorites: [2, 2, 3],
    });
    expect(config.versionsDir).not.toContain("/nix/store");
    expect(config.prHistory).toHaveLength(10);
    expect(config.prHistory.every((n) => n > 0)).toBe(true);
    expect(config.prFavorites).toEqual([2, 3]);
  });

  it("maps legacy Python configuration", () => {
    const mapped = mapLegacyConfig({
      install_dir: "/home/u/Applications/FreeCAD",
      scan_folder: "/home/u/Documents",
      dark_mode: false,
      auto_close: false,
      vanilla_launch: true,
      use_custom_script_env: true,
      use_pixi_build: true,
      disable_update_reminder: true,
      pr_history: ["42", "not-a-number", "7"],
      pr_favorites: [3],
    });
    expect(mapped.versionsDir).toBe("/home/u/Applications/FreeCAD");
    expect(mapped.projectsDir).toBe("/home/u/Documents");
    expect(mapped.theme).toBe("light");
    expect(mapped.closeOnLaunch).toBe(false);
    expect(mapped.vanilla).toBe(true);
    expect(mapped.tutorialHidpi).toBe(true);
    expect(mapped.prBuildBackend).toBe("pixi");
    expect(mapped.prHistory).toEqual([42, 7]);
  });
});

describe("statistics", () => {
  it("ignores sessions of five seconds or less", () => {
    const stats = recordSession(emptyStats(), { key: "release:1", durationSec: 5 });
    expect(stats.entries).toEqual({});
  });

  it("accumulates launches and time for real sessions", () => {
    let stats = recordSession(emptyStats(), {
      key: "release:1",
      durationSec: 61,
      now: () => new Date("2024-01-01T00:00:00Z"),
    });
    stats = recordSession(stats, {
      key: "release:1",
      durationSec: 9,
      now: () => new Date("2024-01-02T00:00:00Z"),
    });
    expect(stats.entries["release:1"]?.launches).toBe(2);
    expect(stats.entries["release:1"]?.timeSec).toBe(70);
    expect(stats.entries["release:1"]?.lastUsedAt).toBe("2024-01-02T00:00:00.000Z");
  });
});

describe("profiles", () => {
  it("keeps the historical stable and weekly locations", () => {
    const env = { XDG_CONFIG_HOME: "/home/u/.config", XDG_DATA_HOME: "/home/u/.local/share" };
    expect(channelProfileDirs("stable", env)).toEqual({
      configDir: "/home/u/.config/FreeCAD",
      dataDir: "/home/u/.local/share/FreeCAD",
    });
    expect(channelProfileDirs("weekly", env)).toEqual({
      configDir: "/home/u/.config/FreeCAD-weekly",
      dataDir: "/home/u/.local/share/FreeCAD-weekly",
    });
  });

  it("gives each PR an isolated persistent profile", () => {
    const paths = testPaths("/tmp/fcl-profile-test");
    const profile = resolveProfile(paths, { channel: "stable", prNumber: 123 });
    expect(profile.kind).toBe("pr");
    expect(profile.ephemeral).toBe(false);
    expect(profile.configDir).toContain("pr/profiles/123");
    expect(profile.userCfg.endsWith("user.cfg")).toBe(true);
    expect(profile.systemCfg.endsWith("system.cfg")).toBe(true);
  });

  it("marks vanilla profiles as ephemeral", () => {
    const paths = testPaths("/tmp/fcl-profile-test");
    const profile = resolveProfile(paths, { channel: "stable", vanilla: true });
    expect(profile.kind).toBe("vanilla");
    expect(profile.ephemeral).toBe(true);
  });
});
