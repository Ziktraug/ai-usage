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

  test('groups model analytics by shared base model identity', () => {
    const analytics = calculateAnalytics([
      row({ model: 'openai/gpt-5.4', costApprox: 2 }),
      row({ model: 'gpt-5.4-high', costApprox: 3 }),
      row({ model: 'gpt-5-codex', costApprox: 5 }),
    ]);

    const gpt54 = analytics.byModel.find((group) => group.key === 'gpt-5.4');
    expect(gpt54?.sessions).toBe(2);
    expect(gpt54?.costSum).toBe(5);
    expect(analytics.byModel.find((group) => group.key === 'gpt-5-codex')?.sessions).toBe(1);
  });

  test('attributes multi-model tokens and API value to the model segment that produced them', () => {
    const multiModelRow = {
      ...row({
        costApprox: 3,
        model: 'gpt-5.4',
        models: ['gpt-5.4', 'gpt-5.4-mini'],
        tokCr: 30,
        tokCw: 10,
        tokIn: 100,
        tokOut: 60,
      }),
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4',
          tokCr: 20,
          tokCw: 0,
          tokIn: 70,
          tokOut: 30,
        },
        {
          costApprox: 1,
          costKnown: true,
          model: 'gpt-5.4-mini',
          tokCr: 10,
          tokCw: 10,
          tokIn: 30,
          tokOut: 30,
        },
      ],
    };

    const analytics = calculateAnalytics([multiModelRow]);
    const primary = analytics.byModel.find((group) => group.key === 'gpt-5.4');
    const secondary = analytics.byModel.find((group) => group.key === 'gpt-5.4-mini');

    expect(primary).toMatchObject({ cache: 20, costSum: 2, fresh: 100, inp: 70, sessions: 1 });
    expect(secondary).toMatchObject({ cache: 10, costSum: 1, fresh: 70, inp: 30, sessions: 1 });
  });

  test('preserves a known model subtotal when attribution for that model is incomplete', () => {
    const analytics = calculateAnalytics([
      {
        ...row({
          costApprox: 2,
          costKnown: false,
          model: 'gpt-5.4-high',
          models: ['gpt-5.4-high', 'gpt-5.4-fast'],
          tokIn: 10,
          tokOut: 10,
        }),
        modelSegments: [
          {
            costApprox: 2,
            costKnown: true,
            model: 'gpt-5.4-high',
            tokCr: 0,
            tokCw: 0,
            tokIn: 10,
            tokOut: 0,
          },
          {
            costApprox: 0,
            costKnown: false,
            model: 'gpt-5.4-fast',
            tokCr: 0,
            tokCw: 0,
            tokIn: 0,
            tokOut: 10,
          },
        ],
      },
    ]);

    expect(analytics.byModel).toHaveLength(1);
    expect(analytics.byModel[0]).toMatchObject({
      costPerSession: null,
      costSum: 2,
      key: 'gpt-5.4',
      medianCost: null,
      priced: 0,
      unpriced: 1,
    });
  });

  test('orders equal model aggregates by a stable lexical key', () => {
    const analytics = calculateAnalytics([
      row({ model: 'z-model' }),
      row({ model: 'a-model' }),
      row({ model: 'ä-model' }),
    ]);

    expect(analytics.byModel.map(({ key }) => key)).toEqual(['a-model', 'z-model', 'ä-model']);
  });

  test('keeps legacy multi-model usage in an explicit unsegmented bucket', () => {
    const analytics = calculateAnalytics([row({ model: 'gpt-5.4', models: ['gpt-5.4', 'claude-sonnet-4-6'] })]);

    expect(analytics.byModel).toHaveLength(1);
    expect(analytics.byModel[0]).toMatchObject({
      costSum: 1,
      key: '(multi-model, unsegmented)',
      sessions: 1,
    });
  });
});
