<script lang="ts" module>
  import { metricDelta, metricDeltaArrow, metricLabel, metricTile, metricValue } from '../../components/metric-tile';

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
