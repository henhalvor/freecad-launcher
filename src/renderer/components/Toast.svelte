<script lang="ts">
import type { ToastMessage } from "../lib/store.svelte";

const { toast, ondismiss }: { toast: ToastMessage; ondismiss: (id: number) => void } = $props();
</script>

<div class="toast {toast.kind}" role={toast.kind === "error" ? "alert" : "status"}>
  <span class="toast-text">{toast.text}</span>
  <button type="button" class="icon" aria-label="Dismiss notification" onclick={() => ondismiss(toast.id)}>
    ×
  </button>
</div>
