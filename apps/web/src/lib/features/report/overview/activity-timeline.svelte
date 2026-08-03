<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const chart = css({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '8px', minW: 0 });
  const plot = css({
    display: 'grid',
    alignItems: 'end',
    minH: '150px',
    p: '8px 4px 0',
    borderBottom: '1px solid token(colors.line)',
    cursor: 'crosshair',
  });
  const bucketClass = css({ display: 'flex', flexDirection: 'column-reverse', h: '140px', minW: 0 });
  const segment = css({ minH: '1px', bg: 'accent', borderTop: '1px solid token(colors.surface)' });
  const unclassified = css({ minH: '1px', bg: 'muted', opacity: 0.55, borderTop: '1px solid token(colors.surface)' });
  const tickRow = css({
    display: 'grid',
    minH: '18px',
    overflow: 'hidden',
    color: 'muted',
    fontSize: '10px',
  });
  const tick = css({ textAlign: 'center', overflow: 'visible', whiteSpace: 'nowrap' });
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
  const swatch = css({ display: 'inline-block', w: '9px', h: '9px', borderRadius: 'sm', bg: 'accent' });
  const gapSwatch = css({
    display: 'inline-block',
    w: '9px',
    h: '9px',
    borderRadius: 'sm',
    bg: 'muted',
    opacity: 0.55,
  });
  const percentage = css({ color: 'muted', textStyle: 'numeric' });
  const readout = css({ display: 'grid', gap: '5px', p: '9px', borderRadius: 'md', bg: 'track', fontSize: '11px' });
  const readoutRow = css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px' });
  const empty = css({ display: 'grid', placeItems: 'center', minH: '150px', color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import { stableSeriesColor } from '@ai-usage/design-system/svelte';
  import type { FocusedTimelineData, FocusedTimelineSeries } from '@ai-usage/report-core/focused-report-query';
  import { onMount } from 'svelte';
  import type { TimelineValue } from '../../../../overview-model';
  import { fmtDateOnly, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import { aggregateApiPriceProvenance } from '../../../foundation/presentation/report-value';
  import {
    type CampaignSeriesPresenter,
    type MachineSeriesPresenter,
    presentTimelineSeries,
    retainTimelineTickLabels,
    timelineBucketValue,
    timelineEntryValue,
    timelineGapValue,
    timelineReadoutFor,
    timelineSeriesIsFilterable,
    timelineSeriesValue,
    timelineSharePercent,
    timelineTickIndexes,
    timelineUsesSessions,
  } from './timeline-model';
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
  const maxBucket = $derived(
    timeline ? Math.max(1, useSessions ? timeline.maxBucketSessions : timeline.maxBucketTotal) : 1,
  );
  const tickIndexes = $derived(timeline ? timelineTickIndexes(timeline.buckets.length) : []);
  const readoutData = $derived(
    timeline && inspectedIndex !== null ? timelineReadoutFor(timeline, value, inspectedIndex, presentedSeries) : null,
  );

  const bucketTotal = (bucket: FocusedTimelineData['buckets'][number]): number =>
    timelineBucketValue(bucket, useSessions);
  const amountFor = (entry: { cost: number; sessions: number }): number => timelineEntryValue(entry, useSessions);
  const heightFor = (bucket: FocusedTimelineData['buckets'][number], amount: number): number => {
    if (value === 'share') {
      return timelineSharePercent(amount, bucketTotal(bucket));
    }
    return (amount / maxBucket) * 100;
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
  const inspectFromPointer = (event: MouseEvent): void => {
    if (!timeline) {
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (box.width <= 0) {
      return;
    }
    const index = Math.min(
      timeline.buckets.length - 1,
      Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * timeline.buckets.length)),
    );
    inspect(index);
  };
  const onChartKeydown = (event: KeyboardEvent): void => {
    if (!timeline) {
      return;
    }
    const current = inspectedIndex ?? 0;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = Math.max(0, current - 1);
    } else if (event.key === 'ArrowRight') {
      next = Math.min(timeline.buckets.length - 1, current + 1);
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = timeline.buckets.length - 1;
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

  onMount(() => {
    measureTickCollisions();
    const observer = new ResizeObserver(measureTickCollisions);
    if (tickRowElement) {
      observer.observe(tickRowElement);
    }
    return () => observer.disconnect();
  });

  const pressedAria = (pressed: boolean): { readonly 'aria-pressed': 'false' | 'true' } => ({
    'aria-pressed': pressed ? 'true' : 'false',
  });

  const seriesFreshness = (series: FocusedTimelineSeries): string | undefined =>
    timeline?.dimension === 'machine' ? machinePresenter(series.key, series.label).freshness : undefined;
</script>

<div class={chart} data-report-range-part="chart">
  {#if timeline && timeline.buckets.length > 0}
    <button
      aria-label="Inspect activity timeline. Use arrow keys to inspect days."
      class={plot}
      data-bucket-index={inspectedIndex ?? 0}
      onfocus={() => inspect(inspectedIndex ?? 0)}
      onkeydown={onChartKeydown}
      onmousemove={inspectFromPointer}
      type="button"
      style:grid-template-columns={`repeat(${timeline.buckets.length}, minmax(4px, 1fr))`}
    >
      {#each timeline.buckets as bucket, index (bucket.date)}
        <span
          aria-label={`${fmtDateOnly(bucket.date)} · ${formattedAmount(bucketTotal(bucket), bucketTotal(bucket))}`}
          class={bucketClass}
          role="img"
        >
          {#each presentedSeries as series (series.key)}
            {@const entry = bucket.byKey[series.key]}
            {#if entry}
              <span
                class={segment}
                data-series-key={series.key}
                title={`${series.label}: ${formattedAmount(amountFor(entry), bucketTotal(bucket))}`}
                style:background={stableSeriesColor(series.key)}
                style:height={`${heightFor(bucket, amountFor(entry))}%`}
                style:opacity={hoveredKey === null || hoveredKey === series.key ? 1 : 0.26}
              ></span>
            {/if}
          {/each}
          {#if bucket.unclassified}
            <span
              class={unclassified}
              data-series-key="unclassified"
              title={originGapDescription(bucket.unclassified)}
              style:height={`${heightFor(bucket, timelineGapValue(bucket.unclassified, useSessions))}%`}
            ></span>
          {/if}
        </span>
      {/each}
    </button>
    <div
      class={tickRow}
      data-report-range-part="chart-axis"
      data-timeline-tick-row
      bind:this={tickRowElement}
      style:grid-template-columns={`repeat(${timeline.buckets.length}, minmax(0, 1fr))`}
    >
      {#each timeline.buckets as bucket, index (bucket.date)}
        {@const tickId = `tick:${index}`}
        <span
          class={tick}
          data-timeline-label-id={tickId}
          data-timeline-tick={tickIndexes.includes(index) ? '' : undefined}
          style:visibility={tickIndexes.includes(index) && retainedTickIds?.has(tickId) !== false ? undefined : 'hidden'}
          >{fmtDateOnly(bucket.date)}</span
        >
      {/each}
    </div>
    <div class={boundaries} data-timeline-boundary-row bind:this={boundaryRowElement}>
      <span data-timeline-boundary data-timeline-label-id="from">{fmtDateOnly(timeline.first)}</span>
      <span data-timeline-boundary data-timeline-label-id="to">{fmtDateOnly(timeline.last)}</span>
    </div>
    <ul aria-label={`${timeline.dimension} timeline legend`} class={legend}>
      {#each presentedSeries as series (series.key)}
        {@const total = timelineSeriesValue(series, useSessions)}
        {@const active = activeSeriesKeys.includes(series.key)}
        {@const filterable = timelineSeriesIsFilterable(timeline.dimension, series)}
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
            <span aria-hidden="true" class={swatch} style:background={stableSeriesColor(series.key)}></span>
            {series.label}
            <span class={percentage}
              >{fmtPct(timelineSharePercent(total, useSessions ? timeline.grandSessions : timeline.grandTotal))}</span
            >
          </button>
        </li>
      {/each}
      {#if timeline.unclassified}
        <li class={legendButton} title={originGapDescription(timeline.unclassified)}>
          <span aria-hidden="true" class={gapSwatch}></span>Not classified
          <span class={percentage}
            >{fmtPct(timelineSharePercent(timelineGapValue(timeline.unclassified, useSessions), useSessions ? timeline.grandSessions : timeline.grandTotal))}</span
          >
        </li>
      {/if}
    </ul>
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
