<script lang="ts">
import type { BuildBackend, Theme } from "@shared/types";
import Modal from "../components/Modal.svelte";
import { store } from "../lib/store.svelte";

let versionsDir = $state("");
let projectsDir = $state("");
let initialized = $state(false);
let showMigration = $state(false);

$effect(() => {
  if (!initialized && store.config) {
    versionsDir = store.config.versionsDir;
    projectsDir = store.config.projectsDir;
    initialized = true;
  }
});

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

async function saveVersionsDir(): Promise<void> {
  if (!isAbsolutePath(versionsDir.trim())) {
    store.toast("error", "Versions directory must be an absolute path");
    return;
  }
  await store.updateConfig({ versionsDir: versionsDir.trim() });
}

async function saveProjectsDir(): Promise<void> {
  if (!isAbsolutePath(projectsDir.trim())) {
    store.toast("error", "Projects directory must be an absolute path");
    return;
  }
  await store.updateConfig({ projectsDir: projectsDir.trim() });
}

async function browseVersions(): Promise<void> {
  await store.chooseVersionsDir();
  if (store.config) versionsDir = store.config.versionsDir;
}

async function browseProjects(): Promise<void> {
  await store.chooseProjectsDir();
  if (store.config) projectsDir = store.config.projectsDir;
}

async function setTheme(theme: Theme): Promise<void> {
  await store.updateConfig({ theme });
}

async function runMigration(): Promise<void> {
  await store.runMigration();
  showMigration = true;
}

const environment = $derived(store.environment);
const config = $derived(store.config);
</script>

<div class="view">
  <div class="view-header">
    <div>
      <h1>Settings</h1>
      <div class="subtitle">Configure the launcher and inspect the detected environment.</div>
    </div>
    <button type="button" class="danger" onclick={() => store.quit()} disabled={store.isBusy("quit")}>
      Quit launcher
    </button>
  </div>

  <section class="panel">
    <div class="panel-head"><h2>Appearance &amp; behavior</h2></div>
    <div class="panel-body">
      <div class="row" style="gap: 20px;">
        <label class="inline">
          <input
            type="radio"
            name="theme"
            value="dark"
            checked={config?.theme === "dark"}
            onchange={() => setTheme("dark")}
          />
          Dark theme
        </label>
        <label class="inline">
          <input
            type="radio"
            name="theme"
            value="light"
            checked={config?.theme === "light"}
            onchange={() => setTheme("light")}
          />
          Light theme
        </label>
      </div>

      <hr class="sep" />

      <label class="inline">
        <input
          type="checkbox"
          checked={config?.closeOnLaunch ?? false}
          onchange={(event) => store.updateConfig({ closeOnLaunch: event.currentTarget.checked })}
        />
        Close the launcher after launching FreeCAD
      </label>
      <br />
      <label class="inline">
        <input
          type="checkbox"
          checked={config?.vanilla ?? false}
          onchange={(event) => store.updateConfig({ vanilla: event.currentTarget.checked })}
        />
        Vanilla mode (start with an empty, isolated profile)
      </label>
      <br />
      <label class="inline">
        <input
          type="checkbox"
          checked={config?.tutorialHidpi ?? false}
          onchange={(event) => store.updateConfig({ tutorialHidpi: event.currentTarget.checked })}
        />
        High-DPI (2x) scaling for tutorials
      </label>
      <br />
      <label class="inline">
        <input
          type="checkbox"
          checked={config?.disableFreecadStartPage ?? false}
          onchange={(event) => store.updateConfig({ disableFreecadStartPage: event.currentTarget.checked })}
        />
        Disable the FreeCAD start page
      </label>
      <br />
      <label class="inline">
        <input
          type="checkbox"
          checked={config?.disableUpdateReminder ?? false}
          onchange={(event) => store.updateConfig({ disableUpdateReminder: event.currentTarget.checked })}
        />
        Disable the FreeCAD update reminder
      </label>

      <hr class="sep" />

      <label class="field" style="max-width: 260px;">
        PR build backend
        <select
          value={config?.prBuildBackend ?? "nix"}
          onchange={(event) => store.updateConfig({ prBuildBackend: event.currentTarget.value as BuildBackend })}
        >
          <option value="nix">nix</option>
          <option value="pixi">pixi</option>
        </select>
      </label>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Directories</h2></div>
    <div class="panel-body" style="display: flex; flex-direction: column; gap: 14px;">
      <div>
        <label class="field" for="versions-dir">Versions directory (installed AppImages)</label>
        <div class="field-row">
          <input
            id="versions-dir"
            type="text"
            bind:value={versionsDir}
            spellcheck="false"
            placeholder="/home/user/.local/share/freecad-launcher/versions"
          />
          <button type="button" onclick={browseVersions} disabled={store.isBusy("pick-directory")}>Browse…</button>
          <button
            type="button"
            class="primary"
            onclick={saveVersionsDir}
            disabled={store.isBusy("config-save") || versionsDir === config?.versionsDir}
          >
            Save
          </button>
        </div>
      </div>

      <div>
        <label class="field" for="projects-dir">Projects directory</label>
        <div class="field-row">
          <input
            id="projects-dir"
            type="text"
            bind:value={projectsDir}
            spellcheck="false"
            placeholder="/home/user/Documents/CAD"
          />
          <button type="button" onclick={browseProjects} disabled={store.isBusy("pick-directory")}>Browse…</button>
          <button
            type="button"
            class="primary"
            onclick={saveProjectsDir}
            disabled={store.isBusy("config-save") || projectsDir === config?.projectsDir}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Environment</h2>
      <span class="muted small grow">
        {environment?.isNixOS ? "NixOS detected" : environment?.platform ?? ""}
      </span>
    </div>
    <div class="panel-body">
      {#if !environment}
        <div class="empty">Detecting environment…</div>
      {:else}
        <div class="env-grid">
          <div class="env-item"><span>Launcher version</span><span>{environment.appVersion}</span></div>
          <div class="env-item"><span>Electron</span><span>{environment.electronVersion}</span></div>
          <div class="env-item"><span>Chromium</span><span>{environment.chromeVersion}</span></div>
          <div class="env-item"><span>Node</span><span>{environment.nodeVersion}</span></div>
          <div class="env-item">
            <span>appimage-run</span>
            <span class="row tight">
              <span class="dot" class:ok={environment.hasAppimageRun} class:bad={!environment.hasAppimageRun}></span>
              {environment.appimageRunPath ?? "not found"}
            </span>
          </div>
          <div class="env-item">
            <span>F3D</span>
            <span class="row tight">
              <span class="dot" class:ok={environment.hasF3d} class:bad={!environment.hasF3d}></span>
              {environment.f3dPath ?? "not found"}
            </span>
          </div>
          <div class="env-item">
            <span>pixi</span>
            <span class="row tight">
              <span class="dot" class:ok={environment.hasPixi} class:bad={!environment.hasPixi}></span>
              {environment.pixiPath ?? "not found"}
            </span>
          </div>
          <div class="env-item">
            <span>git</span>
            <span class="row tight">
              <span class="dot" class:ok={environment.hasGit} class:bad={!environment.hasGit}></span>
              {environment.gitPath ?? "not found"}
            </span>
          </div>
          <div class="env-item">
            <span>GitHub</span>
            <span class="row tight">
              <span class="dot" class:ok={environment.githubAuthenticated} class:warn={!environment.githubAuthenticated}></span>
              {environment.githubAuthenticated ? "authenticated" : "anonymous"}
            </span>
          </div>
        </div>

        {#if !environment.hasAppimageRun}
          <div class="banner danger" style="margin-top: 12px;">
            appimage-run was not found. FreeCAD AppImages cannot be launched without it. On NixOS it is provided by the
            launcher's Nix environment.
          </div>
        {/if}
        {#if !environment.hasGit}
          <div class="banner danger" style="margin-top: 12px;">
            git was not found. Pull-request workspaces and builds cannot be prepared without it.
          </div>
        {/if}
        {#if !environment.hasF3d}
          <div class="banner warning" style="margin-top: 12px;">
            F3D was not found. The “Open in F3D” action will be unavailable.
          </div>
        {/if}
        {#if !environment.githubAuthenticated}
          <div class="banner warning" style="margin-top: 12px;">
            GitHub is unauthenticated. Pull-request lists and catalog refreshes share a low anonymous API rate limit.
          </div>
        {/if}
      {/if}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Migration &amp; about</h2></div>
    <div class="panel-body" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="row">
        <button type="button" onclick={runMigration} disabled={store.isBusy("migration")}>
          {store.isBusy("migration") ? "Importing…" : "Import from Python launcher"}
        </button>
        {#if store.migrationReport}
          <button type="button" class="ghost" onclick={() => (showMigration = true)}>View last report</button>
        {/if}
      </div>
      <p class="faint small">
        Based on deltahedra3d/freecad-launcher (MIT). This launcher manages official FreeCAD AppImages and local builds.
      </p>
    </div>
  </section>
</div>

<Modal open={showMigration} title="Migration report" onclose={() => (showMigration = false)}>
  {#if store.migrationReport}
    {@const report = store.migrationReport}
    <dl class="meta-grid">
      <dt>Legacy config found</dt><dd>{report.legacyConfigFound ? "yes" : "no"}</dd>
      <dt>Legacy stats found</dt><dd>{report.legacyStatsFound ? "yes" : "no"}</dd>
      <dt>Stats entries copied</dt><dd>{report.copiedStats}</dd>
      <dt>Adopted AppImages</dt><dd>{report.adoptedAppImages.length}</dd>
      <dt>Unmatched AppImages</dt><dd>{report.unmatchedAppImages.length}</dd>
    </dl>
    {#if report.adoptedAppImages.length > 0}
      <h3>Adopted</h3>
      <ul>
        {#each report.adoptedAppImages as adopted (adopted.releaseId)}
          <li><code>{adopted.assetName}</code></li>
        {/each}
      </ul>
    {/if}
    {#if report.unmatchedAppImages.length > 0}
      <h3>Unmatched</h3>
      <ul>
        {#each report.unmatchedAppImages as item (item)}
          <li><code>{item}</code></li>
        {/each}
      </ul>
    {/if}
    {#if report.notes.length > 0}
      <h3>Notes</h3>
      <ul>
        {#each report.notes as note (note)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p class="muted">No migration has been run yet.</p>
  {/if}
  <div class="modal-actions">
    <button type="button" onclick={() => (showMigration = false)}>Close</button>
  </div>
</Modal>
