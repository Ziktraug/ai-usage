import { css } from '@ai-usage/design-system/css';
import { Show } from 'solid-js';

export const metricGrid = css({
  display: 'grid',
  gridTemplateColumns: {
    base: 'repeat(2, minmax(0, 1fr))',
    md: 'repeat(4, minmax(0, 1fr))',
    xl: 'repeat(7, minmax(0, 1fr))',
  },
  gap: '10px',
  my: '20px',
});

export const metricTile = css({
  minH: '88px',
  p: '14px 16px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  display: 'grid',
  alignContent: 'space-between',
  gap: '10px',
});

export const metricLabel = css({
  textStyle: 'label',
  color: 'muted',
});

export const metricValue = css({
  textStyle: 'numeric',
  fontSize: { base: '20px', md: '23px' },
  lineHeight: '1',
  fontWeight: 600,
});

export const metricDelta = css({
  textStyle: 'numeric',
  mt: '7px',
  fontSize: '11px',
  color: 'muted',
});

export const metricDeltaArrow = css({
  color: 'accent',
  fontSize: '9px',
});

export interface MetricTileProps {
  delta?: { label: string; hint?: string; positive?: boolean } | null;
  hint?: string;
  label: string;
  value: string;
}

export const MetricTile = (props: MetricTileProps) => (
  <div class={metricTile} title={props.hint}>
    <div class={metricLabel}>{props.label}</div>
    <div>
      <div class={metricValue}>{props.value}</div>
      <Show when={props.delta}>
        {(delta) => (
          <div class={metricDelta} title={delta().hint}>
            <span aria-hidden="true" class={metricDeltaArrow}>
              {delta().positive === false ? '▼' : '▲'}
            </span>{' '}
            {delta().label}
          </div>
        )}
      </Show>
    </div>
  </div>
);
