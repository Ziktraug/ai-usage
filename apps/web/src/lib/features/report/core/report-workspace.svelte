<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/useSemanticElements: the active report region must remain keyboard-reachable after removing primary tabs -->
<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { section } from '@ai-usage/design-system/report';
  import { onMount, type Snippet } from 'svelte';
  import { useOptionalReportPendingIndicator } from '../../shell/report-pending-context';
  import ReportPendingSurface from './report-pending-surface.svelte';
  import ReportStatus from './report-status.svelte';

  let {
    children,
    hasOutput,
    onRetry = () => Promise.resolve(),
    pending,
    refreshError = null,
  }: {
    children?: Snippet;
    hasOutput: boolean;
    onRetry?: () => Promise<void>;
    pending: boolean;
    refreshError?: string | null;
  } = $props();

  const layout = css({ display: 'flex', flexDirection: 'column' });
  // A range change rescales the Activity chart from data already in memory, but every other figure
  // in each changed region still describes the previous request until the server answers. Without this the report
  // shows two contradictory totals for the same quantity and both look definitive.
  // ReportRegion scopes this qualification and its 180ms entry delay to changed request identities.
  const indicator = useOptionalReportPendingIndicator();
  onMount(() => indicator?.observe(() => pending));
  const panel = css({ minW: 0, _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '4px' } });
  const unavailablePanel = css({ border: '1px solid token(colors.line)', borderRadius: 'lg', p: '24px' });
  const unavailableText = css({ color: 'muted', fontSize: '13px' });
</script>

<div class={layout} data-report-workspace>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- active report panel remains keyboard-reachable after removing primary tabs -->
  <div aria-label="Report results" class={panel} data-dashboard-panel role="region" tabindex="0">
    {#if hasOutput}
      <section class={section} data-report-complete-output>
        {#if children}
          {@render children()}
        {/if}
      </section>
    {:else if pending}
      <ReportPendingSurface />
    {:else}
      <section class={unavailablePanel} data-report-unavailable>
        <div class={unavailableText}>Report payload unavailable</div>
      </section>
    {/if}
  </div>
  <ReportStatus {onRetry} {pending} {refreshError} />
</div>
