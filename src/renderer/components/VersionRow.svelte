<script lang="ts">
import type { InstalledRelease } from "@shared/types";
import { formatBytes, formatDate } from "../lib/format";

const {
  release,
  isDefault,
  busy,
  onlaunch,
  ondefault,
  ondesktop,
  onremove,
}: {
  release: InstalledRelease;
  isDefault: boolean;
  busy: boolean;
  onlaunch: () => void;
  ondefault: () => void;
  ondesktop: () => void;
  onremove: () => void;
} = $props();
</script>

<div class="list-row">
  <div class="list-main">
    <div class="list-title">
      {release.version}
      <span class="badge {release.channel}">{release.channel}</span>
      {#if isDefault}
        <span class="badge success">channel default</span>
      {/if}
      {#if !release.intact}
        <span class="badge danger">intact check failed</span>
      {/if}
    </div>
    <div class="list-meta">
      <span>{formatBytes(release.sizeBytes)}</span>
      <span>installed {formatDate(release.installedAt)}</span>
      <span class="faint">{release.assetName}</span>
    </div>
  </div>
  <div class="row tight">
    <button type="button" class="small primary" disabled={busy || !release.intact} onclick={onlaunch}>Launch</button>
    <button
      type="button"
      class="small"
      disabled={busy || isDefault}
      onclick={ondefault}
      aria-label="Set {release.version} as {release.channel} default"
    >
      Set default
    </button>
    <button
      type="button"
      class="small"
      disabled={busy}
      onclick={ondesktop}
      aria-label="Create desktop entry for {release.version}"
    >
      Desktop entry
    </button>
    <button
      type="button"
      class="small danger"
      disabled={busy}
      onclick={onremove}
      aria-label="Remove {release.version}"
    >
      Remove
    </button>
  </div>
</div>
