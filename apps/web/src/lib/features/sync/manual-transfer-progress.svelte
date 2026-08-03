<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
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
  const progressHeader = css({
    alignItems: 'center',
    display: 'flex',
    gap: '12px',
    justifyContent: 'space-between',
  });
  const progressHint = css({
    color: 'muted',
    fontSize: '11px',
    lineHeight: 1.5,
  });
</script>

<div aria-live="polite">
  <div class={strongCell}>{progress.fileName} · {formatTransferBytes(progress.fileSize)}</div>
  {#if progress.phase === 'uploading'}
    <div class={progressHeader}>
      <span>Uploading {formatTransferBytes(progress.loaded)} / {formatTransferBytes(progress.total)}</span>
      <span>{percent ?? 0}%</span>
    </div>
    <progress
      aria-label="Manual import upload progress"
      class={progressTrack}
      max="100"
      value={percent ?? 0}
    ></progress>
  {:else}
    <div class={progressHeader}>
      <span>Merging into the local database…</span>
      <span>{elapsedSeconds}s</span>
    </div>
    <progress aria-label="Manual import processing" class={progressTrack} max="100"></progress>
    <span class={progressHint}>Large files take a moment while each usage row is written and deduplicated.</span>
  {/if}
</div>
