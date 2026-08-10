import { describe, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { analyticsExportRows, breakdownRows, modelAnalysisRows } from './model';

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

describe('Models analysis projection', () => {
  test('derives the measured comparison columns from processed tokens', () => {
    const [row] = modelAnalysisRows([group('<synthetic>', { costPercent: 8.5, costSum: 15 })], '', 'value');

    expect(row).toMatchObject({
      label: 'Unattributed model',
      priceState: 'measured',
      pricingCoverageLabel: '1 / 1 · 100%',
      pricingQualification: null,
      processedTokens: 150,
      processedTokensLabel: '150',
      processedTokensTitle: 'Processed tokens: cache read + cache write + input + output.',
      shareLabel: '8.5%',
      value: { label: '$15.00', status: 'exact' },
      valuePerMillion: { label: '$100000.00', status: 'exact' },
    });
  });

  test('qualifies partial values and reserves the em dash for zero processed tokens', () => {
    const rows = modelAnalysisRows(
      [
        group('partial-positive', {
          cache: 50,
          costSum: 3,
          fresh: 50,
          priced: 1,
          sessions: 2,
          unpriced: 1,
          unpricedFreshTokens: 25,
        }),
        group('partial-zero', {
          cache: 40,
          costSum: 0,
          fresh: 60,
          priced: 0,
          unpriced: 1,
          unpricedFreshTokens: 60,
        }),
        group('zero-processed', { cache: 0, costSum: 0, fresh: 0 }),
      ],
      '',
      'value',
    );

    expect(
      rows.map(({ label, priceState, pricingCoverageLabel, pricingQualification, value, valuePerMillion }) => ({
        label,
        priceState,
        pricingCoverageLabel,
        pricingQualification,
        value: { label: value.label, status: value.status },
        valuePerMillion: { label: valuePerMillion.label, status: valuePerMillion.status },
      })),
    ).toEqual([
      {
        label: 'partial-positive',
        priceState: 'partially measured',
        pricingCoverageLabel: '1 / 2 · 50%',
        pricingQualification: 'Partially measured · 25 unpriced fresh tokens',
        value: { label: '≥ $3.00', status: 'lower-bound' },
        valuePerMillion: { label: '≥ $30000.00', status: 'lower-bound' },
      },
      {
        label: 'partial-zero',
        priceState: 'partially measured',
        pricingCoverageLabel: '0 / 1 · 0%',
        pricingQualification: 'Partially measured · 60 unpriced fresh tokens',
        value: { label: '—', status: 'unknown' },
        valuePerMillion: { label: '≥ $0.00', status: 'lower-bound' },
      },
      {
        label: 'zero-processed',
        priceState: 'zero',
        pricingCoverageLabel: '1 / 1 · 100%',
        pricingQualification: null,
        value: { label: '$0.00', status: 'exact' },
        valuePerMillion: { label: '—', status: 'unknown' },
      },
    ]);
  });

  test('keeps unavailable usage unknown and protects empty pricing coverage', () => {
    const rows = modelAnalysisRows(
      [
        group('unavailable', {
          cache: 0,
          fresh: 0,
          priced: 1,
          sessions: 1,
          usageUnavailable: 1,
        }),
        group('empty', { cache: 0, fresh: 0, priced: 0, sessions: 0 }),
      ],
      '',
      'value',
    );
    const unavailable = rows.find(({ label }) => label === 'unavailable');
    const empty = rows.find(({ label }) => label === 'empty');

    expect(unavailable).toMatchObject({
      priceState: 'unavailable',
      pricingCoverageLabel: '—',
      pricingQualification: 'Session found in prompt history; detailed local token counters are missing',
      processedTokens: 0,
      processedTokensLabel: '—',
      value: { label: '—', status: 'unknown' },
      valuePerMillion: { label: '—', status: 'unknown' },
    });
    expect(unavailable?.value.title).toContain('detailed local token counters are missing');
    expect(empty).toMatchObject({
      pricingCoverageLabel: '0 / 0 · —',
      pricingQualification: 'Pricing coverage unavailable · no model sessions',
      processedTokensLabel: '0',
    });
  });

  test('qualifies mixed missing counters without discarding known model totals', () => {
    const [row] = modelAnalysisRows(
      [group('mixed', { cache: 80, costSum: 4, fresh: 120, priced: 3, sessions: 3, usageUnavailable: 1 })],
      '',
      'value',
    );

    expect(row).toMatchObject({
      priceState: 'partially measured',
      pricingCoverageLabel: '3 / 3 · 100%',
      pricingQualification: '1 of 3 model sessions has unavailable token counters',
      processedTokens: 200,
      processedTokensLabel: '200',
      processedTokensQualification: '1 of 3 model sessions has unavailable token counters',
      value: { label: '≥ $4.00', status: 'lower-bound' },
      valuePerMillion: { label: '—', status: 'unknown' },
    });
    expect(row?.valuePerMillion.title).toContain('detailed local token counters are missing');
  });

  test('preserves historical fresh-token sorting, normalized search, and original CSV groups', () => {
    const groups = [
      group('cache-heavy', { cache: 1000, costSum: 1, fresh: 1 }),
      group('fresh-first', { cache: 0, costSum: 1, fresh: 2 }),
      group('codex', { cache: 0, costSum: 1, fresh: 3 }),
    ];

    expect(modelAnalysisRows(groups, '', 'tokens').map(({ label }) => label)).toEqual([
      'Unspecified Codex model',
      'fresh-first',
      'cache-heavy',
    ]);
    const visible = modelAnalysisRows(groups, '  UNSPECIFIED CODEX  ', 'tokens');
    expect(visible.map(({ label }) => label)).toEqual(['Unspecified Codex model']);
    expect(analyticsExportRows(visible)).toEqual([{ group: groups[2]!, label: 'Unspecified Codex model' }]);
  });
});
