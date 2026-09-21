# FreeCAD Launcher Electron rewrite plan

Status: proposed

## Goal

Replace the current Python launcher, the nixpkgs FreeCAD installation, and the
Gear Lever-managed weekly AppImage with one FreeCAD launcher built for NixOS.
The finished app should make official stable and weekly FreeCAD releases easy
to install, update, keep side by side, launch, and remove on both the
workstation and Lenovo Yoga.

Nix remains responsible for the launcher, Electron, helper programs, desktop
integration, and reproducible PR build dependencies. The launcher manages
FreeCAD releases as mutable user-owned files. It must never install a Nix
FreeCAD package, change a NixOS generation, call `sudo`, or depend on tools
that happen to be available in the interactive shell.

Version 1.0 is complete when it replaces every useful workflow in the Python
app, works on both NixOS computers, and supports removal of the two existing
FreeCAD owners without losing profiles or a rollback path.

## What the app is

FreeCAD Launcher is a Linux desktop application for people who use several
FreeCAD builds or test FreeCAD development work. It combines four jobs in one
window:

- Install and manage official FreeCAD stable and weekly AppImages from GitHub.
- Launch FreeCAD with NixOS-safe environment cleanup and isolated profiles.
- Browse local CAD projects, inspect previews, and open a project with a
  chosen FreeCAD release or PR build.
- Find, build, run, and inspect FreeCAD pull requests without modifying a
  user's Git checkout.

The application is not a general AppImage manager, a Nix package manager, or a
replacement for Home Manager. It supports FreeCAD on x86_64 NixOS and uses
only release artifacts published by `FreeCAD/FreeCAD` for installed FreeCAD
versions.

## Required feature set

Version 1.0 must include:

- A catalog of official stable and weekly FreeCAD releases, with offline cache
  support, architecture filtering, update status, and optional authenticated
  GitHub requests through `GITHUB_TOKEN`.
- Verified, cancellable, atomic AppImage downloads using upstream SHA-256
  metadata. Failed downloads must not appear as installed versions.
- Side-by-side installation of multiple releases, explicit stable and weekly
  defaults, manual removal, and retention of old versions until the user
  removes them.
- Launching a selected release, opening one or more project files, opening a
  project in an existing FreeCAD instance, tutorial HiDPI mode, vanilla mode,
  close-on-launch behavior, and session tracking.
- Stable, weekly, vanilla, and PR profile isolation with the existing stable
  and weekly profile locations preserved.
- Launcher, channel-following, and version-pinned desktop entries that route
  through the launcher's environment and profile handling.
- A project library that scans a configurable folder, lists the 20 newest CAD
  files, handles duplicate filenames, extracts FCStd metadata and thumbnails,
  and supports FCStd, STEP, IGES, STL, and BREP.
- Embedded Three.js previews, FreeCAD-assisted tessellation for CAD formats,
  preview caching, and an external F3D viewer supplied by Nix.
- Recent and searchable GitHub pull requests, favorites, PR metadata,
  conversations, images, milestone status, links, and rate-limit reporting.
- Launcher-owned Git mirrors and worktrees for PR testing, Nix and Pixi build
  backends, streamed build output, progress reporting, process-tree
  cancellation, isolated PR profiles, and project launch with a compiled PR.
- Per-release and per-PR usage statistics, including launch counts, elapsed
  time for sessions longer than five seconds, totals, and reset support.
- Dark and light themes, clear progress and failure states, first-run setup,
  update reminders, configurable storage and project paths, and migration from
  recognized Python-launcher state.
- A single-instance Electron process that forwards later invocations and file
  arguments to the running launcher while continuing to track active FreeCAD
  sessions in the background.

## Summary

Build a fresh repository at `/home/henhal/code/freecad-launcher`, published as
`github:henhal/freecad-launcher`. The existing clone remains a behavioral
reference only. Preserve its MIT license in `LICENSE` and credit
`deltahedra3d/freecad-launcher` in `NOTICE`.

The new application will use Svelte 5, TypeScript, Vite, and Electron. Nix owns
Electron, runtime tools, desktop integration, and the PR build environment. The
launcher owns mutable upstream FreeCAD AppImages under the user's XDG
directories.

There will be no Nix FreeCAD version provider. Stable and weekly FreeCAD
installations come only from official FreeCAD GitHub releases. After
validation, the launcher replaces both the current nixpkgs FreeCAD and Gear
Lever weekly installation.

Version 1.0 requires full behavioral parity. The duplicated Python file,
unverified downloads, raw AppImage execution, silent profile edits, and
mutation of user Git checkouts are bugs to leave behind.

## Architecture and interfaces

### Application structure

Use npm and commit `package-lock.json`. Build the renderer with Vite and bundle
Electron main and preload code with esbuild.

```text
src/
  main/
    app.ts
    ipc.ts
    cli.ts
    services/
      github.ts
      release-catalog.ts
      version-store.ts
      downloader.ts
      launch.ts
      profiles.ts
      desktop-entries.ts
      projects.ts
      preview.ts
      pr-workspaces.ts
      pr-build.ts
      stats.ts
      migration.ts
  preload/index.ts
  renderer/
    components/
    views/
      Versions.svelte
      Projects.svelte
      PullRequests.svelte
      Statistics.svelte
      Settings.svelte
  shared/
    types.ts
    schemas.ts
    channels.ts
tests/
```

Use strict TypeScript, Zod for persisted data and every IPC request and
response, Biome for formatting and linting, `svelte-check`, Vitest, and
Playwright's Electron support.

The renderer remains UI-only. Enable `contextIsolation`, renderer sandboxing,
`nodeIntegration: false`, a restrictive content security policy, sender
validation, and a narrow preload API. Do not expose generic filesystem, shell,
IPC, or process-spawning methods. These choices follow Electron's
[security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

### Public models and CLI

Model only upstream release artifacts and PR builds. Do not introduce a
generic provider system for unsupported Nix or custom binary sources.

```ts
type ReleaseChannel = "stable" | "weekly";
type BuildBackend = "nix" | "pixi";

interface ReleaseArtifact {
  id: string;             // GitHub release ID plus asset ID
  releaseId: number;
  assetId: number;
  channel: ReleaseChannel;
  tag: string;
  version: string;
  architecture: "x86_64";
  assetName: string;
  downloadUrl: string;
  sizeBytes: number;
  sha256: string;
  publishedAt: string;
}

interface InstalledRelease extends ReleaseArtifact {
  path: string;
  installedAt: string;
  verifiedAt: string;
}

interface ChannelDefaults {
  stable?: string;        // InstalledRelease.id
  weekly?: string;
}
```

Expose a stable command interface for generated desktop entries and file
opening:

```text
freecad-launcher
freecad-launcher launch --channel stable [--single-instance] [--] FILE...
freecad-launcher launch --channel weekly [--single-instance] [--] FILE...
freecad-launcher launch --version RELEASE_ID [--single-instance] [--] FILE...
```

Electron uses `app.requestSingleInstanceLock()`. Secondary invocations forward
their files and requested version to the primary process. Closing the window
may hide it while tracked FreeCAD sessions remain active. A later invocation
restores the window.

### State and profiles

Use versioned, atomically written JSON rather than SQLite or native Node
modules:

```text
$XDG_CONFIG_HOME/freecad-launcher/config.json
$XDG_DATA_HOME/freecad-launcher/catalog.json
$XDG_DATA_HOME/freecad-launcher/versions/<asset-id>/<asset-name>
$XDG_DATA_HOME/freecad-launcher/pr/{mirror,worktrees}/
$XDG_STATE_HOME/freecad-launcher/{stats.json,logs/}
$XDG_CACHE_HOME/freecad-launcher/{downloads,previews,github}/
```

The versions root remains configurable through Settings, preserving the
Python app's install-folder capability. Only absolute, user-owned paths are
accepted.

Use the selected per-channel profile policy:

- Stable releases use `~/.config/FreeCAD` and `~/.local/share/FreeCAD`.
- Weekly releases use `~/.config/FreeCAD-weekly` and
  `~/.local/share/FreeCAD-weekly`.
- Each PR gets an isolated persistent profile under launcher data.
- Vanilla launches use a temporary runtime profile and remove it after exit.

The "disable FreeCAD start page" behavior becomes an explicit setting. Apply
it to the selected channel profile before launch instead of silently editing
the stable profile when the launcher starts.

### Release and launch behavior

Fetch releases from `FreeCAD/FreeCAD` through the GitHub API:

- Stable means a non-draft, non-prerelease release.
- Weekly means a non-draft prerelease whose tag starts with `weekly-`.
- Select only Linux x86_64 `.AppImage` assets. Exclude checksum and zsync
  assets.
- If a release has multiple matching variants, display each variant instead
  of guessing.
- Use `GITHUB_TOKEN` when present. Never write tokens to launcher
  configuration or logs.
- Cache the last valid catalog for offline browsing and show rate-limit or
  network failures honestly.

Require a SHA-256 value from GitHub's asset digest or its matching
`-SHA256.txt` asset. Download to `.part`, support cancellation with
`AbortController`, verify size and hash, set executable permissions, then
rename atomically. A failed or interrupted download never enters the installed
catalog.

Install updates side by side. An explicit stable or weekly update switches
that channel's default only after verification. Older releases remain until
the user removes them. Refuse to remove a running release. Removing a channel
default requires selecting a replacement or leaving the channel unset.

Launch all AppImages through the Nix-provided `appimage-run`, never through
host `PATH` or implicit NixOS binfmt. Centralize launch construction and
always:

- Set `QT_QPA_PLATFORM=xcb`, `SDL_VIDEODRIVER=x11`, and
  `DESKTOPINTEGRATION=1`.
- Unset `QT_STYLE_OVERRIDE`, `QT_QPA_PLATFORMTHEME`, `QT_PLUGIN_PATH`,
  `QML2_IMPORT_PATH`, `PYTHONPATH`, and `PYTHONUSERBASE`.
- Pass `FREECAD_USER_HOME`, `-u`, and `-s` for the chosen channel profile.
- Preserve tutorial HiDPI mode, project arguments, and `--single-instance`.
- Retry recognized AppImage runtime or FUSE failures with extract-and-run
  mode.
- Record usage only for sessions lasting more than five seconds.

Generated desktop entries call the launcher CLI rather than the AppImage
directly. Provide channel-following Stable and Weekly entries plus optional
version-pinned entries. This keeps environment cleanup and profile selection
intact after updates.

## Full-parity implementation

### Versions, projects, previews, and statistics

Recreate the current version list, update status, install progress,
cancellation, update reminders, deletion, launch actions, desktop entries,
dark and light themes, auto-close, vanilla mode, tutorial scaling, and
configurable paths.

The project library recursively scans the selected directory for FCStd, STEP,
IGES, STL, and BREP files. Keep the 20 newest by modification time, preserve
full paths to disambiguate duplicate filenames, and make scanning cancellable.

For previews:

- Read FCStd metadata and embedded thumbnails directly from its ZIP container.
- Render STL and generated meshes in an embedded Three.js viewer.
- Use the selected FreeCAD AppImage in headless mode to tessellate FCStd, STEP,
  IGES, and BREP into cached STL.
- Include Nix-provided F3D for the external interactive viewer.
- Remove the Python VTK and cadquery-ocp dependency paths.

Track sessions by immutable release ID or PR number. Show time and launch
counts per version, channel, and PR, with reset support.

### Pull-request lab

Preserve recent PRs, search, favorites, metadata, conversation display,
images, milestone progress, build, cancel, launch, and opening a project with
the compiled PR.

Do not touch a user checkout. Maintain a launcher-owned Git mirror and one
worktree per PR:

1. Fetch `pull/<number>/head` into a launcher namespace.
2. Create or reset the managed worktree.
3. Update submodules.
4. Build into backend-specific directories.
5. Stream structured logs and progress to the UI.
6. Kill the entire process group on cancellation.
7. Retain successful worktrees and build output until the user explicitly
   cleans them.

The primary backend is a Nix development shell exported by the launcher flake.
It uses `inputsFrom = [ pkgs.freecad ]` to inherit the FreeCAD build dependency
set, plus Git, CMake, Ninja, ccache, and pkg-config. It does not install,
expose, or launch the Nix FreeCAD package.

Package a `freecad-pr-runner` that enters the flake's pinned `freecad-pr` shell
and executes fixed argument arrays. Pixi remains an optional backend using the
source tree's `pixi.toml` and Nix-provided `pixi`. Never suggest or run an
upstream `curl | sh` installer.

Render GitHub Markdown as sanitized local content. Cache remote media in the
main process and expose it through the local application protocol. Open only
validated HTTPS GitHub and FreeCAD links externally.

## Flake and dotfiles integration

### Launcher flake

Export:

- `packages.x86_64-linux.default`
- `apps.x86_64-linux.default`
- `packages.x86_64-linux.freecad-pr-runner`
- `devShells.x86_64-linux.default`
- `devShells.x86_64-linux.freecad-pr`
- `checks.x86_64-linux`
- `nixosModules.default`
- `homeModules.default`

Build with `buildNpmPackage`. Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; npm
supplies Electron types only. Run with `pkgs.electron`, not an npm-downloaded
Electron binary or an Electron Builder AppImage.

The runtime closure includes `appimage-run`, F3D, Git, Pixi, coreutils, and
xdg-utils. CMake, Ninja, compiler libraries, and FreeCAD build dependencies
remain in the PR shell.

The NixOS module enables Chromium's setuid sandbox. The Home Manager module
installs the launcher package and its main desktop entry. Do not add
`--no-sandbox`; fail with a diagnostic if the required sandbox is unavailable.

The launcher has no self-updater. Update it by advancing the dotfiles flake
lock.

### Dotfiles bridge and retirement

Add this input to the dotfiles flake:

```nix
freecad-launcher = {
  url = "github:henhal/freecad-launcher";
  inputs.nixpkgs.follows = "nixpkgs-unstable";
};
```

During development, use
`--override-input freecad-launcher path:/home/henhal/code/freecad-launcher`.
Do not commit a machine-local path.

Refactor `modules/features/applications/freecad.nix` into a thin bridge that
imports the launcher's NixOS and Home Manager modules and retains `pkgs.povray`.
Keep the existing `self.nixosModules.freecad` name so workstation and Yoga
imports do not churn.

Retire the old installations in this order:

1. Keep nixpkgs FreeCAD and Gear Lever weekly available while developing.
2. Install the launcher on the workstation and download fresh verified stable
   and weekly releases.
3. Confirm the existing stable and weekly profiles work with their
   corresponding channels.
4. Back up `~/AppImages/freecad.appimage` and the two profile trees.
5. Test both launcher-managed releases, project opening, previews, desktop
   entries, PartDesign viewport, task dialogs, and session tracking.
6. Remove Gear Lever's FreeCAD with its exact Userland package ID.
7. Remove `freecadXcb`, `freecadWeekly`, their desktop entries, and the weekly
   manual-update comments from the dotfiles module.
8. Build and activate the new dotfiles generation. The previous NixOS
   generation and backed-up AppImage remain the rollback path.
9. Repeat runtime validation on the Yoga. Download AppImages separately on
   each host. Do not sync launcher catalogs or binaries between machines.

Keep generic Gear Lever support in `docs/USERLAND.md`. Document that FreeCAD is
no longer Userland-owned and add a FreeCAD launcher migration and recovery
section.

A one-time importer may copy old Python configuration and statistics into XDG
state. It never deletes the source files. Existing AppImages are adopted only
when their SHA-256 matches an official GitHub release asset. Unmatched files
remain untouched.

## Delivery phases and acceptance

1. **Nix and Electron spike.** Produce a sandboxed Svelte window, package it
   with Nix Electron, and prove that a GitHub FreeCAD AppImage launches through
   `appimage-run` with the required XCB and profile environment.
2. **Headless core.** Implement schemas, atomic state, GitHub catalog, verified
   downloads, side-by-side versions, launch CLI, profiles, process tracking,
   statistics, and desktop-entry generation.
3. **Primary UI.** Implement Versions, Settings, update prompts, progress and
   cancellation, channel defaults, deletion, theme handling, community links,
   and statistics.
4. **Projects and preview.** Implement scanning, FCStd thumbnails, Three.js
   previews, FreeCAD-console tessellation, F3D launch, and project opening in
   new or existing instances.
5. **PR lab.** Implement GitHub PR views, managed worktrees, Nix and Pixi
   builders, streamed logs, cancellation, isolated PR profiles, and project
   launch with a PR build.
6. **Migration and release.** Add legacy import, dotfiles integration,
   workstation and Yoga validation, remove old owners, update documentation,
   and tag 1.0 only after the whole parity checklist passes.

Automated checks must cover release classification, architecture filtering,
checksum parsing and mismatch rejection, interrupted downloads, atomic catalog
recovery, channel defaults, profile paths, environment cleanup, CLI argument
quoting, desktop files, legacy import, project duplicates, preview caching,
five-second statistics, GitHub offline and rate-limit behavior, managed Git
worktrees, and build cancellation.

Run `npm test`, `npm run check`, Playwright Electron tests under Xvfb,
`nix flake check`, and a real
`nix build .#packages.x86_64-linux.default`. Build both NixOS system closures
before switching.

Runtime acceptance requires:

- Stable and weekly install, update, launch, rollback selection, and removal.
- Old versions retained until explicit removal.
- No Nix FreeCAD executable remaining after migration.
- Stable and weekly profiles isolated at their current paths.
- PartDesign viewport and task dialogs working under Niri/XWayland.
- Project launch both normally and with `--single-instance`.
- FCStd thumbnail, STL and STEP embedded preview, and F3D interactive preview.
- One clean PR build through the Nix backend, one Pixi smoke test, build
  cancellation, and confirmation that no user checkout changed.
- Generated desktop entries still applying the launcher environment.
- Launcher startup and the main workflows verified on both x86_64 NixOS
  hosts.
