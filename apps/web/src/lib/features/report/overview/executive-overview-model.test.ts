import { describe, expect, test } from 'bun:test';
import type {
  FocusedExecutiveGroup,
  FocusedExecutiveOverview,
  FocusedReportSummary,
} from '@ai-usage/report-core/focused-report-query';
import { apiPriceMeasurement } from '@ai-usage/report-core/provenance';
import {
  buildExecutiveOverviewModel,
  EXECUTIVE_INSIGHT_MINIMUM_CHANGE_PERCENT,
  EXECUTIVE_INSIGHT_MINIMUM_CONCENTRATION_PERCENT,
  type ExecutiveOverviewModelInput,
} from './executive-overview-model';

const FORBIDDEN_INSIGHT_CLAIMS = /caused|driven by|spend|saving|ROI/i;

const summary = (overrides: Partial<FocusedReportSummary> = {}): FocusedReportSummary => {
  const totalCost = overrides.totalCost ?? 100;
  return {
    actualCost: 0,
    cacheRead: 60,
    cacheWrite: 20,
    costQuota: 0,
    fresh: 30,
    meanCost: totalCost / 3,
    pricedSessions: 3,
    priceMeasurement:
      overrides.priceMeasurement ?? apiPriceMeasurement({ costKnown: true, freshTokens: 30, knownCost: totalCost }),
    rtkInput: 0,
    rtkOutput: 0,
    rtkSaved: 0,
    rtkSessions: 0,
    sessionCount: 3,
    tokIn: 20,
    tokOut: 10,
    tools: 7,
    totalCost,
    turns: 8,
    unknownActual: 0,
    ...overrides,
  };
};

const executiveGroup = (
  key: string,
  total: number,
  processedTokens: number,
  options: { partialUnpricedTokens?: number; sessions?: number } = {},
): FocusedExecutiveGroup => {
  const partialUnpricedTokens = options.partialUnpricedTokens ?? 0;
  return {
    key,
    label: key,
    priceMeasurement: apiPriceMeasurement({
      costKnown: partialUnpricedTokens === 0,
      freshTokens: partialUnpricedTokens,
      knownCost: total,
    }),
    processedTokens,
    sessions: options.sessions ?? 1,
    total,
  };
};

const executive: FocusedExecutiveOverview = {
  harnesses: [executiveGroup('Codex', 60, 1_000_000, { sessions: 2 }), executiveGroup('Claude Code', 40, 500_000)],
  models: [executiveGroup('gpt-5.4', 50, 1_000_000), executiveGroup('claude-opus-4-6', 30, 500_000)],
};

const modelInput = (overrides: Partial<ExecutiveOverviewModelInput> = {}): ExecutiveOverviewModelInput => ({
  executive,
  periodInProgress: false,
  previousSummary: summary({ totalCost: 50 }),
  rangeMode: '30d',
  summary: summary(),
  topItems: [
    { costApprox: 30, costKnown: true, kind: 'session' },
    { costApprox: 20, costKnown: true, kind: 'session' },
  ],
  totalSessionCount: 3,
  ...overrides,
});

describe('executive Overview model', () => {
  test('presents the primary value, exact token formula, four support metrics, and bounded groups', () => {
    const model = buildExecutiveOverviewModel(modelInput());

    expect(model.primary.value).toMatchObject({ label: '$100.00', status: 'exact' });
    expect(model.primary.provenance).toBeNull();
    expect(model.primary.periodScope).toBe('in the last 30 days');
    expect(model.primary.comparison).toMatchObject({
      caveat: null,
      delta: { pct: 100 },
      explanation: null,
      state: 'available',
    });
    expect(model.supportMetrics.map(({ key }) => key)).toEqual([
      'processed-tokens',
      'cache-volume',
      'output-tokens',
      'pricing-coverage',
    ]);
    expect(model.supportMetrics).toEqual([
      {
        detail: '110 processed tokens',
        key: 'processed-tokens',
        label: 'Processed tokens',
        qualification: null,
        value: '110',
      },
      {
        detail: '60 read · 20 write',
        key: 'cache-volume',
        label: 'Cache volume',
        qualification: null,
        value: '80',
      },
      {
        detail: '10 output tokens',
        key: 'output-tokens',
        label: 'Output tokens',
        qualification: null,
        value: '10',
      },
      {
        detail: '100% fully priced',
        key: 'pricing-coverage',
        label: 'Pricing coverage',
        qualification: null,
        value: '3 / 3',
      },
    ]);
    expect(model.harnesses.map(({ group, shareLabel, value }) => ({ key: group.key, shareLabel, value }))).toEqual([
      { key: 'Codex', shareLabel: '60%', value: expect.objectContaining({ label: '$60.00' }) },
      { key: 'Claude Code', shareLabel: '40%', value: expect.objectContaining({ label: '$40.00' }) },
    ]);
    expect(model.models[0]?.valuePerMillion).toMatchObject({ label: '$50.00', status: 'exact' });
    expect(model.insight?.sentences).toEqual([
      'API-equivalent value is 100% higher than the previous equal-length period.',
      "The two leading sessions represent 50% of this period's measured value.",
    ]);
    expect(model.emptyState).toBeNull();
  });

  test('describes an eligible decrease without causal or financial claims', () => {
    const model = buildExecutiveOverviewModel(
      modelInput({
        previousSummary: summary({ totalCost: 80 }),
        summary: summary({ totalCost: 40 }),
        topItems: [
          { costApprox: 12, costKnown: true, kind: 'campaign' },
          { costApprox: 8, costKnown: true, kind: 'campaign' },
        ],
      }),
    );

    expect(model.insight?.sentences).toEqual([
      'API-equivalent value is 50% lower than the previous equal-length period.',
      "The two leading campaigns represent 50% of this period's measured value.",
    ]);
    expect(model.insight?.text).not.toMatch(FORBIDDEN_INSIGHT_CLAIMS);
  });

  test('keeps partial pricing visibly qualified and omits the insight', () => {
    const partialMeasurement = apiPriceMeasurement({ costKnown: false, freshTokens: 400, knownCost: 100 });
    const model = buildExecutiveOverviewModel(
      modelInput({
        summary: summary({
          priceMeasurement: partialMeasurement,
          pricedSessions: 2,
          sessionCount: 3,
          totalCost: 100,
        }),
      }),
    );

    expect(model.primary.value).toMatchObject({ label: '≥ $100.00', status: 'lower-bound' });
    expect(model.primary.provenance?.description).toContain('400');
    expect(model.supportMetrics.find(({ key }) => key === 'pricing-coverage')).toMatchObject({
      detail: '67% fully priced',
      qualification: expect.stringContaining('400'),
      value: '2 / 3',
    });
    expect(model.primary.comparison).toEqual({
      caveat: null,
      delta: null,
      explanation: null,
      state: 'available',
    });
    expect(model.insight).toBeNull();
  });

  test('does not infer an exact period delta from a partially measured previous period', () => {
    const previousSummary = summary({
      priceMeasurement: apiPriceMeasurement({ costKnown: false, freshTokens: 200, knownCost: 50 }),
      totalCost: 50,
    });
    const model = buildExecutiveOverviewModel(modelInput({ previousSummary }));

    expect(model.primary.comparison).toEqual({
      caveat: null,
      delta: null,
      explanation: null,
      state: 'available',
    });
  });

  test('uses the established all-time boundary instead of fabricating a comparison', () => {
    const model = buildExecutiveOverviewModel(modelInput({ previousSummary: null, rangeMode: 'all' }));

    expect(model.primary.comparison).toEqual({
      caveat: null,
      delta: null,
      explanation: 'No previous period exists before the full recorded range.',
      state: 'full-range',
    });
    expect(model.primary.periodScope).toBe('across all recorded dates');
    expect(model.insight).toBeNull();
  });

  test('keeps the 90-day and custom period scope visible in the primary answer', () => {
    expect(buildExecutiveOverviewModel(modelInput({ rangeMode: '90d' })).primary.periodScope).toBe(
      'in the last 90 days',
    );
    expect(buildExecutiveOverviewModel(modelInput({ rangeMode: 'custom' })).primary.periodScope).toBe(
      'in the selected custom period',
    );
  });

  test('keeps bounded no-prior and measured-zero outcomes explicit without a delta', () => {
    const zeroSummary = summary({
      priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 30, knownCost: 0 }),
      totalCost: 0,
    });
    const model = buildExecutiveOverviewModel(
      modelInput({ previousSummary: null, rangeMode: '30d', summary: zeroSummary, topItems: [] }),
    );

    expect(model.primary.value).toMatchObject({ label: '$0.00', status: 'exact' });
    expect(model.primary.comparison).toEqual({
      caveat: null,
      delta: null,
      explanation: 'No sessions exist in the previous period.',
      state: 'no-prior-data',
    });
    expect(model.insight).toBeNull();
  });

  test('chooses no-prior copy from the recorded boundary rather than the range mode', () => {
    const beforeRecordedRange = buildExecutiveOverviewModel(
      modelInput({
        comparisonBoundary: {
          rangeFrom: new Date('2026-03-13T00:00:00.000Z'),
          recordedFirst: '2026-04-12T09:20:00.000Z',
        },
        previousSummary: null,
        rangeMode: '90d',
      }),
    );
    const emptyWindowWithinHistory = buildExecutiveOverviewModel(
      modelInput({
        comparisonBoundary: {
          rangeFrom: new Date('2026-05-12T00:00:00.000Z'),
          recordedFirst: '2026-04-12T09:20:00.000Z',
        },
        previousSummary: null,
        rangeMode: '30d',
      }),
    );
    const customBoundary = buildExecutiveOverviewModel(
      modelInput({
        comparisonBoundary: {
          rangeFrom: new Date('2026-04-12T00:00:00.000Z'),
          recordedFirst: '2026-04-12T09:20:00.000Z',
        },
        previousSummary: null,
        rangeMode: 'custom',
      }),
    );

    expect(beforeRecordedRange.primary.comparison).toMatchObject({
      explanation: 'No previous period exists before the full recorded range.',
      state: 'full-range',
    });
    expect(emptyWindowWithinHistory.primary.comparison).toMatchObject({
      explanation: 'No sessions exist in the previous period.',
      state: 'no-prior-data',
    });
    expect(customBoundary.primary.comparison).toMatchObject({ state: 'full-range' });
  });

  test('qualifies comparisons while the selected period is still in progress', () => {
    const caveat = 'This period is still in progress, so the comparison is provisional.';
    const inProgress = buildExecutiveOverviewModel(modelInput({ periodInProgress: true }));
    const withoutDelta = buildExecutiveOverviewModel(
      modelInput({ periodInProgress: true, previousSummary: null, rangeMode: 'all' }),
    );
    const complete = buildExecutiveOverviewModel(modelInput({ periodInProgress: false }));

    expect(inProgress.primary.comparison.caveat).toBe(caveat);
    expect(inProgress.insight?.sentences[0]).toBe(
      'API-equivalent value is 100% higher than the previous equal-length period (this period is still in progress).',
    );
    expect(inProgress.insight?.text).not.toMatch(FORBIDDEN_INSIGHT_CLAIMS);
    expect(withoutDelta.primary.comparison.caveat).toBeNull();
    expect(complete.primary.comparison.caveat).toBeNull();
  });

  test('distinguishes no local usage from filters that return zero', () => {
    const emptySummary = summary({
      priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 }),
      pricedSessions: 0,
      sessionCount: 0,
      totalCost: 0,
    });

    expect(
      buildExecutiveOverviewModel(modelInput({ summary: emptySummary, topItems: [], totalSessionCount: 0 })).emptyState,
    ).toEqual({
      actionIntent: 'open-sources',
      actionLabel: 'Open Sources',
      description: 'Connect or refresh a source to begin analyzing local usage.',
      kind: 'no-local-data',
      title: 'No local usage yet',
    });
    expect(
      buildExecutiveOverviewModel(modelInput({ summary: emptySummary, topItems: [], totalSessionCount: 12 }))
        .emptyState,
    ).toEqual({
      actionIntent: 'clear-filters',
      actionLabel: 'Clear filters',
      description: 'Change or clear the active filters to restore matching sessions.',
      kind: 'filtered-zero',
      title: 'No sessions match these filters',
    });
  });

  test('renders value per million as an exact value, partial lower bound, or em dash', () => {
    const groups: FocusedExecutiveOverview = {
      harnesses: [],
      models: [
        executiveGroup('exact', 2, 1_000_000),
        executiveGroup('partial', 3, 1_000_000, { partialUnpricedTokens: 50 }),
        executiveGroup('zero', 2, 0),
      ],
    };
    const model = buildExecutiveOverviewModel(modelInput({ executive: groups }));

    expect(model.models.map(({ valuePerMillion }) => valuePerMillion)).toEqual([
      expect.objectContaining({ label: '$2.00', status: 'exact' }),
      expect.objectContaining({ label: '≥ $3.00', status: 'lower-bound' }),
      expect.objectContaining({ label: '—', status: 'unknown' }),
    ]);
    expect(model.models[2]?.valuePerMillion.title).toContain('zero processed tokens');
  });

  test('uses items for a mixed session/campaign concentration', () => {
    const model = buildExecutiveOverviewModel(
      modelInput({
        topItems: [
          { costApprox: 30, costKnown: true, kind: 'session' },
          { costApprox: 20, costKnown: true, kind: 'campaign' },
        ],
      }),
    );

    expect(model.insight?.sentences[1]).toBe("The two leading items represent 50% of this period's measured value.");
  });

  test('enforces the named change and concentration thresholds at their exact boundaries', () => {
    expect(EXECUTIVE_INSIGHT_MINIMUM_CHANGE_PERCENT).toBe(20);
    expect(EXECUTIVE_INSIGHT_MINIMUM_CONCENTRATION_PERCENT).toBe(40);

    const insightFor = (totalCost: number, topCost: number) =>
      buildExecutiveOverviewModel(
        modelInput({
          previousSummary: summary({ totalCost: 100 }),
          summary: summary({ totalCost }),
          topItems: [
            { costApprox: topCost / 2, costKnown: true, kind: 'session' },
            { costApprox: topCost / 2, costKnown: true, kind: 'session' },
          ],
        }),
      ).insight;

    expect(insightFor(119.99, 48)).toBeNull();
    expect(insightFor(120, 47.988)).toBeNull();
    expect(insightFor(120, 48)).not.toBeNull();
  });

  test('requires two priced current items before producing an insight', () => {
    const onePricedItem = buildExecutiveOverviewModel(
      modelInput({
        topItems: [
          { costApprox: 50, costKnown: true, kind: 'session' },
          { costApprox: 30, costKnown: false, kind: 'session' },
        ],
      }),
    );
    const twoPricedItems = buildExecutiveOverviewModel(
      modelInput({
        topItems: [
          { costApprox: 30, costKnown: true, kind: 'session' },
          { costApprox: 20, costKnown: true, kind: 'session' },
        ],
      }),
    );

    expect(onePricedItem.insight).toBeNull();
    expect(twoPricedItems.insight).not.toBeNull();
  });
});
