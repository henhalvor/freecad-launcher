<script lang="ts">
import { onMount } from "svelte";
import Nav from "./components/Nav.svelte";
import Toast from "./components/Toast.svelte";
import { type ViewId, store } from "./lib/store.svelte";
import Projects from "./views/Projects.svelte";
import PullRequests from "./views/PullRequests.svelte";
import Settings from "./views/Settings.svelte";
import Statistics from "./views/Statistics.svelte";
import Versions from "./views/Versions.svelte";

onMount(() => {
  void store.init();
});

$effect(() => {
  document.documentElement.dataset.theme = store.config?.theme ?? "dark";
});

const environmentSummary = $derived.by(() => {
  const env = store.environment;
  if (!env) return "Detecting environment…";
  const parts = [env.platform, `Electron ${env.electronVersion}`];
  if (env.isNixOS) parts.push("NixOS");
  return parts.join(" · ");
});

function onSelect(view: ViewId): void {
  store.setView(view);
}
</script>

{#if !store.ready}
  <div class="splash">
    <div class="spinner" aria-hidden="true"></div>
    <p>Starting FreeCAD Launcher…</p>
  </div>
{:else}
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="logo" aria-hidden="true">FC</span>
        <div>
          <strong>FreeCAD</strong>
          <div class="faint small">Launcher</div>
        </div>
      </div>
      <Nav view={store.view} onselect={onSelect} />
      <div class="sidebar-footer">
        <div>Based on deltahedra3d/freecad-launcher (MIT)</div>
      </div>
    </aside>

    <div class="main-column">
      <header class="status-bar">
        <span class="brand">FreeCAD Launcher</span>
        <span class="status-item">{environmentSummary}</span>
        <span class="spacer"></span>
        {#if store.activeDownloads.length > 0}
          <span class="status-item">
            <span class="spinner" style="width: 12px; height: 12px; border-width: 2px;"></span>
            {store.activeDownloads.length} download{store.activeDownloads.length === 1 ? "" : "s"}
          </span>
        {/if}
        {#if store.buildProgress?.running}
          <span class="status-item"><span class="dot warn"></span>Building PR #{store.buildProgress.number}</span>
        {/if}
        <span class="status-item">
          <span class="dot" class:ok={store.environment?.githubAuthenticated} class:bad={store.environment && !store.environment.githubAuthenticated}></span>
          {store.environment?.githubAuthenticated ? "GitHub authenticated" : "GitHub anonymous"}
        </span>
        <button type="button" class="ghost small" onclick={() => store.quit()} aria-label="Quit launcher">Quit</button>
      </header>

      <main class="content">
        {#if store.view === "versions"}
          <Versions />
        {:else if store.view === "projects"}
          <Projects />
        {:else if store.view === "pullrequests"}
          <PullRequests />
        {:else if store.view === "statistics"}
          <Statistics />
        {:else if store.view === "settings"}
          <Settings />
        {/if}
      </main>
    </div>
  </div>
{/if}

<div class="toast-container" aria-live="polite">
  {#each store.toasts as toast (toast.id)}
    <Toast {toast} ondismiss={(id) => store.dismissToast(id)} />
  {/each}
</div>
