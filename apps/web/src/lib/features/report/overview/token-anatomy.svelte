<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    anatomyHeadline,
    anatomyLegend,
    anatomyLegendItem,
    anatomyLegendLabel,
    anatomyLegendPercentage,
    anatomyLegendSwatch,
    anatomyLegendValue,
    anatomyLegendValues,
    panel,
    panelHeader,
    panelSub,
    panelTitle,
    rtkNote,
  } from '@ai-usage/design-system/report';

  const tokenSegmentClasses = {
    cacheRead: css({ bg: 'accent', opacity: 0.22 }),
    cacheWrite: css({ bg: 'accent', opacity: 0.42 }),
    input: css({ bg: 'accent', opacity: 0.68 }),
    output: css({ bg: 'accent' }),
  } as const;
  const emptyPanel = css({ color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import type { FocusedReportSummary } from '@ai-usage/report-core/focused-report-query';
  import { fmtCompact, fmtNum, fmtPct } from '../../../foundation/presentation/format';

  let { summary }: { summary: FocusedReportSummary } = $props();
  const segments = $derived([
    { class: tokenSegmentClasses.cacheRead, key: 'cache-read', label: 'Cache read', value: summary.cacheRead },
    { class: tokenSegmentClasses.cacheWrite, key: 'cache-write', label: 'Cache write', value: summary.cacheWrite },
    { class: tokenSegmentClasses.input, key: 'input', label: 'Input', value: summary.tokIn },
    { class: tokenSegmentClasses.output, key: 'output', label: 'Output', value: summary.tokOut },
  ]);
  const total = $derived(segments.reduce((sum, segment) => sum + segment.value, 0));
  const cachePercentage = $derived(total > 0 ? (summary.cacheRead / total) * 100 : 0);
</script>

<section class={panel}>
  <header class={panelHeader}>
    <h2 class={panelTitle}>Token anatomy</h2>
    <div class={panelSub}>Where the volume actually goes</div>
  </header>
  {#if total > 0}
    <div class={anatomyHeadline}>
      <strong>{fmtPct(cachePercentage)}</strong>
      of all token volume was read from cache — context reuse is what makes agentic sessions affordable.
    </div>
    <dl class={anatomyLegend} data-overview-token-legend>
      {#each segments as segment (segment.key)}
        <div
          class={anatomyLegendItem}
          data-token-anatomy-row
          title={`${segment.label}: ${fmtNum(segment.value)} tokens`}
        >
          <dt class={anatomyLegendLabel}>
            <span class={cx(anatomyLegendSwatch, segment.class)}></span><span>{segment.label}</span>
          </dt>
          <dd class={anatomyLegendValues}>
            <span class={anatomyLegendValue} data-token-exact-value>{fmtNum(segment.value)}</span>
            <span class={anatomyLegendPercentage} data-token-percentage>{fmtPct((segment.value / total) * 100)}</span>
          </dd>
        </div>
      {/each}
    </dl>
    {#if summary.rtkSaved > 0}
      <div class={rtkNote}>
        <span>
          RTK saved <strong>{fmtCompact(summary.rtkSaved)}</strong> tokens ({fmtPct(summary.rtkInput ? (summary.rtkSaved / summary.rtkInput) * 100 : 0)}
          of matched input) across <strong>{fmtNum(summary.rtkSessions)}</strong> sessions.
        </span>
      </div>
    {/if}
  {:else}
    <div class={emptyPanel}>No token data in range</div>
  {/if}
</section>
