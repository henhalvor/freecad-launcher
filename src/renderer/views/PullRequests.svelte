<script lang="ts">
import type { BuildBackend, PullRequestSummary } from "@shared/types";
import { onMount } from "svelte";
import ProgressBar from "../components/ProgressBar.svelte";
import { formatDate } from "../lib/format";
import { store } from "../lib/store.svelte";

onMount(() => {
  void store.loadPullRequests();
});

let searchInput = $state("");
let logEl = $state<HTMLPreElement | null>(null);
let backendOverride = $state<BuildBackend | null>(null);

const backend = $derived<BuildBackend>(backendOverride ?? store.config?.prBuildBackend ?? "nix");
const results = $derived(store.prSearchResult ? store.prSearchResult.items : store.prList);
const searching = $derived(store.prQuery.length > 0);
const building = $derived(store.buildProgress?.running === true);
const selectedNumber = $derived(store.selectedPrNumber);

$effect(() => {
  void store.buildLog.length;
  const element = logEl;
  if (element) element.scrollTop = element.scrollHeight;
});

function avatarColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 42%)`;
}

function initial(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] ?? "?").toUpperCase();
}

function submitSearch(event: SubmitEvent): void {
  event.preventDefault();
  void store.searchPullRequests(searchInput);
}

function summaryTitle(pr: PullRequestSummary): string {
  return `#${pr.number} ${pr.title}`;
}
</script>

<div class="view">
  <div class="view-header">
    <div>
      <h1>Pull Requests</h1>
      <div class="subtitle">Browse, build and launch FreeCAD pull-request builds.</div>
    </div>
    <div class="row">
      <button type="button" onclick={() => store.loadPullRequests()} disabled={store.isBusy("pr-list")}>
        {store.isBusy("pr-list") ? "Loading…" : "Refresh"}
      </button>
    </div>
  </div>

  <form class="search-box" onsubmit={submitSearch}>
    <label class="field" style="width: 100%;">
      Search pull requests
      <input
        type="search"
        bind:value={searchInput}
        placeholder="Search title, author, label or number…"
        aria-label="Search pull requests"
      />
    </label>
    <div class="row" style="margin-top: 6px;">
      <button type="submit" class="primary small" disabled={store.isBusy("pr-search")}>Search</button>
      {#if searching}
        <button
          type="button"
          class="small"
          onclick={() => {
            searchInput = "";
            store.clearSearch();
          }}
        >
          Clear
        </button>
      {/if}
      {#if store.prSearchResult}
        <span class="muted small">
          {store.prSearchResult.total} match{store.prSearchResult.total === 1 ? "" : "es"}
          {#if store.prSearchResult.incomplete}· results may be incomplete{/if}
        </span>
      {/if}
    </div>
  </form>

  <div class="split">
    <div style="display: flex; flex-direction: column; gap: 16px;">
      {#if !searching && store.favoritePullRequests.length > 0}
        <section class="panel">
          <div class="panel-head"><h2>Favorites</h2></div>
          <div class="panel-body flush">
            <div class="list">
              {#each store.favoritePullRequests as pr (pr.number)}
                <div
                  class="list-row selectable"
                  class:selected={selectedNumber === pr.number}
                  role="button"
                  tabindex="0"
                  onclick={() => store.selectPullRequest(pr.number)}
                  onkeydown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void store.selectPullRequest(pr.number);
                    }
                  }}
                >
                  <span class="avatar" style="background: {avatarColor(pr.author)}" aria-hidden="true">
                    {initial(pr.author)}
                  </span>
                  <div class="list-main">
                    <div class="list-title">{summaryTitle(pr)}</div>
                    <div class="list-meta">
                      <span>{pr.author}</span>
                      <span>updated {formatDate(pr.updatedAt)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="star on"
                    aria-label="Remove PR #{pr.number} from favorites"
                    onclick={(event) => {
                      event.stopPropagation();
                      void store.toggleFavorite(pr.number);
                    }}
                  >
                    ★
                  </button>
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/if}

      <section class="panel">
        <div class="panel-head">
          <h2>{searching ? "Search results" : "Recent open pull requests"}</h2>
          <span class="muted small grow">
            {results.length} shown
          </span>
        </div>
        <div class="panel-body flush">
          {#if store.isBusy("pr-list") && results.length === 0}
            <div class="empty">Loading pull requests…</div>
          {:else if store.isBusy("pr-search") && results.length === 0}
            <div class="empty">Searching…</div>
          {:else if results.length === 0}
            <div class="empty">No pull requests found.</div>
          {:else}
            <div class="list">
              {#each results as pr (pr.number)}
                <div
                  class="list-row selectable"
                  class:selected={selectedNumber === pr.number}
                  role="button"
                  tabindex="0"
                  onclick={() => store.selectPullRequest(pr.number)}
                  onkeydown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void store.selectPullRequest(pr.number);
                    }
                  }}
                >
                  <span class="avatar" style="background: {avatarColor(pr.author)}" aria-hidden="true">
                    {initial(pr.author)}
                  </span>
                  <div class="list-main">
                    <div class="list-title">{summaryTitle(pr)}</div>
                    <div class="list-meta">
                      <span>{pr.author}</span>
                      <span>updated {formatDate(pr.updatedAt)}</span>
                      {#if pr.draft}<span class="badge neutral">draft</span>{/if}
                      {#if pr.labels.length > 0}
                        {#each pr.labels.slice(0, 3) as label (label)}
                          <span class="label-chip">{label}</span>
                        {/each}
                        {#if pr.labels.length > 3}
                          <span class="faint">+{pr.labels.length - 3}</span>
                        {/if}
                      {/if}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="star"
                    class:on={pr.isFavorite}
                    aria-label={pr.isFavorite
                      ? `Remove PR #${pr.number} from favorites`
                      : `Add PR #${pr.number} to favorites`}
                    onclick={(event) => {
                      event.stopPropagation();
                      void store.toggleFavorite(pr.number);
                    }}
                  >
                    {pr.isFavorite ? "★" : "☆"}
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </section>
    </div>

    <div style="display: flex; flex-direction: column; gap: 16px;">
      {#if !selectedNumber}
        <section class="panel">
          <div class="panel-body"><div class="empty">Select a pull request to view details and build it.</div></div>
        </section>
      {:else if store.isBusy("pr-details") && !store.prDetails}
        <section class="panel">
          <div class="panel-body"><div class="empty">Loading PR #{selectedNumber}…</div></div>
        </section>
      {:else if store.prDetails}
        {@const pr = store.prDetails}
        <section class="panel">
          <div class="panel-head">
            <h2 style="flex: 1; min-width: 0;">#{pr.number} {pr.title}</h2>
            <button
              type="button"
              class="star"
              class:on={pr.isFavorite}
              aria-label={pr.isFavorite ? "Remove from favorites" : "Add to favorites"}
              onclick={() => store.toggleFavorite(pr.number)}
            >
              {pr.isFavorite ? "★" : "☆"}
            </button>
          </div>
          <div class="panel-body">
            <div class="row" style="margin-bottom: 8px;">
              <span class="badge" class:success={pr.state === "open"} class:neutral={pr.state !== "open"}>{pr.state}</span>
              {#if pr.draft}<span class="badge neutral">draft</span>{/if}
              {#if pr.mergeableState}<span class="badge neutral">{pr.mergeableState}</span>{/if}
              {#each pr.labels as label (label)}
                <span class="label-chip">{label}</span>
              {/each}
            </div>
            <div class="list-meta" style="margin-bottom: 8px;">
              <span class="avatar" style="background: {avatarColor(pr.author)}" aria-hidden="true">{initial(pr.author)}</span>
              <span>{pr.author}</span>
              <span>updated {formatDate(pr.updatedAt)}</span>
              <span>base <code>{pr.baseRef}</code> ← head <code>{pr.headRef}</code></span>
            </div>
            <div class="row">
              <span class="badge success">+{pr.additions}</span>
              <span class="badge danger">−{pr.deletions}</span>
              <span class="badge neutral">{pr.changedFiles} files</span>
              <button type="button" class="small" onclick={() => store.openExternal(pr.htmlUrl)}>
                Open on GitHub
              </button>
            </div>

            {#if pr.milestone}
              {@const milestone = pr.milestone}
              <div style="margin-top: 12px;">
                <div class="row" style="justify-content: space-between;">
                  <strong>{milestone.title}</strong>
                  <span class="muted small">{milestone.closed}/{milestone.total} · {milestone.percent}%</span>
                </div>
                <ProgressBar value={milestone.percent} label="Milestone progress" />
                <div class="row" style="justify-content: space-between; margin-top: 4px;">
                  <span class="faint small">
                    {milestone.dueOn ? `Due ${formatDate(milestone.dueOn)}` : "No due date"}
                  </span>
                  <button type="button" class="ghost small" onclick={() => store.openExternal(milestone.url)}>
                    View milestone
                  </button>
                </div>
              </div>
            {/if}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Description</h2></div>
          <div class="panel-body">
            {#if pr.bodyHtml}
              <div class="markdown">{@html pr.bodyHtml}</div>
            {:else}
              <p class="muted">No description provided.</p>
            {/if}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Build</h2></div>
          <div class="panel-body">
            <div class="row" style="margin-bottom: 10px;">
              <label class="field" style="min-width: 140px;">
                Backend
                <select
                  value={backend}
                  onchange={(event) => {
                    backendOverride = (event.currentTarget as HTMLSelectElement).value as BuildBackend;
                  }}
                >
                  <option value="nix">nix</option>
                  <option value="pixi">pixi</option>
                </select>
              </label>
              <button
                type="button"
                disabled={building || store.isBusy("pr-prepare")}
                onclick={() => store.preparePullRequest(pr.number, backend)}
              >
                Prepare workspace
              </button>
              <button
                type="button"
                class="primary"
                disabled={building || store.isBusy("pr-build")}
                onclick={() => store.startPrBuild(pr.number, backend)}
              >
                Build
              </button>
              <button type="button" class="danger" disabled={!building} onclick={() => store.cancelPrBuild()}>
                Cancel
              </button>
            </div>

            <div class="row" style="margin-bottom: 10px;">
              <button
                type="button"
                disabled={building || store.isBusy("pr-launch")}
                onclick={() => store.launchPullRequest(pr.number)}
              >
                Launch PR build
              </button>
              <button
                type="button"
                disabled={building || store.isBusy("pr-launch") || !store.selectedProject}
                onclick={() => store.launchPullRequest(pr.number, [store.selectedProject?.path ?? ""])}
              >
                Launch with selected project
              </button>
              <button
                type="button"
                disabled={building || store.isBusy("pr-clean")}
                onclick={() => store.cleanPullRequest(pr.number)}
              >
                Clean workspace
              </button>
            </div>

            {#if store.prWorkspace}
              <dl class="meta-grid" style="margin-bottom: 10px;">
                <dt>Worktree</dt><dd><code>{store.prWorkspace.worktreeDir}</code></dd>
                <dt>Build dir</dt><dd><code>{store.prWorkspace.buildDir}</code></dd>
                {#if store.prWorkspace.executable}
                  <dt>Executable</dt><dd><code>{store.prWorkspace.executable}</code></dd>
                {/if}
                {#if store.prWorkspace.builtAt}
                  <dt>Built</dt><dd>{formatDate(store.prWorkspace.builtAt)}</dd>
                {/if}
              </dl>
            {/if}

            {#if store.buildProgress}
              <div style="margin-bottom: 10px;">
                <div class="row" style="justify-content: space-between;">
                  <span class="badge neutral">{store.buildProgress.phase}</span>
                  <span class="muted small">{store.buildProgress.message}</span>
                </div>
                <ProgressBar value={store.buildProgress.percent} label="Build progress" />
              </div>
            {/if}

            <div class="row" style="justify-content: space-between; margin-bottom: 4px;">
              <strong class="small">Build log</strong>
              <span class="faint small">{store.buildLog.length} lines (most recent 500 kept)</span>
            </div>
            <pre class="log-view" bind:this={logEl} aria-label="Build log">{#each store.buildLog as line, index (index)}<span class={line.stream}>{line.text}{"\n"}</span>{/each}</pre>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>Comments</h2>
            <span class="muted small grow">{pr.commentsList.length}</span>
          </div>
          <div class="panel-body" style="display: flex; flex-direction: column; gap: 10px;">
            {#if pr.commentsList.length === 0}
              <p class="muted">No comments.</p>
            {:else}
              {#each pr.commentsList as comment (comment.id)}
                <article class="comment">
                  <header class="comment-head">
                    <span class="avatar" style="background: {avatarColor(comment.author)}" aria-hidden="true">
                      {initial(comment.author)}
                    </span>
                    <strong>{comment.author}</strong>
                    <span class="faint">{formatDate(comment.createdAt)}</span>
                  </header>
                  <div class="comment-body markdown">{@html comment.bodyHtml}</div>
                </article>
              {/each}
            {/if}
          </div>
        </section>
      {/if}
    </div>
  </div>
</div>
