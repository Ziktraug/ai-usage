import { Popover } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import {
  metricDelta,
  metricDeltaArrow,
  metricLabel,
  metricTile,
  metricValue,
  popoverContent,
} from '@ai-usage/design-system/report';
import { For, Show } from 'solid-js';
import type { DateRangeMode } from './date-range';
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

export type MetricComparisonState = 'available' | 'full-range' | 'no-prior-data';

const metricComparisonMessages: Record<Exclude<MetricComparisonState, 'available'>, string> = {
  'full-range': 'No previous period exists before the full recorded range.',
  'no-prior-data': 'No sessions exist in the previous period.',
};

export const metricComparisonStateFor = (
  rangeMode: DateRangeMode,
  previousSummary: object | null | undefined,
): MetricComparisonState => {
  if (previousSummary) {
    return 'available';
  }
  return rangeMode === 'all' ? 'full-range' : 'no-prior-data';
};

export const metricComparisonMessage = (state: MetricComparisonState): string | null =>
  state === 'available' ? null : metricComparisonMessages[state];

const metricLabelRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minH: '24px',
});

export const dashboardMetricGrid = css({
  display: 'grid',
  gridTemplateColumns: {
    base: 'repeat(2, minmax(0, 1fr))',
    md: 'repeat(4, minmax(0, 1fr))',
  },
  gap: '10px',
  my: '20px',
});

const metricComparisonNotice = css({
  gridColumn: '1 / -1',
  m: 0,
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.5,
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

const valueBasesPanel = css({
  gridColumn: { base: '1 / -1', md: 'span 2' },
  gap: 0,
  overflow: 'hidden',
  p: 0,
});

const valueBasesTitle = css({
  p: '12px 16px',
  borderBottom: '1px solid token(colors.line)',
  color: 'ink',
  fontSize: '13px',
  fontWeight: 650,
  m: 0,
});

const valueBasesList = css({
  display: 'grid',
  m: 0,
});

const valueBasesRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px 16px',
  alignItems: 'center',
  p: '10px 16px',
  '& + &': {
    borderTop: '1px solid token(colors.line)',
  },
});

const valueBasesTerm = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minW: 0,
});

const valueBasesDefinition = css({
  display: 'grid',
  justifyItems: 'end',
  m: 0,
});

type ValueBasisKey = 'actual' | 'api' | 'subscription';

const VALUE_BASIS_ORDER = ['api', 'actual', 'subscription'] as const satisfies readonly ValueBasisKey[];
const VALUE_BASIS_LABELS = {
  actual: 'Actual recorded cost',
  api: 'Estimated API-equivalent value',
  subscription: 'Subscription value',
} as const satisfies Record<ValueBasisKey, string>;

const valueBasisKeyFor = (metric: Metric): ValueBasisKey | null => {
  if (metric.label.startsWith('API value')) {
    return 'api';
  }
  if (metric.label === 'Actual cost') {
    return 'actual';
  }
  if (metric.label === 'Sub value') {
    return 'subscription';
  }
  return null;
};

export const splitDashboardMetrics = (
  metrics: readonly Metric[],
): { remainingMetrics: Metric[]; valueBases: Metric[] } => {
  const valueBasesByKey = new Map<ValueBasisKey, Metric>();
  const remainingMetrics: Metric[] = [];
  for (const metric of metrics) {
    const key = valueBasisKeyFor(metric);
    if (key) {
      valueBasesByKey.set(key, metric);
    } else {
      remainingMetrics.push(metric);
    }
  }
  return {
    remainingMetrics,
    valueBases: VALUE_BASIS_ORDER.flatMap((key) => {
      const metric = valueBasesByKey.get(key);
      return metric ? [metric] : [];
    }),
  };
};

const valueBasisLabelFor = (metric: Metric): string => {
  const key = valueBasisKeyFor(metric);
  return key ? VALUE_BASIS_LABELS[key] : metric.label;
};

// Past ~4× the percentage stops being readable ("▲ 4632%"); switch to the
// multiplication factor instead.
export const fmtDeltaPct = (pct: number) => {
  if (pct >= 400) {
    const factor = pct / 100 + 1;
    return `×${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}`;
  }
  return fmtPct(Math.abs(pct));
};

export const metricDeltaFaceLabel = (pct: number): string => `${fmtDeltaPct(pct)} vs previous period`;

export const MetricComparisonNotice = (props: { state: MetricComparisonState }) => {
  const message = () => metricComparisonMessage(props.state);
  return (
    <Show when={message()}>
      {(copy) => (
        <p class={metricComparisonNotice} data-metric-comparison-state={props.state}>
          {copy()}
        </p>
      )}
    </Show>
  );
};

const MetricHintButton = (props: { metric: Metric }) => (
  <Show when={props.metric.hint}>
    {(hint) => (
      <Popover
        contentClass={popoverContent}
        trigger={<span aria-hidden="true">i</span>}
        triggerAriaLabel={`About ${props.metric.label}`}
        triggerClass={metricInfoButton}
        triggerTitle={`About ${props.metric.label}`}
      >
        <div class={metricHintContent}>
          <div>{hint()}</div>
          <Show when={props.metric.delta}>{(delta) => <div>{delta().hint}</div>}</Show>
        </div>
      </Popover>
    )}
  </Show>
);

export const ValueBasesPanel = (props: { metrics: readonly Metric[] }) => (
  <section aria-labelledby="value-bases-title" class={cx(metricTile, valueBasesPanel)} data-value-bases-panel>
    <h3 class={valueBasesTitle} id="value-bases-title">
      Value bases
    </h3>
    <dl class={valueBasesList}>
      <For each={props.metrics}>
        {(metric) => (
          <div class={valueBasesRow} data-value-bases-row>
            <dt class={valueBasesTerm}>
              <span class={metricLabel}>{valueBasisLabelFor(metric)}</span>
              <MetricHintButton metric={metric} />
            </dt>
            <dd class={valueBasesDefinition}>
              <span class={metricValue} data-metric-value>
                {metric.value}
              </span>
              <Show when={metric.delta}>
                {(delta) => (
                  <span class={metricDelta} data-metric-delta>
                    <span aria-hidden="true" class={metricDeltaArrow}>
                      {delta().pct >= 0 ? '▲' : '▼'}
                    </span>{' '}
                    {metricDeltaFaceLabel(delta().pct)}
                  </span>
                )}
              </Show>
            </dd>
          </div>
        )}
      </For>
    </dl>
  </section>
);

// Period deltas read as context, not judgement: cost going up is not "bad",
// so the arrow stays in the accent and the number in muted ink.
export const MetricTile = (props: Metric) => (
  <div class={metricTile} data-metric-tile>
    <div class={metricLabelRow}>
      <div class={metricLabel}>{props.label}</div>
      <MetricHintButton metric={props} />
    </div>
    <div>
      <div class={metricValue} data-metric-value>
        {props.value}
      </div>
      <Show when={props.delta}>
        {(delta) => (
          <div class={metricDelta} data-metric-delta>
            <span aria-hidden="true" class={metricDeltaArrow}>
              {delta().pct >= 0 ? '▲' : '▼'}
            </span>{' '}
            {metricDeltaFaceLabel(delta().pct)}
          </div>
        )}
      </Show>
    </div>
  </div>
);
