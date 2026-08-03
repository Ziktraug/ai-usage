<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const rows = css({ display: 'grid', gap: '8px' });
  const row = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    gap: '12px',
    alignItems: 'baseline',
  });
  const label = css({ color: 'muted', fontSize: '12px' });
  const exact = css({ fontSize: '13px', fontWeight: 650, textStyle: 'numeric' });
  const percentage = css({ color: 'muted', fontSize: '11px', minW: '48px', textAlign: 'right', textStyle: 'numeric' });
  const note = css({ color: 'muted', fontSize: '12px', mt: '4px' });
</script>

<script lang="ts">
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { FocusedReportSummary } from '@ai-usage/report-core/focused-report-query';
  import { fmtCompact, fmtNum } from '../../../foundation/presentation/format';
  import { tokenAnatomyRows } from './view-model';

  let { summary }: { summary: FocusedReportSummary } = $props();
  const anatomy = $derived(tokenAnatomyRows(summary));
</script>

<section class={panel}>
  <div>
    <h2 class={panelTitle}>Token anatomy</h2>
    <p class={panelSub}>Exact token definitions for the selected report range</p>
  </div>
  <dl class={rows}>
    {#each anatomy as item (item.key)}
      <div class={row} data-token-anatomy-row>
        <dt class={label}>{item.label}</dt>
        <dd class={exact} data-token-exact-value>{item.value}</dd>
        <dd class={percentage} data-token-percentage>{item.percentage}</dd>
      </div>
    {/each}
  </dl>
  {#if summary.rtkSessions > 0}
    <p class={note}>
      RTK saved {fmtCompact(summary.rtkSaved)} tokens across {fmtNum(summary.rtkSessions)} sessions; RTK input and
      output remain included in the exact rows above.
    </p>
  {/if}
</section>
