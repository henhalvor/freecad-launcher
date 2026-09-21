import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const mainEntry = join(root, "dist", "main", "app.cjs");
const electronExecutable = process.env.ELECTRON_EXECUTABLE_PATH ?? "";

const canRun = existsSync(mainEntry) && electronExecutable !== "" && existsSync(electronExecutable);

test.describe("FreeCAD Launcher shell", () => {
  test.skip(
    !canRun,
    "Requires a built dist/ and ELECTRON_EXECUTABLE_PATH (run in the Nix dev shell under Xvfb)",
  );

  test("starts, exposes a narrow preload API, and renders the shell", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "fcl-e2e-"));
    const app = await electron.launch({
      executablePath: electronExecutable,
      args: [root],
      env: {
        ...process.env,
        ELECTRON_EXECUTABLE_PATH: electronExecutable,
        XDG_CONFIG_HOME: join(xdg, "config"),
        XDG_DATA_HOME: join(xdg, "data"),
        XDG_STATE_HOME: join(xdg, "state"),
        XDG_CACHE_HOME: join(xdg, "cache"),
        FREECAD_LAUNCHER_CLI: "freecad-launcher",
      },
    });

    const window = await app.firstWindow();
    await expect(window).toHaveTitle(/FreeCAD Launcher/);

    // The shell must actually render its navigation, not just open a window.
    await expect(window.getByRole("button", { name: /versions/i }).first()).toBeVisible();
    await expect(window.getByRole("button", { name: /projects/i }).first()).toBeVisible();
    await expect(window.getByRole("button", { name: /statistics/i }).first()).toBeVisible();
    await expect(window.getByRole("button", { name: /settings/i }).first()).toBeVisible();

    const exposed = await window.evaluate(() => {
      const api = (window as unknown as { freecadLauncher?: Record<string, unknown> })
        .freecadLauncher;
      return {
        present: Boolean(api),
        hasEnvironment: typeof api?.environment === "function",
        hasLaunch: typeof api?.launchRelease === "function",
        // A generic escape hatch must never be exposed.
        hasRequire: typeof (window as unknown as { require?: unknown }).require === "function",
        hasIpcRenderer:
          typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer === "object",
      };
    });

    expect(exposed.present).toBe(true);
    expect(exposed.hasEnvironment).toBe(true);
    expect(exposed.hasLaunch).toBe(true);
    expect(exposed.hasRequire).toBe(false);
    expect(exposed.hasIpcRenderer).toBe(false);

    const environment = await window.evaluate(() =>
      (
        window as unknown as { freecadLauncher: { environment(): Promise<{ platform: string }> } }
      ).freecadLauncher.environment(),
    );
    expect(environment.platform).toBe("linux");

    await app.close();
  });
});
