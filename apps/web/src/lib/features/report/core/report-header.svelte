<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { header, meta, title, titleBlock } from '@ai-usage/design-system/svelte';
  import { reportFreshnessLabel, reportFreshnessTime } from './report-view-model';

  let {
    generatedAt,
    hasReportData,
    heading = 'Usage overview',
    isDemo,
  }: { generatedAt: string | null; hasReportData: boolean; heading?: string; isDemo: boolean } = $props();

  const headerTop = css({ alignItems: 'flex-start', display: 'flex', justifyContent: 'space-between' });
  const eyebrowRow = css({ alignItems: 'center', display: 'flex', gap: '8px' });
  const eyebrow = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  });
  const demoBadge = css({
    bg: 'accentTint',
    borderRadius: 'full',
    color: 'accent',
    fontSize: '10px',
    fontWeight: 700,
    px: '8px',
    py: '2px',
  });
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
      <h1 class={title}>{heading}</h1>
      <div
        class={meta}
        data-report-freshness
        title="When the stored report was last assembled from collected usage. It changes only when the data changes, not when you navigate."
      >
        {#if hasReportData && generatedAt}
          Data as of <time datetime={generatedAt}>{reportFreshnessTime(generatedAt)}</time>
        {:else}
          {reportFreshnessLabel(generatedAt, hasReportData)}
        {/if}
      </div>
    </div>
  </div>
</header>
