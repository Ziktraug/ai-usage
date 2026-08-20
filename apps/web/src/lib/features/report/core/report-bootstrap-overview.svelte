<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { ReportOverviewItem } from './report-view-model';

  let {
    items,
    publicationLabel,
    revision,
  }: { items: readonly ReportOverviewItem[]; publicationLabel: string; revision: string | null } = $props();

  const heading = css({ display: 'grid', gap: '4px', mb: '16px' });
  const grid = css({
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' },
  });
  const metric = css({
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    display: 'grid',
    gap: '4px',
    p: '12px',
  });
  const metricLabel = css({ color: 'muted', fontSize: '11px', fontWeight: 650, textTransform: 'uppercase' });
  const metricValue = css({ color: 'ink', fontSize: '14px', fontWeight: 700 });
</script>

<section class={panel} data-report-bootstrap-overview data-report-revision={revision ?? undefined}>
  <div class={heading}>
    <h2 class={panelTitle}>Overview</h2>
    <p class={panelSub} data-report-publication>{publicationLabel}</p>
  </div>
  <dl class={grid}>
    {#each items as item (item.label)}
      <div class={metric}>
        <dt class={metricLabel}>{item.label}</dt>
        <dd class={metricValue}>{item.value}</dd>
      </div>
    {/each}
  </dl>
</section>
