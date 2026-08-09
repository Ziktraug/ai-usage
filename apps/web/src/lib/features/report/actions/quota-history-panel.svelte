<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { Drawer } from '@ai-usage/design-system/svelte';
  import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
  import {
    buildProviderQuotaHistoryModel,
    type ProviderQuotaHistoryRange,
    type ProviderQuotaHistorySeries,
  } from '../../../../provider-quota-history-model';
  import { fmtDate, fmtPct } from '../../../foundation/presentation/format';
  import { button, field, list, muted, panel, row, stack, table, tableCell, title } from '../breakdown/styles';

  const chart = css({
    w: 'full',
    h: '180px',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
  });
  const rangeControls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', border: 0, m: 0, p: 0 });
  const selectedRange = css({ borderColor: 'accent', bg: 'accentTint', color: 'accent' });

  const tableWrap = css({ overflowX: 'auto' });
  const srOnly = css({ srOnly: true });
  const historyRanges = ['24h', '7d', '30d'] as const satisfies readonly ProviderQuotaHistoryRange[];
  const MILLISECONDS_PER_MINUTE = 60_000;
  const MINUTES_PER_HOUR = 60;
  const CHART_WIDTH = 600;
  const CHART_HEIGHT = 180;
  const CHART_LEFT = 20;
  const CHART_RIGHT = 580;
  const CHART_TOP = 30;
  const CHART_MIDDLE = 90;
  const CHART_BOTTOM = 150;
  const CHART_PLOT_WIDTH = CHART_RIGHT - CHART_LEFT;
  const CHART_PLOT_HEIGHT = CHART_BOTTOM - CHART_TOP;
  const FULL_PERCENT = 100;
  const BREAK_LINE_TOP = 22;
  const BREAK_LINE_BOTTOM = 158;
  const BREAK_LABEL_OFFSET_X = 4;
  const BREAK_LABEL_Y = 18;

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
  const model = $derived(result ? buildProviderQuotaHistoryModel(result) : null);
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
  const seriesX = (series: ProviderQuotaHistorySeries, observedAt: string): number => {
    const firstTime = Date.parse(series.firstObservedAt);
    const duration = Math.max(1, Date.parse(series.lastObservedAt) - firstTime);
    return CHART_LEFT + ((Date.parse(observedAt) - firstTime) / duration) * CHART_PLOT_WIDTH;
  };
  const seriesY = (usedPercent: number | null): number =>
    CHART_BOTTOM - ((usedPercent ?? 0) / FULL_PERCENT) * CHART_PLOT_HEIGHT;
  const seriesPath = (series: ProviderQuotaHistorySeries, segmentIndex: number): string => {
    const segment = series.segments[segmentIndex];
    if (!segment?.points.length) {
      return '';
    }
    return segment.points
      .map((point, index) => {
        const x = seriesX(series, point.firstObservedAt).toFixed(1);
        const y = seriesY(point.usedPercent).toFixed(1);
        return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ');
  };
</script>

<Drawer
  contentAriaLabel="Codex quota history"
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
  <div class={stack} data-quota-history>
    <header class={row}>
      <div>
        <h2 class={title}>Codex quota history</h2>
        <p class={muted}>Provider-defined quota observations retained on this machine.</p>
      </div>
      <button
        aria-label="Close Codex quota history"
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
            class={[button, range === item ? selectedRange : undefined]}
            onclick={() => changeRange(item)}
            type="button"
          >
            {item}
          </button>
        {/each}
      </fieldset>
      <label
        >Provider
        <select class={field} bind:value={provider}>
          <option value="">All</option>
          {#each providers as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label
        >Machine
        <select class={field} bind:value={machine}>
          <option value="">All</option>
          {#each machines as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label
        >Account scope
        <select class={field} bind:value={account}>
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
    <div class={list}>
      {#each visibleSeries as series (series.key)}
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
          <svg
            aria-hidden="true"
            class={chart}
            preserveAspectRatio="none"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          >
            <title>{series.label} quota observation chart</title>
            <path
              d={`M ${CHART_LEFT} ${CHART_TOP} H ${CHART_RIGHT} M ${CHART_LEFT} ${CHART_MIDDLE} H ${CHART_RIGHT} M ${CHART_LEFT} ${CHART_BOTTOM} H ${CHART_RIGHT}`}
              fill="none"
              stroke="currentColor"
              stroke-opacity="0.12"
            ></path>
            {#each series.segments as _segment, segmentIndex}
              <path d={seriesPath(series, segmentIndex)} fill="none" stroke="currentColor" stroke-width="3"></path>
            {/each}
            {#each series.points as point (`${point.windowId}:${point.firstObservedAt}`)}
              <circle
                cx={seriesX(series, point.firstObservedAt)}
                cy={seriesY(point.usedPercent)}
                fill="currentColor"
                r="3"
              ></circle>
            {/each}
            {#each series.segments.filter(({ breakReason }) => breakReason !== null) as segment}
              {@const point = segment.points[0]}
              {#if point}
                {@const x = seriesX(series, point.firstObservedAt)}
                <line
                  stroke="currentColor"
                  stroke-dasharray="5 4"
                  x1={x}
                  x2={x}
                  y1={BREAK_LINE_TOP}
                  y2={BREAK_LINE_BOTTOM}
                ></line>
                <text font-size="11" x={x + BREAK_LABEL_OFFSET_X} y={BREAK_LABEL_Y}>{segment.breakReason}</text>
              {/if}
            {/each}
          </svg>
          <p class={muted}>
            First {fmtDate(series.firstObservedAt)} · Last {fmtDate(series.lastObservedAt)} · Next reset
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
                {#each series.points as point (`${point.windowId}:${point.firstObservedAt}`)}
                  <tr>
                    <td class={tableCell}>{fmtDate(point.firstObservedAt)}</td>
                    <td class={tableCell}>{point.usedPercent === null ? 'Unknown' : fmtPct(point.usedPercent)}</td>
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
