import { describe, expect, test } from 'bun:test';
import type { MetricPeriodComparison, PeriodWindow } from '../../../../dashboard-model';
import { fmtCompact, fmtDateOnly, fmtMoney } from '../../../foundation/presentation/format';
import {
  explanationWithCaveat,
  type PeriodComparisonMetricCopy,
  presentPeriodComparison,
} from './period-comparison-presentation';

const window: PeriodWindow = {
  from: new Date(2026, 4, 28, 0, 0, 0, 1),
  to: new Date(2026, 5, 3, 23, 59, 59, 999),
};
const previousPeriod = `Previous period, same filters: ${fmtDateOnly(window.from)} – ${fmtDateOnly(window.to)}`;
const apiValue: PeriodComparisonMetricCopy = { format: fmtMoney, noun: 'API-equivalent value', partly: 'priced' };
const processedTokens: PeriodComparisonMetricCopy = { format: fmtCompact, noun: 'processed tokens', partly: 'counted' };
const change = (
  overrides: Partial<Extract<MetricPeriodComparison, { kind: 'change' }>> = {},
): MetricPeriodComparison => ({
  current: 150,
  kind: 'change',
  percent: 50,
  previous: 100,
  provisional: false,
  window,
  ...overrides,
});

describe('period comparison presentation', () => {
  test('states a change in one sentence and keeps the window and its value for on-demand reading', () => {
    expect(presentPeriodComparison(change(), apiValue)).toEqual({
      caveat: null,
      explanation: [`${previousPeriod} · $100.00 API-equivalent value`],
      figure: '+50%',
      outcome: change(),
      statement: '50% higher than the previous equal-length period.',
    });
  });

  test('words a decrease, and an unchanged value as the headline always did', () => {
    const lower = presentPeriodComparison(
      change({ current: 91_500, percent: -8.5, previous: 100_000 }),
      processedTokens,
    );
    const unchanged = presentPeriodComparison(change({ current: 100, percent: 0 }), processedTokens);

    expect(lower.figure).toBe('−8.5%');
    expect(lower.statement).toBe('8.5% lower than the previous equal-length period.');
    expect(lower.explanation).toEqual([`${previousPeriod} · 100k processed tokens`]);
    expect(unchanged.figure).toBe('+0%');
    expect(unchanged.statement).toBe('0% higher than the previous equal-length period.');
  });

  test('names a one-day previous period by its single date', () => {
    const oneDay: PeriodWindow = { from: new Date(2026, 5, 10), to: new Date(2026, 5, 10, 23, 59, 59, 999) };

    expect(presentPeriodComparison(change({ window: oneDay }), processedTokens).explanation).toEqual([
      `Previous period, same filters: ${fmtDateOnly(oneDay.from)} · 100 processed tokens`,
    ]);
  });

  test('carries the in-progress caveat only with a percentage, and as a last explanation line', () => {
    const caveat = 'This period is still in progress, so the comparison is provisional.';
    const provisional = presentPeriodComparison(change({ provisional: true }), apiValue);
    const settled = presentPeriodComparison(change(), apiValue);

    expect(provisional.caveat).toBe(caveat);
    expect(explanationWithCaveat(provisional)).toEqual([...provisional.explanation, caveat]);
    expect(settled.caveat).toBeNull();
    expect(explanationWithCaveat(settled)).toEqual(settled.explanation);
  });

  test('explains a zero baseline instead of printing a percentage', () => {
    const presentation = presentPeriodComparison({ kind: 'zero-baseline', window }, apiValue);

    expect(presentation).toMatchObject({
      caveat: null,
      explanation: [previousPeriod],
      figure: null,
      statement: 'No percentage: the previous period has no API-equivalent value.',
    });
  });

  test.each([
    { current: false, previous: true },
    { current: true, previous: false },
    { current: false, previous: false },
  ])('shows a partly measured previous value as a lower bound: %o', ({ current, previous }) => {
    const presentation = presentPeriodComparison(
      {
        current: { complete: current, value: 120 },
        kind: 'partial-measurement',
        previous: { complete: previous, value: 80 },
        window,
      },
      apiValue,
    );

    expect(presentation.figure).toBeNull();
    expect(presentation.statement).toBe('No percentage: the API-equivalent value is only partly priced.');
    expect(presentation.explanation).toEqual([
      `${previousPeriod} · ${previous ? '$80.00' : '≥ $80.00'} API-equivalent value`,
    ]);
  });

  test('keeps the established sentences for a full range and an empty previous period', () => {
    const fullRange = presentPeriodComparison({ kind: 'full-range' }, apiValue);
    const empty = presentPeriodComparison({ kind: 'no-previous-sessions', window }, apiValue);

    expect(fullRange).toMatchObject({
      caveat: null,
      explanation: [],
      figure: null,
      statement: 'No previous period exists before the full recorded range.',
    });
    expect(empty.statement).toBe('No sessions exist in the previous period.');
    expect(empty.explanation).toEqual([previousPeriod]);
  });

  test('tells history that starts in the selected period from history that starts in the previous one', () => {
    const recordedFirst = new Date(2026, 5, 1, 12);
    const historyStart = `Recorded history starts ${fmtDateOnly(recordedFirst)} under the current filters.`;
    const unrecorded = presentPeriodComparison(
      { kind: 'history-shorter-than-window', previousPeriod: 'unrecorded', recordedFirst, window },
      apiValue,
    );
    const partlyRecorded = presentPeriodComparison(
      { kind: 'history-shorter-than-window', previousPeriod: 'partly-recorded', recordedFirst, window },
      apiValue,
    );

    expect(unrecorded.statement).toBe('No previous period exists before the full recorded range.');
    expect(unrecorded.explanation).toEqual([historyStart]);
    expect(partlyRecorded.figure).toBeNull();
    expect(partlyRecorded.statement).toBe('No percentage: the previous period is only partly recorded.');
    expect(partlyRecorded.explanation).toEqual([historyStart, previousPeriod]);
  });

  test('names each harness that does not cover the previous period', () => {
    const claude = { label: 'Claude Code', recordedFirst: new Date(2026, 5, 2, 9) };
    const cursor = { label: 'Cursor', recordedFirst: new Date(2026, 5, 8, 9) };
    const presentation = presentPeriodComparison(
      { kind: 'source-not-covering-window', sources: [claude, cursor], window },
      apiValue,
    );

    expect(presentation.figure).toBeNull();
    expect(presentation.statement).toBe('No percentage: the previous period is only partly recorded.');
    expect(presentation.explanation).toEqual([
      `Claude Code history starts ${fmtDateOnly(claude.recordedFirst)} under the current filters.`,
      `Cursor history starts ${fmtDateOnly(cursor.recordedFirst)} under the current filters.`,
      previousPeriod,
    ]);
  });
});
