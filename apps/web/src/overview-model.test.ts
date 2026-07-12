import { describe, expect, test } from 'bun:test';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { buildCampaignViews } from './dashboard-model';
import { toDateInputValue } from './date-range';
import {
  buildAdvancedAnalysisSummary,
  buildCalendarHeatmapData,
  buildModelMigrationData,
  buildOverviewHeroData,
  buildOverviewRecords,
  buildOverviewSessionItems,
  buildPunchcardData,
  buildSessionShapeData,
  buildTimelineData,
  buildTopSessions,
  nextHeatmapFocusIndex,
  type TimelineDimension,
} from './overview-model';
import { buildReportSummary, enrichReportRow } from './shared';

const baseRow: SerializedRow = {
  date: '2026-06-10T12:00:00.000Z',
  endDate: null,
  activeDate: '2026-06-10T12:00:00.000Z',
  harness: 'Codex',
  provider: 'Codex API',
  name: 'Base session',
  sessionLabel: 'Base session',
  model: 'gpt-5',
  project: 'alpha',
  tokIn: 10,
  tokOut: 5,
  tokCr: 3,
  tokCw: 2,
  tokenTotal: 20,
  freshTokens: 17,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 2,
  tools: 3,
  linesAdded: 4,
  linesDeleted: 1,
  lineDelta: 5,
};

const row = (overrides: Partial<SerializedRow> = {}) => enrichReportRow({ ...baseRow, ...overrides });

const heatDay = (data: NonNullable<ReturnType<typeof buildCalendarHeatmapData>>, day: string) =>
  data.weeks.flatMap((week) => week.days).find((cell) => cell && toDateInputValue(cell.date) === day) ?? null;

describe('overview model', () => {
  test('summarizes only the advanced analyses supported by the current data', () => {
    const fullyAnalyzableRows = [
      row({ sessionLabel: 'A', durationMs: 60_000, costApprox: 1 }),
      row({ sessionLabel: 'B', durationMs: 120_000, costApprox: 2 }),
      row({ sessionLabel: 'C', durationMs: 180_000, costApprox: 3 }),
    ];

    expect(buildAdvancedAnalysisSummary(fullyAnalyzableRows)).toEqual({
      hasPunchcard: true,
      hasSessionShape: true,
      summary: 'Duration/value patterns and weekly/hourly activity · 3 sessions',
    });
    expect(
      buildAdvancedAnalysisSummary([
        row({ sessionLabel: 'Unpriced', costApprox: 0, costKnown: false, durationMs: null }),
      ]),
    ).toEqual({
      hasPunchcard: true,
      hasSessionShape: false,
      summary: 'Weekly/hourly activity · 1 session',
    });
    expect(
      buildAdvancedAnalysisSummary([
        row({
          activeDate: null,
          date: null,
          sessionLabel: 'Undated',
          costApprox: 0,
          costKnown: false,
          durationMs: null,
        }),
      ]),
    ).toBeNull();
  });

  test('presents API-equivalent value and spend coverage without deriving an ROI multiple', () => {
    const rows = [
      row({ costActual: 2, costApprox: 12, costKnown: true }),
      row({ costActual: null, costApprox: 8, costKnown: true }),
      row({ costActual: null, costApprox: 0, costKnown: false }),
    ];

    const data = buildOverviewHeroData(buildReportSummary(rows, () => true));

    expect(data).toEqual({
      actualSpend: 2,
      actualSpendKnownSessions: 1,
      apiEquivalentValue: 20,
      apiPricedSessions: 2,
      sessionCount: 3,
      subscriptionValue: 0,
    });
  });

  test('moves heatmap focus by day and week while staying inside the calendar', () => {
    expect(nextHeatmapFocusIndex(10, 30, 'ArrowLeft')).toBe(3);
    expect(nextHeatmapFocusIndex(10, 30, 'ArrowRight')).toBe(17);
    expect(nextHeatmapFocusIndex(10, 30, 'ArrowUp')).toBe(9);
    expect(nextHeatmapFocusIndex(10, 30, 'ArrowDown')).toBe(11);
    expect(nextHeatmapFocusIndex(2, 30, 'Home')).toBe(0);
    expect(nextHeatmapFocusIndex(2, 30, 'End')).toBe(29);
    expect(nextHeatmapFocusIndex(1, 30, 'ArrowLeft')).toBe(0);
    expect(nextHeatmapFocusIndex(28, 30, 'ArrowRight')).toBe(29);
    expect(nextHeatmapFocusIndex(10, 30, 'Enter')).toBeNull();
  });

  test('builds calendar heatmap data from dated sessions', () => {
    const rows = [
      row({
        sessionLabel: 'A',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'B',
        activeDate: '2026-06-10T15:00:00.000Z',
        date: '2026-06-10T15:00:00.000Z',
        costApprox: 3,
      }),
      row({
        sessionLabel: 'C',
        activeDate: '2026-06-11T12:00:00.000Z',
        date: '2026-06-11T12:00:00.000Z',
        costApprox: 0,
        costKnown: false,
      }),
    ];

    const data = buildCalendarHeatmapData(rows, new Date('2026-06-11T12:00:00.000Z'));
    const june10 = data ? heatDay(data, '2026-06-10') : null;

    expect(data?.todayKey).toBe('2026-06-11');
    expect(june10?.sessions).toBe(2);
    expect(june10?.cost).toBe(5);
    expect(june10?.level).toBeGreaterThan(0);
  });

  test('shows activity for an unpriced day when another day has API-equivalent value', () => {
    const rows = [
      row({
        sessionLabel: 'Priced',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'Unpriced',
        activeDate: '2026-06-11T12:00:00.000Z',
        date: '2026-06-11T12:00:00.000Z',
        costApprox: 0,
        costKnown: false,
      }),
    ];

    const data = buildCalendarHeatmapData(rows, new Date('2026-06-11T12:00:00.000Z'));
    const unpricedDay = data ? heatDay(data, '2026-06-11') : null;

    expect(unpricedDay?.level).toBeGreaterThan(0);
  });

  test('keeps distinct model migration series below the density limit', () => {
    const rows = [
      row({
        sessionLabel: 'GPT one',
        activeDate: '2026-06-01T12:00:00.000Z',
        date: '2026-06-01T12:00:00.000Z',
        model: 'gpt-5',
        costApprox: 5,
      }),
      row({
        sessionLabel: 'Claude',
        activeDate: '2026-06-02T12:00:00.000Z',
        date: '2026-06-02T12:00:00.000Z',
        model: 'claude-sonnet',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'GPT two',
        activeDate: '2026-06-03T12:00:00.000Z',
        date: '2026-06-03T12:00:00.000Z',
        model: 'gpt-5',
        costApprox: 4,
      }),
    ];

    const data = buildModelMigrationData(rows);

    expect(data?.granularity).toBe('day');
    expect(data?.series.map((series) => series.key)).toEqual(['gpt-5', 'claude-sonnet']);
    expect(data?.grandTotal).toBe(11);
    // Highest single-bucket total drives the absolute (Value) bar heights.
    expect(data?.maxBucketTotal).toBe(5);
  });

  test('builds timeline series for every supported dimension with cost and sessions', () => {
    const rows = [
      row({
        sessionLabel: 'Codex alpha',
        activeDate: '2026-06-01T12:00:00.000Z',
        date: '2026-06-01T12:00:00.000Z',
        harness: 'Codex',
        model: 'gpt-5',
        provider: 'Codex API',
        project: 'alpha',
        costApprox: 5,
      }),
      row({
        sessionLabel: 'Claude beta',
        activeDate: '2026-06-02T12:00:00.000Z',
        date: '2026-06-02T12:00:00.000Z',
        harness: 'Claude',
        model: 'claude-sonnet',
        provider: 'Anthropic',
        project: 'beta',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'Codex alpha unpriced',
        activeDate: '2026-06-03T12:00:00.000Z',
        date: '2026-06-03T12:00:00.000Z',
        harness: 'Codex',
        model: 'gpt-5',
        provider: 'Codex API',
        project: 'alpha',
        costApprox: 0,
        costKnown: false,
      }),
    ];

    const expectations: Record<TimelineDimension, string[]> = {
      harness: ['Codex', 'Claude'],
      model: ['gpt-5', 'claude-sonnet'],
      project: ['alpha', 'beta'],
      provider: ['Codex API', 'Anthropic'],
    };

    for (const [dimension, keys] of Object.entries(expectations) as [TimelineDimension, string[]][]) {
      const data = buildTimelineData(rows, { dimension, granularity: 'day' });
      const firstKey = keys[0] ?? '';

      expect(data?.dimension).toBe(dimension);
      expect(data?.series.map((series) => series.key)).toEqual(keys);
      expect(data?.grandTotal).toBe(7);
      expect(data?.grandSessions).toBe(3);
      expect(data?.series.find((series) => series.key === firstKey)?.sessions).toBe(2);
      expect(data?.buckets[2]?.byKey.get(firstKey)?.sessions).toBe(1);
      expect(data?.buckets[2]?.byKey.get(firstKey)?.cost).toBe(0);
    }
  });

  test('builds timeline data over a forced domain', () => {
    const rows = [
      row({
        sessionLabel: 'Middle',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 3,
      }),
    ];

    const data = buildTimelineData(rows, {
      dimension: 'model',
      domain: {
        minDay: new Date('2026-06-01T00:00:00.000Z'),
        maxDay: new Date('2026-06-30T00:00:00.000Z'),
      },
      granularity: 'week',
    });

    expect(data?.first.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(data?.last.toISOString()).toBe('2026-06-29T00:00:00.000Z');
    expect(data?.buckets).toHaveLength(5);
    expect(data?.maxBucketTotal).toBe(3);
    expect(data?.maxBucketSessions).toBe(1);
  });

  test('aggregates the smallest additive timeline series without changing totals', () => {
    const rows = Array.from({ length: 15 }, (_, index) =>
      row({
        costApprox: index + 1,
        model: `model-${index + 1}`,
        sessionLabel: `Session ${index + 1}`,
      }),
    );

    const data = buildTimelineData(rows, { dimension: 'model', granularity: 'day' });
    const aggregate = data?.series.at(-1);

    expect(data?.series).toHaveLength(12);
    expect(aggregate?.label).toBe('Other');
    expect(aggregate?.memberKeys).toEqual(['model-4', 'model-3', 'model-2', 'model-1']);
    expect(aggregate?.sessions).toBe(4);
    expect(aggregate?.total).toBe(10);
    expect(data?.buckets[0]?.byKey.get(aggregate?.key ?? '')).toEqual({ cost: 10, sessions: 4 });
    expect(data?.series.reduce((sum, series) => sum + series.total, 0)).toBe(data?.grandTotal);
    expect(data?.series.reduce((sum, series) => sum + series.sessions, 0)).toBe(data?.grandSessions);
  });

  test('builds session shape chart data for timed priced rows', () => {
    const rows = [
      row({ sessionLabel: 'Short', durationMs: 60_000, costApprox: 0.1, harness: 'Codex' }),
      row({ sessionLabel: 'Medium', durationMs: 600_000, costApprox: 1, harness: 'Claude' }),
      row({ sessionLabel: 'Long', durationMs: 3_600_000, costApprox: 10, harness: 'Codex' }),
    ];

    const data = buildSessionShapeData(rows);

    expect(data?.points).toHaveLength(3);
    expect(data?.totalPoints).toBe(3);
    expect(data?.points.reduce((sum, point) => sum + point.aggregateCount, 0)).toBe(3);
    expect(data?.outliers.map((point) => point.label)).toEqual(['Long', 'Medium', 'Short']);
    expect(data?.harnesses).toEqual(['Codex', 'Claude']);
    expect(data?.xPct(600_000)).toBeGreaterThan(0);
    expect(data?.yPct(1)).toBeGreaterThan(0);
  });

  test('aggregates a dense session shape while retaining standout sessions for inspection', () => {
    const rows = Array.from({ length: 720 }, (_, index) =>
      row({
        sessionLabel: `Session ${index}`,
        durationMs: 60_000 * (1 + (index % 180)),
        costApprox: 0.01 * (1 + (index % 240)),
        harness: index % 2 ? 'Claude' : 'Codex',
      }),
    );

    const data = buildSessionShapeData(rows);

    expect(data?.totalPoints).toBe(720);
    expect(data?.points.length).toBeLessThanOrEqual(240);
    expect(data?.points.reduce((sum, point) => sum + point.aggregateCount, 0)).toBe(720);
    expect(data?.outliers).toHaveLength(6);
    expect(data?.outliers.every((point) => rows.includes(point.row))).toBe(true);
  });

  test('weights campaign bins by sessions and keeps harnesses separate', () => {
    const codexRoot = row({
      sessionLabel: 'Codex root',
      costApprox: 8,
      durationMs: 600_000,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        rootSourceSessionId: 'codex-root',
        sourceSessionId: 'codex-root',
      },
    });
    const codexChild = row({
      sessionLabel: 'Codex child',
      costApprox: 2,
      durationMs: 300_000,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'codex-root',
        rootSourceSessionId: 'codex-root',
        sourceSessionId: 'codex-child',
      },
    });
    const claude = row({ sessionLabel: 'Claude', costApprox: 10, durationMs: 600_000, harness: 'Claude' });
    const solo = row({ sessionLabel: 'Solo', costApprox: 1, durationMs: 60_000 });
    const rows = [codexRoot, codexChild, claude, solo];

    const data = buildSessionShapeData(rows, buildCampaignViews(rows, rows));

    expect(data?.totalPoints).toBe(4);
    expect(data?.points.reduce((sum, point) => sum + point.aggregateCount, 0)).toBe(4);
    expect(data?.points.some((point) => point.harness === 'Codex' && point.aggregateCount === 2)).toBe(true);
    expect(data?.points.some((point) => point.harness === 'Claude' && point.aggregateCount === 1)).toBe(true);
    expect(data?.harnessSummaries.map((summary) => [summary.harness, summary.sessions])).toEqual([
      ['Codex', 3],
      ['Claude', 1],
    ]);
  });

  test('retains expensive-short and long-cheap axis extremes as standouts', () => {
    const expensiveShort = row({ sessionLabel: 'Expensive short', costApprox: 1000, durationMs: 60_000 });
    const longCheap = row({ sessionLabel: 'Long cheap', costApprox: 0.01, durationMs: 360_000_000 });
    const ordinary = Array.from({ length: 10 }, (_, index) =>
      row({ sessionLabel: `Ordinary ${index}`, costApprox: 1 + index, durationMs: 600_000 + index * 60_000 }),
    );

    const data = buildSessionShapeData([expensiveShort, longCheap, ...ordinary]);
    const labels = data?.outliers.map((point) => point.label) ?? [];

    expect(labels).toContain('Expensive short');
    expect(labels).toContain('Long cheap');
  });

  test('builds punchcard density', () => {
    const rows = [
      row({
        sessionLabel: 'A',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'B',
        activeDate: '2026-06-10T12:30:00.000Z',
        date: '2026-06-10T12:30:00.000Z',
        costApprox: 3,
      }),
    ];

    const data = buildPunchcardData(rows);
    const cells = data?.cells.flat() ?? [];

    expect(data?.maxSessions).toBe(2);
    expect(cells.reduce((sum, cell) => sum + cell.sessions, 0)).toBe(2);
    expect(cells.reduce((sum, cell) => sum + cell.cost, 0)).toBe(5);
  });

  test('builds records and top sessions', () => {
    const rows = [
      row({
        sessionLabel: 'High',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 10,
        durationMs: 60_000,
      }),
      row({
        sessionLabel: 'Long',
        activeDate: '2026-06-09T12:00:00.000Z',
        date: '2026-06-09T12:00:00.000Z',
        costApprox: 3,
        durationMs: 3_600_000,
      }),
      row({
        sessionLabel: 'Old',
        activeDate: '2026-06-08T12:00:00.000Z',
        date: '2026-06-08T12:00:00.000Z',
        costApprox: 1,
        durationMs: 600_000,
      }),
    ];

    const records = buildOverviewRecords(rows, rows);
    const top = buildTopSessions(rows, 2);

    expect(records?.topCost?.sessionLabel).toBe('High');
    expect(records?.longest?.sessionLabel).toBe('Long');
    expect(records?.streak).toBe(3);
    expect(top.map((item) => item.label)).toEqual(['High', 'Long']);
  });

  test('groups campaigns for top sessions and session shape without double counting children', () => {
    const campaignRoot = row({
      sessionLabel: 'Campaign root',
      activeDate: '2026-06-10T12:00:00.000Z',
      date: '2026-06-10T12:00:00.000Z',
      costApprox: 8,
      durationMs: 600_000,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'root-1',
        rootSourceSessionId: 'root-1',
        machineId: 'machine-a',
      },
    });
    const campaignChild = row({
      sessionLabel: 'Campaign child',
      activeDate: '2026-06-10T12:05:00.000Z',
      date: '2026-06-10T12:05:00.000Z',
      costApprox: 5,
      durationMs: 300_000,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'child-1',
        parentSourceSessionId: 'root-1',
        rootSourceSessionId: 'root-1',
        machineId: 'machine-a',
      },
    });
    const soloA = row({ sessionLabel: 'Solo A', costApprox: 12, durationMs: 120_000 });
    const soloB = row({ sessionLabel: 'Solo B', costApprox: 3, durationMs: 240_000 });
    const rows = [campaignRoot, campaignChild, soloA, soloB];
    const campaigns = buildCampaignViews(rows, rows);

    const items = buildOverviewSessionItems(rows, campaigns);
    const top = buildTopSessions(rows, 2, campaigns);
    const shape = buildSessionShapeData(rows, campaigns);

    expect(items.map((item) => item.label).sort()).toEqual(['Campaign root', 'Solo A', 'Solo B']);
    expect(top.map((item) => item.kind)).toEqual(['campaign', 'session']);
    expect(top.map((item) => item.costApprox)).toEqual([13, 12]);
    expect(shape?.points.map((item) => item.label).sort()).toEqual(['Campaign root', 'Solo A', 'Solo B']);
  });
});
