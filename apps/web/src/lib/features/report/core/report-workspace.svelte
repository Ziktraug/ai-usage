<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/useSemanticElements: the active report region must remain keyboard-reachable after removing primary tabs -->
<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { section, unavailablePanel, unavailableText } from '@ai-usage/design-system/report';
  import type { Snippet } from 'svelte';
  import ReportPendingSurface from './report-pending-surface.svelte';
  import ReportStatus from './report-status.svelte';

  let {
    children,
    hasOutput,
    pending,
    refreshError,
  }: { children?: Snippet; hasOutput: boolean; pending: boolean; refreshError?: string | null } = $props();

  const layout = css({ display: 'flex', flexDirection: 'column' });
  const panel = css({ minW: 0, _focus: { outline: '2px solid token(colors.accent)', outlineOffset: '4px' } });
</script>

<div class={layout} data-report-workspace>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- active report panel remains keyboard-reachable after removing primary tabs -->
  <div aria-label="Report results" aria-live="polite" class={panel} data-dashboard-panel role="region" tabindex="0">
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
  <ReportStatus {pending} {refreshError} />
</div>
