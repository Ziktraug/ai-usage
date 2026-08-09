<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { header, meta, title, titleBlock } from '@ai-usage/design-system/svelte/passive';
  import { reportGeneratedLabel } from './report-view-model';

  let { generatedAt, hasReportData, isDemo }: { generatedAt: string | null; hasReportData: boolean; isDemo: boolean } =
    $props();

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
      <h1 class={title}>Usage report</h1>
      <div class={meta}>{reportGeneratedLabel(generatedAt, hasReportData)}</div>
    </div>
  </div>
</header>
