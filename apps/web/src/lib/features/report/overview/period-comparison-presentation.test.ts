import { describe, expect, test } from 'bun:test';
import type { MetricPeriodComparison, PeriodWindow } from '../../../foundation/dashboard/dashboard-model';
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
      relation: '50% higher than the previous equal-length period',
      statement: '50% higher than the previous equal-length period.',
    });
  });

  test('words a decrease with one decimal below ten percent', () => {
    const lower = presentPeriodComparison(
      change({ current: 91_500, percent: -8.5, previous: 100_000 }),
      processedTokens,
    );

    expect(lower.figure).toBe('−8.5%');
    expect(lower.statement).toBe('8.5% lower than the previous equal-length period.');
    expect(lower.explanation).toEqual([`${previousPeriod} · 100k processed tokens`]);
  });

  test('groups the digits of a large change and drops the decimal from ten percent up', () => {
    const large = presentPeriodComparison(change({ current: 3.2, percent: 1782.35, previous: 0.17 }), apiValue);
    const roundsToTen = presentPeriodComparison(change({ percent: -9.96 }), apiValue);

    expect(large.figure).toBe('+1,782%');
    expect(large.statement).toBe('1,782% higher than the previous equal-length period.');
    expect(roundsToTen.figure).toBe('−10%');
    expect(roundsToTen.statement).toBe('10% lower than the previous equal-length period.');
  });

  test('reads an unchanged value, and a change below the shown precision, as no change in either direction', () => {
    const unchanged = presentPeriodComparison(change({ current: 100, percent: 0 }), processedTokens);
    const tinyIncrease = presentPeriodComparison(change({ percent: 0.04 }), processedTokens);
    const tinyDecrease = presentPeriodComparison(change({ percent: -0.049 }), processedTokens);

    expect(unchanged).toMatchObject({
      figure: '0%',
      relation: 'unchanged from the previous equal-length period',
      statement: 'Unchanged from the previous equal-length period.',
    });
    for (const tiny of [tinyIncrease, tinyDecrease]) {
      expect(tiny).toMatchObject({
        figure: '≈0%',
        relation: 'about the same as the previous equal-length period',
        statement: 'About the same as the previous equal-length period.',
      });
    }
    expect(presentPeriodComparison(change({ percent: -0.05 }), processedTokens).figure).toBe('−0.1%');
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
    const history = { first: new Date(2026, 5, 1, 12), limitedToHarnesses: [] };
    const historyStart = `Recorded history starts ${fmtDateOnly(history.first)}.`;
    const unrecorded = presentPeriodComparison(
      { history, kind: 'history-shorter-than-window', previousPeriod: 'unrecorded', window },
      apiValue,
    );
    const partlyRecorded = presentPeriodComparison(
      { history, kind: 'history-shorter-than-window', previousPeriod: 'partly-recorded', window },
      apiValue,
    );

    expect(unrecorded.statement).toBe('No previous period exists before the full recorded range.');
    expect(unrecorded.explanation).toEqual([historyStart]);
    expect(partlyRecorded).toMatchObject({ figure: null, relation: null });
    expect(partlyRecorded.statement).toBe('No percentage: the previous period is only partly recorded.');
    expect(partlyRecorded.explanation).toEqual([historyStart, previousPeriod]);
  });

  test('names the harnesses whose history decides, never the other filters', () => {
    const first = new Date(2026, 5, 1, 12);
    const historyOf = (limitedToHarnesses: readonly string[]) =>
      presentPeriodComparison(
        {
          history: { first, limitedToHarnesses },
          kind: 'history-shorter-than-window',
          previousPeriod: 'partly-recorded',
          window,
        },
        apiValue,
      ).explanation[0];

    expect(historyOf(['OpenCode'])).toBe(`Recorded OpenCode history starts ${fmtDateOnly(first)}.`);
    expect(historyOf(['Codex', 'Claude', 'Cursor'])).toBe(
      `Recorded history of Codex, Claude, and Cursor starts ${fmtDateOnly(first)}.`,
    );
  });
});
