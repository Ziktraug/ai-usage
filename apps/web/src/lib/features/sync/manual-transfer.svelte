<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { UsageEngineMergePreviewOutput } from '@ai-usage/usage-engine-control';
  import { onDestroy } from 'svelte';
  import { formatManualImportSummary, formatTransferBytes } from '../../../manual-transfer-model';
  import { createManualTransferClient, type ManualUploadProgress } from './manual-transfer-client';
  import ManualTransferProgress from './manual-transfer-progress.svelte';
  import { actionRow, ghostButton, panelHeader, strongCell } from './styles';

  let {
    mutationAvailable,
    mutationMessage,
    onCompleted,
  }: { mutationAvailable: boolean; mutationMessage: string | null; onCompleted?: () => Promise<void> | void } =
    $props();

  type PendingOperation = 'confirm' | 'export' | 'preview';
  let fileInput: HTMLInputElement;
  let pending = $state<PendingOperation | null>(null);
  let preview = $state<{ data: UsageEngineMergePreviewOutput; file: File } | null>(null);
  let notice = $state<{ kind: 'error' | 'status'; message: string } | null>(null);
  let progress = $state<ManualUploadProgress | null>(null);
  let progressNow = $state(Date.now());
  let dragActive = $state(false);
  let operationController: AbortController | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const client = createManualTransferClient();

  const dropZone = css({
    bg: 'surfaceMuted',
    border: '1px dashed token(colors.lineStrong)',
    borderRadius: 'md',
    cursor: 'pointer',
    display: 'grid',
    gap: '6px',
    minH: '112px',
    p: '18px',
    placeItems: 'center',
    textAlign: 'center',
  });
  const dropZoneActive = css({ bg: 'surfaceElevated', borderColor: 'accent' });
  const operationPanel = css({
    bg: 'surfaceMuted',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    display: 'grid',
    gap: '8px',
    p: '12px',
  });

  const begin = (operation: PendingOperation): AbortSignal | undefined => {
    if (pending) {
      return;
    }
    operationController?.abort();
    operationController = new AbortController();
    pending = operation;
    progress = null;
    notice = null;
    return operationController.signal;
  };

  const finish = (): void => {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    progress = null;
    pending = null;
    operationController = undefined;
  };

  const updateProgress = (next: ManualUploadProgress): void => {
    progress = next;
    progressNow = Date.now();
    if (next.phase === 'processing' && !progressTimer) {
      progressTimer = setInterval(() => {
        progressNow = Date.now();
      }, 1000);
    }
  };

  const showUnexpectedFailure = (signal: AbortSignal): void => {
    if (!signal.aborted) {
      notice = { kind: 'error', message: 'Manual transfer failed.' };
    }
  };

  const exportCurrentMachine = async (): Promise<void> => {
    const signal = begin('export');
    if (!signal) {
      return;
    }
    try {
      const download = await client.download(signal);
      const blob = await download.response.blob();
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.download = download.filename;
        anchor.href = url;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      notice = {
        kind: 'status',
        message: `Exported ${download.filename}: ${download.rows.toLocaleString()} rows, ${formatTransferBytes(blob.size)}.`,
      };
    } catch {
      showUnexpectedFailure(signal);
    } finally {
      finish();
    }
  };

  const previewFile = async (file: File | undefined): Promise<void> => {
    if (!(file && mutationAvailable)) {
      return;
    }
    const signal = begin('preview');
    if (!signal) {
      return;
    }
    try {
      const result = await client.preview(file, signal, updateProgress);
      if (result.ok) {
        preview = { data: result.data, file };
        notice = { kind: 'status', message: 'Preview ready. Review the changes before confirming.' };
      } else {
        notice = { kind: 'error', message: result.error.message };
      }
    } catch {
      showUnexpectedFailure(signal);
    } finally {
      finish();
    }
  };

  const confirmImport = async (): Promise<void> => {
    const current = preview;
    if (!(current && mutationAvailable)) {
      return;
    }
    const signal = begin('confirm');
    if (!signal) {
      return;
    }
    try {
      const result = await client.confirm(current.file, current.data, signal, updateProgress);
      if (result.ok) {
        preview = null;
        notice = { kind: 'status', message: formatManualImportSummary(current.data) };
        await onCompleted?.();
      } else {
        if (result.error.reason === 'preview-stale') {
          preview = null;
        }
        notice = { kind: 'error', message: result.error.message };
      }
    } catch {
      showUnexpectedFailure(signal);
    } finally {
      finish();
    }
  };

  onDestroy(() => {
    operationController?.abort();
    if (progressTimer) {
      clearInterval(progressTimer);
    }
  });
</script>

<section class={panel}>
  <div class={panelHeader}>
    <h2 class={panelTitle}>Manual transfer</h2>
    <div class={panelSub}>Export usage as a file or import a file from another machine.</div>
  </div>
  {#if notice?.kind === 'error'}
    <div class={operationPanel} role="alert">{notice.message}</div>
  {:else if notice}
    <div class={operationPanel} role="status">{notice.message}</div>
  {/if}
  {#if mutationMessage}
    <p class={panelSub} role="status">{mutationMessage}</p>
  {/if}
  <div class={actionRow}>
    <button class={ghostButton} disabled={pending !== null} onclick={exportCurrentMachine} type="button">
      {pending === 'export' ? 'Exporting' : 'Export current machine'}
    </button>
  </div>
  <input
    accept=".json,application/json"
    disabled={!mutationAvailable || pending !== null}
    hidden
    onchange={async (event) => {
      const input = event.currentTarget;
      await previewFile(input.files?.[0]);
      input.value = '';
    }}
    type="file"
    bind:this={fileInput}
  >
  <button
    class={cx(dropZone, dragActive && dropZoneActive)}
    disabled={!mutationAvailable || pending !== null}
    onclick={() => fileInput.click()}
    ondragenter={() => (dragActive = true)}
    ondragleave={() => (dragActive = false)}
    ondragover={(event) => event.preventDefault()}
    ondrop={async (event) => {
      event.preventDefault();
      dragActive = false;
      if (mutationAvailable && pending === null) {
        await previewFile(event.dataTransfer?.files[0]);
      }
    }}
    type="button"
  >
    <span class={strongCell}>Drop a merge file here or choose a file</span>
    <span class={panelSub}>JSON only. The file is previewed before any local usage changes.</span>
  </button>
  {#if preview}
    <div class={operationPanel} role="status">
      <div class={strongCell}>Review merge import</div>
      <div>
        {preview.file.name}
        · {preview.data.rows.toLocaleString()} rows · {formatTransferBytes(preview.data.bytes)}
      </div>
      <div>
        {preview.data.result.inserted}
        inserted, {preview.data.result.updated} updated,
        {preview.data.result.unchanged}
        unchanged, {preview.data.result.superseded} superseded,
        {preview.data.result.deleted}
        deleted, {preview.data.warningCount} warnings
      </div>
      <div class={panelSub}>Peer provenance is preserved; local history is not replaced wholesale.</div>
      <div class={actionRow}>
        <button
          class={ghostButton}
          disabled={!mutationAvailable || pending !== null}
          onclick={confirmImport}
          type="button"
        >
          {pending === 'confirm' ? 'Confirming' : 'Confirm import'}
        </button>
        <button class={ghostButton} disabled={pending !== null} onclick={() => (preview = null)} type="button">
          Cancel
        </button>
      </div>
    </div>
  {/if}
  {#if progress}
    <ManualTransferProgress now={progressNow} {progress} />
  {/if}
</section>
