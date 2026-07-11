import { Popover } from '@ai-usage/design-system';
import { css } from '@ai-usage/design-system/css';
import {
  metricDelta,
  metricDeltaArrow,
  metricLabel,
  metricTile,
  metricValue,
  popoverContent,
} from '@ai-usage/design-system/report';
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

const metricLabelRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
});

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

const metricHintContent = css({
  maxW: '320px',
  color: 'ink',
  fontSize: '13px',
  lineHeight: 1.5,
});

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
  <div class={metricTile}>
    <div class={metricLabelRow}>
      <div class={metricLabel}>{props.label}</div>
      <Show when={props.hint}>
        {(hint) => (
          <Popover
            contentClass={popoverContent}
            trigger={<span aria-hidden="true">i</span>}
            triggerAriaLabel={`About ${props.label}`}
            triggerClass={metricInfoButton}
          >
            <div class={metricHintContent}>
              <div>{hint()}</div>
              <Show when={props.delta}>{(delta) => <div>{delta().hint}</div>}</Show>
            </div>
          </Popover>
        )}
      </Show>
    </div>
    <div>
      <div class={metricValue}>{props.value}</div>
      <Show when={props.delta}>
        {(delta) => (
          <div class={metricDelta}>
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
