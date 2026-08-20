<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { UsageReportWarning } from '@ai-usage/report-core/report-data';

  let {
    cleanupDisabled = false,
    cleaningProjectWarningGroupId,
    omittedSupportItemCount = 0,
    onCleanupProjectWarning,
    warnings = [],
  }: {
    cleanupDisabled?: boolean;
    cleaningProjectWarningGroupId?: string;
    omittedSupportItemCount?: number;
    onCleanupProjectWarning?: (warning: UsageReportWarning) => void;
    warnings?: readonly UsageReportWarning[];
  } = $props();

  const warningPanel = css({ borderColor: 'status.warn', bg: 'status.warnSoft', mt: '16px' });
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
  const panelHeader = css({ display: 'grid', gap: '4px' });
  const cleanupButton = css({
    bg: 'transparent',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    color: 'ink',
    cursor: 'pointer',
    fontSize: '11px',
    ml: '8px',
    px: '8px',
    py: '3px',
    _disabled: { cursor: 'not-allowed', opacity: 0.55 },
  });

  const canCleanup = (warning: UsageReportWarning): boolean =>
    warning.groupId !== undefined && warning.selectors !== undefined && warning.selectors.length > 0;
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
            {#if canCleanup(warning) && onCleanupProjectWarning}
              <button
                class={cleanupButton}
                disabled={cleanupDisabled || cleaningProjectWarningGroupId === warning.groupId}
                onclick={() => onCleanupProjectWarning?.(warning)}
                type="button"
              >
                {cleaningProjectWarningGroupId === warning.groupId ? 'Cleaning…' : 'Cleanup'}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
