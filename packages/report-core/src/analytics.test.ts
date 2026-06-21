import { describe, expect, test } from 'bun:test';
import { calculateAnalytics, groupAnalytics, rowToAnalyticsInput } from './analytics';
import type { Row } from './types';

const row = (overrides: Partial<Row>): Row => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: 'fixture',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 100,
  tokOut: 50,
  tokCr: 50,
  tokCw: 0,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 2,
  linesAdded: 10,
  linesDeleted: 5,
  ...overrides,
});

describe('analytics calculation', () => {
  test('calculates reusable report metrics without rendering strings', () => {
    const analytics = calculateAnalytics(
      [
        row({ costApprox: 2, linesAdded: 20, linesDeleted: 0 }),
        row({
          model: 'unknown-model',
          provider: 'Mystery',
          costKnown: false,
          costApprox: 0,
          linesAdded: null,
          linesDeleted: null,
        }),
        row({
          model: 'usage unavailable',
          provider: 'Claude sub',
          costActual: null,
          costKnown: false,
          costApprox: 0,
          tokIn: 0,
          tokOut: 0,
          tokCr: 0,
          linesAdded: null,
          linesDeleted: null,
          usageUnavailable: true,
        }),
      ],
      new Date('2026-01-01T00:03:00.000Z').getTime(),
    );

    expect(analytics.sessionCount).toBe(3);
    expect(analytics.unpricedCount).toBe(2);
    expect(analytics.totalCost).toBe(2);
    expect(analytics.linesA).toBe(20);
    expect(analytics.linesD).toBe(0);
    expect(analytics.byModel[0]?.key).toBe('gpt-5.3-codex');
    expect(analytics.byModel[0]?.cacheHitPct).toBeCloseTo(33.333, 2);
    expect(analytics.byModel.find((group) => group.key === 'usage unavailable')?.usageUnavailable).toBe(1);
    expect(analytics.recentSessions).toBe(3);
  });

  test('groupAnalytics groups any row by an arbitrary key with shared finalize math', () => {
    const rows = [
      row({ project: 'alpha', costApprox: 3 }),
      row({ project: 'alpha', costApprox: 1 }),
      row({ project: 'beta', costApprox: 0, costKnown: false }),
    ];
    const totalCost = 4;
    const groups = groupAnalytics(rows, rowToAnalyticsInput, (row) => row.project, totalCost);

    const alpha = groups.find((group) => group.key === 'alpha');
    const beta = groups.find((group) => group.key === 'beta');
    expect(groups[0]?.key).toBe('alpha'); // sorted by costSum desc
    expect(alpha?.sessions).toBe(2);
    expect(alpha?.costSum).toBe(4);
    expect(alpha?.costPercent).toBe(100);
    expect(alpha?.costPerSession).toBe(2);
    expect(beta?.unpriced).toBe(1);
    expect(beta?.costPerSession).toBeNull();
  });
});
