import type { LauncherApi } from "@shared/api";

declare global {
  interface Window {
    freecadLauncher: LauncherApi;
  }
}

export const api = (window as any).freecadLauncher as LauncherApi;
