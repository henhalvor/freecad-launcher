<script lang="ts">
import type { ViewId } from "../lib/store.svelte";

const { view, onselect }: { view: ViewId; onselect: (view: ViewId) => void } = $props();

const items: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: "versions", label: "Versions", icon: "⬢" },
  { id: "projects", label: "Projects", icon: "▤" },
  { id: "pullrequests", label: "Pull Requests", icon: "⑃" },
  { id: "statistics", label: "Statistics", icon: "▥" },
  { id: "settings", label: "Settings", icon: "⚙" },
];
</script>

<nav class="nav" aria-label="Main navigation">
  {#each items as item (item.id)}
    <button
      type="button"
      class="nav-item"
      class:active={view === item.id}
      aria-current={view === item.id ? "page" : undefined}
      onclick={() => onselect(item.id)}
    >
      <span class="nav-icon" aria-hidden="true">{item.icon}</span>
      <span>{item.label}</span>
    </button>
  {/each}
</nav>
