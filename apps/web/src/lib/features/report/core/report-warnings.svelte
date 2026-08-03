<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
  import type { UsageReportWarning } from '@ai-usage/report-core/report-data';

  let {
    omittedSupportItemCount = 0,
    warnings = [],
  }: { omittedSupportItemCount?: number; warnings?: readonly UsageReportWarning[] } = $props();

  const warningPanel = css({ borderColor: 'accent', bg: 'accentTint', mt: '16px' });
  const warningList = css({
    color: 'muted',
    display: 'grid',
    fontSize: '12px',
    gap: '6px',
    m: 0,
    maxW: '900px',
    pl: '18px',
  });
  const warningHarness = css({ color: 'ink', fontWeight: 650 });
</script>

{#if warnings.length > 0 || omittedSupportItemCount > 0}
  <section class={cx(panel, warningPanel)}>
    <div class={panelHeader}>
      <h2 class={panelTitle}>Report warnings</h2>
      <p class={panelSub}>Some report inputs could not be fully processed. Totals use available rows only.</p>
      {#if omittedSupportItemCount > 0}
        <p class={panelSub} role="status">
          {omittedSupportItemCount}
          additional support {omittedSupportItemCount === 1 ? 'item is' : 'items are'} omitted from this bounded
          summary. Exact report queries and complete exports remain available.
        </p>
      {/if}
    </div>
    {#if warnings.length > 0}
      <ul class={warningList}>
        {#each warnings as warning}
          <li>
            {#if warning.harness}
              <span class={warningHarness}>{warning.harness}: </span>
            {/if}
            {warning.message}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
