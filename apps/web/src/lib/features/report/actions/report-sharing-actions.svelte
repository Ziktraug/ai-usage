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

  const copyLink = async (): Promise<void> => {
    notice = await copyExactBreakdownUrl(environment());
  };
  const exportCsv = async (): Promise<void> => {
    notice = await exportVisibleBreakdown(createExport, environment());
  };
</script>

<div class={row} data-report-sharing-actions>
  <button class={button} onclick={copyLink} type="button">Copy link</button>
  <button class={button} onclick={exportCsv} type="button">Export CSV</button>
  {#if notice?.tone === 'error'}
    <span aria-live="assertive" class={noticeError} role="alert">{notice.message}</span>
  {:else if notice}
    <span aria-live="polite" role="status">{notice.message}</span>
  {/if}
</div>
