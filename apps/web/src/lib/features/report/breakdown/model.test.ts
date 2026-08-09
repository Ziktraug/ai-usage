import { describe, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { analyticsExportRows, breakdownRows } from './model';

const group = (key: string, overrides: Partial<AnalyticsGroup> = {}): AnalyticsGroup => ({
  ambiguous: 0,
  cache: 50,
  cacheHitPct: 25,
  costPer100Lines: null,
  costPercent: 0,
  costPerSession: null,
  costSum: 0,
  fresh: 100,
  harness: key,
  inp: 150,
  key,
  lineCount: 0,
  linesA: 0,
  linesD: 0,
  medianCost: null,
  priced: 1,
  provider: key,
  sessions: 1,
  tools: 0,
  turns: 0,
  unpriced: 0,
  unpricedFreshTokens: 0,
  usageUnavailable: 0,
  ...overrides,
});

describe('breakdown row projection', () => {
  test('sorts and projects measured, partial, zero, and unavailable bars exactly', () => {
    const rows = breakdownRows(
      [
        group('zero'),
        group('unavailable', { usageUnavailable: 1 }),
        group('partial', { costSum: 5, priced: 0, unpriced: 1, unpricedFreshTokens: 100 }),
        group('measured', { costSum: 10 }),
      ],
      '',
      'value',
      'providers',
    );

    expect(rows.map(({ label }) => label)).toEqual(['measured', 'partial', 'unavailable', 'zero']);
    expect(rows.map(({ priceState, widthPercent }) => ({ priceState, widthPercent }))).toEqual([
      { priceState: 'measured', widthPercent: 100 },
      { priceState: 'partially measured', widthPercent: 50 },
      { priceState: 'unavailable', widthPercent: null },
      { priceState: 'zero', widthPercent: 0 },
    ]);
    expect(rows.map(({ ariaLabel }) => ariaLabel).sort()).toEqual([
      'Measured API-value bar',
      'Partially measured API-value bar',
      'Unavailable API-value bar',
      'Zero API-value bar',
    ]);
  });

  test('searches normalized display labels and exports visible sorted rows only', () => {
    const groups = [group('zeta', { fresh: 10 }), group('<synthetic>', { fresh: 20 })];
    const visible = breakdownRows(groups, 'unattributed', 'tokens', 'models');

    expect(visible.map(({ label }) => label)).toEqual(['Unattributed model']);
    expect(analyticsExportRows(visible)).toEqual([{ group: groups[1]!, label: 'Unattributed model' }]);
  });
});
