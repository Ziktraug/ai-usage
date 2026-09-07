<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/svelte';
  import {
    browserSharingEnvironment,
    copyExactBreakdownUrl,
    type ExportFile,
    exportVisibleBreakdown,
    type SharingEnvironment,
    type SharingNotice,
  } from './sharing';

  const actions = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    alignItems: 'center',
    minW: 0,
    ml: { base: '0', md: 'auto' },
    _print: { display: 'none' },
  });
  const noticeText = css({ color: 'muted', fontSize: '12px' });
  const errorNoticeText = css({ color: 'status.danger' });

  let {
    createExport,
    environment = browserSharingEnvironment,
    exportLabel = 'Export CSV',
  }: {
    createExport: () => Promise<ExportFile>;
    environment?: () => SharingEnvironment;
    /** Destination-specific action name when the export covers less than the visible result. */
    exportLabel?: string;
  } = $props();

  let notice: SharingNotice | undefined = $state();

  const copyLink = async (): Promise<void> => {
    notice = await copyExactBreakdownUrl(environment());
  };
  const exportCsv = async (): Promise<void> => {
    notice = await exportVisibleBreakdown(createExport, environment());
  };
</script>

<div class={actions} data-report-sharing-actions>
  <button class={ghostButton} onclick={copyLink} type="button">Copy link</button>
  <button class={ghostButton} onclick={exportCsv} type="button">{exportLabel}</button>
  {#if notice?.tone === 'error'}
    <span aria-live="assertive" class={cx(noticeText, errorNoticeText)} role="alert">{notice.message}</span>
  {:else if notice}
    <span aria-live="polite" class={noticeText} role="status">{notice.message}</span>
  {/if}
</div>
