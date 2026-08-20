<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panelSub } from '@ai-usage/design-system/svelte';
  import { formatTransferBytes } from '../../../manual-transfer-model';
  import type { ManualTransferOperation, ManualUploadProgress } from './manual-transfer-client';

  let {
    now,
    operation,
    progress,
  }: { now: number; operation: ManualTransferOperation; progress: ManualUploadProgress } = $props();
  // A preview reads the staged file and reports what an import would do; it writes no usage row.
  // Announcing a merge during that phase contradicts the guarantee shown next to the drop zone.
  const processingLabel = $derived(
    operation === 'confirm' ? 'Merging into the local database…' : 'Checking the file against your usage…',
  );
  const processingHint = $derived(
    operation === 'confirm'
      ? 'Large files take a moment while each usage row is written and deduplicated.'
      : 'Large files take a moment to compare. Nothing is written until you confirm.',
  );
  const percent = $derived(
    progress.phase === 'uploading' && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : undefined,
  );
  const fillPercent = $derived(percent ?? 100);
  const progressValueAttributes = $derived(progress.phase === 'uploading' ? { 'aria-valuenow': percent ?? 0 } : {});
  const elapsedSeconds = $derived(
    progress.phase === 'processing' ? Math.max(0, Math.floor((now - progress.startedAt) / 1000)) : 0,
  );
  const progressRegion = css({ display: 'grid', gap: '6px', mt: '4px' });
  const progressHeader = css({
    color: 'muted',
    display: 'flex',
    fontSize: '12px',
    gap: '8px',
    justifyContent: 'space-between',
  });
  const progressTrack = css({
    bg: 'surfaceMuted',
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    h: '6px',
    overflow: 'hidden',
    position: 'relative',
  });
  const progressFill = css({
    bg: 'accent',
    borderRadius: 'full',
    insetBlock: 0,
    left: 0,
    position: 'absolute',
    transition: 'width 0.2s ease',
  });
  const progressFillProcessing = css({ opacity: 0.55 });
  const progressHint = css({
    color: 'muted',
    fontSize: '11px',
    lineHeight: 1.5,
  });
</script>

<div aria-live="polite" class={progressRegion}>
  <div class={panelSub}>{progress.fileName} · {formatTransferBytes(progress.fileSize)}</div>
  <div class={progressHeader}>
    {#if progress.phase === 'uploading'}
      <span>Uploading {formatTransferBytes(progress.loaded)} / {formatTransferBytes(progress.total)}</span>
      <span>{percent ?? 0}%</span>
    {:else}
      <span>{processingLabel}</span>
      <span>{elapsedSeconds}s</span>
    {/if}
  </div>
  <div
    aria-label={progress.phase === 'uploading' ? 'Manual import upload progress' : 'Manual import processing'}
    aria-valuemax="100"
    aria-valuemin="0"
    {...progressValueAttributes}
    class={progressTrack}
    role="progressbar"
  >
    <div
      class={cx(progressFill, progress.phase === 'processing' ? progressFillProcessing : undefined)}
      style:width={`${fillPercent}%`}
    ></div>
  </div>
  {#if progress.phase === 'processing'}
    <span class={progressHint}>{processingHint}</span>
  {/if}
</div>
