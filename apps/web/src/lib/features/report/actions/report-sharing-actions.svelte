<script lang="ts">
  import { button, noticeError, row } from '../breakdown/styles';
  import {
    browserSharingEnvironment,
    copyExactBreakdownUrl,
    type ExportFile,
    exportVisibleBreakdown,
    type SharingEnvironment,
    type SharingNotice,
  } from './sharing';

  let {
    createExport,
    environment = browserSharingEnvironment,
  }: {
    createExport: () => Promise<ExportFile>;
    environment?: () => SharingEnvironment;
  } = $props();

  let notice: SharingNotice | undefined = $state();
  let pending = $state(false);

  const copyLink = async (): Promise<void> => {
    pending = true;
    notice = await copyExactBreakdownUrl(environment());
    pending = false;
  };
  const exportCsv = async (): Promise<void> => {
    pending = true;
    notice = await exportVisibleBreakdown(createExport, environment());
    pending = false;
  };
</script>

<div class={row} data-report-sharing-actions>
  <button class={button} disabled={pending} onclick={copyLink} type="button">Copy link</button>
  <button class={button} disabled={pending} onclick={exportCsv} type="button">Export CSV</button>
  {#if notice?.tone === 'error'}
    <span aria-live="assertive" class={noticeError} role="alert">{notice.message}</span>
  {:else if notice}
    <span aria-live="polite" role="status">{notice.message}</span>
  {/if}
</div>
