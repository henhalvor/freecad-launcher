<script lang="ts">
import type { Snippet } from "svelte";

const {
  open,
  title,
  onclose,
  children,
}: { open: boolean; title: string; onclose: () => void; children?: Snippet } = $props();
</script>

{#if open}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) onclose();
    }}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1">
      <header class="modal-head">
        <h2>{title}</h2>
        <button type="button" class="icon" aria-label="Close dialog" onclick={onclose}>×</button>
      </header>
      <div class="modal-body">
        {@render children?.()}
      </div>
    </div>
  </div>
{/if}
