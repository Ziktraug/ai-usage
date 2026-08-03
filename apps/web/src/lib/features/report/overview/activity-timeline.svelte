<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const chart = css({ display: 'grid', gap: '8px', minW: 0 });
  const plot = css({
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(4px, 1fr)',
    alignItems: 'end',
    minH: '150px',
    p: '8px 4px 0',
    borderBottom: '1px solid token(colors.line)',
    cursor: 'crosshair',
  });
  const bucket = css({
    display: 'flex',
    flexDirection: 'column-reverse',
    justifyContent: 'flex-start',
    h: '140px',
    minW: 0,
  });
  const segment = css({ minH: '1px', bg: 'accent', borderTop: '1px solid token(colors.surface)' });
  const unclassified = css({ minH: '1px', bg: 'muted', opacity: 0.55, borderTop: '1px solid token(colors.surface)' });
  const tickRow = css({
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: '1fr',
    minH: '18px',
    color: 'muted',
    fontSize: '10px',
  });
  const tick = css({ textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' });
  const boundaries = css({ display: 'flex', justifyContent: 'space-between', color: 'muted', fontSize: '11px' });
  const legend = css({ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', mt: '4px' });
  const legendItem = css({ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '11px' });
  const swatch = css({ display: 'inline-block', w: '9px', h: '9px', borderRadius: 'sm', bg: 'accent' });
  const gapSwatch = css({
    display: 'inline-block',
    w: '9px',
    h: '9px',
    borderRadius: 'sm',
    bg: 'muted',
    opacity: 0.55,
  });
  const empty = css({ display: 'grid', placeItems: 'center', minH: '150px', color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import type { FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
  import type { TimelineValue } from '../../../../overview-model';
  import { fmtDateOnly, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import { originGapDescription } from './view-model';

  let {
    onInspect = () => undefined,
    timeline,
    value,
  }: { onInspect?: (index: number) => void; timeline: FocusedTimelineData | null; value: TimelineValue } = $props();

  const bucketTotal = (bucket: FocusedTimelineData['buckets'][number]): number =>
    value === 'sessions' ? bucket.sessions : bucket.total;
  const maxBucket = $derived(
    timeline ? Math.max(1, value === 'sessions' ? timeline.maxBucketSessions : timeline.maxBucketTotal) : 1,
  );
  const heightFor = (bucket: FocusedTimelineData['buckets'][number], amount: number): number => {
    if (value === 'share') {
      return bucketTotal(bucket) > 0 ? (amount / bucketTotal(bucket)) * 100 : 0;
    }
    return (amount / maxBucket) * 100;
  };
  const amountFor = (entry: { cost?: number; sessions: number; total?: number }): number =>
    value === 'sessions' || value === 'share' ? entry.sessions : (entry.cost ?? entry.total ?? 0);
  const formattedTotal = (amount: number, total: number): string => {
    if (value === 'share') {
      return fmtPct(total > 0 ? (amount / total) * 100 : 0);
    }
    return value === 'sessions' ? fmtNum(amount) : fmtMoney(amount);
  };
  const onChartKeydown = (event: KeyboardEvent): void => {
    if (!timeline) {
      return;
    }
    const current = Number((event.currentTarget as HTMLElement).dataset.bucketIndex ?? 0);
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = Math.max(0, current - 1);
    }
    if (event.key === 'ArrowRight') {
      next = Math.min(timeline.buckets.length - 1, current + 1);
    }
    if (event.key === 'Home') {
      next = 0;
    }
    if (event.key === 'End') {
      next = timeline.buckets.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      (event.currentTarget as HTMLElement).dataset.bucketIndex = String(next);
      onInspect(next);
    }
  };
</script>

<div class={chart} data-report-range-part="chart">
  {#if timeline && timeline.buckets.length > 0}
    <button
      aria-label="Inspect activity timeline. Use arrow keys to inspect days."
      class={plot}
      data-bucket-index="0"
      onkeydown={onChartKeydown}
      type="button"
    >
      {#each timeline.buckets as bucket (bucket.date)}
        <span
          aria-label={`${fmtDateOnly(bucket.date)} · ${formattedTotal(bucketTotal(bucket), bucketTotal(bucket))}`}
          class={bucket}
          role="img"
        >
          {#each timeline.series as series (series.key)}
            {@const entry = bucket.byKey[series.key]}
            {#if entry}
              <span
                class={segment}
                data-series-key={series.key}
                title={`${series.label}: ${formattedTotal(amountFor(entry), bucketTotal(bucket))}`}
                style:height={`${heightFor(bucket, amountFor(entry))}%`}
              ></span>
            {/if}
          {/each}
          {#if bucket.unclassified}
            <span
              class={unclassified}
              data-series-key="unclassified"
              title={originGapDescription(bucket.unclassified)}
              style:height={`${heightFor(bucket, amountFor(bucket.unclassified))}%`}
            ></span>
          {/if}
        </span>
      {/each}
    </button>
    <div class={tickRow} data-report-range-part="chart-axis" data-timeline-tick-row>
      {#each timeline.buckets as bucket, index (bucket.date)}
        <span class={tick} data-timeline-tick
          >{index % Math.max(1, Math.ceil(timeline.buckets.length / 6)) === 0 ? fmtDateOnly(bucket.date) : ''}</span
        >
      {/each}
    </div>
    <div class={boundaries} data-timeline-boundary-row>
      <span data-timeline-boundary>{fmtDateOnly(timeline.first)}</span>
      <span data-timeline-boundary>{fmtDateOnly(timeline.last)}</span>
    </div>
    <ul aria-label={`${timeline.dimension} timeline legend`} class={legend}>
      {#each timeline.series as series (series.key)}
        <li class={legendItem} data-series-key={series.key} title={`Filter by ${series.label}`}>
          <span aria-hidden="true" class={swatch}></span>{series.label}
        </li>
      {/each}
      {#if timeline.unclassified}
        <li class={legendItem} title={originGapDescription(timeline.unclassified)}>
          <span aria-hidden="true" class={gapSwatch}></span>Not classified
        </li>
      {/if}
    </ul>
  {:else}
    <p class={empty}>No dated sessions in range</p>
  {/if}
</div>
