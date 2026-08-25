import { describe, expect, test } from 'bun:test';
import type { FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
import { apiPriceMeasurement } from '@ai-usage/report-core/provenance';
import {
  presentTimelineSeries,
  presentTimelineValue,
  resolveTimelineMetric,
  retainTimelineTickLabels,
  timelineGapValue,
  timelineMetricLabel,
  timelineOtherDisclosure,
  timelineReadoutFor,
  timelineSeriesIsFilterable,
  timelineSeriesValue,
  timelineSharePercent,
  timelineTrendIsVisible,
} from './timeline-model';

const measured = apiPriceMeasurement({ costKnown: true, freshTokens: 10, knownCost: 10 });
const timeline = (grandTotal: number): FocusedTimelineData => ({
  buckets: [
    {
      byKey: {
        alpha: { cost: 9, priceMeasurement: measured, sessions: 1, tokens: 900 },
        beta: { cost: 1, priceMeasurement: measured, sessions: 9, tokens: 100 },
      },
      date: '2026-06-01',
      priceMeasurement: measured,
      sessions: 10,
      tokens: 1000,
      total: grandTotal > 0 ? 10 : 0,
      unclassified: null,
    },
  ],
  dimension: 'harness',
  first: '2026-06-01',
  grandSessions: 10,
  grandTokens: 1000,
  grandTotal,
  granularity: 'day',
  last: '2026-06-01',
  maxBucketSessions: 10,
  maxBucketTokens: 1000,
  maxBucketTotal: grandTotal > 0 ? 10 : 0,
  priceMeasurement: measured,
  series: [
    { key: 'alpha', label: 'Alpha', priceMeasurement: measured, sessions: 1, tokens: 900, total: 9 },
    { key: 'beta', label: 'Beta', priceMeasurement: measured, sessions: 9, tokens: 100, total: 1 },
  ],
  unclassified: null,
});

describe('P2 timeline presentation model', () => {
  test('uses cost for every share when cost exists, never sessions divided by cost', () => {
    const data = timeline(10);
    const readout = timelineReadoutFor(data, 'share', 0);

    expect(resolveTimelineMetric(data, 'share')).toBe('cost');
    expect(readout?.rows.map((row) => [row.key, timelineSharePercent(row.value, readout.total)])).toEqual([
      ['alpha', 90],
      ['beta', 10],
    ]);
  });

  test('falls back all share numerators and denominators to sessions when cost is unavailable', () => {
    const data = timeline(0);
    const readout = timelineReadoutFor(data, 'share', 0);

    expect(resolveTimelineMetric(data, 'share')).toBe('sessions');
    expect(readout?.rows.map((row) => [row.key, timelineSharePercent(row.value, readout.total)])).toEqual([
      ['beta', 90],
      ['alpha', 10],
    ]);
  });

  test('resolves Tokens to processed-token values without consulting price coverage', () => {
    const data = timeline(0);
    const firstSeries = data.series[0];
    const readout = timelineReadoutFor(data, 'tokens', 0);
    if (!firstSeries) {
      throw new Error('Expected a timeline series fixture.');
    }

    expect(resolveTimelineMetric(data, 'tokens')).toBe('tokens');
    expect(readout?.metric).toBe('tokens');
    expect(readout?.total).toBe(1000);
    expect(readout?.rows.map((row) => [row.key, row.value])).toEqual([
      ['alpha', 900],
      ['beta', 100],
    ]);
    expect(timelineSeriesValue(firstSeries, 'tokens')).toBe(900);
    expect(timelineGapValue({ sessions: 2, tokens: 75, total: 0 }, 'tokens')).toBe(75);
    expect(timelineMetricLabel('tokens', 'tokens')).toBe('Processed tokens');
    expect(presentTimelineValue(241_600, 241_600, 'tokens', 'tokens', measured)).toEqual({
      label: '241,600 tokens',
      provenance: null,
      title: null,
    });
  });

  test('qualifies API value as exact, a lower bound, or unavailable from its price measurement', () => {
    const partial = apiPriceMeasurement({ costKnown: false, freshTokens: 2500, knownCost: 4.5 });
    const unpriced = apiPriceMeasurement({ costKnown: false, freshTokens: 2500, knownCost: 0 });

    expect(presentTimelineValue(10, 10, 'cost', 'cost', measured)).toMatchObject({
      label: '$10.00',
      provenance: null,
    });
    expect(presentTimelineValue(4.5, 4.5, 'cost', 'cost', partial)).toMatchObject({
      label: '≥ $4.50',
      provenance: { label: 'Partially measured', severity: 'warning' },
    });
    expect(presentTimelineValue(0, 0, 'cost', 'cost', unpriced)).toMatchObject({
      label: '—',
      provenance: { label: 'Partially measured', severity: 'warning' },
    });
    expect(presentTimelineValue(2500, 2500, 'tokens', 'tokens', partial)).toEqual({
      label: '2,500 tokens',
      provenance: null,
      title: null,
    });
  });

  test('presents campaign and machine language without changing stable keys', () => {
    const campaign = { ...timeline(10), dimension: 'campaign' as const };
    expect(
      presentTimelineSeries(
        campaign,
        (series) => ({ ...series, label: `Campaign ${series.label}` }),
        () => ({
          freshness: 'fresh',
          label: 'unused',
        }),
      ).map(({ key, label }) => ({ key, label })),
    ).toEqual([
      { key: 'alpha', label: 'Campaign Alpha' },
      { key: 'beta', label: 'Campaign Beta' },
    ]);

    const machine = { ...timeline(10), dimension: 'machine' as const };
    expect(
      presentTimelineSeries(
        machine,
        (series) => series,
        (key) => ({
          freshness: key === 'alpha' ? 'stale' : 'fresh',
          label: `${key} · ${key === 'alpha' ? 'Stale' : 'Current'}`,
        }),
      )[0],
    ).toMatchObject({ key: 'alpha', label: 'alpha · Stale' });
  });

  test('keeps only filterable dimensions and excludes aggregate series', () => {
    expect(timelineSeriesIsFilterable('harness', { key: 'claude' })).toBe(true);
    expect(timelineSeriesIsFilterable('campaign', { key: 'campaign:one' })).toBe(false);
    expect(timelineSeriesIsFilterable('origin', { key: 'human' })).toBe(false);
    expect(timelineSeriesIsFilterable('machine', { key: '' })).toBe(false);
    expect(timelineSeriesIsFilterable('model', { key: 'other', memberKeys: ['a'] })).toBe(false);
  });

  test('discloses what an aggregated series swallowed without offering a filter', () => {
    expect(timelineOtherDisclosure({})).toBeNull();
    expect(timelineOtherDisclosure({ memberKeys: [] })).toBeNull();
    expect(
      timelineOtherDisclosure({
        memberKeys: ['claude-opus-4', 'gpt-5.4'],
        memberSummaries: [
          { label: 'claude-opus-4', sessions: 12, total: 4.5 },
          { label: 'gpt-5.4', sessions: 1, total: 0.5 },
        ],
      }),
    ).toEqual({ items: ['claude-opus-4 · 12 sessions', 'gpt-5.4 · 1 session'], label: '2 grouped' });
    // The summaries are bounded but the keys are not, so the count of members
    // that stayed unnamed has to come from the key list.
    expect(
      timelineOtherDisclosure({
        memberKeys: Array.from({ length: 1400 }, (_, index) => `model-${index}`),
        memberSummaries: [{ label: 'model-0', sessions: 3, total: 1 }],
      }),
    ).toEqual({ items: ['model-0 · 3 sessions', 'and 1,399 more'], label: '1,400 grouped' });
    // Keys without summaries still disclose the count rather than nothing.
    expect(timelineOtherDisclosure({ memberKeys: ['a', 'b'] })).toEqual({
      items: ['and 2 more'],
      label: '2 grouped',
    });
  });

  test('retains spaced ticks only when they do not collide with boundary labels', () => {
    expect(
      retainTimelineTickLabels(
        [
          { id: 'collides-left', left: 8, right: 30 },
          { id: 'middle', left: 40, right: 60 },
          { id: 'collides-right', left: 75, right: 92 },
        ],
        [
          { id: 'from', left: 0, right: 20 },
          { id: 'to', left: 80, right: 100 },
        ],
      ).map(({ id }) => id),
    ).toEqual(['middle']);
  });
});

test('wires legend buttons, keyboard inspection, live readout, and collision measurement in the Svelte leaf', async () => {
  const source = await Bun.file(new URL('./activity-timeline.svelte', import.meta.url)).text();
  expect(source).toContain('onkeydown={onChartKeydown}');
  expect(source).toContain('onfocus={() => inspect(inspectedIndex ?? (bars[0]?.index ?? 0))}');
  expect(source).toContain('aria-live="polite"');
  expect(source).toContain('data-timeline-readout');
  expect(source).toContain('{...pressedAria(active)}');
  expect(source).toContain('onclick={() => filterable && onDimensionFilter(timeline.dimension, series.key)}');
  expect(source).toContain('new ResizeObserver(measureTickCollisions)');
  expect(source).toContain('class={timelineHoverLayer}');
  expect(source).toContain('data-origin-series-stack');
  expect(source).toContain('data-origin-unclassified-band');
  expect(source).toContain('data-origin-unclassified-legend');
  expect(source).toContain('document.fonts.ready.then');
  expect(source).toContain('observer.observe(boundaryRowElement)');
  expect(source).toContain('metricLabel}:');
  expect(source).toContain('presentTimelineValue(');
  expect(source).toContain('classifiedBucketPriceMeasurement(bar.bucket)');
  expect(source).toContain('accessibleAmount(barValue)');
  expect(source).toContain('presentation.provenance');
  expect(source).toContain('data-timeline-legend-entry=');
  expect(source).toContain('...(rank === undefined ? {} : { rank })');
  expect(source).toContain('aggregate: (series?.memberKeys?.length ?? 0) > 0');
  expect(source).not.toContain('data-origin-gap-value');
});

test('remeasures tick collisions when timeline labels change without a resize', async () => {
  const source = await Bun.file(new URL('./activity-timeline.svelte', import.meta.url)).text();
  expect(source).toContain('const tickMeasurementRevision = $derived(');
  expect(source).toContain("monthTicks.map(timelineMonthTickId).join('|')");
  expect(source).toContain('retainedTickIds = null');
  expect(source).toContain('afterDomUpdate().then(() =>');
  expect(source).toContain('cancelled = true');
});

describe('readout series trend', () => {
  const bucketWith = (date: string, alpha: number, beta: number) => ({
    byKey: {
      alpha: { cost: alpha, priceMeasurement: measured, sessions: alpha, tokens: alpha * 10 },
      beta: { cost: beta, priceMeasurement: measured, sessions: beta, tokens: beta * 10 },
    },
    date,
    priceMeasurement: measured,
    sessions: alpha + beta,
    tokens: (alpha + beta) * 10,
    total: alpha + beta,
    unclassified: null,
  });
  const twoDays = (): FocusedTimelineData => ({
    ...timeline(10),
    buckets: [bucketWith('2026-06-01', 10, 4), bucketWith('2026-06-02', 15, 2)],
  });

  test('measures each series against the same series in the previous bucket', () => {
    const readout = timelineReadoutFor(twoDays(), 'cost', 1);

    expect(readout?.hasPrevious).toBe(true);
    expect(readout?.rows.map((row) => [row.key, row.delta])).toEqual([
      ['alpha', 50],
      ['beta', -50],
    ]);
  });

  test('reports no comparison for the first bucket in the timeline', () => {
    const readout = timelineReadoutFor(twoDays(), 'cost', 0);

    expect(readout?.hasPrevious).toBe(false);
    expect(readout?.rows.every((row) => row.delta === null)).toBe(true);
  });

  test('leaves the delta null when the series carried nothing to compare against', () => {
    const appeared: FocusedTimelineData = {
      ...timeline(10),
      buckets: [bucketWith('2026-06-01', 10, 0), bucketWith('2026-06-02', 10, 7)],
    };

    expect(timelineReadoutFor(appeared, 'cost', 1)?.rows.find((row) => row.key === 'beta')?.delta).toBeNull();
  });

  test('hides a change that is noise or an unusable ratio', () => {
    // Under one percent reads as movement that is not there; a thousandfold jump
    // stops describing anything a reader can use.
    expect(timelineTrendIsVisible(null)).toBe(false);
    expect(timelineTrendIsVisible(0.4)).toBe(false);
    expect(timelineTrendIsVisible(-0.9)).toBe(false);
    expect(timelineTrendIsVisible(1)).toBe(true);
    expect(timelineTrendIsVisible(-42)).toBe(true);
    expect(timelineTrendIsVisible(999.9)).toBe(true);
    expect(timelineTrendIsVisible(1000)).toBe(false);
  });
});
