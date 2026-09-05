<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
  import { presentReportWarning, reportNoticesSummary } from './report-warnings-model';

  let {
    cleanupDisabled = false,
    cleaningProjectWarningGroupId,
    omittedSupportItemCount = 0,
    onCleanupProjectWarning,
    presentMachineLabel = (id: string) => id,
    warnings = [],
  }: {
    cleanupDisabled?: boolean;
    cleaningProjectWarningGroupId?: string;
    omittedSupportItemCount?: number;
    onCleanupProjectWarning?: (warning: UsageReportWarning) => void;
    /** Resolves a machine id to its label; an unresolved id falls back to a shortened id. */
    presentMachineLabel?: (id: string) => string;
    warnings?: readonly UsageReportWarning[];
  } = $props();

  // Closed by default: the summary line states the count and the consequence, which is all the
  // report reader needs. The details exist for the reader about to act on them.
  const warningPanel = css({
    borderColor: 'status.warn',
    bg: 'status.warnSoft',
    mt: '16px',
    gap: '6px',
    py: '10px',
  });
  const warningDetails = css({
    display: 'grid',
    gap: '10px',
    '& > summary': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'baseline',
      gap: '4px 10px',
      cursor: 'pointer',
      listStyle: 'none',
      '&::-webkit-details-marker': { display: 'none' },
      '&::before': { content: '"▸"', color: 'muted', fontSize: '11px', mr: '2px' },
    },
    '&[open] > summary::before': { content: '"▾"' },
  });
  const warningList = css({
    color: 'muted',
    display: 'grid',
    fontSize: '12px',
    gap: '8px',
    m: 0,
    maxW: '900px',
    pl: '18px',
  });
  const warningHarness = css({ color: 'ink', fontWeight: 650 });
  const headline = css({ color: 'ink' });
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
  const selectorDetails = css({
    mt: '4px',
    '& > summary': { cursor: 'pointer', fontSize: '11px', color: 'muted' },
  });
  const selectorGroup = css({ display: 'grid', gap: '2px', mt: '6px' });
  const selectorMachine = css({ color: 'ink', fontWeight: 650 });
  const selectorPaths = css({ m: 0, pl: '16px', display: 'grid', gap: '1px' });
  const mono = css({ fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });

  const canCleanup = (warning: UsageReportWarning): boolean =>
    warning.groupId !== undefined && warning.selectors !== undefined && warning.selectors.length > 0;
  const notices = $derived(warnings.map((warning) => presentReportWarning(warning, presentMachineLabel)));
</script>

{#if warnings.length > 0 || omittedSupportItemCount > 0}
  <!-- The heading stays outside the disclosure: a heading inside <summary> is flattened by some
       accessibility mappings, and the heading is how a screen-reader user finds this block. -->
  <section aria-labelledby="report-warnings-title" class={cx(panel, warningPanel)} data-report-warnings>
    <h2 class={panelTitle} id="report-warnings-title">Report warnings</h2>
    <details class={warningDetails}>
      <summary>
        <span class={panelSub} data-report-warnings-summary>
          {reportNoticesSummary(warnings, omittedSupportItemCount)}
        </span>
      </summary>
      {#if omittedSupportItemCount > 0}
        <p class={panelSub} role="status">
          {omittedSupportItemCount}
          additional support {omittedSupportItemCount === 1 ? 'item is' : 'items are'} omitted from this bounded
          summary. Exact report queries and complete exports remain available.
        </p>
      {/if}
      {#if notices.length > 0}
        <ul class={warningList}>
          {#each notices as notice}
            <li data-report-warning>
              {#if notice.harness}
                <span class={warningHarness}>{notice.harness}: </span>
              {/if}
              <span class={headline}>{notice.headline}</span>
              {#if canCleanup(notice.warning) && onCleanupProjectWarning}
                <button
                  class={cleanupButton}
                  disabled={cleanupDisabled || cleaningProjectWarningGroupId === notice.warning.groupId}
                  onclick={() => onCleanupProjectWarning?.(notice.warning)}
                  type="button"
                >
                  {cleaningProjectWarningGroupId === notice.warning.groupId ? 'Cleaning…' : 'Cleanup'}
                </button>
              {/if}
              {#if notice.selectorGroups.length > 0}
                <details class={selectorDetails}>
                  <summary>
                    Show the {notice.selectorCount} configured {notice.selectorCount === 1 ? 'source' : 'sources'}
                  </summary>
                  {#each notice.selectorGroups as group (group.machineId)}
                    <div class={selectorGroup}>
                      <span>
                        <span class={selectorMachine}>{group.machine}</span>
                        {#if group.prefix}
                          · {group.paths.length} paths under <code class={mono}>{group.prefix}</code>
                        {/if}
                      </span>
                      {#if group.paths.length > 0 || group.otherSelectors.length > 0}
                        <ul class={selectorPaths}>
                          {#each group.paths as path}
                            <li><code class={mono}>{path}</code></li>
                          {/each}
                          {#each group.otherSelectors as selector}
                            <li><code class={mono}>{selector}</code></li>
                          {/each}
                        </ul>
                      {/if}
                    </div>
                  {/each}
                </details>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </details>
  </section>
{/if}
