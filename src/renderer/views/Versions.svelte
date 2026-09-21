<script lang="ts">
import type { InstalledRelease, ReleaseArtifact, ReleaseChannel } from "@shared/types";
import Modal from "../components/Modal.svelte";
import ProgressBar from "../components/ProgressBar.svelte";
import VersionRow from "../components/VersionRow.svelte";
import { formatBytes, formatDate, isNewerVersion } from "../lib/format";
import { store } from "../lib/store.svelte";

let removeTarget = $state<InstalledRelease | null>(null);
let removeReplacement = $state<string>("");

const channels: Array<{ id: ReleaseChannel; label: string }> = [
  { id: "stable", label: "Stable" },
  { id: "weekly", label: "Weekly" },
];

function installedFor(channel: ReleaseChannel): InstalledRelease[] {
  return channel === "stable" ? store.installedStable : store.installedWeekly;
}

function catalogFor(channel: ReleaseChannel): ReleaseArtifact[] {
  if (!store.catalog) return [];
  return channel === "stable" ? store.catalog.stable : store.catalog.weekly;
}

function installedRelease(releaseId: string | null | undefined): InstalledRelease | undefined {
  if (!releaseId) return undefined;
  return store.versions.installed.find((release) => release.id === releaseId);
}

function isDefault(release: InstalledRelease): boolean {
  return store.versions.defaults[release.channel] === release.id;
}

function updateAvailable(channel: ReleaseChannel): boolean {
  const latest = store.latestForChannel(channel);
  const current = installedRelease(store.defaultRelease(channel));
  if (!latest || !current) return false;
  return isNewerVersion(latest, current.version);
}

function isInstalled(releaseId: string): boolean {
  return store.versions.installed.some((release) => release.id === releaseId);
}

function requestRemove(release: InstalledRelease): void {
  if (isDefault(release)) {
    const replacements = installedFor(release.channel).filter(
      (candidate) => candidate.id !== release.id,
    );
    removeTarget = release;
    removeReplacement = replacements[0]?.id ?? "";
  } else {
    void store.removeRelease(release.id, null);
  }
}

async function confirmRemove(): Promise<void> {
  const target = removeTarget;
  if (!target) return;
  const removed = await store.removeRelease(
    target.id,
    removeReplacement === "" ? null : removeReplacement,
  );
  if (removed) {
    removeTarget = null;
    removeReplacement = "";
  }
}

const rateLimit = $derived(store.catalog?.rateLimit ?? null);
const removeReplacements = $derived(
  removeTarget
    ? installedFor(removeTarget.channel).filter((release) => release.id !== removeTarget?.id)
    : [],
);
</script>

<div class="view">
  <div class="view-header">
    <div>
      <h1>Versions</h1>
      <div class="subtitle">Manage installed FreeCAD AppImages and install new releases.</div>
    </div>
    <div class="row">
      <button
        type="button"
        onclick={() => store.createDesktopEntry({ kind: "launcher" })}
        disabled={store.isBusy("desktop")}
      >
        Launcher desktop entry
      </button>
      <button
        type="button"
        class="primary"
        onclick={() => store.refreshCatalog(true)}
        disabled={store.isBusy("catalog")}
      >
        {store.isBusy("catalog") ? "Refreshing…" : "Refresh catalog"}
      </button>
    </div>
  </div>

  {#if store.catalog?.error}
    <div class="banner danger" role="alert"><strong>Catalog error:</strong> {store.catalog.error}</div>
  {:else if store.catalog?.stale}
    <div class="banner warning">
      Showing the cached catalog because GitHub could not be reached. Install and version data may be out of date.
    </div>
  {/if}

  {#if rateLimit && rateLimit.remaining !== null}
    <div class="banner" class:warning={(rateLimit.remaining ?? 99) <= 5} class:info={(rateLimit.remaining ?? 0) > 5}>
      GitHub API rate limit: {rateLimit.remaining}
      {#if rateLimit.limit !== null}/{rateLimit.limit}{/if} requests remaining
      {#if rateLimit.resetAt}· resets {formatDate(rateLimit.resetAt)}{/if}
      · {rateLimit.authenticated ? "authenticated" : "anonymous"}.
    </div>
  {/if}

  {#each channels as channel (channel.id)}
    {@const installed = installedFor(channel.id)}
    {@const available = catalogFor(channel.id)}
    {@const latest = available[0] ?? null}
    <section class="panel">
      <div class="panel-head">
        <h2>{channel.label}</h2>
        <span class="badge {channel.id}">{channel.id}</span>
        {#if updateAvailable(channel.id)}
          <span class="badge warning">update available</span>
        {/if}
        <span class="spacer grow"></span>
        <button
          type="button"
          class="small"
          onclick={() => store.createDesktopEntry({ kind: channel.id })}
          disabled={store.isBusy("desktop")}
        >
          Create {channel.label.toLowerCase()} desktop entry
        </button>
      </div>

      <div class="panel-body">
        <div class="row" style="justify-content: space-between;">
          <div>
            <strong>Latest available:</strong>
            {#if latest}
              <span>{latest.version}</span>
              <span class="muted small">· {latest.tag} · published {formatDate(latest.publishedAt)}</span>
            {:else}
              <span class="muted">none in catalog</span>
            {/if}
          </div>
          <div>
            {#if store.defaultRelease(channel.id)}
              {@const current = installedRelease(store.defaultRelease(channel.id))}
              <span class="muted small">
                Default: {current ? current.version : "missing installation"}
              </span>
            {:else}
              <span class="muted small">No channel default set</span>
            {/if}
          </div>
        </div>
      </div>

      <div class="panel-body flush">
        {#if installed.length === 0}
          <div class="empty">No {channel.label.toLowerCase()} releases installed.</div>
        {:else}
          <div class="list">
            {#each installed as release (release.id)}
              <VersionRow
                {release}
                isDefault={isDefault(release)}
                busy={store.isBusy("remove") || store.isBusy("default") || store.isBusy("desktop")}
                onlaunch={() => store.launchInstalledRelease(release.id)}
                ondefault={() => store.setChannelDefault(release.channel, release.id)}
                ondesktop={() => store.createDesktopEntry({ kind: "version", releaseId: release.id })}
                onremove={() => requestRemove(release)}
              />
            {/each}
          </div>
        {/if}
      </div>

      <div class="panel-head">
        <h3>Available {channel.label.toLowerCase()} releases</h3>
        <span class="muted small">{available.length} release{available.length === 1 ? "" : "s"}</span>
      </div>
      <div class="panel-body flush">
        {#if available.length === 0}
          <div class="empty">
            {store.isBusy("catalog") ? "Loading catalog…" : "No releases available. Try refreshing the catalog."}
          </div>
        {:else}
          <div class="list">
            {#each available as release (release.id)}
              {@const progress = store.downloads[release.id]}
              {@const installing = store.isBusy(`install:${release.id}`) || progress?.state === "downloading"}
              <div class="list-row">
                <div class="list-main">
                  <div class="list-title">
                    {release.version}
                    {#if isInstalled(release.id)}
                      <span class="badge success">installed</span>
                    {/if}
                  </div>
                  <div class="list-meta">
                    <span>{release.tag}</span>
                    <span>{formatBytes(release.sizeBytes)}</span>
                    <span>{release.assetName}</span>
                    <span>published {formatDate(release.publishedAt)}</span>
                  </div>
                  {#if progress?.state === "downloading"}
                    <div style="margin-top: 7px; max-width: 420px;">
                      <ProgressBar value={progress.percent} label="Downloading {release.assetName}" />
                      <div class="faint small" style="margin-top: 3px;">
                        {progress.message ?? `${progress.percent ?? 0}%`}
                        {#if progress.receivedBytes !== undefined}
                          · {formatBytes(progress.receivedBytes)}{#if progress.totalBytes} / {formatBytes(progress.totalBytes)}{/if}
                        {/if}
                      </div>
                    </div>
                  {/if}
                </div>
                <div class="row tight">
                  {#if installing}
                    <button type="button" class="small danger" onclick={() => store.cancelInstall(release.id)}>
                      Cancel
                    </button>
                  {:else if isInstalled(release.id)}
                    <button type="button" class="small" disabled>Installed</button>
                  {:else}
                    <button type="button" class="small primary" onclick={() => store.installRelease(release.id)}>
                      Install
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </section>
  {/each}
</div>

<Modal
  open={removeTarget !== null}
  title="Remove {removeTarget?.channel ?? ''} release {removeTarget?.version ?? ''}"
  onclose={() => {
    removeTarget = null;
    removeReplacement = "";
  }}
>
  <p>
    This release is the current <strong>{removeTarget?.channel}</strong> channel default. Choose a replacement default,
    or unset the channel default.
  </p>
  <label class="field">
    Replacement default
    <select bind:value={removeReplacement}>
      <option value="">Unset channel default</option>
      {#each removeReplacements as replacement (replacement.id)}
        <option value={replacement.id}>{replacement.version}</option>
      {/each}
    </select>
  </label>
  <div class="modal-actions">
    <button
      type="button"
      onclick={() => {
        removeTarget = null;
        removeReplacement = "";
      }}
    >
      Cancel
    </button>
    <button type="button" class="danger" onclick={confirmRemove} disabled={store.isBusy("remove")}>
      Remove release
    </button>
  </div>
</Modal>
