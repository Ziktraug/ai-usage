<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type {
    ProviderQuotaHistorySeries,
    ProviderQuotaHistoryWindow,
  } from '../../../../provider-quota-history-model';
  import { fmtDate, fmtPct } from '../../../foundation/presentation/format';
  import { muted, panel, row, table, tableCell } from '../breakdown/styles';

  const chart = css({
    w: 'full',
    h: 'auto',
    aspectRatio: '3 / 1',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
  });
  const axisRow = css({ display: 'flex', justifyContent: 'space-between', color: 'muted', fontSize: '11px' });
  const tableWrap = css({ overflowX: 'auto' });
  const srOnly = css({ srOnly: true });
  const MILLISECONDS_PER_MINUTE = 60_000;
  const MINUTES_PER_HOUR = 60;
  const CHART_WIDTH = 600;
  const CHART_HEIGHT = 200;
  const CHART_LEFT = 20;
  const CHART_RIGHT = 580;
  const MARKER_BAND_TOP = 6;
  const MARKER_BAND_BOTTOM = 22;
  const MARKER_HALF_WIDTH = 5;
  const PLOT_TOP = 30;
  const PLOT_MIDDLE = 100;
  const PLOT_BOTTOM = 170;
  const CHART_PLOT_WIDTH = CHART_RIGHT - CHART_LEFT;
  const CHART_PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;
  const FULL_PERCENT = 100;

  interface QuotaBreakBoundary {
    readonly key: string;
    readonly label: string;
    readonly reason: 'gap' | 'reset';
    readonly x: number;
  }

  let { series, window }: { series: ProviderQuotaHistorySeries; window: ProviderQuotaHistoryWindow } = $props();

  const largestGapLabel = (milliseconds: number): string => {
    const minutes = Math.round(milliseconds / MILLISECONDS_PER_MINUTE);
    return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${(minutes / MINUTES_PER_HOUR).toFixed(1)}h`;
  };
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const seriesX = (observedAt: string): number => {
    const from = Date.parse(window.from);
    const span = Math.max(1, Date.parse(window.to) - from);
    return CHART_LEFT + clamp01((Date.parse(observedAt) - from) / span) * CHART_PLOT_WIDTH;
  };
  const seriesY = (usedPercent: number | null): number =>
    PLOT_BOTTOM - ((usedPercent ?? 0) / FULL_PERCENT) * CHART_PLOT_HEIGHT;
  const seriesPath = (segmentIndex: number): string => {
    const segment = series.segments[segmentIndex];
    if (!segment?.points.length) {
      return '';
    }
    return segment.points
      .map((point, index) => {
        const x = seriesX(point.firstObservedAt).toFixed(1);
        const y = seriesY(point.usedPercent).toFixed(1);
        return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ');
  };
  const breakBoundaries = (): QuotaBreakBoundary[] =>
    series.segments.flatMap((segment) => {
      const point = segment.points[0];
      if (!(segment.breakReason && point)) {
        return [];
      }
      const observed = fmtDate(point.firstObservedAt);
      return [
        {
          key: `${segment.breakReason}:${point.firstObservedAt}`,
          label:
            segment.breakReason === 'reset' ? `Reset boundary at ${observed}` : `Collection gap before ${observed}`,
          reason: segment.breakReason,
          x: seriesX(point.firstObservedAt),
        },
      ];
    });
  const markerPath = (x: number): string =>
    `M ${(x - MARKER_HALF_WIDTH).toFixed(1)} ${MARKER_BAND_TOP} L ${(x + MARKER_HALF_WIDTH).toFixed(1)} ${MARKER_BAND_TOP} L ${x.toFixed(1)} ${MARKER_BAND_BOTTOM} Z`;
  const percentLabel = (usedPercent: number | null): string => (usedPercent === null ? 'Unknown' : fmtPct(usedPercent));
  const heldClause = (): string =>
    series.carriedIn
      ? ` · held at ${percentLabel(series.carriedIn.usedPercent)} since ${fmtDate(series.carriedIn.firstObservedAt)}`
      : '';
  const midpoint = $derived(new Date((Date.parse(window.from) + Date.parse(window.to)) / 2).toISOString());
  const boundaries = $derived(breakBoundaries());
</script>

<article class={panel}>
  <div class={row}>
    <strong>{series.label}</strong
    ><strong>{series.currentPercent === null ? 'Unknown' : fmtPct(series.currentPercent)}</strong>
  </div>
  <p class={muted}>{series.providerLabel} · {series.machineLabel ?? series.machineId}</p>
  <p class={muted}>
    {series.summary}
    · largest gap {largestGapLabel(series.largestGapMs)} · {series.sourceKey} ({series.sourceConfidence})
  </p>
  <svg aria-hidden="true" class={chart} data-quota-chart viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}>
    <title>{series.label} quota observation chart</title>
    <path
      d={`M ${CHART_LEFT} ${PLOT_TOP} H ${CHART_RIGHT} M ${CHART_LEFT} ${PLOT_MIDDLE} H ${CHART_RIGHT} M ${CHART_LEFT} ${PLOT_BOTTOM} H ${CHART_RIGHT}`}
      fill="none"
      stroke="currentColor"
      stroke-opacity="0.12"
    ></path>
    {#each boundaries as boundary (boundary.key)}
      <line
        data-break-reason={boundary.reason}
        data-quota-break-guide
        stroke="currentColor"
        stroke-dasharray="3 4"
        stroke-opacity="0.25"
        x1={boundary.x}
        x2={boundary.x}
        y1={PLOT_TOP}
        y2={PLOT_BOTTOM}
      ></line>
    {/each}
    {#if series.carriedIn}
      {@const heldY = seriesY(series.carriedIn.usedPercent)}
      <line
        data-quota-hold-line
        stroke="currentColor"
        stroke-dasharray="4 4"
        stroke-opacity="0.45"
        x1={CHART_LEFT}
        x2={seriesX(series.carriedIn.lastObservedAt)}
        y1={heldY}
        y2={heldY}
      ></line>
      <circle
        cx={CHART_LEFT}
        cy={heldY}
        data-quota-carried-in
        fill="none"
        r="3.5"
        stroke="currentColor"
        stroke-width="1.5"
      >
        <title>
          Held at {percentLabel(series.carriedIn.usedPercent)} since {fmtDate(series.carriedIn.firstObservedAt)}
        </title>
      </circle>
    {/if}
    {#each series.segments as _segment, segmentIndex}
      <path
        d={seriesPath(segmentIndex)}
        data-quota-series-path
        fill="none"
        stroke="currentColor"
        stroke-width="3"
      ></path>
    {/each}
    {#each series.points as point (`${point.windowId}:${point.firstObservedAt}`)}
      <circle
        cx={seriesX(point.firstObservedAt)}
        cy={seriesY(point.usedPercent)}
        data-quota-point
        fill="currentColor"
        r="3"
      ></circle>
    {/each}
    {#each boundaries as boundary (boundary.key)}
      <path
        d={markerPath(boundary.x)}
        data-break-reason={boundary.reason}
        data-quota-break-marker
        fill={boundary.reason === 'reset' ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.5"
      >
        <title>{boundary.label}</title>
      </path>
    {/each}
  </svg>
  <div class={axisRow} data-quota-axis>
    <span>{fmtDate(window.from)}</span>
    <span>{fmtDate(midpoint)}</span>
    <span>{fmtDate(window.to)}</span>
  </div>
  <p class={muted} data-quota-series-footer>
    Latest observation {fmtDate(series.lastObservedAt)}{heldClause()}
    · Next reset
    {series.nextResetAt ? fmtDate(series.nextResetAt) : 'unknown'}
  </p>
  <div class={tableWrap}>
    <table class={table}>
      <caption class={srOnly}>
        {series.label}
        quota observations
      </caption>
      <thead>
        <tr>
          <th class={tableCell}>Observed</th>
          <th class={tableCell}>Used</th>
          <th class={tableCell}>Reset</th>
          <th class={tableCell}>Source</th>
        </tr>
      </thead>
      <tbody>
        {#if series.carriedIn}
          <tr data-quota-carried-in-row>
            <td class={tableCell}>held since {fmtDate(series.carriedIn.firstObservedAt)}</td>
            <td class={tableCell}>{percentLabel(series.carriedIn.usedPercent)}</td>
            <td class={tableCell}>Reset {series.carriedIn.resetAt ? fmtDate(series.carriedIn.resetAt) : 'unknown'}</td>
            <td class={tableCell}>{series.carriedIn.source.key} ({series.carriedIn.source.confidence})</td>
          </tr>
        {/if}
        {#each series.points as point (`${point.windowId}:${point.firstObservedAt}`)}
          <tr>
            <td class={tableCell}>{fmtDate(point.firstObservedAt)}</td>
            <td class={tableCell}>{percentLabel(point.usedPercent)}</td>
            <td class={tableCell}>Reset {point.resetAt ? fmtDate(point.resetAt) : 'unknown'}</td>
            <td class={tableCell}>{point.source.key} ({point.source.confidence})</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</article>
