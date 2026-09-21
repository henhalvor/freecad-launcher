<script lang="ts">
const { value, label }: { value: number | null; label?: string } = $props();

const clamped = $derived(value === null ? null : Math.max(0, Math.min(100, value)));
</script>

<div
  class="progress"
  role="progressbar"
  aria-label={label ?? "Progress"}
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow={clamped ?? undefined}
>
  <div class="progress-fill" class:indeterminate={clamped === null} style="width: {clamped ?? 100}%"></div>
</div>
