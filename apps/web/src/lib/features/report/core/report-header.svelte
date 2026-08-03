<script lang="ts">
  import {
    demoBadge,
    eyebrow,
    eyebrowRow,
    header,
    headerTop,
    meta,
    title,
    titleBlock,
  } from '@ai-usage/design-system/report';
  import { reportGeneratedLabel } from './report-view-model';

  let { generatedAt, hasReportData, isDemo }: { generatedAt: string | null; hasReportData: boolean; isDemo: boolean } =
    $props();
</script>

<header class={header}>
  <div class={headerTop}>
    <div class={titleBlock}>
      <div class={eyebrowRow}>
        <div class={eyebrow}>ai-usage</div>
        {#if isDemo}
          <span class={demoBadge}>Demo data</span>
        {/if}
      </div>
      <h1 class={title}>Usage report</h1>
      <div class={meta}>{reportGeneratedLabel(generatedAt, hasReportData)}</div>
    </div>
  </div>
</header>
