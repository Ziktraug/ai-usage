import { describe, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import {
  breakdownBarPresentation,
  breakdownModelLabel,
  breakdownPriceStateLabel,
  filterAndSortBreakdownGroups,
  sortBreakdownGroups,
} from './group-panel-presentation';

const analyticsGroup = (key: string, costSum: number, fresh: number, sessions: number): AnalyticsGroup => ({
  ambiguous: 0,
  cache: 0,
  cacheHitPct: 0,
  costPer100Lines: null,
  costPercent: 0,
  costPerSession: null,
  costSum,
  fresh,
  harness: key,
  inp: fresh,
  key,
  lineCount: 0,
  linesA: 0,
  linesD: 0,
  medianCost: null,
  priced: sessions,
  provider: key,
  sessions,
  tools: 0,
  turns: 0,
  unpriced: 0,
  unpricedFreshTokens: 0,
  usageUnavailable: 0,
});

const groupKeys = (groups: readonly AnalyticsGroup[]): string[] => groups.map(({ key }) => key);

describe('Breakdown price presentation', () => {
  test('keeps a small positive value proportional instead of flooring it', () => {
    const presentation = breakdownBarPresentation({
      knownCost: 0.12,
      maxKnownCost: 20.41,
      unpricedCount: 0,
      usageUnavailable: false,
    });

    expect(presentation.state).toBe('measured');
    expect(presentation.widthPercent).toBeCloseTo((0.12 / 20.41) * 100);
    expect(presentation.widthPercent).toBeGreaterThan(0);
    expect(presentation.widthPercent).toBeLessThan(3);
  });

  test('keeps genuine zero and partially measured values as distinct states', () => {
    const zero = breakdownBarPresentation({
      knownCost: 0,
      maxKnownCost: 20.41,
      unpricedCount: 0,
      usageUnavailable: false,
    });
    const partiallyMeasured = breakdownBarPresentation({
      knownCost: 0,
      maxKnownCost: 20.41,
      unpricedCount: 1,
      usageUnavailable: false,
    });
    const unavailable = breakdownBarPresentation({
      knownCost: 0,
      maxKnownCost: 20.41,
      unpricedCount: 0,
      usageUnavailable: true,
    });

    expect(zero).toEqual({ state: 'zero', widthPercent: 0 });
    expect(partiallyMeasured).toEqual({
      state: 'partially measured',
      widthPercent: 0,
    });
    expect(unavailable).toEqual({ state: 'unavailable', widthPercent: null });
    expect(breakdownPriceStateLabel(zero.state)).toBe('Zero');
    expect(breakdownPriceStateLabel(partiallyMeasured.state)).toBe('Partially measured');
    expect(breakdownPriceStateLabel(unavailable.state)).toBe('Unavailable');
  });
});

describe('Breakdown model labels', () => {
  test('replaces internal model placeholders without changing real model names', () => {
    expect(breakdownModelLabel('<synthetic>')).toBe('Unattributed model');
    expect(breakdownModelLabel('codex')).toBe('Unspecified Codex model');
    expect(breakdownModelLabel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });
});

describe('Breakdown sorting', () => {
  test('applies every descending numeric order and an ascending label tie-breaker without mutating input', () => {
    const alpha = analyticsGroup('alpha', 5, 10, 2);
    const beta = analyticsGroup('beta', 5, 20, 1);
    const gamma = analyticsGroup('gamma', 7, 5, 1);
    const delta = analyticsGroup('delta', 5, 20, 3);
    const input = [alpha, beta, gamma, delta];

    const byValue = sortBreakdownGroups(input, 'value');
    const byTokens = sortBreakdownGroups(input, 'tokens');
    const bySessions = sortBreakdownGroups(input, 'sessions');

    expect(groupKeys(byValue)).toEqual(['gamma', 'beta', 'delta', 'alpha']);
    expect(groupKeys(byTokens)).toEqual(['beta', 'delta', 'alpha', 'gamma']);
    expect(groupKeys(bySessions)).toEqual(['delta', 'alpha', 'beta', 'gamma']);
    expect(input).toEqual([alpha, beta, gamma, delta]);
    expect(byValue).not.toBe(input);
  });

  test('preserves input order when every locked sort key and label tie', () => {
    const first = analyticsGroup('same', 1, 1, 1);
    const second = { ...analyticsGroup('same', 1, 1, 1), provider: 'second' };

    expect(sortBreakdownGroups([first, second], 'sessions')).toEqual([first, second]);
  });
});

describe('Breakdown search', () => {
  test('trims and normalizes a case-insensitive Unicode query before sorting matches', () => {
    const zebra = analyticsGroup('Équipe Zèbre', 1, 10, 1);
    const alpha = analyticsGroup('Équipe Alpha', 1, 20, 2);
    const other = analyticsGroup('Other', 1, 30, 3);
    const input = [zebra, other, alpha];

    expect(groupKeys(filterAndSortBreakdownGroups(input, '  E\u0301QUIPE  ', 'tokens'))).toEqual([
      'Équipe Alpha',
      'Équipe Zèbre',
    ]);
    expect(input).toEqual([zebra, other, alpha]);
  });

  test('shows every sorted row for whitespace and no rows for an unmatched query', () => {
    const alpha = analyticsGroup('Alpha', 1, 10, 2);
    const beta = analyticsGroup('Beta', 1, 20, 1);

    expect(groupKeys(filterAndSortBreakdownGroups([alpha, beta], '   ', 'tokens'))).toEqual(['Beta', 'Alpha']);
    expect(filterAndSortBreakdownGroups([alpha, beta], 'missing', 'sessions')).toEqual([]);
  });
});
