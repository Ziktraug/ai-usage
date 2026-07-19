import { describe, expect, test } from 'bun:test';
import type { SessionDetailConsistency } from '@ai-usage/report-core/session-detail';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import { demoReportPayload } from './report-data';
import { buildSessionAnalysisPresentation } from './session-analysis-presentation';
import type { SessionAnalysisTarget } from './session-analysis-target';

const row = enrichSessionPresentationRow(demoReportPayload.rows[0]!);
const sessionTarget: SessionAnalysisTarget = { kind: 'session', reportRowId: row.rowId, summaryRow: row };
const campaignTarget = (visibleCount: number): SessionAnalysisTarget => ({
  campaignKey: 'fixture-campaign',
  kind: 'campaign-root',
  reportRowId: row.rowId,
  summaryRow: row,
  totalCount: 15,
  visibleCount,
});
const matches: SessionDetailConsistency = { checkedFields: ['tokens'], status: 'matches-report' };

const present = (
  consistency: SessionDetailConsistency = matches,
  overrides: Partial<Parameters<typeof buildSessionAnalysisPresentation>[0]> = {},
) =>
  buildSessionAnalysisPresentation({
    consistency,
    durationPartialBody: 'Partial duration body.',
    durationPartialTitle: 'Partial duration',
    durationStatus: 'recorded',
    promptDataTruncated: false,
    target: sessionTarget,
    turnsStatus: 'recorded',
    ...overrides,
  });

describe('session analysis presentation', () => {
  test.each([
    [matches, 'consistency-meta', 'Local detail · comparable metrics match this report revision.', 'neutral'],
    [
      {
        checkedFields: ['duration', 'tokens'],
        differingFields: ['duration', 'model-attribution'],
        status: 'differs-from-report',
      } satisfies SessionDetailConsistency,
      'consistency-warning',
      'Local trace differs from this report revision. Differing metrics: duration, model attribution.',
      'warning',
    ],
    [
      {
        checkedFields: ['duration'],
        reason: 'insufficient-comparable-facts',
        status: 'cannot-compare',
      } satisfies SessionDetailConsistency,
      'consistency-meta',
      'Local detail · comparison unavailable for this row.',
      'neutral',
    ],
  ] as const)('presents every consistency state', (consistency, kind, text, tone) => {
    const item = present(consistency)[0];
    expect(item?.kind).toBe(kind);
    expect(item?.text).toBe(text);
    expect(item?.tone).toBe(tone);
  });

  test.each([
    [15, 'Root rollout · 15 rollouts'],
    [6, 'Root rollout · 6 visible of 15 rollouts'],
  ])('describes campaign scope with visible metrics (%i/15)', (visibleCount, expected) => {
    expect(present(matches, { target: campaignTarget(visibleCount) })).toContainEqual({
      kind: 'scope',
      text: expected,
      tone: 'neutral',
    });
  });

  test('combines match with metric-level warnings without making metadata alarming', () => {
    const items = present(matches, {
      durationStatus: 'partial',
      promptDataTruncated: true,
      turnsStatus: 'partial',
    });
    expect(items.filter(({ tone }) => tone === 'warning').map(({ kind }) => kind)).toEqual([
      'partial-duration',
      'partial-turns',
      'prompt-truncation',
    ]);
    expect(items.find(({ kind }) => kind === 'consistency-meta')?.tone).toBe('neutral');
    expect(items.find(({ kind }) => kind === 'privacy')).toEqual({
      kind: 'privacy',
      text: 'Local only · detailed prompt bodies are not included in reports or exports.',
      tone: 'neutral',
    });
  });

  test('keeps divergence and partial duration as two targeted warnings', () => {
    const items = present(
      { checkedFields: ['tokens'], differingFields: ['tokens'], status: 'differs-from-report' },
      { durationStatus: 'partial' },
    );
    expect(items.filter(({ tone }) => tone === 'warning').map(({ kind }) => kind)).toEqual([
      'consistency-warning',
      'partial-duration',
    ]);
  });
});
