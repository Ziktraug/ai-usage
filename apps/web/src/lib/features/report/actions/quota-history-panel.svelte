<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { Drawer } from '@ai-usage/design-system/svelte';
  import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
  import {
    buildProviderQuotaHistoryModel,
    type ProviderQuotaHistoryRange,
    type ProviderQuotaHistorySeries,
    providerQuotaHistoryWindow,
  } from '../../../../provider-quota-history-model';
  import { fmtDate, fmtPct } from '../../../foundation/presentation/format';
  import { button, field, list, muted, panel, row, stack, table, tableCell, title } from '../breakdown/styles';

  // A 600-unit viewBox stretched non-uniformly into a 440 px drawer rendered every glyph at ~0.63
  // horizontal scale. Scaling the box uniformly keeps the marks round and moves the words to HTML.
  const chart = css({
    w: 'full',
    h: 'auto',
    aspectRatio: '3 / 1',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
  });
  const axisRow = css({ display: 'flex', justifyContent: 'space-between', color: 'muted', fontSize: '11px' });
  const rangeControls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', border: 0, m: 0, p: 0 });
  // `Drawer` styles its content with `drawerClass` only — `drawerBody`, which forces descendant
  // controls to 44 px, is never applied here. Without this the buttons sit at their 32 px minimum
  // beside 36 px selects, so the height has to be stated: it tracks `field`'s own responsive height.
  const rangeButton = css({ minW: '56px', minH: { base: '44px', sm: '36px' } });
  const selectedRange = css({ borderColor: 'accent', bg: 'accentTint', color: 'accent' });
  const historyControl = css({ display: 'grid', gap: '4px', fontSize: '12px' });
  const historySelect = cx(field, css({ w: '168px', minW: '168px' }));

  const tableWrap = css({ overflowX: 'auto' });
  const srOnly = css({ srOnly: true });
  const historyRanges = ['24h', '7d', '30d'] as const satisfies readonly ProviderQuotaHistoryRange[];
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

  let {
    errorMessage = null,
    loading,
    onClose,
    onRangeChange,
    open,
    range,
    result,
  }: {
    errorMessage?: string | null;
    loading: boolean;
    onClose: () => void;
    onRangeChange: (range: ProviderQuotaHistoryRange) => void;
    open: boolean;
    range: ProviderQuotaHistoryRange;
    result: ProviderQuotaHistoryResult | null;
  } = $props();

  let closeButton: HTMLButtonElement | undefined;
  let previousFocus: HTMLElement | null = $state(null);
  let wasOpen = false;
  $effect.pre(() => {
    if (open && !wasOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpen = open;
  });
  // The window ends at the result's `generatedAt` — the server's own query time — rather than at the
  // owner's request clock, so the drawn axis matches the observations the server actually answered with.
  const historyWindow = $derived(result ? providerQuotaHistoryWindow(range, result.generatedAt) : null);
  const model = $derived(result && historyWindow ? buildProviderQuotaHistoryModel(result, historyWindow) : null);
  const changeRange = (value: string): void => {
    if (value === '24h' || value === '7d' || value === '30d') {
      onRangeChange(value);
    }
  };
  const pressedAria = (item: ProviderQuotaHistoryRange) =>
    ({ 'aria-pressed': range === item ? 'true' : 'false' }) as const;
  const providers = $derived([...new Set(model?.series.map(({ providerKey }) => providerKey) ?? [])]);
  const machines = $derived([...new Set(model?.series.map(({ machineId }) => machineId) ?? [])]);
  const accounts = $derived([...new Set(model?.series.map(({ accountScope }) => accountScope ?? 'unknown') ?? [])]);
  let provider = $state('');
  let machine = $state('');
  let account = $state('');
  const visibleSeries = $derived(
    model?.series.filter(
      (series) =>
        (!provider || series.providerKey === provider) &&
        (!machine || series.machineId === machine) &&
        (!account || (series.accountScope ?? 'unknown') === account),
    ) ?? [],
  );
  const resetFilters = (): void => {
    provider = '';
    machine = '';
    account = '';
  };
  const largestGapLabel = (milliseconds: number): string => {
    const minutes = Math.round(milliseconds / MILLISECONDS_PER_MINUTE);
    return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${(minutes / MINUTES_PER_HOUR).toFixed(1)}h`;
  };
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const seriesX = (observedAt: string): number => {
    const bounds = model?.window;
    if (!bounds) {
      return CHART_LEFT;
    }
    const from = Date.parse(bounds.from);
    const span = Math.max(1, Date.parse(bounds.to) - from);
    return CHART_LEFT + clamp01((Date.parse(observedAt) - from) / span) * CHART_PLOT_WIDTH;
  };
  const seriesY = (usedPercent: number | null): number =>
    PLOT_BOTTOM - ((usedPercent ?? 0) / FULL_PERCENT) * CHART_PLOT_HEIGHT;
  const seriesPath = (series: ProviderQuotaHistorySeries, segmentIndex: number): string => {
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
  const breakBoundaries = (series: ProviderQuotaHistorySeries): QuotaBreakBoundary[] =>
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
  const heldClause = (series: ProviderQuotaHistorySeries): string =>
    series.carriedIn
      ? ` · held at ${percentLabel(series.carriedIn.usedPercent)} since ${fmtDate(series.carriedIn.firstObservedAt)}`
      : '';
  const midpointOf = (from: string, to: string): string =>
    new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString();
</script>

<Drawer
  contentAriaLabel="Provider quota history"
  finalFocusEl={() => (previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : null)}
  initialFocusEl={() => closeButton ?? null}
  modal
  onOpenChange={(nextOpen) => {
    if (!nextOpen) {
      onClose();
    }
  }}
  {open}
  trapFocus
>
  <div
    class={stack}
    data-quota-history
    data-quota-window-from={model?.window.from}
    data-quota-window-to={model?.window.to}
  >
    <header class={row}>
      <div>
        <h2 class={title}>Provider quota history</h2>
        <p class={muted}>Provider-defined quota observations retained on this machine.</p>
      </div>
      <button
        aria-label="Close provider quota history"
        class={button}
        onclick={onClose}
        type="button"
        bind:this={closeButton}
      >
        ✕
      </button>
    </header>
    {#if errorMessage}
      <div class={panel} role="status">{errorMessage}</div>
    {/if}
    <div class={row}>
      <fieldset class={rangeControls}>
        <legend>History range</legend>
        {#each historyRanges as item (item)}
          <button
            {...pressedAria(item)}
            class={[button, rangeButton, range === item ? selectedRange : undefined]}
            onclick={() => changeRange(item)}
            type="button"
          >
            {item}
          </button>
        {/each}
      </fieldset>
      <label class={historyControl}
        >Provider
        <select class={historySelect} bind:value={provider}>
          <option value="">All</option>
          {#each providers as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label class={historyControl}
        >Machine
        <select class={historySelect} bind:value={machine}>
          <option value="">All</option>
          {#each machines as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label class={historyControl}
        >Account scope
        <select class={historySelect} bind:value={account}>
          <option value="">All</option>
          {#each accounts as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <button class={button} onclick={resetFilters} type="button">Reset filters</button>
    </div>
    {#if loading}
      <div role="status">Loading quota history…</div>
    {/if}
    {#if !loading && model?.emptyMessage}
      <div>{model.emptyMessage}</div>
    {/if}
    {#if model?.partial}
      <div class={panel}>History is partial or contains skipped corrupt observations.</div>
    {/if}
    {#if visibleSeries.length > 0}
      <p class={muted} data-quota-legend>▼ reset boundary · ▽ collection gap · ○ held from before the window</p>
    {/if}
    <div class={list}>
      {#each visibleSeries as series (series.key)}
        {@const boundaries = breakBoundaries(series)}
        {@const bounds = model?.window}
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
                  Held at {percentLabel(series.carriedIn.usedPercent)} since
                  {fmtDate(
                    series.carriedIn.firstObservedAt,
                  )}
                </title>
              </circle>
            {/if}
            {#each series.segments as _segment, segmentIndex}
              <path
                d={seriesPath(series, segmentIndex)}
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
          {#if bounds}
            <div class={axisRow} data-quota-axis>
              <span>{fmtDate(bounds.from)}</span>
              <span>{fmtDate(midpointOf(bounds.from, bounds.to))}</span>
              <span>{fmtDate(bounds.to)}</span>
            </div>
          {/if}
          <p class={muted} data-quota-series-footer>
            Latest observation {fmtDate(series.lastObservedAt)}{heldClause(series)}
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
                    <td class={tableCell}>
                      Reset {series.carriedIn.resetAt ? fmtDate(series.carriedIn.resetAt) : 'unknown'}
                    </td>
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
      {/each}
    </div>
  </div>
</Drawer>
