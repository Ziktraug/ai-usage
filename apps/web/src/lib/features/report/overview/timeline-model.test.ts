import { describe, expect, test } from 'bun:test';
import type { FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
import { apiPriceMeasurement } from '@ai-usage/report-core/provenance';
import {
  presentTimelineSeries,
  retainTimelineTickLabels,
  timelineReadoutFor,
  timelineSeriesIsFilterable,
  timelineSharePercent,
  timelineTrendIsVisible,
  timelineUsesSessions,
} from './timeline-model';

const measured = apiPriceMeasurement({ costKnown: true, freshTokens: 10, knownCost: 10 });
const timeline = (grandTotal: number): FocusedTimelineData => ({
  buckets: [
    {
      byKey: {
        alpha: { cost: 9, priceMeasurement: measured, sessions: 1 },
        beta: { cost: 1, priceMeasurement: measured, sessions: 9 },
      },
      date: '2026-06-01',
      priceMeasurement: measured,
      sessions: 10,
      total: grandTotal > 0 ? 10 : 0,
      unclassified: null,
    },
  ],
  dimension: 'harness',
  first: '2026-06-01',
  grandSessions: 10,
  grandTotal,
  granularity: 'day',
  last: '2026-06-01',
  maxBucketSessions: 10,
  maxBucketTotal: grandTotal > 0 ? 10 : 0,
  priceMeasurement: measured,
  series: [
    { key: 'alpha', label: 'Alpha', priceMeasurement: measured, sessions: 1, total: 9 },
    { key: 'beta', label: 'Beta', priceMeasurement: measured, sessions: 9, total: 1 },
  ],
  unclassified: null,
});

describe('P2 timeline presentation model', () => {
  test('uses cost for every share when cost exists, never sessions divided by cost', () => {
    const data = timeline(10);
    const readout = timelineReadoutFor(data, 'share', 0);

    expect(timelineUsesSessions(data, 'share')).toBe(false);
    expect(readout?.rows.map((row) => [row.key, timelineSharePercent(row.value, readout.total)])).toEqual([
      ['alpha', 90],
      ['beta', 10],
    ]);
  });

  test('falls back all share numerators and denominators to sessions when cost is unavailable', () => {
    const data = timeline(0);
    const readout = timelineReadoutFor(data, 'share', 0);

    expect(timelineUsesSessions(data, 'share')).toBe(true);
    expect(readout?.rows.map((row) => [row.key, timelineSharePercent(row.value, readout.total)])).toEqual([
      ['beta', 90],
      ['alpha', 10],
    ]);
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
      alpha: { cost: alpha, priceMeasurement: measured, sessions: alpha },
      beta: { cost: beta, priceMeasurement: measured, sessions: beta },
    },
    date,
    priceMeasurement: measured,
    sessions: alpha + beta,
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
