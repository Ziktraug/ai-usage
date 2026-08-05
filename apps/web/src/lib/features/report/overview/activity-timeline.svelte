<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const chart = css({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '8px', minW: 0 });
  const plot = css({
    position: 'relative',
    display: 'block',
    minH: '150px',
    // A dense window must never escape the panel, whatever the bucket count.
    overflow: 'hidden',
    // 8px horizontal inset matches the hover overlay and the crosshair correction.
    p: '8px 8px 0',
    borderBottom: '1px solid token(colors.line)',
  });
  // Flex, not a `repeat(N, minmax(4px, 1fr))` grid: a minmax floor multiplies
  // into a minimum width the container cannot honour, so 249 day buckets pushed
  // the bars about a thousand pixels past the panel. Flex items shrink instead,
  // and `timelineBucketLayout` caps the per-bucket minimum at its fair share.
  const seriesStack = css({
    display: 'flex',
    alignItems: 'flex-end',
    w: 'full',
    h: '140px',
    minW: 0,
    // Marks only; the hover overlay above owns pointer input.
    pointerEvents: 'none',
  });
  const bucketClass = css({ display: 'flex', flex: '1 1 0', flexDirection: 'column-reverse', h: '140px', minW: 0 });
  const gapBands = css({
    position: 'absolute',
    insetInline: '4px',
    bottom: '1px',
    display: 'flex',
    h: '6px',
    minW: 0,
    pointerEvents: 'none',
  });
  const gapBand = css({
    flex: '1 1 0',
    minW: 0,
    border: '1px solid token(colors.lineStrong)',
    borderRadius: '1px',
    bg: 'surfaceMuted',
    backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 2px, token(colors.lineStrong) 2px 3px)',
  });
  const gapEmpty = css({ flex: '1 1 0', minW: 0 });
  // No `bg` here: the series swatch owns the fill, and a base `bg` atom would
  // race it on stylesheet order rather than losing to it.
  const segment = css({ minH: '1px', borderTop: '1px solid token(colors.surface)' });
  const tickRow = css({
    position: 'relative',
    minH: '18px',
    overflow: 'hidden',
    color: 'muted',
    fontSize: '10px',
  });
  const tick = css({ position: 'absolute', top: 0, transform: 'translateX(-50%)', whiteSpace: 'nowrap' });
  const boundaries = css({ display: 'flex', justifyContent: 'space-between', color: 'muted', fontSize: '11px' });
  const legend = css({ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', mt: '4px' });
  const legendButton = css({
    display: 'inline-flex',
    gap: '6px',
    alignItems: 'center',
    p: '3px 5px',
    borderRadius: 'sm',
    fontSize: '11px',
    _hover: { bg: 'track' },
    _disabled: { cursor: 'default', opacity: 0.8 },
  });
  const swatch = css({ display: 'inline-block', w: '9px', h: '9px', borderRadius: 'sm' });
  const gapSwatch = css({
    display: 'inline-block',
    w: '9px',
    h: '9px',
    borderRadius: 'sm',
    bg: 'muted',
    opacity: 0.55,
  });
  const percentage = css({ color: 'muted', textStyle: 'numeric' });
  const rangeTotal = css({ fontWeight: 600, textStyle: 'numeric', mr: '4px' });
  const readout = css({ display: 'grid', gap: '5px', p: '9px', borderRadius: 'md', bg: 'track', fontSize: '11px' });
  const readoutRow = css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px' });
  const empty = css({ display: 'grid', placeItems: 'center', minH: '150px', color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    accentFill,
    type DimensionSwatch,
    dimensionSwatch,
    migrationCrosshair,
    monthGridline,
    timelineHoverLayer,
  } from '@ai-usage/design-system/svelte';
  import type { FocusedTimelineData, FocusedTimelineSeries } from '@ai-usage/report-core/focused-report-query';
  import { tick as afterDomUpdate, onMount } from 'svelte';
  import type { TimelineValue } from '../../../../overview-model';
  import type { TimeRangeIndexRange } from '../../../../time-range-control-state';
  import { fmtDateOnly, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import { aggregateApiPriceProvenance } from '../../../foundation/presentation/report-value';
  import {
    type CampaignSeriesPresenter,
    type MachineSeriesPresenter,
    presentTimelineSeries,
    retainTimelineTickLabels,
    timelineGapValue,
    timelineReadoutFor,
    timelineSeriesIsFilterable,
    timelineSharePercent,
    timelineUsesSessions,
  } from './timeline-model';
  import {
    timelineBucketCenterPercent,
    timelineBucketLayout,
    timelineMonthTickId,
    timelinePlotLeft,
    visibleTimelineBars,
    visibleTimelineBounds,
    visibleTimelineMaximum,
    visibleTimelineMonthTicks,
    visibleTimelineSummary,
  } from './timeline-window';
  import { originGapDescription } from './view-model';

  interface Props {
    activeSeriesKeys?: readonly string[];
    machineFreshnessStatus?: string | null;
    onDimensionFilter?: (dimension: FocusedTimelineData['dimension'], key: string) => void;
    onInspect?: (index: number) => void;
    presentCampaignSeries?: CampaignSeriesPresenter;
    presentMachineSeries?: MachineSeriesPresenter;
    timeline: FocusedTimelineData | null;
    value: TimelineValue;
    /** Bucket indexes the report range selects; the whole domain when absent. */
    visibleRange?: TimeRangeIndexRange | null;
  }

  const unchangedCampaignSeries: CampaignSeriesPresenter = (series) => series;
  const unchangedMachineSeries: MachineSeriesPresenter = (_key, label) => ({ freshness: 'unavailable', label });

  let {
    activeSeriesKeys = [],
    machineFreshnessStatus = null,
    onDimensionFilter = () => undefined,
    onInspect = () => undefined,
    presentCampaignSeries: campaignPresenter = unchangedCampaignSeries,
    presentMachineSeries: machinePresenter = unchangedMachineSeries,
    timeline,
    value,
    visibleRange = null,
  }: Props = $props();

  let inspectedIndex = $state<number | null>(null);
  let hoveredKey = $state<string | null>(null);
  let retainedTickIds = $state<ReadonlySet<string> | null>(null);
  let tickRowElement: HTMLDivElement | undefined = $state();
  let boundaryRowElement: HTMLDivElement | undefined = $state();
  const presentedSeries = $derived(
    timeline ? presentTimelineSeries(timeline, campaignPresenter, machinePresenter) : [],
  );
  const useSessions = $derived(timeline ? timelineUsesSessions(timeline, value) : value === 'sessions');
  // The report range owns which buckets are on screen. Everything downstream —
  // scale, ticks, boundary dates, pointer hit-testing — reads this one window.
  const visibleWindow = $derived<TimeRangeIndexRange>(
    timeline ? (visibleRange ?? { from: 0, to: Math.max(0, timeline.buckets.length - 1) }) : { from: 0, to: 0 },
  );
  const bars = $derived(timeline ? visibleTimelineBars(timeline, visibleWindow, useSessions) : []);
  const layout = $derived(timelineBucketLayout(bars.length));
  // Scale against the tallest bucket inside the window, so narrowing the range
  // rescales the chart instead of flattening it against a domain-wide peak.
  const windowMaximum = $derived(
    timeline ? Math.max(1, visibleTimelineMaximum(timeline, visibleWindow, useSessions)) : 1,
  );
  const summary = $derived(
    timeline
      ? visibleTimelineSummary(timeline, visibleWindow, useSessions)
      : { gap: 0, total: 0, totalsByKey: new Map<string, number>() },
  );
  // A series carrying nothing in the window is noise, but an active filter must
  // stay visible so it can be cleared.
  const legendSeries = $derived(
    presentedSeries.filter(
      (series) => (summary.totalsByKey.get(series.key) ?? 0) > 0 || activeSeriesKeys.includes(series.key),
    ),
  );
  const monthTicks = $derived(timeline ? visibleTimelineMonthTicks(timeline, visibleWindow) : []);
  const bounds = $derived(timeline ? visibleTimelineBounds(timeline, visibleWindow) : { first: '', last: '' });
  const tickMeasurementRevision = $derived(monthTicks.map(timelineMonthTickId).join('|'));
  const readoutData = $derived(
    timeline && inspectedIndex !== null ? timelineReadoutFor(timeline, value, inspectedIndex, presentedSeries) : null,
  );

  const heightFor = (barTotal: number, amount: number): number => {
    if (value === 'share') {
      return timelineSharePercent(amount, barTotal);
    }
    return (amount / windowMaximum) * 100;
  };
  const formattedAmount = (amount: number, total: number): string => {
    if (value === 'share') {
      return fmtPct(timelineSharePercent(amount, total));
    }
    return useSessions ? fmtNum(amount) : fmtMoney(amount);
  };
  const inspect = (index: number): void => {
    inspectedIndex = index;
    onInspect(index);
  };
  // Pointer and keyboard address the buckets actually drawn, so inspection can
  // never land on a day the report range excluded.
  const inspectFromPointer = (event: MouseEvent): void => {
    if (bars.length === 0) {
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (box.width <= 0) {
      return;
    }
    const offset = Math.min(
      bars.length - 1,
      Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * bars.length)),
    );
    const bar = bars[offset];
    if (bar) {
      inspect(bar.index);
    }
  };
  const onChartKeydown = (event: KeyboardEvent): void => {
    if (bars.length === 0) {
      return;
    }
    const firstIndex = bars[0]?.index ?? 0;
    const lastIndex = bars.at(-1)?.index ?? firstIndex;
    const current = inspectedIndex ?? firstIndex;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = Math.max(firstIndex, current - 1);
    } else if (event.key === 'ArrowRight') {
      next = Math.min(lastIndex, current + 1);
    } else if (event.key === 'Home') {
      next = firstIndex;
    } else if (event.key === 'End') {
      next = lastIndex;
    }
    if (next !== null) {
      event.preventDefault();
      inspect(next);
    }
  };
  const labelBoxes = (root: HTMLElement | undefined, selector: string) =>
    root
      ? [...root.querySelectorAll<HTMLElement>(selector)].map((element) => {
          const box = element.getBoundingClientRect();
          return { id: element.dataset.timelineLabelId ?? '', left: box.left, right: box.right };
        })
      : [];
  const measureTickCollisions = (): void => {
    const ticks = labelBoxes(tickRowElement, '[data-timeline-tick]');
    const boundaries = labelBoxes(boundaryRowElement, '[data-timeline-boundary]');
    retainedTickIds = new Set(retainTimelineTickLabels(ticks, boundaries).map(({ id }) => id));
  };
  $effect(() => {
    if (!tickMeasurementRevision) {
      retainedTickIds = null;
      return;
    }

    retainedTickIds = null;
    let cancelled = false;
    afterDomUpdate().then(() => {
      if (!cancelled) {
        measureTickCollisions();
      }
    });
    return () => {
      cancelled = true;
    };
  });

  onMount(() => {
    let disposed = false;
    const frame = requestAnimationFrame(measureTickCollisions);
    document.fonts.ready.then(() => {
      if (!disposed) {
        measureTickCollisions();
      }
    });
    const observer = new ResizeObserver(measureTickCollisions);
    if (tickRowElement) {
      observer.observe(tickRowElement);
    }
    if (boundaryRowElement) {
      observer.observe(boundaryRowElement);
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  const pressedAria = (pressed: boolean): { readonly 'aria-pressed': 'false' | 'true' } => ({
    'aria-pressed': pressed ? 'true' : 'false',
  });

  const seriesFreshness = (series: FocusedTimelineSeries): string | undefined =>
    timeline?.dimension === 'machine' ? machinePresenter(series.key, series.label).freshness : undefined;

  // Harness and model series carry branded semantic tokens; only the open-ended
  // dimensions fall back to a hash-derived hue. Calling the hash directly for
  // every dimension collapsed Codex and OpenCode onto neighbouring tans.
  const swatchFor = (key: string): DimensionSwatch => (timeline ? dimensionSwatch(timeline.dimension, key) : {});
</script>

<div class={chart} data-timeline-labels-settled={retainedTickIds === null ? 'false' : 'true'}>
  {#if timeline && timeline.buckets.length > 0}
    <ul aria-label={`${timeline.dimension} timeline legend`} class={legend} data-report-range-part="total-legend">
      <li class={rangeTotal} data-report-range-total>{formattedAmount(summary.total, summary.total)}</li>
      {#each legendSeries as series (series.key)}
        {@const total = summary.totalsByKey.get(series.key) ?? 0}
        {@const active = activeSeriesKeys.includes(series.key)}
        {@const filterable = timelineSeriesIsFilterable(timeline.dimension, series)}
        {@const marker = swatchFor(series.key)}
        <li>
          <button
            {...pressedAria(active)}
            class={legendButton}
            data-active={active ? 'true' : 'false'}
            data-machine-freshness={seriesFreshness(series)}
            data-series-key={series.key}
            disabled={!filterable}
            onclick={() => filterable && onDimensionFilter(timeline.dimension, series.key)}
            onmouseenter={() => (hoveredKey = series.key)}
            onmouseleave={() => (hoveredKey = null)}
            title={filterable ? `${active ? 'Clear or replace' : 'Filter by'} ${series.label}` : series.label}
            type="button"
          >
            <span
              aria-hidden="true"
              class={cx(swatch, marker.className ?? accentFill)}
              style:background={marker.style?.background}
            ></span>
            {series.label}
            <span class={percentage}>{fmtPct(timelineSharePercent(total, summary.total))}</span>
          </button>
        </li>
      {/each}
      {#if timeline.unclassified && summary.gap > 0}
        <li class={legendButton} data-origin-unclassified-legend title={originGapDescription(timeline.unclassified)}>
          <span aria-hidden="true" class={gapSwatch}></span>Not classified
          <span class={percentage}>{fmtPct(timelineSharePercent(summary.gap, summary.total))}</span>
        </li>
      {/if}
    </ul>
    <div class={plot} data-bucket-index={inspectedIndex ?? 0} data-report-range-part="chart">
      {#each monthTicks as monthTick (timelineMonthTickId(monthTick))}
        <span
          aria-hidden="true"
          class={monthGridline}
          data-month-gridline
          style:left={timelinePlotLeft(monthTick.pct)}
        ></span>
      {/each}
      <span
        class={seriesStack}
        data-origin-series-stack={timeline.dimension === 'origin' ? '' : undefined}
        style:gap={layout.bucketGap}
      >
        {#each bars as bar (bar.bucket.date)}
          <span
            aria-label={`${fmtDateOnly(bar.bucket.date)} · ${formattedAmount(bar.total, bar.total)}`}
            class={bucketClass}
            role="img"
            style:min-width={layout.bucketMinWidth}
          >
            {#each bar.segments as segmentEntry (segmentEntry.key)}
              {@const marker = swatchFor(segmentEntry.key)}
              <span
                class={cx(segment, marker.className ?? accentFill)}
                data-series-key={segmentEntry.key}
                style:background={marker.style?.background}
                style:height={`${heightFor(bar.total, segmentEntry.value)}%`}
                style:opacity={hoveredKey === null || hoveredKey === segmentEntry.key ? 1 : 0.26}
              ></span>
            {/each}
          </span>
        {/each}
      </span>
      {#if timeline.dimension === 'origin' && timeline.unclassified}
        <span aria-hidden="true" class={gapBands} data-origin-unclassified-band style:gap={layout.bucketGap}>
          {#each bars as bar (bar.bucket.date)}
            {#if bar.bucket.unclassified}
              <span
                class={gapBand}
                data-origin-gap-sessions={bar.bucket.unclassified.sessions}
                title={originGapDescription(bar.bucket.unclassified)}
                style:min-width={layout.bucketMinWidth}
              ></span>
            {:else}
              <span class={gapEmpty} style:min-width={layout.bucketMinWidth}></span>
            {/if}
          {/each}
        </span>
      {/if}
      <!-- Inspection lives on its own transparent overlay so the bars stay
      non-interactive marks and the crosshair can sit above them. -->
      <button
        aria-label="Inspect activity timeline. Use arrow keys to inspect days."
        class={timelineHoverLayer}
        onfocus={() => inspect(inspectedIndex ?? (bars[0]?.index ?? 0))}
        onkeydown={onChartKeydown}
        onmouseleave={() => (inspectedIndex = null)}
        onmousemove={inspectFromPointer}
        title="Inspect activity in the selected report range"
        type="button"
      ></button>
      {#if inspectedIndex !== null}
        <span
          aria-hidden="true"
          class={migrationCrosshair}
          data-timeline-crosshair
          style:left={timelinePlotLeft(timelineBucketCenterPercent(inspectedIndex - visibleWindow.from, bars.length))}
        ></span>
      {/if}
    </div>
    <div class={tickRow} data-report-range-part="chart-axis" data-timeline-tick-row bind:this={tickRowElement}>
      {#each monthTicks as monthTick (timelineMonthTickId(monthTick))}
        {@const tickId = timelineMonthTickId(monthTick)}
        <span
          class={tick}
          data-timeline-label-id={tickId}
          data-timeline-tick
          style:left={`${monthTick.pct}%`}
          style:visibility={retainedTickIds?.has(tickId) === false ? 'hidden' : undefined}
          >{monthTick.label}</span
        >
      {/each}
    </div>
    <div class={boundaries} data-timeline-boundary-row bind:this={boundaryRowElement}>
      <span data-timeline-boundary data-timeline-label-id="from">{fmtDateOnly(bounds.first)}</span>
      <span data-timeline-boundary data-timeline-label-id="to">{fmtDateOnly(bounds.last)}</span>
    </div>

    {#if timeline.dimension === 'machine' && machineFreshnessStatus}
      <p class={percentage} data-machine-freshness-status>{machineFreshnessStatus}</p>
    {/if}
    {#if readoutData}
      <div aria-live="polite" class={readout} data-timeline-readout role="status">
        <div class={readoutRow}>
          <strong>{fmtDateOnly(readoutData.bucket.date)}</strong>
          <span>{formattedAmount(readoutData.total, readoutData.total)}</span>
          {#if !readoutData.useSessions && aggregateApiPriceProvenance(readoutData.bucket.priceMeasurement)}
            {@const provenance = aggregateApiPriceProvenance(readoutData.bucket.priceMeasurement)}
            <span title={provenance?.description}>{provenance?.label}</span>
          {/if}
        </div>
        {#each readoutData.rows as row (row.key)}
          <div class={readoutRow} data-active={hoveredKey === row.key ? 'true' : 'false'}>
            <span>{row.label}</span>
            <span
              >{formattedAmount(row.value, readoutData.total)}
              · {fmtPct(timelineSharePercent(row.value, readoutData.total))}</span
            >
          </div>
        {/each}
        {#if readoutData.bucket.unclassified}
          <div class={readoutRow} title={originGapDescription(readoutData.bucket.unclassified)}>
            <span>Not classified</span>
            <span
              >{formattedAmount(timelineGapValue(readoutData.bucket.unclassified, readoutData.useSessions), readoutData.total)}</span
            >
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <p class={empty}>No dated sessions in range</p>
  {/if}
</div>
