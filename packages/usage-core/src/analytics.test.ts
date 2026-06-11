import { describe, expect, test } from 'bun:test';
import { calculateAnalytics } from './analytics';
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
      ],
      new Date('2026-01-01T00:03:00.000Z').getTime(),
    );

    expect(analytics.sessionCount).toBe(2);
    expect(analytics.unpricedCount).toBe(1);
    expect(analytics.totalCost).toBe(2);
    expect(analytics.linesA).toBe(20);
    expect(analytics.linesD).toBe(0);
    expect(analytics.byModel[0]?.key).toBe('gpt-5.3-codex');
    expect(analytics.byModel[0]?.cacheHitPct).toBeCloseTo(33.333, 2);
    expect(analytics.recentSessions).toBe(2);
  });
});
