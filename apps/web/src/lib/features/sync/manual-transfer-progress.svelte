<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { panelSub } from '@ai-usage/design-system/svelte';
  import { formatTransferBytes } from '../../../manual-transfer-model';
  import type { ManualUploadProgress } from './manual-transfer-client';
  import { strongCell } from './styles';

  let { now, progress }: { now: number; progress: ManualUploadProgress } = $props();
  const percent = $derived(
    progress.phase === 'uploading' && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : undefined,
  );
  const elapsedSeconds = $derived(
    progress.phase === 'processing' ? Math.max(0, Math.floor((now - progress.startedAt) / 1000)) : 0,
  );
  const progressTrack = css({
    bg: 'surfaceElevated',
    borderRadius: 'full',
    h: '8px',
    overflow: 'hidden',
    w: 'full',
  });
</script>

<div aria-live="polite">
  <div class={strongCell}>{progress.fileName} · {formatTransferBytes(progress.fileSize)}</div>
  {#if progress.phase === 'uploading'}
    <progress
      aria-label={`Uploading ${progress.fileName}`}
      class={progressTrack}
      max="100"
      value={percent ?? 0}
    ></progress>
    <div class={panelSub}>{percent ?? 0}% uploaded</div>
  {:else}
    <div class={panelSub} role="status">Processing import on this machine · {elapsedSeconds}s elapsed</div>
  {/if}
</div>
