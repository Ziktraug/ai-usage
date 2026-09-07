<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import WorkspaceHeader from '../../shell/workspace-header.svelte';
  import { reportFreshnessLabel, reportFreshnessTime } from './report-view-model';

  let {
    generatedAt,
    hasReportData,
    heading = 'Usage overview',
    isDemo,
  }: { generatedAt: string | null; hasReportData: boolean; heading?: string; isDemo: boolean } = $props();

  const freshness = css({
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 12px',
    color: 'muted',
    fontSize: '11px',
    lineHeight: 1.5,
  });
  const demoBadge = css({
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    color: 'muted',
    fontSize: '10px',
    px: '7px',
    py: '3px',
  });
  const description = $derived.by(() => {
    if (heading === 'Usage overview') {
      return 'A little perspective on the work you are building.';
    }
    if (heading === 'Sessions') {
      return 'Follow the work, from the first prompt to the details.';
    }
    return 'Explore the models, harnesses, and projects behind your usage.';
  });
</script>

<WorkspaceHeader atmospheric={heading === 'Usage overview'} {description} eyebrow="Local activity" {heading}>
  {#snippet meta()}
    <div class={freshness}>
      <span
        data-report-freshness
        title="When the stored report was last assembled from collected usage. It changes only when the data changes, not when you navigate."
      >
        {#if hasReportData && generatedAt}
          Data as of <time datetime={generatedAt}>{reportFreshnessTime(generatedAt)}</time>
        {:else}
          {reportFreshnessLabel(generatedAt, hasReportData)}
        {/if}
      </span>
      {#if isDemo}
        <span class={demoBadge}>Demo data</span>
      {/if}
    </div>
  {/snippet}
</WorkspaceHeader>
