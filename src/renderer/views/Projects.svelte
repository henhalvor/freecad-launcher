<script lang="ts">
import type { DisplayProject } from "@shared/types";
import { onMount } from "svelte";
import ThreePreview from "../components/ThreePreview.svelte";
import { formatBytes, formatDate } from "../lib/format";
import { store } from "../lib/store.svelte";

onMount(() => {
  void store.refreshProjects();
});

const recent = $derived(
  [...store.projects].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 20),
);

const preview = $derived(store.preview);
const selected = $derived(store.selectedProject);
const canLaunch = $derived(store.hasInstalled);
const canUseF3d = $derived(Boolean(store.selectedProject) && store.environment?.hasF3d !== false);
</script>

<div class="view">
  <div class="view-header">
    <div>
      <h1>Projects</h1>
      <div class="subtitle">Browse local CAD files and open them with an installed FreeCAD build.</div>
    </div>
    <div class="row">
      <button type="button" onclick={() => store.refreshProjects()} disabled={store.isBusy("projects")}>
        {store.isBusy("projects") ? "Scanning…" : "Refresh"}
      </button>
      <button type="button" onclick={() => store.chooseProjectsDir()} disabled={store.isBusy("pick-directory")}>
        Choose folder…
      </button>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h3>Projects directory</h3>
      <span class="muted small grow">{store.config?.projectsDir ?? "not configured"}</span>
    </div>
    {#if !store.hasInstalled}
      <div class="banner warning" style="margin: 12px;">
        No FreeCAD release is installed. Install one from the Versions view to launch projects.
      </div>
    {/if}
  </div>

  <div class="split">
    <section class="panel">
      <div class="panel-head">
        <h2>Newest files</h2>
        <span class="muted small grow">{recent.length} of {store.projects.length}</span>
      </div>
      <div class="panel-body flush">
        {#if store.isBusy("projects") && store.projects.length === 0}
          <div class="empty">Scanning projects directory…</div>
        {:else if recent.length === 0}
          <div class="empty">No project files found in this directory.</div>
        {:else}
          <div class="list">
            {#each recent as project (project.path)}
              <div
                class="list-row selectable"
                class:selected={selected?.path === project.path}
                role="button"
                tabindex="0"
                aria-pressed={selected?.path === project.path}
                onclick={() => store.selectProject(project)}
                onkeydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void store.selectProject(project);
                  }
                }}
              >
                <div class="list-main">
                  <div class="list-title">{project.displayName}</div>
                  <div class="list-meta">
                    <span class="badge neutral">{project.format}</span>
                    <span>{formatBytes(project.sizeBytes)}</span>
                    <span>{formatDate(project.modifiedAt)}</span>
                  </div>
                  <div class="list-meta faint" title={project.path}>
                    <span style="overflow: hidden; text-overflow: ellipsis;">{project.directory}</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Preview</h2>
        {#if selected}
          <span class="muted small grow" title={selected.path}>{selected.displayName}</span>
        {/if}
      </div>
      <div class="panel-body">
        {#if !selected}
          <div class="empty">Select a project to preview it.</div>
        {:else if store.isBusy("preview")}
          <div class="empty">
            <div class="spinner" style="margin: 0 auto 10px;"></div>
            Loading preview…
          </div>
        {:else if preview}
          {#if preview.kind === "thumbnail" && preview.thumbnailDataUrl}
            <div class="preview-stage">
              <img class="preview-thumb" src={preview.thumbnailDataUrl} alt="Thumbnail of {selected.displayName}" />
            </div>
          {:else if preview.kind === "mesh" && preview.mesh}
            <ThreePreview mesh={preview.mesh} />
          {:else}
            <div class="empty">{preview.message ?? "No preview is available for this file."}</div>
          {/if}

          {#if preview.metadata}
            {@const metadata = preview.metadata}
            {#if metadata.programVersion || metadata.label || metadata.creator}
              <h3 style="margin-top: 12px;">FCStd metadata</h3>
              <dl class="meta-grid">
                {#if metadata.label}<dt>Label</dt><dd>{metadata.label}</dd>{/if}
                {#if metadata.programVersion}<dt>Program version</dt><dd>{metadata.programVersion}</dd>{/if}
                {#if metadata.creator}<dt>Creator</dt><dd>{metadata.creator}</dd>{/if}
              </dl>
            {/if}
          {/if}

          <div class="row" style="margin-top: 14px;">
            <button
              type="button"
              class="primary"
              disabled={!canLaunch || store.isBusy("launch")}
              onclick={() => store.launchProject(false)}
            >
              Open in FreeCAD
            </button>
            <button
              type="button"
              disabled={!canLaunch || store.isBusy("launch")}
              onclick={() => store.launchProject(true)}
            >
              Open in running instance
            </button>
            <button
              type="button"
              disabled={!canUseF3d || store.isBusy("f3d")}
              onclick={() => store.openExternalViewer()}
            >
              Open in F3D
            </button>
          </div>
        {/if}
      </div>
    </section>
  </div>

  {#if store.preview?.cached}
    <div class="banner info">Preview served from the on-disk cache.</div>
  {/if}
</div>
