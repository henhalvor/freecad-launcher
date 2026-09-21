# FreeCAD Launcher

A Linux desktop application that installs and manages official FreeCAD stable
and weekly AppImages, launches them with NixOS-safe environment cleanup and
isolated profiles, browses local CAD projects with previews, and builds/inspects
FreeCAD pull requests in launcher-owned Git worktrees.

This is an Electron + Svelte 5 rewrite of the Python
[FreeCAD Smart Launcher](https://github.com/deltahedra3d/freecad-launcher). The
MIT license and original copyright are preserved in [LICENSE](LICENSE) and
[NOTICE](NOTICE).

> Not affiliated with or endorsed by the FreeCAD project. Installed FreeCAD
> versions come only from official `FreeCAD/FreeCAD` GitHub releases.

## What it does

- **Versions** — catalog of official stable and weekly FreeCAD releases with
  offline cache, architecture filtering, update status, verified cancellable
  downloads, side-by-side installs, per-channel defaults, and removal.
- **Launching** — always through the Nix-provided `appimage-run` with
  `QT_QPA_PLATFORM=xcb`, a cleaned Qt/Python environment, and the correct
  stable/weekly/PR/vanilla profile. Optional `--single-instance`, tutorial HiDPI
  mode, and session tracking.
- **Projects** — scans a configurable folder for FCStd/STEP/IGES/STL/BREP files,
  shows the 20 newest, extracts FCStd metadata and thumbnails, renders meshes in
  an embedded Three.js viewer, tessellates CAD files with the selected FreeCAD
  build, and opens F3D (supplied by Nix).
- **Pull requests** — recent and searchable PRs, favorites, conversations and
  images, milestone progress, launcher-owned Git mirror + one worktree per PR,
  Nix or Pixi build backends with streamed logs and process-group cancellation,
  and launching a project with a compiled PR.
- **Statistics, themes, and migration** — per-release/PR usage stats, dark and
  light themes, and a one-time importer for the old Python launcher's config,
  statistics, and matching AppImages.

## NixOS installation

The flake exposes `packages.x86_64-linux.default`, a `freecad-pr-runner`, dev
shells (`default` and `freecad-pr`), `checks.x86_64-linux`, and NixOS/Home
Manager modules.

```nix
# flake.nix
inputs.freecad-launcher = {
  url = "github:henhalvor/freecad-launcher";
  inputs.nixpkgs.follows = "nixpkgs-unstable";
};
```

NixOS module (enables the Chromium setuid sandbox and installs the package):

```nix
{ inputs, ... }: {
  imports = [ inputs.freecad-launcher.nixosModules.default ];
  services.freecad-launcher.enable = true;
}
```

Home Manager module (installs the package and the main desktop entry):

```nix
{ inputs, ... }: {
  imports = [ inputs.freecad-launcher.homeModules.default ];
  programs.freecad-launcher.enable = true;
}
```

Build directly:

```sh
nix build .#packages.x86_64-linux.default
```

The launcher has no self-updater. Update it by advancing your flake lock.

### Why Nix owns the runtime

`appimage-run`, F3D, Git, Pixi, coreutils, and `xdg-utils` come from the Nix
closure; the launcher never relies on the interactive shell's `PATH`. Electron is
`pkgs.electron`, not an npm-downloaded binary or an Electron Builder AppImage.
The launcher only manages mutable upstream FreeCAD AppImages under the user's
XDG directories and never calls `sudo`, changes a NixOS generation, or installs a
Nix FreeCAD package.

## Command line

Generated desktop entries call the launcher CLI so environment cleanup and
profile selection survive updates:

```sh
freecad-launcher
freecad-launcher launch --channel stable [--single-instance] [--] FILE...
freecad-launcher launch --channel weekly [--single-instance] [--] FILE...
freecad-launcher launch --version RELEASE_ID [--single-instance] [--] FILE...
```

Electron takes a single-instance lock; later invocations forward their files and
requested version to the running launcher. Closing the window hides it while
tracked FreeCAD sessions remain active, and a later invocation restores it.

## State locations

```text
$XDG_CONFIG_HOME/freecad-launcher/config.json
$XDG_DATA_HOME/freecad-launcher/catalog.json
$XDG_DATA_HOME/freecad-launcher/versions/<release-id>/<asset-name>
$XDG_DATA_HOME/freecad-launcher/pr/{mirror,worktrees,profiles}/
$XDG_STATE_HOME/freecad-launcher/{stats.json,logs/}
$XDG_CACHE_HOME/freecad-launcher/{downloads,previews,github}/
```

The versions root is configurable (Settings). Only absolute, user-owned paths
are accepted. The stable profile keeps `~/.config/FreeCAD` +
`~/.local/share/FreeCAD`; weekly keeps the `-weekly` variants; each PR gets an
isolated persistent profile; vanilla launches use a temporary profile that is
removed after exit.

## Development

```sh
nix develop            # node, electron, appimage-run, f3d, git, pixi
npm install
npm run dev            # Vite + Electron
npm test               # Vitest unit tests
npm run check          # tsc + svelte-check
npm run build          # esbuild (main/preload) + Vite (renderer)
npm run test:e2e       # Playwright Electron (needs a display / Xvfb)
nix flake check
```

Set `GITHUB_TOKEN` to raise GitHub API rate limits; it is only ever read from the
environment and is never written to configuration or logs.

## Security model

The renderer is UI-only: `contextIsolation`, renderer sandboxing,
`nodeIntegration: false`, a restrictive CSP, sender validation, and a narrow
preload API. No generic filesystem, shell, IPC, or process-spawning methods are
exposed. Remote media is cached in the main process and served over a local
protocol; only validated HTTPS GitHub/FreeCAD links open externally.

## License

MIT. Based on `deltahedra3d/freecad-launcher` (MIT); see [NOTICE](NOTICE).
