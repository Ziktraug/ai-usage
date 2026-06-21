import { metricDelta, metricDeltaArrow, metricLabel, metricTile, metricValue } from '@ai-usage/design-system/report';
import { Show } from 'solid-js';
import { fmtPct } from './shared';

export interface MetricDelta {
  hint: string;
  pct: number;
}

export interface Metric {
  delta?: MetricDelta | null;
  hint?: string;
  label: string;
  value: string;
}

// Past ~4× the percentage stops being readable ("▲ 4632%"); switch to the
// multiplication factor instead.
export const fmtDeltaPct = (pct: number) => {
  if (pct >= 400) {
    const factor = pct / 100 + 1;
    return `×${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}`;
  }
  return fmtPct(Math.abs(pct));
};

// Period deltas read as context, not judgement: cost going up is not "bad",
// so the arrow stays in the accent and the number in muted ink.
export const MetricTile = (props: Metric) => (
  <div class={metricTile} title={props.hint}>
    <div class={metricLabel}>{props.label}</div>
    <div>
      <div class={metricValue}>{props.value}</div>
      <Show when={props.delta}>
        {(delta) => (
          <div class={metricDelta} title={delta().hint}>
            <span aria-hidden="true" class={metricDeltaArrow}>
              {delta().pct >= 0 ? '▲' : '▼'}
            </span>{' '}
            {fmtDeltaPct(delta().pct)}
          </div>
        )}
      </Show>
    </div>
  </div>
);
