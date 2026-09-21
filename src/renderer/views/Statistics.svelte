<script lang="ts">
import { onMount } from "svelte";
import Modal from "../components/Modal.svelte";
import ProgressBar from "../components/ProgressBar.svelte";
import { formatDate, formatDuration } from "../lib/format";
import { store } from "../lib/store.svelte";

onMount(() => {
  void store.loadStats();
});

let confirmReset = $state(false);

const entries = $derived(
  Object.entries(store.stats?.stats.entries ?? {})
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.timeSec - a.timeSec),
);

const totalLaunches = $derived(entries.reduce((sum, entry) => sum + entry.launches, 0));
const totalTime = $derived(entries.reduce((sum, entry) => sum + entry.timeSec, 0));

function labelFor(key: string): string {
  if (key.startsWith("release:")) return `Release ${key.slice("release:".length)}`;
  if (key.startsWith("pr:")) return `PR #${key.slice("pr:".length)}`;
  if (key.startsWith("channel:")) return `Channel ${key.slice("channel:".length)}`;
  if (key.startsWith("legacy:")) return `Legacy ${key.slice("legacy:".length)}`;
  return key;
}

async function doReset(): Promise<void> {
  await store.resetStats();
  confirmReset = false;
}
</script>

<div class="view">
  <div class="view-header">
    <div>
      <h1>Statistics</h1>
      <div class="subtitle">Launch counts and session time recorded by the launcher.</div>
    </div>
    <div class="row">
      <button type="button" onclick={() => store.loadStats()} disabled={store.isBusy("stats")}>
        {store.isBusy("stats") ? "Loading…" : "Refresh"}
      </button>
      <button type="button" class="danger" onclick={() => (confirmReset = true)}>Reset statistics</button>
    </div>
  </div>

  <div class="stat-cards">
    <div class="stat-card">
      <div class="value">{totalLaunches}</div>
      <div class="label">Total launches</div>
    </div>
    <div class="stat-card">
      <div class="value">{formatDuration(totalTime)}</div>
      <div class="label">Total session time</div>
    </div>
    <div class="stat-card">
      <div class="value">{entries.length}</div>
      <div class="label">Tracked entries</div>
    </div>
  </div>

  {#if store.stats?.milestone}
    {@const milestone = store.stats.milestone}
    <section class="panel">
      <div class="panel-head">
        <h2>Next milestone</h2>
        <span class="badge neutral grow" style="justify-self: start;">{milestone.closed}/{milestone.total} closed</span>
        <button type="button" class="small" onclick={() => store.openExternal(milestone.url)}>Open on GitHub</button>
      </div>
      <div class="panel-body">
        <div class="row" style="justify-content: space-between;">
          <strong>{milestone.title}</strong>
          <span class="muted">{milestone.percent}%</span>
        </div>
        <ProgressBar value={milestone.percent} label="Milestone progress" />
        <div class="faint small" style="margin-top: 6px;">
          {milestone.dueOn ? `Due ${formatDate(milestone.dueOn)}` : "No due date"}
        </div>
      </div>
    </section>
  {/if}

  <section class="panel">
    <div class="panel-head">
      <h2>Usage by entry</h2>
      <span class="muted small grow">{entries.length} entries</span>
    </div>
    <div class="panel-body flush">
      {#if store.isBusy("stats") && entries.length === 0}
        <div class="empty">Loading statistics…</div>
      {:else if entries.length === 0}
        <div class="empty">No statistics recorded yet. Launch a release or PR build to populate this table.</div>
      {:else}
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Entry</th>
              <th scope="col" class="numeric">Launches</th>
              <th scope="col" class="numeric">Time</th>
              <th scope="col">Last used</th>
            </tr>
          </thead>
          <tbody>
            {#each entries as entry (entry.key)}
              <tr>
                <td>{labelFor(entry.key)}</td>
                <td class="numeric">{entry.launches}</td>
                <td class="numeric">{formatDuration(entry.timeSec)}</td>
                <td>{formatDate(entry.lastUsedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </section>
</div>

<Modal open={confirmReset} title="Reset statistics" onclose={() => (confirmReset = false)}>
  <p>This permanently deletes all recorded launch counts and session times. This cannot be undone.</p>
  <div class="modal-actions">
    <button type="button" onclick={() => (confirmReset = false)}>Cancel</button>
    <button type="button" class="danger" onclick={doReset} disabled={store.isBusy("stats-reset")}>
      Reset statistics
    </button>
  </div>
</Modal>
