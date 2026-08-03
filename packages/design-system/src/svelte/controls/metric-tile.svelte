<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const metricTile = css({
    minH: '88px',
    p: '14px 16px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'card',
    display: 'grid',
    alignContent: 'start',
    gap: '10px',
  });
  const metricLabel = css({ textStyle: 'label', color: 'muted' });
  const metricValue = css({
    textStyle: 'numeric',
    fontSize: { base: '20px', md: '23px' },
    lineHeight: '1',
    fontWeight: 600,
  });
  const metricDelta = css({ textStyle: 'numeric', mt: '7px', fontSize: '11px', color: 'muted' });
  const metricDeltaArrow = css({ color: 'accent', fontSize: '9px' });

  export interface MetricTileProps {
    delta?: { label: string; hint?: string; positive?: boolean } | null;
    hint?: string;
    label: string;
    value: string;
  }
</script>

<script lang="ts">
  let { delta, hint, label, value }: MetricTileProps = $props();
</script>

<div class={metricTile} title={hint}>
  <div class={metricLabel}>{label}</div>
  <div>
    <div class={metricValue}>{value}</div>
    {#if delta}
      <div class={metricDelta} title={delta.hint}>
        <span aria-hidden="true" class={metricDeltaArrow}>{delta.positive === false ? '▼' : '▲'}</span>
        {' '}{delta.label}
      </div>
    {/if}
  </div>
</div>
