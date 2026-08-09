<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/useSemanticElements: the active report region must remain keyboard-reachable after removing primary tabs -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { section } from '@ai-usage/design-system/report';
  import type { Snippet } from 'svelte';
  import ReportPendingSurface from './report-pending-surface.svelte';
  import ReportStatus from './report-status.svelte';

  let {
    children,
    hasOutput,
    pending,
    refreshError = null,
    status,
  }: {
    children?: Snippet;
    hasOutput: boolean;
    pending: boolean;
    refreshError?: string | null;
    status?: Snippet;
  } = $props();

  const layout = css({ display: 'flex', flexDirection: 'column' });
  // A range change rescales the Activity chart from data already in memory, but every other figure
  // here still describes the previous request until the server answers. Without this the report
  // shows two contradictory totals for the same quantity and both look definitive.
  const settledOutput = css({ transition: 'opacity 120ms ease' });
  // The delay applies on the way in only, so refreshes shorter than it never flash.
  const staleOutput = css({ opacity: 0.5, transitionDelay: '180ms' });
  const staleAttributes = $derived(pending ? ({ 'aria-busy': 'true', 'data-report-stale': 'true' } as const) : {});
  const panel = css({ minW: 0, _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '4px' } });
  const unavailablePanel = css({ border: '1px solid token(colors.border)', borderRadius: 'lg', p: '24px' });
  const unavailableText = css({ color: 'muted', fontSize: '13px' });
</script>

<div class={layout} data-report-workspace>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- active report panel remains keyboard-reachable after removing primary tabs -->
  <div aria-label="Report results" class={panel} data-dashboard-panel role="region" tabindex="0">
    {#if hasOutput}
      <section
        {...staleAttributes}
        class={cx(section, settledOutput, pending && staleOutput)}
        data-report-complete-output
      >
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
  {#if status}
    <div data-report-secondary-status>
      {@render status()}
    </div>
  {/if}
  <ReportStatus {pending} {refreshError} />
</div>
