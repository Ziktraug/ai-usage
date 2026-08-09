<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const metricInfoButton = css({
    display: 'inline-grid',
    placeItems: 'center',
    w: '24px',
    h: '24px',
    p: 0,
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    bg: 'surfaceMuted',
    color: 'muted',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
    _hover: { borderColor: 'lineStrong', color: 'ink' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const metricHintContent = css({ maxW: '320px', color: 'ink', fontSize: '13px', lineHeight: 1.5 });
</script>

<script lang="ts">
  import { Popover } from '@ai-usage/design-system/svelte';
  import type { Metric } from '../../../../dashboard-metric-model';

  let { metric }: { metric: Metric } = $props();
</script>

{#if metric.hint}
  <Popover
    triggerAriaLabel={`About ${metric.label}`}
    triggerClass={metricInfoButton}
    triggerTitle={`About ${metric.label}`}
  >
    {#snippet trigger()}
      <span aria-hidden="true">i</span>
    {/snippet}
    <div class={metricHintContent}>
      <div>{metric.hint}</div>
      {#if metric.delta}
        <div>{metric.delta.hint}</div>
      {/if}
    </div>
  </Popover>
{/if}
